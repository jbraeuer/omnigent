/**
 * Inbox: approvals waiting across sessions plus sessions with unread output,
 * newest first under recency headers. Approvals come from each session's
 * snapshot (`pending_elicitations`), refetched when its pending count changes —
 * the same composition as the web Inbox page, via the shared `inbox.ts` helpers.
 */
import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { collectInboxItems, groupInboxEntries, type InboxItem, type InboxSource } from "@/lib/inbox";
import { sessionTitle } from "../api/client";
import type { SessionListItem } from "../api/types";
import type OmnigentPlugin from "../main";

export const INBOX_VIEW_TYPE = "omnigent-inbox";

type Entry =
  | { kind: "approval"; at: number; item: InboxItem }
  | { kind: "unread"; at: number; session: SessionListItem };

export class InboxView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  /** Snapshot pending prompts per session, keyed by `${id}:${count}:${updated_at}` freshness. */
  private readonly sources = new Map<string, { key: string; source: InboxSource }>();
  private listEl!: HTMLElement;
  private loading = new Set<string>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OmnigentPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return INBOX_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Omnigent inbox";
  }

  override getIcon(): string {
    return "inbox";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("omnigent-inbox");
    this.listEl = this.contentEl.createDiv({ cls: "omnigent-inbox-list" });
    this.unsubscribe = this.plugin.store.subscribe(() => this.sync());
    this.sync();
  }

  override async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Fetch snapshots for sessions whose pending count or update time changed, then render. */
  private sync(): void {
    const rows = [...this.plugin.store.sessions.values()].filter(
      (row) => !row.archived && (row.pending_elicitations_count ?? 0) > 0,
    );
    const wanted = new Set(rows.map((row) => row.id));
    for (const id of [...this.sources.keys()]) if (!wanted.has(id)) this.sources.delete(id);
    for (const row of rows) {
      const key = `${row.pending_elicitations_count}:${row.updated_at}`;
      if (this.sources.get(row.id)?.key === key || this.loading.has(row.id)) continue;
      this.loading.add(row.id);
      void this.plugin
        .withClient((client) => client.getSession(row.id))
        .then((snapshot) => {
          this.sources.set(row.id, {
            key,
            source: { row: row as never, pendingElicitations: snapshot.pending_elicitations ?? [] },
          });
        })
        .catch(() => {
          // Leave the row out; the next list change retries.
        })
        .finally(() => {
          this.loading.delete(row.id);
          this.render();
        });
    }
    this.render();
  }

  private render(): void {
    this.listEl.empty();
    const approvals = collectInboxItems([...this.sources.values()].map((entry) => entry.source));
    const unread = [...this.plugin.store.sessions.values()].filter(
      (row) => !row.archived && row.viewer_unread && !row.parent_session_id,
    );
    const entries: Entry[] = [
      ...approvals.map((item): Entry => ({ kind: "approval", at: (item.row as SessionListItem).updated_at ?? 0, item })),
      ...unread.map((session): Entry => ({ kind: "unread", at: session.updated_at ?? session.created_at ?? 0, session })),
    ];
    if (entries.length === 0) {
      this.listEl.createDiv({
        cls: "omnigent-empty",
        text: this.loading.size > 0 ? "Loading…" : "Nothing needs your attention.",
      });
      return;
    }
    for (const group of groupInboxEntries(entries)) {
      this.listEl.createDiv({ cls: "omnigent-section-header", text: group.label });
      for (const entry of group.entries) {
        if (entry.kind === "approval") this.renderApproval(entry.item);
        else this.renderUnread(entry.session);
      }
    }
  }

  private renderApproval(item: InboxItem): void {
    const row = item.row as SessionListItem;
    const card = this.listEl.createDiv({ cls: "omnigent-approval" });
    card.createDiv({ cls: "omnigent-inbox-session", text: sessionTitle(row) });
    card.createDiv({ cls: "omnigent-approval-title", text: item.elicitation.message || "Approval requested" });
    if (item.elicitation.contentPreview) {
      card.createEl("pre", { cls: "omnigent-pre" }).createEl("code", { text: item.elicitation.contentPreview });
    }
    const actions = card.createDiv({ cls: "omnigent-approval-actions" });
    const needsFullUi =
      item.elicitation.mode === "url" || Object.keys(item.elicitation.requestedSchema ?? {}).length > 0;
    if (!needsFullUi) {
      const accept = actions.createEl("button", { cls: "mod-cta", text: "Approve" });
      const decline = actions.createEl("button", { cls: "mod-warning", text: "Deny" });
      const resolve = async (action: "accept" | "decline") => {
        accept.disabled = decline.disabled = true;
        try {
          await this.plugin.withClient((client) =>
            client.resolveElicitation(item.resolveSessionId, item.elicitation.elicitationId, action),
          );
          card.remove();
        } catch (error) {
          accept.disabled = decline.disabled = false;
          new Notice(`Could not answer: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      accept.addEventListener("click", () => void resolve("accept"));
      decline.addEventListener("click", () => void resolve("decline"));
    }
    const open = actions.createEl("button", { text: needsFullUi ? "Answer in session" : "Open session" });
    open.addEventListener("click", () => void this.plugin.openSession(row.id));
  }

  private renderUnread(session: SessionListItem): void {
    const row = this.listEl.createDiv({ cls: "omnigent-session-row", attr: { role: "button", tabindex: "0" } });
    row.createSpan({ cls: "omnigent-unread-dot" });
    row.createSpan({ cls: "omnigent-row-title", text: sessionTitle(session) });
    row.createSpan({ cls: "omnigent-row-meta", text: session.agent_name ?? "" });
    row.addEventListener("click", () => void this.plugin.openSession(session.id));
  }
}
