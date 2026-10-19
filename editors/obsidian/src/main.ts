/**
 * Omnigent for Obsidian: browse projects and sessions, chat with agents
 * (rendered transcript or live terminal), answer approvals, and use the vault
 * as context and as the agents' working directory.
 */
import { FileSystemAdapter, MarkdownView, Notice, Plugin, TFile, normalizePath, type WorkspaceLeaf } from "obsidian";
import { isLoopbackUrl } from "./auth/auth";
import { sessionTitle, type OmnigentClient } from "./api/client";
import type { Project, SessionListItem } from "./api/types";
import { buildCanvas, canvasFileName, sessionsByProject, type CanvasData } from "./canvas/canvasFile";
import { createClient, readLocalHostId } from "./connection";
import { DEFAULT_SETTINGS, OmnigentSettingTab, type OmnigentSettings } from "./settings";
import { SessionsStore, sortedTopLevelSessions } from "./state/sessionsStore";
import { FULL_OMNIGENT_VIEW_TYPE, FullOmnigentView } from "./ui/fullOmnigentView";
import { INBOX_VIEW_TYPE, InboxView } from "./ui/inboxView";
import { NAVIGATOR_VIEW_TYPE, NavigatorView, notifyError } from "./ui/navigatorView";
import { NewSessionModal, type NewSessionChoices } from "./ui/newSessionModal";
import { ProjectSettingsModal } from "./ui/projectSettingsModal";
import { SESSION_VIEW_TYPE, SessionView, type OutputMode } from "./ui/sessionView";
import { composeMessageWithContext, extractWikiLinks, type ContextNote } from "./vault/context";
import { pickHost, resolveWorkspacePath } from "./vault/workspace";

