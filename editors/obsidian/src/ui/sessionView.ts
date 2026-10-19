/**
 * One Omnigent session in a workspace tab: a rendered transcript (Obsidian
 * markdown) or the live terminal (console), pending approvals, and a composer
 * that can pull notes from the vault in as context.
 */
import { Component, ItemView, MarkdownRenderer, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { InboxItem } from "@/lib/inbox";
import type OmnigentPlugin from "../main";
import { SessionController } from "../state/sessionController";
import { NotePickerModal } from "./notePickerModal";
import { renderBlocks } from "./renderBlocks";
import { terminalLabel } from "../api/terminals";
import { splitContext } from "../vault/context";
import { TerminalPane } from "./terminalPane";

export const SESSION_VIEW_TYPE = "omnigent-session";

export type OutputMode = "rendered" | "console";

interface SessionViewState extends Record<string, unknown> {
  sessionId?: string;
  mode?: OutputMode;
}

const LIVE_RENDER_INTERVAL_MS = 150;

export class SessionView extends ItemView {
  sessionId: string | null = null;
  private mode: OutputMode = "rendered";
  private controller: SessionController | null = null;
  private unsubscribe: (() => void) | null = null;
  private transcriptComponent = new Component();
  private liveComponent = new Component();
  private terminal: TerminalPane | null = null;
  private renderedBlocks: unknown = null;
  private liveTimer: number | null = null;

  private sessionTitleEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private modeButtons!: Record<OutputMode, HTMLButtonElement>;
  private stopButton!: HTMLButtonElement;
  private scrollEl!: HTMLElement;
  private transcriptEl!: HTMLElement;
  private pendingEl!: HTMLElement;
  private liveEl!: HTMLElement;
  private consoleEl!: HTMLElement;
  private consoleStatusEl!: HTMLElement;
  private terminalSelect!: HTMLSelectElement;
  private approvalsEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private attachedEl!: HTMLElement;
  /** Vault paths attached to the next message besides `[[links]]` in its text. */
  private attachedPaths: string[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OmnigentPlugin,
  ) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string {
    return SESSION_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.controller?.title ?? "Omnigent session";
  }

  override getIcon(): string {
    return "bot";
  }

  override getState(): Record<string, unknown> {
    return { sessionId: this.sessionId ?? undefined, mode: this.mode } satisfies SessionViewState;
  }

  override async setState(state: SessionViewState, result: ViewStateResult): Promise<void> {
    if (state.mode === "rendered" || state.mode === "console") this.mode = state.mode;
    if (state.sessionId && state.sessionId !== this.sessionId) await this.loadSession(state.sessionId);
    else this.applyMode();
    await super.setState(state, result);
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("omnigent-session-view");

    const header = root.createDiv({ cls: "omnigent-session-header" });
    this.sessionTitleEl = header.createDiv({ cls: "omnigent-session-title", text: "Omnigent session" });
    this.statusEl = header.createDiv({ cls: "omnigent-session-status" });
    const actions = header.createDiv({ cls: "omnigent-session-actions" });
    const toggle = actions.createDiv({ cls: "omnigent-mode-toggle" });
    this.modeButtons = {
      rendered: toggle.createEl("button", { text: "Rendered", attr: { "aria-label": "Show rendered transcript" } }),
      console: toggle.createEl("button", { text: "Console", attr: { "aria-label": "Show live terminal" } }),
    };
    for (const mode of ["rendered", "console"] as const) {
      this.registerDomEvent(this.modeButtons[mode], "click", () => this.setMode(mode));
    }
    this.stopButton = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Stop the agent" } });
    setIcon(this.stopButton, "square");
    this.registerDomEvent(this.stopButton, "click", () => void this.interrupt());
    const openWeb = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Open in Omnigent" } });
    setIcon(openWeb, "external-link");
    this.registerDomEvent(openWeb, "click", () => {
      if (this.sessionId) this.plugin.openInOmnigent(`/c/${encodeURIComponent(this.sessionId)}`);
    });

    this.errorEl = root.createDiv({ cls: ["omnigent-status", "omnigent-error", "omnigent-hidden"] });
    this.scrollEl = root.createDiv({ cls: "omnigent-transcript-scroll" });
    this.transcriptEl = this.scrollEl.createDiv({ cls: "omnigent-transcript" });
    this.pendingEl = this.scrollEl.createDiv({ cls: "omnigent-pending" });
    this.liveEl = this.scrollEl.createDiv({ cls: "omnigent-live" });
    const consoleWrap = root.createDiv({ cls: ["omnigent-console", "omnigent-hidden"] });
    const consoleBar = consoleWrap.createDiv({ cls: "omnigent-console-bar" });
    this.consoleStatusEl = consoleBar.createDiv({ cls: "omnigent-status" });
    this.terminalSelect = consoleBar.createEl("select", { cls: ["dropdown", "omnigent-hidden"], attr: { "aria-label": "Terminal" } });
    this.registerDomEvent(this.terminalSelect, "change", () => void this.attachTerminal(this.terminalSelect.value));
    this.consoleEl = consoleWrap.createDiv({ cls: "omnigent-console-terminal" });
    this.approvalsEl = root.createDiv({ cls: "omnigent-approvals" });

    const composer = root.createDiv({ cls: "omnigent-composer" });
    this.attachedEl = composer.createDiv({ cls: "omnigent-attached" });
    this.inputEl = composer.createEl("textarea", {
      cls: "omnigent-input",
      attr: { placeholder: "Message the agent. Use [[note]] to include a note.", rows: "3" },
    });
    this.registerDomEvent(this.inputEl, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.submit();
      }
    });
    const composerActions = composer.createDiv({ cls: "omnigent-composer-actions" });
    const attachNote = composerActions.createEl("button", { text: "Add note", attr: { "aria-label": "Attach a note as context" } });
    this.registerDomEvent(attachNote, "click", () =>
      new NotePickerModal(this.app, (file) => this.attach(file.path)).open(),
    );
    const attachActive = composerActions.createEl("button", { text: "Add current note" });
    this.registerDomEvent(attachActive, "click", () => {
      const file = this.plugin.lastActiveMarkdownFile();
      if (file) this.attach(file.path);
      else new Notice("Open a note first.");
    });
    const send = composerActions.createEl("button", { cls: "mod-cta", text: "Send" });
    this.registerDomEvent(send, "click", () => void this.submit());

    this.addChild(this.transcriptComponent);
    this.addChild(this.liveComponent);
    this.applyMode();
    if (this.sessionId && !this.controller) await this.loadSession(this.sessionId);
  }

  override async onClose(): Promise<void> {
    this.teardown();
  }

  /** Attach a vault path to the next message. */
  attach(path: string): void {
    if (!this.attachedPaths.includes(path)) this.attachedPaths.push(path);
    this.renderAttached();
  }

  /** Prefill the composer, e.g. from "Ask Omnigent about this note". */
  prefill(text: string): void {
    this.inputEl.value = text;
    this.inputEl.focus();
  }

  private async loadSession(sessionId: string): Promise<void> {
    this.teardown();
    this.sessionId = sessionId;
    const client = await this.plugin.getClient();
    const controller = new SessionController(client, sessionId);
    this.controller = controller;
    this.unsubscribe = controller.subscribe(() => this.render());
    controller.start();
    this.applyMode();
    this.render();
  }

  private teardown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.controller?.stop();
    this.controller = null;
    this.terminal?.dispose();
    this.terminal = null;
    this.renderedBlocks = null;
    if (this.liveTimer !== null) window.clearTimeout(this.liveTimer);
    this.liveTimer = null;
  }

  private setMode(mode: OutputMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.applyMode();
    this.app.workspace.requestSaveLayout();
  }

  private applyMode(): void {
    if (!this.modeButtons) return;
    const consoleMode = this.mode === "console";
    for (const mode of ["rendered", "console"] as const) {
      this.modeButtons[mode].toggleClass("is-active", mode === this.mode);
    }
    this.scrollEl.toggleClass("omnigent-hidden", consoleMode);
    this.consoleEl.parentElement!.toggleClass("omnigent-hidden", !consoleMode);
    if (consoleMode && this.controller && !this.terminal) {
      this.terminal = new TerminalPane(this.consoleEl, this.controller.client, this.controller.sessionId, (message) =>
        this.consoleStatusEl.setText(message),
      );
      void this.attachTerminal();
    } else if (!consoleMode && this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }
  }

  private async attachTerminal(terminalId?: string): Promise<void> {
    const pane = this.terminal;
    if (!pane) return;
    this.consoleStatusEl.setText("Connecting to terminal…");
    try {
      const terminals = await pane.attach(false, terminalId);
      this.terminalSelect.empty();
      for (const terminal of terminals) {
        this.terminalSelect.createEl("option", { value: terminal.id, text: terminalLabel(terminal) });
      }
      if (pane.attachedId) this.terminalSelect.value = pane.attachedId;
      this.terminalSelect.toggleClass("omnigent-hidden", terminals.length < 2);
    } catch (error) {
      this.consoleStatusEl.setText(`Could not attach: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private render(): void {
    const controller = this.controller;
    if (!controller || !this.sessionTitleEl) return;
    if (this.sessionTitleEl.getText() !== controller.title) {
      this.sessionTitleEl.setText(controller.title);
      // updateHeader() refreshes the tab; the view header title is a runtime-only field.
      (this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
      (this as unknown as { titleEl?: HTMLElement }).titleEl?.setText(controller.title);
    }
    const running = controller.status === "running" || controller.status === "launching";
    this.statusEl.setText(
      [controller.status, controller.snapshot?.agent_name, controller.streamConnected ? null : "reconnecting…"]
        .filter(Boolean)
        .join(" · "),
    );
    this.stopButton.toggleClass("omnigent-hidden", !running);
    this.errorEl.setText(controller.error ?? "");
    this.errorEl.toggleClass("omnigent-hidden", !controller.error);

    const stickToBottom = this.scrollEl.scrollHeight - this.scrollEl.scrollTop - this.scrollEl.clientHeight < 80;
    if (this.renderedBlocks !== controller.blocks) {
      this.renderedBlocks = controller.blocks;
      this.removeChild(this.transcriptComponent);
      this.transcriptComponent = this.addChild(new Component());
      renderBlocks(
        { app: this.app, component: this.transcriptComponent, sourcePath: this.plugin.lastActiveMarkdownFile()?.path ?? "" },
        this.transcriptEl,
        controller.blocks,
      );
      if (controller.olderItemsExist) {
        const older = this.transcriptEl.createDiv({ cls: "omnigent-status", text: "Earlier messages are available in " });
        const link = older.createEl("a", { text: "the full Omnigent view", href: "#" });
        link.addEventListener("click", (event) => {
          event.preventDefault();
          this.plugin.openInOmnigent(`/c/${encodeURIComponent(controller.sessionId)}`);
        });
        this.transcriptEl.prepend(older);
      }
    }
    this.pendingEl.empty();
    for (const message of controller.pendingMessages) {
      this.pendingEl.createDiv({
        cls: ["omnigent-message", "omnigent-message-user", "omnigent-sending"],
        text: splitContext(message).text,
      });
    }
    this.scheduleLiveRender();
    this.renderApprovals(controller.approvals);
    if (stickToBottom) this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }

  /** Re-render the streaming tail at most every LIVE_RENDER_INTERVAL_MS. */
  private scheduleLiveRender(): void {
    if (this.liveTimer !== null) return;
    this.liveTimer = window.setTimeout(() => {
      this.liveTimer = null;
      const text = this.controller?.liveText ?? "";
      this.removeChild(this.liveComponent);
      this.liveComponent = this.addChild(new Component());
      this.liveEl.empty();
      if (text) {
        const el = this.liveEl.createDiv({ cls: ["omnigent-message", "omnigent-message-assistant", "omnigent-streaming"] });
        void MarkdownRenderer.render(this.app, text, el, "", this.liveComponent);
      }
    }, LIVE_RENDER_INTERVAL_MS);
  }

  private renderApprovals(approvals: InboxItem[]): void {
    this.approvalsEl.empty();
    for (const item of approvals) {
      const card = this.approvalsEl.createDiv({ cls: "omnigent-approval" });
      card.createDiv({ cls: "omnigent-approval-title", text: item.elicitation.message || "The agent is asking for approval" });
      if (item.elicitation.contentPreview) {
        card.createEl("pre", { cls: "omnigent-pre" }).createEl("code", { text: item.elicitation.contentPreview });
      }
      const buttons = card.createDiv({ cls: "omnigent-approval-actions" });
      if (item.elicitation.mode === "url" || Object.keys(item.elicitation.requestedSchema ?? {}).length > 0) {
        // Forms and URL-mode prompts need the full web UI.
        const open = buttons.createEl("button", { cls: "mod-cta", text: "Answer in Omnigent" });
        open.addEventListener("click", () =>
          this.plugin.openInOmnigent(`/c/${encodeURIComponent(item.row.id)}`),
        );
        continue;
      }
      const accept = buttons.createEl("button", { cls: "mod-cta", text: "Approve" });
      const decline = buttons.createEl("button", { cls: "mod-warning", text: "Deny" });
      const resolve = (action: "accept" | "decline") => {
        accept.disabled = decline.disabled = true;
        this.controller?.resolveApproval(item, action).catch((error: unknown) => {
          accept.disabled = decline.disabled = false;
          new Notice(`Could not answer the approval: ${error instanceof Error ? error.message : String(error)}`);
        });
      };
      accept.addEventListener("click", () => resolve("accept"));
      decline.addEventListener("click", () => resolve("decline"));
    }
  }

  private renderAttached(): void {
    this.attachedEl.empty();
    for (const path of this.attachedPaths) {
      const chip = this.attachedEl.createDiv({ cls: "omnigent-chip", text: path });
      const remove = chip.createSpan({ cls: "omnigent-chip-remove", attr: { "aria-label": `Remove ${path}` } });
      setIcon(remove, "x");
      remove.addEventListener("click", () => {
        this.attachedPaths = this.attachedPaths.filter((candidate) => candidate !== path);
        this.renderAttached();
      });
    }
  }

  private async submit(): Promise<void> {
    const controller = this.controller;
    const text = this.inputEl.value.trim();
    if (!controller || !text) return;
    const attached = this.attachedPaths;
    this.inputEl.value = "";
    this.attachedPaths = [];
    this.renderAttached();
    try {
      await controller.send(await this.plugin.composeMessage(text, attached));
    } catch {
      // Restore the draft so nothing typed is lost; the controller shows the error.
      this.inputEl.value = text;
      this.attachedPaths = attached;
      this.renderAttached();
    }
  }

  private async interrupt(): Promise<void> {
    try {
      await this.controller?.interrupt();
    } catch (error) {
      new Notice(`Could not stop the agent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
