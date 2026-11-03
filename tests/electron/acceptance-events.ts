import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  appEventSchema,
  type DesktopAppEvent,
} from "../../apps/desktop/src/contracts.js";

export class AcceptanceEvents {
  readonly #events: DesktopAppEvent[] = [];
  #bytes = 0;
  #failure: Error | undefined;

  constructor(
    private readonly maximumEvents = 10_000,
    private readonly maximumBytes = 16 * 1024 * 1024,
  ) {
    if (
      !Number.isSafeInteger(maximumEvents) ||
      maximumEvents < 1 ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1
    )
      throw new Error("Invalid acceptance event bounds");
  }

  receive(value: unknown): void {
    if (this.#failure !== undefined) return;
    try {
      const event = appEventSchema.parse(value);
      this.#bytes += Buffer.byteLength(JSON.stringify(event), "utf8");
      if (
        this.#events.length >= this.maximumEvents ||
        this.#bytes > this.maximumBytes
      )
        throw new Error(
          "Required acceptance event evidence exceeded its bound",
        );
      this.#events.push(event);
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
    }
  }

  read(): readonly DesktopAppEvent[] {
    if (this.#failure !== undefined) throw this.#failure;
    return this.#events;
  }

  diagnostics() {
    return {
      events: this.#events,
      ...(this.#failure ? { failure: this.#failure.message } : {}),
    };
  }

  async attach(page: Page): Promise<() => Promise<void>> {
    const name = `acceptance_${randomUUID().replaceAll("-", "")}`;
    await page.exposeFunction(name, (event: unknown) => this.receive(event));
    await page.evaluate((callbackName) => {
      const callback: unknown = Reflect.get(window, callbackName);
      if (typeof callback !== "function")
        throw new Error("Acceptance observer binding is unavailable");
      const stop = window.desktop.events.subscribe((event) => {
        void Promise.resolve(
          Reflect.apply(callback, undefined, [event]) as unknown,
        ).catch((error: unknown) => {
          Reflect.set(window, `${callbackName}_error`, String(error));
        });
      });
      Reflect.set(window, `${callbackName}_stop`, stop);
    }, name);
    return async () => {
      if (page.isClosed()) return;
      const failure = await page.evaluate((callbackName) => {
        const stop: unknown = Reflect.get(window, `${callbackName}_stop`);
        if (typeof stop === "function") Reflect.apply(stop, undefined, []);
        const error: unknown = Reflect.get(window, `${callbackName}_error`);
        Reflect.deleteProperty(window, `${callbackName}_stop`);
        Reflect.deleteProperty(window, `${callbackName}_error`);
        return typeof error === "string" ? error : null;
      }, name);
      if (failure !== null)
        throw new Error(`Acceptance event delivery failed: ${failure}`);
      this.read();
    };
  }
}
