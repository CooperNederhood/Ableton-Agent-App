import { describe, expect, it, vi } from "vitest";

import {
  abletonToolMetadata,
  type ToolApprovalRequest,
} from "@ableton-agent/tools";

import type { ApprovalRequest } from "../contracts.js";
import {
  type ApprovalAttribution,
  ApprovalCoordinator,
  ApprovalPolicyController,
} from "./approvals.js";

const baseRequest = {
  metadata: abletonToolMetadata.find(
    (metadata) => metadata.risk === "reversible",
  )!,
  arguments: { tempo: 128 },
};

function requestFor(agentInstanceId?: string): ToolApprovalRequest {
  return {
    ...baseRequest,
    ...(agentInstanceId === undefined ? {} : { agentInstanceId }),
  };
}

describe("ApprovalPolicyController", () => {
  it.each(["always", "risky"] as const)(
    "auto-approves attributed YOLO agents under %s",
    async (policy) => {
      const publish = vi.fn(() => false);
      const approvals = new ApprovalCoordinator();
      approvals.setPublisher(publish);
      const controller = new ApprovalPolicyController(
        policy,
        approvals,
        new Set(["agent-a"]),
      );

      await expect(controller.request(requestFor("agent-a"))).resolves.toBe(
        true,
      );
      await expect(controller.request(requestFor("agent-b"))).resolves.toBe(
        false,
      );
      await expect(controller.request(requestFor())).resolves.toBe(false);
      expect(publish).toHaveBeenCalledTimes(2);
    },
  );

  it("gives global policies precedence over YOLO overrides", async () => {
    const approvals = new ApprovalCoordinator();
    const controller = new ApprovalPolicyController(
      "never",
      approvals,
      new Set(["agent-a"]),
    );

    await expect(controller.request(requestFor("agent-a"))).resolves.toBe(
      false,
    );

    controller.setPolicy("approve-all");
    await expect(controller.request(requestFor("agent-b"))).resolves.toBe(true);
    expect(controller.askForReads()).toBe(false);
  });

  it("keeps stable callbacks while replacing policy and override providers", async () => {
    let autoApproved = new Set(["agent-a"]);
    const controller = new ApprovalPolicyController(
      "risky",
      new ApprovalCoordinator(),
      () => autoApproved,
    );
    const requestCallback = controller.request;
    const readCallback = controller.askForReads;

    await expect(requestCallback(requestFor("agent-a"))).resolves.toBe(true);
    autoApproved = new Set(["agent-b"]);
    await expect(requestCallback(requestFor("agent-b"))).resolves.toBe(true);

    controller.setAutoApprovedAgentInstanceIds(new Set(["agent-c"]));
    await expect(requestCallback(requestFor("agent-c"))).resolves.toBe(true);
    expect(readCallback()).toBe(false);
    controller.setPolicy("always");
    expect(controller.request).toBe(requestCallback);
    expect(controller.askForReads).toBe(readCallback);
    expect(readCallback()).toBe(true);
  });

  it("removes overrides without changing existing prompt behavior", async () => {
    const approvals = new ApprovalCoordinator();
    approvals.setPublisher(vi.fn(() => false));
    const controller = new ApprovalPolicyController(
      "risky",
      approvals,
      new Set(["agent-a"]),
    );

    await expect(controller.request(requestFor("agent-a"))).resolves.toBe(true);
    controller.setAutoApprovedAgentInstanceIds(new Set());
    await expect(controller.request(requestFor("agent-a"))).resolves.toBe(
      false,
    );
  });

  it("does not resolve pending approvals when an override is removed", async () => {
    const approvals = new ApprovalCoordinator();
    approvals.setPublisher(vi.fn(() => true));
    const agentA = approvals.request(requestFor("agent-a"));
    const agentB = approvals.request(requestFor("agent-b"));
    const controller = new ApprovalPolicyController(
      "risky",
      approvals,
      new Set(["agent-a", "agent-b"]),
    );

    controller.setAutoApprovedAgentInstanceIds(new Set(["agent-b"]));

    expect(approvals.pendingCount).toBe(2);
    approvals.resolveAll(false);
    await expect(agentA).resolves.toBe(false);
    await expect(agentB).resolves.toBe(false);
  });

  it("applies global transitions to all pending requests", async () => {
    const approvals = new ApprovalCoordinator();
    approvals.setPublisher(vi.fn(() => true));
    const controller = new ApprovalPolicyController("risky", approvals);
    const approvePending = controller.request(requestFor("agent-a"));

    expect(approvals.pendingCount).toBe(1);
    controller.setPolicy("approve-all");

    await expect(approvePending).resolves.toBe(true);
    controller.setPolicy("risky");
    const denyPending = controller.request(requestFor("agent-b"));
    expect(approvals.pendingCount).toBe(1);
    controller.setPolicy("never");
    await expect(denyPending).resolves.toBe(false);
    expect(approvals.pendingCount).toBe(0);
  });
});

describe("ApprovalCoordinator", () => {
  it("publishes and stores request attribution", async () => {
    const approvals = new ApprovalCoordinator();
    let approvalId = "";
    const publish = vi.fn(
      (approval: ApprovalRequest, attribution: ApprovalAttribution) => {
        approvalId = approval.id;
        expect(attribution).toEqual({
          agentInstanceId: "agent-a",
          sdkSessionId: "session-a",
        });
        return true;
      },
    );
    approvals.setPublisher(publish);

    const pending = approvals.request({
      ...requestFor("agent-a"),
      sdkSessionId: "session-a",
    });
    approvals.resolve(approvalId, "approve");

    await expect(pending).resolves.toBe(true);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("approves pending requests only for targeted agents", async () => {
    const approvals = new ApprovalCoordinator();
    approvals.setPublisher(vi.fn(() => true));
    const agentA = approvals.request(requestFor("agent-a"));
    const agentB = approvals.request(requestFor("agent-b"));
    const unattributed = approvals.request(requestFor());

    expect(approvals.approveForAgentInstanceIds(new Set(["agent-a"]))).toBe(1);
    await expect(agentA).resolves.toBe(true);
    expect(approvals.pendingCount).toBe(2);

    approvals.denyAll();
    await expect(agentB).resolves.toBe(false);
    await expect(unattributed).resolves.toBe(false);
  });

  it("approves already-pending requests when an override is enabled", async () => {
    const approvals = new ApprovalCoordinator();
    approvals.setPublisher(vi.fn(() => true));
    const controller = new ApprovalPolicyController("risky", approvals);
    const agentA = controller.request(requestFor("agent-a"));
    const agentB = controller.request(requestFor("agent-b"));
    const unattributed = controller.request(requestFor());

    controller.setAutoApprovedAgentInstanceIds(new Set(["agent-a"]));

    await expect(agentA).resolves.toBe(true);
    expect(approvals.pendingCount).toBe(2);
    approvals.resolveAll(false);
    await expect(agentB).resolves.toBe(false);
    await expect(unattributed).resolves.toBe(false);
  });
});
