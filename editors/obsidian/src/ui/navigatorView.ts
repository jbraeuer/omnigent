/**
 * Sidebar navigator mirroring the Omnigent desktop sidebar: New session, Inbox,
 * Canvas, projects with their sessions, and the filterable list of unfiled
 * sessions. Rows stay live through the sessions store's updates socket.
 */
import { ItemView, Menu, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import { sessionTitle } from "../api/client";
import type { Project, SessionListItem } from "../api/types";
import type OmnigentPlugin from "../main";
import { matchesFilter, sortedTopLevelSessions, type MoveDirection } from "../state/sessionsStore";
import { ConfirmModal, TextPromptModal } from "./newSessionModal";

export const NAVIGATOR_VIEW_TYPE = "omnigent-navigator";

export class NavigatorView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private query = "";
  private showArchived = false;
  private readonly collapsedProjects = new Set<string>();
  private listEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private inboxBadgeEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OmnigentPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return NAVIGATOR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Omnigent";
  }

  override getIcon(): string {
    return "bot";
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("omnigent-navigator");

    const nav = root.createDiv({ cls: "omnigent-nav" });
    this.navRow(nav, "message-square-plus", "New session", () => this.plugin.openNewSessionDialog({}));
    const inbox = this.navRow(nav, "inbox", "Inbox", () => void this.plugin.openInbox());
    this.inboxBadgeEl = inbox.createSpan({ cls: "omnigent-badge omnigent-hidden" });
    this.navRow(nav, "layout-dashboard", "Canvas", () => void this.plugin.generateCanvases(true));

    this.statusEl = root.createDiv({ cls: "omnigent-connection" });
    const filter = root.createDiv({ cls: "omnigent-filter" });
    const search = filter.createEl("input", {
      cls: "omnigent-search",
      attr: { type: "search", placeholder: "Filter sessions" },
    });
    this.registerDomEvent(search, "input", () => {
      this.query = search.value.trim();
      this.renderList();
    });
    const filterButton = filter.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "Session filters" },
    });
    setIcon(filterButton, "list-filter");
    this.registerDomEvent(filterButton, "click", (event: MouseEvent) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Show archived sessions")
          .setChecked(this.showArchived)
          .onClick(() => {
            this.showArchived = !this.showArchived;
            this.renderList();
          }),
      );
      menu.addItem((item) =>
        item
          .setTitle("Refresh")
          .setIcon("refresh-cw")
          .onClick(() => void this.plugin.store.refresh().catch((error: unknown) => notifyError("Refresh failed", error))),
      );
      menu.showAtMouseEvent(event);
    });

    this.listEl = root.createDiv({ cls: "omnigent-list" });
    this.unsubscribe = this.plugin.store.subscribe(() => this.render());
    this.render();
  }

  override async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private navRow(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
    const row = parent.createDiv({ cls: "omnigent-nav-row", attr: { role: "button", tabindex: "0" } });
    setIcon(row.createSpan({ cls: "omnigent-nav-icon" }), icon);
    row.createSpan({ text: label });
    this.registerDomEvent(row, "click", onClick);
    this.registerDomEvent(row, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") onClick();
    });
    return row;
  }

  private render(): void {
    const { state } = this.plugin.store;
    this.statusEl.empty();
    this.statusEl.toggleClass("omnigent-hidden", state.kind === "connected");
    if (state.kind === "error") {
      this.statusEl.createDiv({ cls: "omnigent-error", text: state.message });
      const retry = this.statusEl.createEl("button", { text: "Retry" });
      retry.addEventListener("click", () => void this.plugin.reconnect());
    } else if (state.kind === "connecting") {
      this.statusEl.setText("Connecting…");
    } else if (state.kind === "disconnected") {
      this.statusEl.setText("Not connected.");
    }
    const inboxCount = this.plugin.store.inboxCount;
    this.inboxBadgeEl.setText(String(inboxCount));
    this.inboxBadgeEl.toggleClass("omnigent-hidden", inboxCount === 0);
    this.renderList();
  }

  private renderList(): void {
    const { store } = this.plugin;
    this.listEl.empty();
    const sessions = sortedTopLevelSessions(store.sessions.values(), this.showArchived).filter((session) =>
      matchesFilter(session, this.query),
    );
    const projectIds = new Set(store.projects.map((project) => project.id));

    const projectsHeader = this.sectionHeader("Projects");
    const addProject = projectsHeader.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "New project" },
    });
    setIcon(addProject, "folder-plus");
    addProject.addEventListener("click", () =>
      new TextPromptModal(this.app, "New project", "", async (name) => {
        await this.plugin.withClient((client) => client.createProject(name));
        await store.refresh();
      }).open(),
    );
    store.projects.forEach((project, index) => {
      const members = sessions.filter((session) => session.project_id === project.id);
      if (this.query && members.length === 0) return;
      this.renderProject(project, members, index, store.projects.length);
    });

    const sessionsHeader = this.sectionHeader("Sessions");
    sessionsHeader.addClass("omnigent-section-sessions");
    const unfiled = sessions.filter((session) => !session.project_id || !projectIds.has(session.project_id));
    if (unfiled.length === 0) {
      this.listEl.createDiv({ cls: "omnigent-empty", text: this.query ? "No matching sessions." : "No sessions yet." });
    }
    for (const session of unfiled) this.renderSession(this.listEl, session, false);
  }

  private sectionHeader(label: string): HTMLElement {
    const header = this.listEl.createDiv({ cls: "omnigent-section-header" });
    header.createSpan({ text: label });
    return header;
  }

  private renderProject(project: Project, members: SessionListItem[], index: number, count: number): void {
    const collapsed = this.collapsedProjects.has(project.id) && !this.query;
    const row = this.listEl.createDiv({ cls: "omnigent-project-row", attr: { role: "button", tabindex: "0" } });
    setIcon(row.createSpan({ cls: "omnigent-nav-icon" }), collapsed ? "folder" : "folder-open");
    row.createSpan({ cls: "omnigent-row-title", text: project.name });
    const actions = row.createDiv({ cls: "omnigent-row-actions" });
    this.rowButton(actions, "message-square-plus", "New session in project", () =>
      this.plugin.openNewSessionDialog({ projectId: project.id }),
    );
    this.rowButton(actions, "more-horizontal", "Project actions", (button) =>
      this.showBelow(this.projectMenu(project, index, count), button),
    );
    row.addEventListener("click", () => {
      if (this.collapsedProjects.has(project.id)) this.collapsedProjects.delete(project.id);
      else this.collapsedProjects.add(project.id);
      this.renderList();
    });
    row.addEventListener("contextmenu", (event) => this.projectMenu(project, index, count).showAtMouseEvent(event));
    if (collapsed) return;
    const children = this.listEl.createDiv({ cls: "omnigent-project-children" });
    for (const session of members) this.renderSession(children, session, true);
  }

  /** Hover action button inside a row; clicks don't toggle or open the row itself. */
  private rowButton(parent: HTMLElement, icon: string, label: string, onClick: (button: HTMLElement) => void): void {
    const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
    setIcon(button, icon);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick(button);
    });
  }

  /** Open a menu below its button (also right for keyboard activation, which has no pointer position). */
  private showBelow(menu: Menu, button: HTMLElement): void {
    const rect = button.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  private projectMenu(project: Project, index: number, count: number): Menu {
    const { plugin } = this;
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("New session")
        .setIcon("message-square-plus")
        .onClick(() => plugin.openNewSessionDialog({ projectId: project.id })),
    );
    menu.addItem((item) =>
      item
        .setTitle("Rename project")
        .setIcon("pencil")
        .onClick(() =>
          new TextPromptModal(this.app, "Rename project", project.name, async (name) => {
            await plugin.withClient((client) => client.updateProject(project.id, { name }));
            await plugin.store.refresh();
          }).open(),
        ),
    );
    menu.addItem((item) =>
      item
        .setTitle("Project settings")
        .setIcon("settings-2")
        .onClick(() => plugin.openProjectSettings(project)),
    );
    if (count > 1) {
      const moves: Array<[MoveDirection, string, boolean]> = [
        ["up", "Move up", index > 0],
        ["down", "Move down", index < count - 1],
        ["top", "Move to top", index > 0],
        ["bottom", "Move to bottom", index < count - 1],
      ];
      for (const [direction, title, enabled] of moves) {
        if (!enabled) continue;
        menu.addItem((item) =>
          item
            .setTitle(title)
            .setIcon(direction === "up" || direction === "top" ? "arrow-up" : "arrow-down")
            .onClick(() =>
              void plugin.store.moveProject(project.id, direction).catch((error: unknown) => {
                notifyError("Could not move the project", error);
                void plugin.store.refresh();
              }),
            ),
        );
      }
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Delete project")
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() =>
          new ConfirmModal(
            this.app,
            `Delete "${project.name}"?`,
            "Its sessions are kept and move to Sessions.",
            "Delete",
            async () => {
              await plugin.withClient((client) => client.deleteProject(project.id));
              await plugin.store.refresh();
            },
          ).open(),
        ),
    );
    return menu;
  }

  private renderSession(parent: HTMLElement, session: SessionListItem, nested: boolean): void {
    const row = parent.createDiv({
      cls: ["omnigent-session-row", nested ? "is-nested" : ""],
      attr: { role: "button", tabindex: "0", "data-session-id": session.id },
    });
    if (this.plugin.isSessionOpenAndActive(session.id)) row.addClass("is-active");
    if (session.archived) row.addClass("is-archived");
    const status = session.status ?? "idle";
    row.createSpan({ cls: ["omnigent-status-dot", `is-${status}`], attr: { "aria-label": status } });
    row.createSpan({ cls: "omnigent-row-title", text: sessionTitle(session) });
    const approvals = session.pending_elicitations_count ?? 0;
    if (approvals > 0) row.createSpan({ cls: "omnigent-badge", text: String(approvals) });
    else if (session.viewer_unread) row.createSpan({ cls: "omnigent-unread-dot", attr: { "aria-label": "Unread" } });
    this.rowButton(row.createDiv({ cls: "omnigent-row-actions" }), "more-horizontal", "Session actions", (button) =>
      this.showBelow(this.sessionMenu(session), button),
    );
    row.addEventListener("click", (event) => void this.plugin.openSession(session.id, { newTab: event.metaKey || event.ctrlKey }));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void this.plugin.openSession(session.id);
    });
    row.addEventListener("contextmenu", (event) => this.sessionMenu(session).showAtMouseEvent(event));
  }

  private sessionMenu(session: SessionListItem): Menu {
    const { plugin } = this;
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Open").setIcon("message-square").onClick(() => void plugin.openSession(session.id)),
    );
    menu.addItem((item) =>
      item
        .setTitle("Open console")
        .setIcon("terminal")
        .onClick(() => void plugin.openSession(session.id, { mode: "console" })),
    );
    menu.addItem((item) =>
      item
        .setTitle("Open in Omnigent")
        .setIcon("external-link")
        .onClick(() => plugin.openInOmnigent(`/c/${encodeURIComponent(session.id)}`)),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Rename")
        .setIcon("pencil")
        .onClick(() =>
          new TextPromptModal(this.app, "Rename session", sessionTitle(session), async (title) => {
            plugin.store.upsert(await plugin.withClient((client) => client.updateSession(session.id, { title })));
          }).open(),
        ),
    );
    for (const project of plugin.store.projects) {
      if (project.id === session.project_id) continue;
      menu.addItem((item) =>
        item
          .setTitle(`Move to ${project.name}`)
          .setIcon("folder-input")
          .onClick(() => void this.update(session, { project_id: project.id })),
      );
    }
    if (session.project_id) {
      menu.addItem((item) =>
        item
          .setTitle("Remove from project")
          .setIcon("folder-minus")
          .onClick(() => void this.update(session, { project_id: "" })),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle(session.archived ? "Unarchive" : "Archive")
        .setIcon("archive")
        .onClick(() => void this.update(session, { archived: !session.archived })),
    );
    return menu;
  }

  private async update(session: SessionListItem, patch: Record<string, unknown>): Promise<void> {
    try {
      const updated = await this.plugin.withClient((client) => client.updateSession(session.id, patch));
      // The server unfiles on `project_id: ""`; rows represent "no project" as null.
      const local = patch.project_id === "" ? { ...patch, project_id: null } : patch;
      this.plugin.store.upsert({ ...session, ...local, ...updated });
    } catch (error) {
      notifyError("Could not update the session", error);
    }
  }
}

export function notifyError(prefix: string, error: unknown): void {
  new Notice(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
}