export default class OmnigentPlugin extends Plugin {
  override settings: OmnigentSettings = { ...DEFAULT_SETTINGS };
  readonly store = new SessionsStore();
  private client: Promise<OmnigentClient> | null = null;
  private lastMarkdownFile: TFile | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(NAVIGATOR_VIEW_TYPE, (leaf) => new NavigatorView(leaf, this));
    this.registerView(SESSION_VIEW_TYPE, (leaf) => new SessionView(leaf, this));
    this.registerView(INBOX_VIEW_TYPE, (leaf) => new InboxView(leaf, this));
    this.registerView(FULL_OMNIGENT_VIEW_TYPE, (leaf) => new FullOmnigentView(leaf));
    this.addSettingTab(new OmnigentSettingTab(this.app, this));
    this.addRibbonIcon("bot", "Open Omnigent", () => void this.activateNavigator());
    this.registerCommands();
    this.registerObsidianProtocolHandler("omnigent", (params) => {
      if (params.session) void this.openSession(params.session);
      else void this.activateNavigator();
    });
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView && leaf.view.file) this.lastMarkdownFile = leaf.view.file;
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Ask Omnigent about this note")
            .setIcon("bot")
            .onClick(() => this.openNewSessionDialog({ message: `[[${file.basename}]]\n\n` })),
        );
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      void this.reconnect();
      if (this.app.workspace.getLeavesOfType(NAVIGATOR_VIEW_TYPE).length === 0) void this.activateNavigator(false);
    });
  }

  override onunload(): void {
    this.store.disconnect();
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<OmnigentSettings> | null) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private registerCommands(): void {
    this.addCommand({ id: "open-navigator", name: "Open sessions sidebar", callback: () => void this.activateNavigator() });
    this.addCommand({ id: "new-session", name: "New session", callback: () => this.openNewSessionDialog({}) });
    this.addCommand({ id: "open-inbox", name: "Open inbox", callback: () => void this.openInbox() });
    this.addCommand({
      id: "generate-canvas",
      name: "Update session canvases",
      callback: () => void this.generateCanvases(true),
    });
    this.addCommand({
      id: "open-web-ui",
      name: "Open full Omnigent",
      callback: () => this.openInOmnigent("/"),
    });
    this.addCommand({ id: "reconnect", name: "Reconnect to server", callback: () => void this.reconnect() });
    this.addCommand({
      id: "ask-about-note",
      name: "Ask about current note in a new session",
      editorCheckCallback: (checking, _editor, view) => {
        if (!view.file) return false;
        if (!checking) this.openNewSessionDialog({ message: `[[${view.file.basename}]]\n\n` });
        return true;
      },
    });
    this.addCommand({
      id: "send-selection",
      name: "Send selection to the open session",
      editorCheckCallback: (checking, editor, view) => {
        const selection = editor.getSelection();
        const session = this.mostRecentSessionView();
        if (!selection || !session) return false;
        if (!checking) {
          const source = view.file ? ` (from [[${view.file.basename}]])` : "";
          session.prefill(`${selection.includes("\n") ? `\n\`\`\`\n${selection}\n\`\`\`` : `"${selection}"`}${source}\n\n`);
          void this.app.workspace.revealLeaf(session.leaf);
        }
        return true;
      },
    });
    this.addCommand({
      id: "attach-current-note",
      name: "Attach current note to the open session",
      checkCallback: (checking) => {
        const file = this.lastActiveMarkdownFile();
        const session = this.mostRecentSessionView();
        if (!file || !session) return false;
        if (!checking) {
          session.attach(file.path);
          void this.app.workspace.revealLeaf(session.leaf);
        }
        return true;
      },
    });
  }

  /** Lazily create the client for the current settings (discovering the local server if needed). */
  getClient(): Promise<OmnigentClient> {
    this.client ??= createClient(this.settings.serverUrl, {
      mode: this.settings.authMode,
      token: this.settings.token,
      databricksCliPath: this.settings.databricksCliPath,
      databricksProfile: this.settings.databricksProfile,
    }).catch((error: unknown) => {
      this.client = null;
      throw error;
    });
    return this.client;
  }

  async withClient<T>(action: (client: OmnigentClient) => Promise<T>): Promise<T> {
    return action(await this.getClient());
  }

  /** Rebuild the client from settings and reconnect the live session list. */
  async reconnect(): Promise<void> {
    this.client = null;
    try {
      await this.store.connect(await this.getClient());
    } catch (error) {
      this.store.fail(error instanceof Error ? error.message : String(error));
    }
  }

  lastActiveMarkdownFile(): TFile | null {
    const active = this.app.workspace.getActiveFile();
    if (active?.extension === "md") return active;
    return this.lastMarkdownFile;
  }

  async activateNavigator(reveal = true): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(NAVIGATOR_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeftLeaf(false);
      await leaf?.setViewState({ type: NAVIGATOR_VIEW_TYPE, active: true });
    }
    if (leaf && reveal) await workspace.revealLeaf(leaf);
  }

  async openInbox(): Promise<void> {
    const { workspace } = this.app;
    const leaf = workspace.getLeavesOfType(INBOX_VIEW_TYPE)[0] ?? workspace.getLeaf("tab");
    await leaf.setViewState({ type: INBOX_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  private sessionLeaves(): WorkspaceLeaf[] {
    return this.app.workspace.getLeavesOfType(SESSION_VIEW_TYPE);
  }

  private mostRecentSessionView(): SessionView | null {
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (leaf?.view instanceof SessionView) return leaf.view;
    const first = this.sessionLeaves()[0]?.view;
    return first instanceof SessionView ? first : null;
  }

  isSessionOpenAndActive(sessionId: string): boolean {
    const view = this.app.workspace.getActiveViewOfType(SessionView);
    return view?.sessionId === sessionId;
  }

  /** Focus the session's tab, reusing an open one; otherwise open a new tab. */
  async openSession(sessionId: string, options: { newTab?: boolean; mode?: OutputMode } = {}): Promise<void> {
    const { workspace } = this.app;
    const existing = this.sessionLeaves().find(
      (leaf) => leaf.view instanceof SessionView && leaf.view.sessionId === sessionId,
    );
    const leaf = existing ?? workspace.getLeaf("tab");
    const state: Record<string, unknown> = { sessionId };
    if (options.mode) state.mode = options.mode;
    await leaf.setViewState({ type: SESSION_VIEW_TYPE, active: true, state });
    await workspace.revealLeaf(leaf);
  }

  /** Open a web UI route: embedded for local servers, in the browser for hosted ones. */
  openInOmnigent(route: string): void {
    void this.withClient(async (client) => {
      const url = client.webUrl(route);
      if (!isLoopbackUrl(client.baseUrl)) {
        window.open(url);
        return;
      }
      const leaf =
        this.app.workspace.getLeavesOfType(FULL_OMNIGENT_VIEW_TYPE)[0] ?? this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: FULL_OMNIGENT_VIEW_TYPE, active: true, state: { url } });
      await this.app.workspace.revealLeaf(leaf);
    }).catch((error: unknown) => notifyError("Could not open Omnigent", error));
  }

  /** Inline `[[links]]` in `text` plus `extraPaths` as note context. */
  async composeMessage(text: string, extraPaths: string[] = []): Promise<string> {
    const sourcePath = this.lastActiveMarkdownFile()?.path ?? "";
    const files: TFile[] = [];
    const add = (file: TFile | null) => {
      if (file && file.extension === "md" && !files.includes(file)) files.push(file);
    };
    for (const link of extractWikiLinks(text)) {
      add(this.app.metadataCache.getFirstLinkpathDest(link, sourcePath));
    }
    for (const path of extraPaths) {
      const file = this.app.vault.getFileByPath(normalizePath(path));
      add(file);
    }
    const notes: ContextNote[] = await Promise.all(
      files.map(async (file) => ({ path: file.path, content: await this.app.vault.cachedRead(file) })),
    );
    return composeMessageWithContext(text, notes, this.settings.contextCharLimit);
  }

  private vaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  openProjectSettings(project: Project): void {
    void this.withClient(async (client) => {
      const [agents, hosts] = await Promise.all([client.listAgents(), client.listHosts().catch(() => [])]);
      new ProjectSettingsModal(this.app, project, { agents, hosts, vaultPath: this.vaultBasePath() }, async (config) => {
        await client.updateProject(project.id, { config });
        await this.store.refresh();
      }).open();
    }).catch((error: unknown) => notifyError("Could not load project settings", error));
  }

  openNewSessionDialog(prefill: { projectId?: string; message?: string }): void {
    void this.withClient(async (client) => {
      const [agents, hosts, localHostId] = await Promise.all([
        client.listAgents(),
        client.listHosts().catch(() => []),
        readLocalHostId(client.baseUrl),
      ]);
      // A project's stored defaults win over the plugin's.
      const projectConfig = this.store.projects.find((project) => project.id === prefill.projectId)?.config ?? {};
      const host = pickHost(hosts, projectConfig.host_id ?? this.settings.defaultHostId, localHostId);
      let workspace: string | undefined = projectConfig.workspace;
      if (!workspace) {
        try {
          workspace = resolveWorkspacePath(this.vaultBasePath(), this.settings.workspaceMode, this.settings.workspaceFolder);
        } catch (error) {
          notifyError("Working folder setting", error);
        }
      }
      new NewSessionModal(
        this.app,
        {
          agents,
          projects: this.store.projects,
          hosts,
          agentId: projectConfig.agent_id ?? this.settings.defaultAgentId,
          projectId: prefill.projectId ?? null,
          hostId: host?.host_id ?? null,
          workspace: host ? workspace : undefined,
          message: prefill.message ?? "",
        },
        (choices) => this.startSession(choices),
      ).open();
    }).catch((error: unknown) => notifyError("Could not load agents", error));
  }

  private async startSession(choices: NewSessionChoices): Promise<void> {
    const client = await this.getClient();
    const session = await client.createSession({
      agent_id: choices.agentId,
      ...(choices.projectId ? { project_id: choices.projectId } : {}),
      ...(choices.hostId ? { host_id: choices.hostId } : {}),
      ...(choices.hostId && choices.workspace ? { workspace: choices.workspace } : {}),
    });
    this.store.upsert(session);
    const projectAgent = this.store.projects.find((project) => project.id === choices.projectId)?.config?.agent_id;
    // Remember the last picked agent, unless it merely came from the project's defaults.
    if (choices.agentId !== this.settings.defaultAgentId && choices.agentId !== projectAgent) {
      this.settings.defaultAgentId = choices.agentId;
      await this.saveSettings();
    }
    await this.openSession(session.id);
    if (choices.message.trim()) {
      await client.sendMessage(session.id, [{ type: "input_text", text: await this.composeMessage(choices.message.trim()) }]);
    }
  }

  /** Write one `.canvas` per project (plus "Main") and optionally open the first. */
  async generateCanvases(open: boolean): Promise<void> {
    if (this.store.state.kind !== "connected") {
      new Notice("Connect to an Omnigent server first.");
      return;
    }
    const folder = normalizePath(this.settings.canvasFolder || "Omnigent");
    if (!this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
    const projects = new Map(this.store.projects.map((project) => [project.id, project.name]));
    const groups = sessionsByProject(sortedTopLevelSessions(this.store.sessions.values(), false));
    if (!groups.has(null)) groups.set(null, []);
    let first: TFile | null = null;
    // "Main" last, so it ends up as the canvas that opens.
    const ordered = [...groups].sort(([a], [b]) => Number(a === null) - Number(b === null));
    for (const [projectId, sessions] of ordered) {
      const name = projectId === null ? "Main" : (projects.get(projectId) ?? projectId);
      const path = normalizePath(`${folder}/${canvasFileName(name)}.canvas`);
      const existingFile = this.app.vault.getFileByPath(path);
      let existing: CanvasData | null = null;
      if (existingFile) {
        try {
          existing = JSON.parse(await this.app.vault.read(existingFile)) as CanvasData;
        } catch {
          existing = null;
        }
      }
      const data = JSON.stringify(
        buildCanvas(sessions, (session: SessionListItem) => sessionTitle(session), existing),
        null,
        "\t",
      );
      let file = existingFile;
      if (file) await this.app.vault.modify(file, data);
      else file = await this.app.vault.create(path, data);
      // Open the "Main" canvas, like the web Canvas page does by default.
      if (projectId === null || !first) first = file;
    }
    new Notice(`Updated ${groups.size} Omnigent canvas${groups.size === 1 ? "" : "es"} in ${folder}.`);
    if (open && first) await this.app.workspace.getLeaf("tab").openFile(first);
  }
}
