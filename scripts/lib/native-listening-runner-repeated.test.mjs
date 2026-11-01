import { expect, it, vi } from "vitest";
import { nativeRepeatedSessionSteps } from "./native-listening-runner.mjs";

async function runNativeRepeatedSessionSteps({ passes, step }) {
  for (const index of nativeRepeatedSessionSteps(passes)) await step(index);
}

const pass = (id, stage = "completed") => ({ job: { passId: id, stage } });

it("runs exactly two reset/capture boundaries after verified completion", async () => {
  const passes = [pass("one")];
  const step = vi.fn(async (index) => {
    passes.push(pass(`next-${index}`));
  });
  await runNativeRepeatedSessionSteps({ passes, step });
  expect(step.mock.calls).toEqual([[1], [2]]);
  expect(passes).toHaveLength(3);
});

it.each(["failed", "cancelled", "partial", "queued"])(
  "never resets or captures after a %s first pass",
  async (stage) => {
    const step = vi.fn();
    await expect(
      runNativeRepeatedSessionSteps({
        passes: [pass("one", stage)],
        step,
      }),
    ).rejects.toThrow(/verified completed/);
    expect(step).not.toHaveBeenCalled();
  },
);

it.each(["reset-denied", "capture-failed", "context-rewritten", "cancelled"])(
  "propagates %s unchanged and never invokes a later pass",
  async (message) => {
    const error = new Error(message);
    const passes = [pass("one")];
    const step = vi.fn(async () => {
      throw error;
    });
    await expect(runNativeRepeatedSessionSteps({ passes, step })).rejects.toBe(
      error,
    );
    expect(step).toHaveBeenCalledTimes(1);
    expect(passes).toHaveLength(1);
  },
);

it("rejects missing or failed next captures without retry", async () => {
  for (const stage of [undefined, "failed"]) {
    const passes = [pass("one")];
    const step = vi.fn(async () => {
      if (stage) passes.push(pass("two", stage));
    });
    await expect(
      runNativeRepeatedSessionSteps({ passes, step }),
    ).rejects.toThrow(/verified completed/);
    expect(step).toHaveBeenCalledTimes(1);
  }
});
