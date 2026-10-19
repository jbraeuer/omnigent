import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem } from "@/lib/conversationItems";
import type { OmnigentClient } from "../api/client";
import type { SessionSnapshot } from "../api/types";
import { SessionController } from "./sessionController";

const ITEMS = [
  {
    id: "msg_user",
    response_id: "resp_1",
    type: "message",
    role: "user",
    status: "completed",
    content: [{ type: "input_text", text: "Summarize [[Roadmap]]" }],
  },
  {
    id: "msg_asst",
    response_id: "resp_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Here is the **summary**." }],
  },
] as ConversationItem[];

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "conv_1",
    title: "Tokenization effort details",
    status: "idle",
    agent_name: "claude-native",
    updated_at: 10,
    pending_elicitations: [
      {
        type: "response.elicitation_request",
        elicitation_id: "elicit_1",
        method: "elicitation/create",
        params: { mode: "form", message: "Run rm -rf build?", requestedSchema: {}, target_session_id: "conv_child" },
      },
    ],
    ...overrides,
  };
}

function fakeClient(getSession: () => Promise<SessionSnapshot>): OmnigentClient {
  return {
    getSession: vi.fn(getSession),
    listSessionItems: vi.fn(async () => ({ items: ITEMS, hasMore: false })),
    sendMessage: vi.fn(async () => ({ queued: true })),
    resolveElicitation: vi.fn(async () => ({ queued: true })),
  } as unknown as OmnigentClient;
}

describe("SessionController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders the snapshot through the shared transcript reducer and parses approvals", () => {
    const controller = new SessionController(fakeClient(async () => snapshot()), "conv_1");
    controller.applySnapshot(snapshot(), ITEMS);
    expect(controller.title).toBe("Tokenization effort details");
    expect(controller.blocks.map((block) => block.type)).toEqual(["user_message", "text_done"]);
    expect(controller.approvals).toHaveLength(1);
    // Mirrored sub-agent prompts must be resolved on the child session.
    expect(controller.approvals[0]!.resolveSessionId).toBe("conv_child");
    expect(controller.approvals[0]!.elicitation.message).toBe("Run rm -rf build?");
  });

  it("shows a sent message until the snapshot contains it", async () => {
    const client = fakeClient(async () => snapshot());
    const controller = new SessionController(client, "conv_1");
    await controller.send("  Summarize [[Roadmap]]  ");
    expect(client.sendMessage).toHaveBeenCalledWith("conv_1", [{ type: "input_text", text: "Summarize [[Roadmap]]" }]);
    expect(controller.pendingMessages).toEqual(["Summarize [[Roadmap]]"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(controller.pendingMessages).toEqual([]);
  });

  it("drops the pending bubble and reports the error when sending fails", async () => {
    const client = fakeClient(async () => snapshot());
    (client.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no runner bound"));
    const controller = new SessionController(client, "conv_1");
    await expect(controller.send("hi")).rejects.toThrow("no runner bound");
    expect(controller.pendingMessages).toEqual([]);
    expect(controller.error).toBe("no runner bound");
  });

  it("accumulates streamed text and refreshes once the message commits", async () => {
    const client = fakeClient(async () => snapshot());
    const controller = new SessionController(client, "conv_1");
    controller.handleEvent({ type: "response_created" } as never);
    controller.handleEvent({ type: "text_delta", delta: "Here is " } as never);
    controller.handleEvent({ type: "text_delta", delta: "the" } as never);
    expect(controller.liveText).toBe("Here is the");
    expect(client.getSession).not.toHaveBeenCalled();

    controller.handleEvent({ type: "message_done" } as never);
    controller.handleEvent({ type: "response_completed" } as never);
    expect(controller.liveText).toBe("");
    await vi.advanceTimersByTimeAsync(300);
    // Bursts of commit events coalesce into a single snapshot fetch.
    expect(client.getSession).toHaveBeenCalledTimes(1);
  });

  it("tracks status and title edges", () => {
    const controller = new SessionController(fakeClient(async () => snapshot()), "conv_1");
    controller.applySnapshot(snapshot(), ITEMS);
    controller.handleEvent({ type: "session_status", conversationId: "conv_1", status: "running" });
    controller.handleEvent({ type: "session_title", conversationId: "conv_1", title: "Renamed" });
    expect(controller.status).toBe("running");
    expect(controller.title).toBe("Renamed");
  });

  it("resolves approvals against the owning session", async () => {
    const client = fakeClient(async () => snapshot({ pending_elicitations: [] }));
    const controller = new SessionController(client, "conv_1");
    controller.applySnapshot(snapshot(), ITEMS);
    await controller.resolveApproval(controller.approvals[0]!, "accept");
    expect(client.resolveElicitation).toHaveBeenCalledWith("conv_child", "elicit_1", "accept");
    expect(controller.approvals).toEqual([]);
  });
});
