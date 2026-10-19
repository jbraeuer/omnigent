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
import { isTextBlock, type AnyBlock } from "@/lib/blocks";
import type { ConversationItem } from "@/lib/conversationItems";
import type { StreamEvent } from "@/lib/events";
import { collectInboxItems, type InboxItem } from "@/lib/inbox";
import { itemsToBlocks } from "@/lib/itemsToBlocks";
import type { SseStreamResult } from "@/lib/sse";
import type { OmnigentClient } from "../api/client";
import type { SessionSnapshot, SessionStatus } from "../api/types";
import { Observable } from "./observable";

const REFRESH_DEBOUNCE_MS = 250;
const MAX_STREAM_BACKOFF_MS = 15_000;

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
  /** Assistant text streamed since the last committed message. */
  liveText = "";
  /** Messages sent but not yet visible in the snapshot. */
  pendingMessages: string[] = [];
  status: SessionStatus = "idle";
  error: string | null = null;
  streamConnected = false;
  /** Whether the transcript shows only the newest page of a longer history. */
  olderItemsExist = false;

  private abort: AbortController | null = null;
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

  start(): void {
    if (this.abort) return;
    this.abort = new AbortController();
    void this.streamLoop(this.abort.signal);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  async send(rawText: string): Promise<void> {
    const text = rawText.trim();
    this.pendingMessages = [...this.pendingMessages, text];
    this.error = null;
    this.emit();
    try {
      await this.client.sendMessage(this.sessionId, [{ type: "input_text", text }]);
    } catch (error) {
      this.pendingMessages = this.pendingMessages.filter((message) => message !== text);
      this.fail(error);
      throw error;
    }
    this.scheduleRefresh();
  }

  async interrupt(): Promise<void> {
    await this.client.interrupt(this.sessionId);
  }

  async resolveApproval(item: InboxItem, action: "accept" | "decline"): Promise<void> {
    await this.client.resolveElicitation(item.resolveSessionId, item.elicitation.elicitationId, action);
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
    this.approvals = collectInboxItems([
      {
        row: snapshot as never,
        pendingElicitations: snapshot.pending_elicitations ?? [],
      },
    ]);
    if (snapshot.status) this.status = snapshot.status;
    const committedUserTexts = new Set(userTexts(this.blocks));
    this.pendingMessages = this.pendingMessages.filter((message) => !committedUserTexts.has(message));
    this.error = null;
    this.emit();
  }

  /** Visible for tests: react to one live stream event. */
  handleEvent(event: StreamEvent): void {
    switch (event.type) {
      case "text_delta":
        this.liveText += event.delta;
        this.emit();
        return;
      case "session_status":
        this.status = event.status;
        if (event.status !== "running") this.scheduleRefresh();
        this.emit();
        return;
      case "session_title":
        if (this.snapshot) this.snapshot = { ...this.snapshot, title: event.title };
        this.emit();
        return;
      case "response_created":
        this.liveText = "";
        this.emit();
        return;
      default:
        break;
    }
    if (REFRESH_EVENTS.has(event.type)) {
      if (event.type === "message_done") this.liveText = "";
      this.scheduleRefresh();
    }
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

function userTexts(blocks: AnyBlock[]): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type !== "user_message") continue;
    for (const part of block.content) if (isTextBlock(part)) texts.push(part.text.trim());
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
