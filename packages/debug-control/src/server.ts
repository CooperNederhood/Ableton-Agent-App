import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type Server, type Socket } from "node:net";

import {
  AUTOMATION_HOST,
  AUTOMATION_PROTOCOL_VERSION,
  MAX_AUTOMATION_FRAME_BYTES,
  automationResponseSchema,
  sendUserMessageRequestSchema,
  type AutomationErrorCode,
  type AutomationLifecycleEvent,
  type AutomationResponse,
  type SendUserMessageRequest,
} from "./contracts.js";

export interface AutomationControlServerOptions {
  descriptorPath: string;
  sendUserMessage(
    request: SendUserMessageRequest,
  ): Promise<{ accepted: true; messageId: string }>;
  onLifecycle?: (event: AutomationLifecycleEvent) => void;
  now?: () => number;
}

export class AutomationControlServer {
  readonly #server: Server;
  readonly #secret = randomBytes(32).toString("hex");
  readonly #secretPath: string;
  readonly #now: () => number;
  #descriptorContent: string | undefined;
  #secretContent: string | undefined;
  #started = false;
  #activeRequestId: string | undefined;

  public constructor(private readonly options: AutomationControlServerOptions) {
    this.#secretPath = `${options.descriptorPath}.secret`;
    this.#now = options.now ?? Date.now;
    this.#server = createServer((socket) => this.#accept(socket));
  }

  public async start(): Promise<{
    host: typeof AUTOMATION_HOST;
    port: number;
  }> {
    if (this.#started)
      throw new Error("Automation control server already started");
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, AUTOMATION_HOST, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      await this.stop();
      throw new Error("Automation control server did not expose a TCP address");
    }
    const descriptor = {
      version: AUTOMATION_PROTOCOL_VERSION,
      host: AUTOMATION_HOST,
      port: address.port,
      secretPath: this.#secretPath,
      processId: process.pid,
      startedAt: new Date(this.#now()).toISOString(),
    };
    this.#secretContent = `${this.#secret}\n`;
    this.#descriptorContent = `${JSON.stringify(descriptor)}\n`;
    try {
      await writePrivateFile(this.#secretPath, this.#secretContent);
      await writePrivateFile(
        this.options.descriptorPath,
        this.#descriptorContent,
      );
      this.#started = true;
      return { host: AUTOMATION_HOST, port: address.port };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.#server.listening) {
        resolve();
        return;
      }
      this.#server.close(() => resolve());
    });
    await Promise.all([
      removeOwnedFile(this.options.descriptorPath, this.#descriptorContent),
      removeOwnedFile(this.#secretPath, this.#secretContent),
    ]);
    this.#descriptorContent = undefined;
    this.#secretContent = undefined;
    this.#started = false;
  }

  #accept(socket: Socket): void {
    socket.setTimeout(5_000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_AUTOMATION_FRAME_BYTES) {
        socket.pause();
        void this.#respondError(
          socket,
          randomUUID(),
          "invalid_request",
          "Automation request exceeded the frame limit",
        );
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      socket.pause();
      void this.#handle(socket, buffer.subarray(0, newline).toString("utf8"));
    });
  }

  async #handle(socket: Socket, line: string): Promise<void> {
    let untrustedId: string = randomUUID();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
      if (
        typeof parsedJson === "object" &&
        parsedJson !== null &&
        "id" in parsedJson &&
        typeof parsedJson.id === "string"
      ) {
        untrustedId = parsedJson.id;
      }
    } catch {
      await this.#respondError(
        socket,
        untrustedId,
        "invalid_request",
        "Automation request was not valid JSON",
      );
      return;
    }
    const parsed = sendUserMessageRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      await this.#respondError(
        socket,
        untrustedId,
        "invalid_request",
        "Automation request did not match the supported contract",
      );
      return;
    }
    const request = parsed.data;
    if (!secretsEqual(request.secret, this.#secret)) {
      await this.#respondError(
        socket,
        request.id,
        "unauthorized",
        "Automation request was not authorized",
      );
      return;
    }
    if (this.#activeRequestId !== undefined) {
      await this.#respondError(
        socket,
        request.id,
        "busy",
        "Desktop automation is already processing a request",
      );
      return;
    }
    const startedAt = this.#now();
    this.#activeRequestId = request.id;
    this.options.onLifecycle?.({
      stage: "queued",
      requestId: request.id,
      trace: request.trace,
      messageCharacters: request.params.message.length,
    });
    this.options.onLifecycle?.({
      stage: "started",
      requestId: request.id,
      trace: request.trace,
      messageCharacters: request.params.message.length,
    });
    try {
      const result = await this.options.sendUserMessage(request);
      this.options.onLifecycle?.({
        stage: "completed",
        requestId: request.id,
        trace: request.trace,
        messageCharacters: request.params.message.length,
        messageId: result.messageId,
        durationMs: this.#now() - startedAt,
      });
      await this.#respond(socket, {
        version: AUTOMATION_PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        result,
      });
    } catch (error) {
      const classified = classifyError(error);
      this.options.onLifecycle?.({
        stage: "failed",
        requestId: request.id,
        trace: request.trace,
        messageCharacters: request.params.message.length,
        errorCode: classified.code,
        durationMs: this.#now() - startedAt,
      });
      await this.#respondError(
        socket,
        request.id,
        classified.code,
        classified.message,
      );
    } finally {
      if (this.#activeRequestId === request.id)
        this.#activeRequestId = undefined;
    }
  }

  #respondError(
    socket: Socket,
    id: string,
    code: AutomationErrorCode,
    message: string,
  ): Promise<void> {
    return this.#respond(socket, {
      version: AUTOMATION_PROTOCOL_VERSION,
      id: isUuid(id) ? id : randomUUID(),
      ok: false,
      error: { code, message: message.slice(0, 512) },
    });
  }

  async #respond(socket: Socket, response: AutomationResponse): Promise<void> {
    const frame = `${JSON.stringify(automationResponseSchema.parse(response))}\n`;
    await new Promise<void>((resolve) => socket.end(frame, resolve));
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function secretsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function classifyError(error: unknown): {
  code: AutomationErrorCode;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (/already|busy|in progress/iu.test(message)) {
    return { code: "busy", message };
  }
  if (/not accepting|no active|not found|unavailable|stopped/iu.test(message)) {
    return { code: "unavailable", message };
  }
  return {
    code: "internal_error",
    message: "Desktop could not accept the message",
  };
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function removeOwnedFile(
  path: string,
  expectedContent: string | undefined,
): Promise<void> {
  if (expectedContent === undefined) return;
  try {
    if ((await readFile(path, "utf8")) === expectedContent) await rm(path);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
}
