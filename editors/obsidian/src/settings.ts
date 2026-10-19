import { App, PluginSettingTab, Setting } from "obsidian";
import type { AuthMode } from "./auth/auth";
import type OmnigentPlugin from "./main";

export type WorkspaceMode = "vault" | "folder" | "none";

export interface OmnigentSettings {
  /** Empty: auto-discover the local server from `~/.omnigent/local_server.pid`. */
  serverUrl: string;
  authMode: AuthMode;
  /** Bearer for `authMode === "token"`; stored in plaintext plugin data. */
  token: string;
  databricksCliPath: string;
  /** `~/.databrickscfg` profile; empty picks the best profile for the server's host. */
  databricksProfile: string;
  defaultAgentId: string;
  /** Host for new sessions; empty picks this machine's host (or the only online one). */
  defaultHostId: string;
  workspaceMode: WorkspaceMode;
  /** Vault-relative folder for `workspaceMode === "folder"`, e.g. `"Agents"`. */
  workspaceFolder: string;
  /** Upper bound for note text attached as context, in characters. */
  contextCharLimit: number;
  /** Vault folder for generated canvas files. */
  canvasFolder: string;
}

export const DEFAULT_SETTINGS: OmnigentSettings = {
  serverUrl: "",
  authMode: "auto",
  token: "",
  databricksCliPath: "",
  databricksProfile: "",
  defaultAgentId: "",
  defaultHostId: "",
  workspaceMode: "vault",
  workspaceFolder: "",
  contextCharLimit: 40_000,
  canvasFolder: "Omnigent",
};

export class OmnigentSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: OmnigentPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings;
    const save = async (patch: Partial<OmnigentSettings>, reconnect = false) => {
      Object.assign(settings, patch);
      await this.plugin.saveSettings();
      if (reconnect) await this.plugin.reconnect();
    };

    new Setting(containerEl).setName("Server").setHeading();
    new Setting(containerEl)
      .setName("Server URL")
      .setDesc(
        "Leave empty to use the local server started by `omnigent server`. For a hosted server use its API URL, " +
          "e.g. https://<workspace>.cloud.databricks.com/api/2.0/omnigent.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Auto-discover local server")
          .setValue(settings.serverUrl)
          .onChange((value) => save({ serverUrl: value.trim() })),
      );
    new Setting(containerEl)
      .setName("Authentication")
      .setDesc(
        "Automatic uses no credentials for local servers, your `omnigent login` session when present, and the " +
          "Databricks CLI for workspace-hosted servers.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            auto: "Automatic",
            none: "None",
            "databricks-cli": "Databricks CLI",
            token: "Access token",
          })
          .setValue(settings.authMode)
          .onChange(async (value) => {
            await save({ authMode: value as AuthMode });
            this.display();
          }),
      );
    if (settings.authMode === "token") {
      new Setting(containerEl)
        .setName("Access token")
        .setDesc("Stored unencrypted in this vault's plugin data.")
        .addText((text) => {
          text.inputEl.type = "password";
          text.setValue(settings.token).onChange((value) => save({ token: value.trim() }));
        });
    }
    if (settings.authMode === "auto" || settings.authMode === "databricks-cli") {
      new Setting(containerEl)
        .setName("Databricks CLI path")
        .setDesc("Leave empty to look in the usual Homebrew locations.")
        .addText((text) =>
          text
            .setPlaceholder("/opt/homebrew/bin/databricks")
            .setValue(settings.databricksCliPath)
            .onChange((value) => save({ databricksCliPath: value.trim() })),
        );
      new Setting(containerEl)
        .setName("Databricks profile")
        .setDesc(
          "Profile in ~/.databrickscfg to use. Leave empty to pick automatically among the profiles for the server's workspace.",
        )
        .addText((text) =>
          text
            .setPlaceholder("Automatic")
            .setValue(settings.databricksProfile)
            .onChange((value) => save({ databricksProfile: value.trim() })),
        );
    }
    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText("Connect")
        .setCta()
        .onClick(() => this.plugin.reconnect()),
    );

    new Setting(containerEl).setName("New sessions").setHeading();
    new Setting(containerEl)
      .setName("Default agent ID")
      .setDesc("Preselected in the new session dialog, e.g. ag_123. Leave empty to choose each time.")
      .addText((text) =>
        text.setValue(settings.defaultAgentId).onChange((value) => save({ defaultAgentId: value.trim() })),
      );
    new Setting(containerEl)
      .setName("Default host ID")
      .setDesc("Machine that runs new sessions. Leave empty to use this computer's registered host.")
      .addText((text) =>
        text.setValue(settings.defaultHostId).onChange((value) => save({ defaultHostId: value.trim() })),
      );
    new Setting(containerEl)
      .setName("Working directory")
      .setDesc("Where new sessions run. The agent can read and edit notes inside it.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ vault: "Vault root", folder: "Vault folder", none: "Agent default" })
          .setValue(settings.workspaceMode)
          .onChange(async (value) => {
            await save({ workspaceMode: value as WorkspaceMode });
            this.display();
          }),
      );
    if (settings.workspaceMode === "folder") {
      new Setting(containerEl)
        .setName("Working folder")
        .setDesc("Vault-relative folder, e.g. Agents.")
        .addText((text) =>
          text.setValue(settings.workspaceFolder).onChange((value) => save({ workspaceFolder: value.trim() })),
        );
    }

    new Setting(containerEl).setName("Vault").setHeading();
    new Setting(containerEl)
      .setName("Context size limit")
      .setDesc("Maximum characters of note text attached to one message.")
      .addText((text) =>
        text.setValue(String(settings.contextCharLimit)).onChange((value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed > 0) void save({ contextCharLimit: parsed });
        }),
      );
    new Setting(containerEl)
      .setName("Canvas folder")
      .setDesc("Where generated session canvases are saved.")
      .addText((text) =>
        text.setValue(settings.canvasFolder).onChange((value) => save({ canvasFolder: value.trim() || "Omnigent" })),
      );
  }
}
