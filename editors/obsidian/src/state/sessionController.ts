/**
 * View model for one open session.
 *
 * The committed items (`GET /v1/sessions/{id}/items`, newest page) are the
 * source of truth for the transcript, rendered through the web client's
 * `itemsToBlocks`; the snapshot supplies status, title and pending prompts. The SSE stream
 * only supplies the in-flight text tail and signals when committed items changed,
 * which triggers a debounced snapshot refresh. This follows the server's
 * reconnect contract (subscribe first, then snapshot) without client-side dedupe.
 */
import { askUserQuestionPayloadOf } from "@/lib/askUserQuestion";
import { isTextBlock, type AnyBlock } from "@/lib/blocks";
import { claudePermissionModeFromSession, isClaudeNativeSession } from "@/lib/claudePermissionMode";
import type { ConversationItem } from "@/lib/conversationItems";
import { TERMINAL_PROMPT_BLOCKED_ON, type StreamEvent } from "@/lib/events";
import { collectInboxItems, type InboxItem } from "@/lib/inbox";
import { itemsToBlocks } from "@/lib/itemsToBlocks";
import { nativeCodingAgentForWrapper, WRAPPER_LABEL_KEY } from "@/lib/nativeCodingAgents";
import type { SseStreamResult } from "@/lib/sse";
import type { InputContent, OmnigentClient, UploadFile } from "../api/client";
import type { SessionSnapshot, SessionStatus } from "../api/types";
import { Observable } from "./observable";

const REFRESH_DEBOUNCE_MS = 250;
const MAX_STREAM_BACKOFF_MS = 15_000;

/** Native harnesses whose runner can type their own `/clear`. */
const CLEARABLE_HARNESSES = new Set(["claude-native", "codex-native"]);

/** Stream events that mean the committed transcript or pending prompts changed. */
const REFRESH_EVENTS = new Set<StreamEvent["type"]>([
  "message_done",
  "tool_call",
  "tool_result",
  "native_tool_call",
  "reasoning_done",
  "terminal_command",
  "slash_command",
  "output_file_done",
  "response_completed",
  "response_failed",
  "response_incomplete",
  "response_cancelled",
  "error",
  "policy_denied",
  "elicitation_request",
  "elicitation_resolved",
  "session_input_consumed",
  "session_interrupted",
  "compaction_completed",
]);

export class SessionController extends Observable {
  snapshot: SessionSnapshot | null = null;
  blocks: AnyBlock[] = [];
  approvals: InboxItem[] = [];
  /** Prompts seen on the live stream; kept until resolved, since a snapshot can miss them. */
  private liveApprovals = new Map<string, InboxItem>();
  /** Assistant text streamed since the last committed message. */
  liveText = "";
  /** Messages sent but not yet visible in the snapshot. */
  pendingMessages: string[] = [];
  status: SessionStatus = "idle";
  error: string | null = null;
  streamConnected = false;
  /** Claude Code's permission mode (`plan`, `acceptEdits`, …), when the session reports one. */
  permissionMode: string | null = null;
  /** Whether the transcript shows only the newest page of a longer history. */
  olderItemsExist = false;
  /** The session a native `/clear` moved this session's terminal to; the view follows it. */
  supersededBy: string | null = null;
  /** What a running terminal agent is parked on, e.g. `"permission prompt"`, when it says. */
  blockedOn: string | null = null;
  /** Receives the agent's transient requests to show a workspace-relative file. */
  onOpenFileRequest: ((path: string) => void) | null = null;
  /** Whether the server accepts the `clear` control (from `GET /v1/info`). */
  private serverAcceptsClear = false;

  private abort: AbortController | null = null;
  /** Native preview stream (claude-native etc.) currently shown in `liveText`. */
  private liveMessageId: string | null = null;
  private liveChunkIndex = -1;
  /** Native messages already committed; their late or replayed chunks are dropped. */
  private readonly finishedMessageIds = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshQueued = false;

  constructor(
    readonly client: OmnigentClient,
    readonly sessionId: string,
  ) {
    super();
  }

  get title(): string {
    return this.snapshot?.title?.trim() || this.snapshot?.agent_name || this.sessionId;
  }

  /** Header status: why a running session isn't moving, else its status. */
  get statusLabel(): string {
    if (this.status !== "running") return this.status;
    if (this.approvals.length > 0) {
      return this.approvals.some((item) => askUserQuestionPayloadOf(item.elicitation) !== null)
        ? "waiting for your answer"
        : "waiting for your approval";
    }
    if (this.blockedOn === "permission prompt") return "waiting for approval in the console";
    if (this.blockedOn === TERMINAL_PROMPT_BLOCKED_ON) return "may need input in the console";
    if (this.blockedOn) return `waiting in the console (${this.blockedOn})`;
    return this.status;
  }

