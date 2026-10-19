/**
 * Project settings: the defaults new sessions in the project start with
 * (agent, host, working directory), stored in the project's `config` like the
 * web Project settings dialog.
 */
import { App, Modal, Notice, Setting } from "obsidian";
import type { Agent, Host, Project, ProjectConfig } from "../api/types";
import { mergeProjectConfig } from "../state/projectConfig";

export class ProjectSettingsModal extends Modal {
  constructor(
    app: App,
    private readonly project: Project,
    private readonly choices: { agents: Agent[]; hosts: Host[]; vaultPath: string | null },
    private readonly onSave: (config: ProjectConfig) => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle(`${this.project.name} settings`);
    contentEl.createEl("p", { cls: "setting-item-description", text: "Defaults for new sessions in this project." });
    const edits = {
      agent_id: this.project.config?.agent_id ?? "",
      host_id: this.project.config?.host_id ?? "",
      workspace: this.project.config?.workspace ?? "",
    };
    new Setting(contentEl).setName("Agent").addDropdown((dropdown) => {
      dropdown.addOption("", "Choose each time");
      for (const agent of this.choices.agents) dropdown.addOption(agent.id, agent.name);
      dropdown.setValue(edits.agent_id).onChange((value) => (edits.agent_id = value));
    });
    new Setting(contentEl).setName("Host").addDropdown((dropdown) => {
      dropdown.addOption("", "Server default");
      for (const host of this.choices.hosts.filter((candidate) => !candidate.sandbox_provider)) {
        dropdown.addOption(host.host_id, `${host.name ?? host.host_id}${host.status === "online" ? "" : " (offline)"}`);
      }
      dropdown.setValue(edits.host_id).onChange((value) => (edits.host_id = value));
    });
    let workspaceInput: HTMLInputElement | null = null;
    const workspace = new Setting(contentEl)
      .setName("Working directory")
      .setDesc("Absolute path on the host.")
      .addText((text) => {
        workspaceInput = text.inputEl;
        text.setValue(edits.workspace).onChange((value) => (edits.workspace = value));
      });
    const vaultPath = this.choices.vaultPath;
    if (vaultPath) {
      workspace.addButton((button) =>
        button.setButtonText("Use this vault").onClick(() => {
          edits.workspace = vaultPath;
          if (workspaceInput) workspaceInput.value = vaultPath;
        }),
      );
    }
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText("Save")
        .setCta()
        .onClick(async () => {
          if (edits.workspace.trim() && !edits.host_id) {
            new Notice("Choose a host for the working directory.");
            return;
          }
          button.setDisabled(true);
          try {
            await this.onSave(mergeProjectConfig(this.project.config, edits));
            this.close();
          } catch (error) {
            new Notice(`Could not save: ${error instanceof Error ? error.message : String(error)}`);
            button.setDisabled(false);
          }
        }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
