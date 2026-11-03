import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";

import {
  AUTOMATION_PROTOCOL_VERSION,
  DEFAULT_AUTOMATION_REQUEST_TIMEOUT_MS,
  MAX_AUTOMATION_FRAME_BYTES,
  automationDiscoveryDescriptorSchema,
  automationResponseSchema,
  sendUserMessageRequestSchema,
  type AutomationErrorCode,
  type AutomationResponse,
  type AutomationTrace,
  type AutomationTargetIdentity,
  type AutomationAcceptance,
} from "./contracts.js";

export class AutomationControlError extends Error {
  public constructor(
    message: string,
    public readonly code:
      "discovery" | "connection" | "protocol" | "timeout" | AutomationErrorCode,
  ) {
    super(message);
  }
}

export interface SendAutomationMessageOptions {
  descriptorPath: string;
  message: string;
  timeoutMs?: number;
  trace?: AutomationTrace;
  expectedTarget?: AutomationTargetIdentity;
}

export async function sendAutomationMessage(
  options: SendAutomationMessageOptions,
): Promise<AutomationAcceptance & { trace: AutomationTrace }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTOMATION_REQUEST_TIMEOUT_MS;
  const descriptor = automationDiscoveryDescriptorSchema.parse(
    JSON.parse(await readFile(options.descriptorPath, "utf8")),
  );
  const secret = (await readFile(descriptor.secretPath, "utf8")).trim();
  const trace =
    options.trace ??
    ({
      traceId: randomUUID(),
      spanId: randomUUID(),
      correlationId: randomUUID(),
    } satisfies AutomationTrace);
  const request = sendUserMessageRequestSchema.parse({
    version: AUTOMATION_PROTOCOL_VERSION,
    id: randomUUID(),
    secret,
    method: "send_user_message",
    trace,
    params: {
      message: options.message,
      ...(options.expectedTarget === undefined
        ? {}
        : { expectedTarget: options.expectedTarget }),
    },
  });
  const response = await exchange(
    descriptor.host,
    descriptor.port,
    `${JSON.stringify(request)}\n`,
    timeoutMs,
    request.id,
  );
  if (!response.ok) {
    throw new AutomationControlError(
      response.error.message,
      response.error.code,
    );
  }
  const expected = options.expectedTarget;
  const actual = response.result.turn?.target;
  if (
    expected !== undefined &&
    (actual?.appSessionId !== expected.appSessionId ||
      actual.agentInstanceId !== expected.agentInstanceId ||
      actual.sdkSessionId !== expected.sdkSessionId)
  ) {
    throw new AutomationControlError(
      "Desktop automation acknowledgement did not match the expected target",
      "protocol",
    );
  }
  return { ...response.result, trace };
}

function exchange(
  host: string,
  port: number,
  frame: string,
  timeoutMs: number,
  requestId: string,
): Promise<AutomationResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, response?: AutomationResponse): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error !== undefined) reject(error);
      else if (response !== undefined) resolve(response);
    };
    socket.setTimeout(timeoutMs, () =>
      finish(
        new AutomationControlError(
          "Timed out waiting for the desktop automation endpoint",
          "timeout",
        ),
      ),
    );
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_AUTOMATION_FRAME_BYTES) {
        finish(
          new AutomationControlError(
            "Desktop automation response exceeded the frame limit",
            "protocol",
          ),
        );
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const response = automationResponseSchema.parse(
          JSON.parse(buffer.subarray(0, newline).toString("utf8")),
        );
        if (response.id !== requestId) {
          finish(
            new AutomationControlError(
              "Desktop automation response did not match the request ID",
              "protocol",
            ),
          );
          return;
        }
        finish(undefined, response);
      } catch {
        finish(
          new AutomationControlError(
            "Desktop automation response was invalid",
            "protocol",
          ),
        );
      }
    });
    socket.once("error", (error) =>
      finish(
        new AutomationControlError(
          `Could not connect to the desktop automation endpoint: ${error.message}`,
          "connection",
        ),
      ),
    );
    socket.once("end", () => {
      if (!settled) {
        finish(
          new AutomationControlError(
            "Desktop automation endpoint closed without a response",
            "protocol",
          ),
        );
      }
    });
  });
}
