import { parentPort } from "node:worker_threads";

parentPort.on("message", (message) => {
  if (message.method === "open") {
    parentPort.postMessage({
      id: message.id,
      ok: true,
      value: { schemaVersion: 1 },
    });
  }
});