  /** Whether `/clear` can run the harness's own clear (claude-native or codex-native). */
  get supportsClear(): boolean {
    const harness = nativeCodingAgentForWrapper(this.snapshot?.labels?.[WRAPPER_LABEL_KEY])?.harness;
    return this.serverAcceptsClear && harness !== undefined && CLEARABLE_HARNESSES.has(harness);
  }

  /** Whether the session runs Claude Code in a terminal, whose permission mode can be switched. */
  get supportsPermissionMode(): boolean {
    return isClaudeNativeSession(this.snapshot);
  }

  start(): void {
    if (this.abort) return;
    this.abort = new AbortController();
    void this.streamLoop(this.abort.signal);
    void this.loadServerInfo();
  }

  /** Visible for tests: learn which session controls the server accepts; older servers lack the list. */
  async loadServerInfo(): Promise<void> {
    try {
      const info = await this.client.serverInfo();
      this.serverAcceptsClear = info.session_event_types?.includes("clear") ?? false;
      this.emit();
    } catch {
      // Without the list, `/clear` stays a plain message to the harness.
    }
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** Post a user message; `files` are uploaded first and sent as image/file blocks. */
  async send(rawText: string, files: readonly UploadFile[] = []): Promise<void> {
    const text = rawText.trim();
    this.pendingMessages = [...this.pendingMessages, text];
    this.error = null;
    this.emit();
    try {
      const content: InputContent[] = [];
      for (const file of files) {
        // Sequential, so a failed upload stops before later ones are stored.
        content.push(await this.client.uploadFile(this.sessionId, file));
      }
      if (text || content.length === 0) content.unshift({ type: "input_text", text });
      await this.client.sendMessage(this.sessionId, content);
    } catch (error) {
      this.pendingMessages = this.pendingMessages.filter((message) => message !== text);
      this.fail(error);
      throw error;
    }
    this.scheduleRefresh();
  }

  /** Switch Claude Code's permission mode; the server reports the mode the terminal landed on. */
  async setPermissionMode(mode: string): Promise<void> {
    const previous = this.permissionMode;
    this.permissionMode = mode;
    this.emit();
    try {
      const snapshot = await this.client.updateSession(this.sessionId, { permission_mode: mode });
      this.permissionMode = permissionModeOf(snapshot) ?? mode;
    } catch (error) {
      this.permissionMode = previous;
      throw error;
    } finally {
      this.emit();
    }
  }

  async interrupt(): Promise<void> {
    await this.client.interrupt(this.sessionId);
  }

  /** Clear the agent's context; the harness continues in a new session (see {@link supersededBy}). */
  async clearContext(): Promise<void> {
    this.error = null;
    try {
      await this.client.clearContext(this.sessionId);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async resolveApproval(
    item: InboxItem,
    action: "accept" | "decline",
    content?: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await this.client.resolveElicitation(item.resolveSessionId, item.elicitation.elicitationId, action, content, meta);
    this.liveApprovals.delete(item.elicitation.elicitationId);
    this.approvals = this.approvals.filter((candidate) => candidate !== item);
    this.emit();
    this.scheduleRefresh();
  }

  /** Fetch the snapshot now; concurrent calls coalesce into one trailing refresh. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        const [snapshot, page] = await Promise.all([
          this.client.getSession(this.sessionId),
          this.client.listSessionItems(this.sessionId),
        ]);
        this.applySnapshot(snapshot, page.items, page.hasMore);
      } catch (error) {
        this.fail(error);
      } finally {
        this.refreshing = null;
      }
    })();
    await this.refreshing;
    if (this.refreshQueued) {
      this.refreshQueued = false;
      await this.refresh();
    }
  }

  /** Visible for tests: fold a snapshot and its newest items into the view model. */
  applySnapshot(snapshot: SessionSnapshot, items: ConversationItem[], olderItemsExist = false): void {
    this.snapshot = snapshot;
    this.olderItemsExist = olderItemsExist;
    this.blocks = itemsToBlocks(items);
    this.approvals = this.withLiveApprovals(
      collectInboxItems([{ row: snapshot as never, pendingElicitations: snapshot.pending_elicitations ?? [] }]),
    );
    if (snapshot.status) this.status = snapshot.status;
    if (this.status !== "running") this.blockedOn = null;
    this.permissionMode = permissionModeOf(snapshot) ?? this.permissionMode;
    const committedUserTexts = new Set(userTexts(this.blocks));
    this.pendingMessages = this.pendingMessages.filter((message) => !committedUserTexts.has(message));
    this.error = null;
    this.emit();
  }

  /** `fromSnapshot` plus live prompts it lacks (a snapshot served by another replica can miss them). */
  private withLiveApprovals(fromSnapshot: InboxItem[]): InboxItem[] {
    const ids = new Set(fromSnapshot.map((item) => item.elicitation.elicitationId));
    return [...fromSnapshot, ...[...this.liveApprovals.values()].filter((item) => !ids.has(item.elicitation.elicitationId))];
  }

  /** Visible for tests: react to one live stream event. */
  handleEvent(event: StreamEvent): void {
    switch (event.type) {
      case "text_delta":
        if (!this.acceptLiveDelta(event.messageId, event.index)) return;
        this.liveText += event.delta;
        this.emit();
        return;
      case "session_status":
        this.status = event.status;
        this.blockedOn = event.status === "running" ? (event.blockedOn ?? null) : null;
        if (event.status !== "running") {
          // The turn is over; its committed items replace any preview tail.
          this.clearLiveText();
          this.scheduleRefresh();
        }
        this.emit();
        return;
      case "session_permission_mode":
        this.permissionMode = event.permissionMode;
        this.emit();
        return;
      case "session_title":
        if (this.snapshot) this.snapshot = { ...this.snapshot, title: event.title };
        this.emit();
        return;
      case "response_created":
        this.clearLiveText();
        this.emit();
        return;
      case "ui_open_file":
        this.onOpenFileRequest?.(event.path);
        return;
      case "elicitation_request":
        if (this.snapshot) {
          const item: InboxItem = {
            row: this.snapshot as never,
            resolveSessionId: event.targetSessionId ?? this.sessionId,
            elicitation: event,
          };
          this.liveApprovals.set(event.elicitationId, item);
          this.approvals = this.withLiveApprovals(this.approvals);
          this.emit();
        }
        this.scheduleRefresh();
        return;
      case "elicitation_resolved":
        this.liveApprovals.delete(event.elicitationId);
        this.approvals = this.approvals.filter((item) => item.elicitation.elicitationId !== event.elicitationId);
        this.emit();
        this.scheduleRefresh();
        return;
      case "session_superseded":
        // Live-only; a later open shows the notice the server appended instead.
        if (event.conversationId !== this.sessionId || event.targetConversationId === this.sessionId) return;
        this.supersededBy = event.targetConversationId;
        this.emit();
        return;
      default:
        break;
    }
    if (REFRESH_EVENTS.has(event.type)) {
      if (event.type === "message_done") {
        if (event.messageId !== undefined) this.finishedMessageIds.add(event.messageId);
        this.clearLiveText();
      }
      this.scheduleRefresh();
    }
  }

  /**
   * Whether a text delta extends the preview. Native deltas carry a message id and
   * chunk index: a new id starts a fresh preview, and repeated chunks or chunks of an
   * already committed message are dropped so they cannot pile up under the transcript.
   */
  private acceptLiveDelta(messageId: string | undefined, index: number | undefined): boolean {
    if (messageId === undefined) return true;
    if (this.finishedMessageIds.has(messageId)) return false;
    if (messageId !== this.liveMessageId) {
      this.liveText = "";
      this.liveMessageId = messageId;
      this.liveChunkIndex = -1;
    }
    if (index !== undefined) {
      if (index <= this.liveChunkIndex) return false;
      this.liveChunkIndex = index;
    }
    return true;
  }

  private clearLiveText(): void {
    this.liveText = "";
    this.liveMessageId = null;
    this.liveChunkIndex = -1;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  private async streamLoop(signal: AbortSignal): Promise<void> {
    let backoffMs = 1_000;
    while (!signal.aborted) {
      const result: SseStreamResult = { sawDone: false };
      try {
        const events = this.client.streamSession(this.sessionId, signal, result)[Symbol.asyncIterator]();
        // Subscribe first, then snapshot, so nothing between the two is lost.
        const first = events.next();
        this.streamConnected = true;
        await this.refresh();
        for (let next = await first; !next.done; next = await events.next()) {
          backoffMs = 1_000;
          this.handleEvent(next.value);
        }
      } catch (error) {
        if (signal.aborted) return;
        this.fail(error);
      }
      this.streamConnected = false;
      this.emit();
      if (signal.aborted) return;
      await sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, MAX_STREAM_BACKOFF_MS);
    }
  }

  private fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.emit();
  }
}

function permissionModeOf(snapshot: SessionSnapshot): string | null {
  return claudePermissionModeFromSession({
    labels: snapshot.labels,
    terminalLaunchArgs: snapshot.terminal_launch_args,
  });
}

function userTexts(blocks: AnyBlock[]): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type !== "user_message") continue;
    const parts = block.content.filter(isTextBlock);
    // An attachment-only message matches the empty pending text it was sent with.
    if (parts.length === 0) texts.push("");
    for (const part of parts) texts.push(part.text.trim());
  }
  return texts;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
