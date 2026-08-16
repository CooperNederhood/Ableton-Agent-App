import { describe, expect, it, vi } from "vitest";

import { abletonToolMetadata } from "@ableton-agent/tools";

import { ApprovalCoordinator, ApprovalPolicyController } from "./approvals.js";

const request = {
  metadata: abletonToolMetadata.find(
    (metadata) => metadata.risk === "reversible",
  )!,
  arguments: { tempo: 128 },
};

describe("ApprovalPolicyController", () => {
  it("switches approve-all and deny-all behavior immediately", async () => {
    const approvals = new ApprovalCoordinator();
    const controller = new ApprovalPolicyController("risky", approvals);

    await expect(controller.request(request)).resolves.toBe(false);

    controller.setPolicy("approve-all");
    await expect(controller.request(request)).resolves.toBe(true);
    expect(controller.askForReads()).toBe(false);

    controller.setPolicy("never");
    await expect(controller.request(request)).resolves.toBe(false);
  });

  it("keeps stable callbacks while dynamically changing read policy", () => {
    const controller = new ApprovalPolicyController(
      "risky",
      new ApprovalCoordinator(),
    );
    const requestCallback = controller.request;
    const readCallback = controller.askForReads;

    expect(readCallback()).toBe(false);
    controller.setPolicy("always");
    expect(controller.request).toBe(requestCallback);
    expect(controller.askForReads).toBe(readCallback);
    expect(readCallback()).toBe(true);
  });

  it("resolves pending prompts when switching to approve-all", async () => {
    const approvals = new ApprovalCoordinator();
    approvals.setPublisher(vi.fn(() => true));
    const controller = new ApprovalPolicyController("risky", approvals);
    const pending = controller.request(request);

    expect(approvals.pendingCount).toBe(1);
    controller.setPolicy("approve-all");

    await expect(pending).resolves.toBe(true);
    expect(approvals.pendingCount).toBe(0);
  });
});
