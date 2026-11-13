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
    uploadFile: vi.fn(async (_sessionId: string, file: { name: string }) => ({
      type: "input_image",
      file_id: `file_${file.name}`,
      filename: file.name,
    })),
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

  it("uploads pasted images and sends them after the text", async () => {
    const client = fakeClient(async () => snapshot());
    const controller = new SessionController(client, "conv_1");
    const image = { name: "image.png", type: "image/png", data: new Uint8Array([1]) };
    await controller.send("Add these colors", [image]);
    expect(client.uploadFile).toHaveBeenCalledWith("conv_1", image);
    expect(client.sendMessage).toHaveBeenCalledWith("conv_1", [
      { type: "input_text", text: "Add these colors" },
      { type: "input_image", file_id: "file_image.png", filename: "image.png" },
    ]);
  });

  it("sends an image-only message without an empty text block", async () => {
    const client = fakeClient(async () => snapshot());
    const controller = new SessionController(client, "conv_1");
    await controller.send("", [{ name: "image.png", type: "image/png", data: new Uint8Array([1]) }]);
    expect(client.sendMessage).toHaveBeenCalledWith("conv_1", [
      { type: "input_image", file_id: "file_image.png", filename: "image.png" },
    ]);
  });

  it("does not send the message when an upload fails", async () => {
    const client = fakeClient(async () => snapshot());
    (client.uploadFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Unsupported attachment type"));
    const controller = new SessionController(client, "conv_1");
    await expect(controller.send("hi", [{ name: "a.bin", type: "", data: new Uint8Array([1]) }])).rejects.toThrow(
      "Unsupported attachment type",
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
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

  it("drops repeated and late native preview chunks", () => {
    const controller = new SessionController(fakeClient(async () => snapshot()), "conv_1");
    const delta = (delta: string, index: number, messageId = "msg_1") =>
      controller.handleEvent({ type: "text_delta", delta, messageId, index } as never);
    delta("1. First?", 0);
    delta("\n2. Second?", 1);
    delta("\n2. Second?", 1);
    expect(controller.liveText).toBe("1. First?\n2. Second?");

    controller.handleEvent({ type: "message_done", messageId: "msg_1" } as never);
    delta("\n2. Second?", 2);
    expect(controller.liveText).toBe("");

    delta("Next message", 0, "msg_2");
    expect(controller.liveText).toBe("Next message");
    controller.handleEvent({ type: "session_status", conversationId: "conv_1", status: "idle" });
    expect(controller.liveText).toBe("");
  });

  it("reads, switches and follows Claude Code's permission mode", async () => {
    const claude = (mode: string) =>
      snapshot({
        labels: { "omnigent.wrapper": "claude-code-native-ui", "omnigent.claude_native.permission_mode": mode },
      });
    const client = fakeClient(async () => claude("default"));
    const updateSession = vi.fn(async () => claude("plan"));
    (client as unknown as { updateSession: typeof updateSession }).updateSession = updateSession;
    const controller = new SessionController(client, "conv_1");
    expect(controller.supportsPermissionMode).toBe(false);

    controller.applySnapshot(claude("default"), ITEMS);
    expect(controller.supportsPermissionMode).toBe(true);
    expect(controller.permissionMode).toBe("default");

    await controller.setPermissionMode("plan");
    expect(updateSession).toHaveBeenCalledWith("conv_1", { permission_mode: "plan" });
    expect(controller.permissionMode).toBe("plan");

    // Shift+Tab in the terminal is reported live.
    controller.handleEvent({ type: "session_permission_mode", conversationId: "conv_1", permissionMode: "auto" });
    expect(controller.permissionMode).toBe("auto");

    updateSession.mockRejectedValueOnce(new Error("runner offline"));
    await expect(controller.setPermissionMode("acceptEdits")).rejects.toThrow("runner offline");
    expect(controller.permissionMode).toBe("auto");
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
    await controller.resolveApproval(controller.approvals[0]!, "accept", { allow_directories: true });
    expect(client.resolveElicitation).toHaveBeenCalledWith("conv_child", "elicit_1", "accept", { allow_directories: true }, undefined);
    expect(controller.approvals).toEqual([]);
  });

  it("keeps a question from the live stream that a snapshot missed until it resolves", () => {
    const controller = new SessionController(fakeClient(async () => snapshot({ pending_elicitations: [] })), "conv_1");
    controller.applySnapshot(snapshot({ status: "running", pending_elicitations: [] }), ITEMS);
    const questions = [{ question: "Rollout?", multiSelect: false, options: [{ label: "You first" }] }];
    controller.handleEvent({
      type: "elicitation_request",
      elicitationId: "elicit_q",
      message: "",
      phase: "",
      policyName: "",
      contentPreview: "",
      requestedSchema: {},
      askUserQuestion: { questions },
    } as never);
    controller.applySnapshot(snapshot({ status: "running", pending_elicitations: [] }), ITEMS);
    expect(controller.approvals.map((item) => [item.elicitation.elicitationId, item.resolveSessionId])).toEqual([["elicit_q", "conv_1"]]);
    expect(controller.statusLabel).toBe("waiting for your answer");
    controller.handleEvent({ type: "elicitation_resolved", elicitationId: "elicit_q" });
    expect(controller.approvals).toEqual([]);
  });

  it("offers /clear on native sessions the server can clear and follows the new session", async () => {
    const native = (wrapper: string) => snapshot({ labels: { "omnigent.wrapper": wrapper } });
    const client = fakeClient(async () => native("codex-native-ui"));
    const serverInfo = vi.fn(async () => ({ session_event_types: ["clear", "message"] }));
    const clearContext = vi.fn(async () => ({ queued: false }));
    Object.assign(client, { serverInfo, clearContext });
    const controller = new SessionController(client, "conv_1");
    controller.applySnapshot(native("codex-native-ui"), ITEMS);
    expect(controller.supportsClear).toBe(false);

    await controller.loadServerInfo();
    expect(controller.supportsClear).toBe(true);
    controller.applySnapshot(native("some-other-wrapper"), ITEMS);
    expect(controller.supportsClear).toBe(false);

    await controller.clearContext();
    expect(clearContext).toHaveBeenCalledWith("conv_1");

    // A late event from another session's stream, or a self-target, is not a redirect.
    controller.handleEvent({ type: "session_superseded", conversationId: "conv_other", targetConversationId: "conv_2", reason: "clear" });
    controller.handleEvent({ type: "session_superseded", conversationId: "conv_1", targetConversationId: "conv_1", reason: "clear" });
    expect(controller.supersededBy).toBeNull();
    controller.handleEvent({ type: "session_superseded", conversationId: "conv_1", targetConversationId: "conv_2", reason: "clear" });
    expect(controller.supersededBy).toBe("conv_2");
  });

  it("keeps /clear off on servers that don't list the clear control", async () => {
    const client = fakeClient(async () => snapshot());
    Object.assign(client, { serverInfo: vi.fn(async () => ({})) });
    const controller = new SessionController(client, "conv_1");
    controller.applySnapshot(snapshot({ labels: { "omnigent.wrapper": "claude-code-native-ui" } }), ITEMS);
    await controller.loadServerInfo();
    expect(controller.supportsClear).toBe(false);
  });

  it("says why a running session is parked", () => {
    const controller = new SessionController(fakeClient(async () => snapshot()), "conv_1");
    controller.applySnapshot(snapshot({ status: "running", pending_elicitations: [] }), ITEMS);
    expect(controller.statusLabel).toBe("running");

    controller.handleEvent({ type: "session_status", conversationId: "conv_1", status: "running", blockedOn: "permission prompt" });
    expect(controller.statusLabel).toBe("waiting for approval in the console");
    controller.handleEvent({ type: "session_status", conversationId: "conv_1", status: "running", blockedOn: "plan review" });
    expect(controller.statusLabel).toBe("waiting in the console (plan review)");

    // A prompt mirrored as a card is answered here, not in the console.
    controller.applySnapshot(snapshot({ status: "running" }), ITEMS);
    expect(controller.statusLabel).toBe("waiting for your approval");

    controller.handleEvent({ type: "session_status", conversationId: "conv_1", status: "idle" });
    expect(controller.statusLabel).toBe("idle");
    expect(controller.blockedOn).toBeNull();
  });

  it("hands the agent's open-file requests to the view", () => {
    const controller = new SessionController(fakeClient(async () => snapshot()), "conv_1");
    controller.handleEvent({ type: "ui_open_file", path: "ignored-without-a-view.md" });
    const opened: string[] = [];
    controller.onOpenFileRequest = (path) => opened.push(path);
    controller.handleEvent({ type: "ui_open_file", path: "Notes/Plan.md" });
    expect(opened).toEqual(["Notes/Plan.md"]);
  });
});
