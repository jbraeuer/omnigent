/**
 * New session dialog: agent, project, host and working directory (defaults to
 * the vault), plus the first message.
 */
import { App, Modal, Notice, Setting } from "obsidian";
import type { Agent, Host, Project } from "../api/types";

export interface NewSessionChoices {
  agentId: string;
  projectId: string | null;
  hostId: string | null;
  workspace: string | undefined;
  message: string;
}

export interface NewSessionDefaults {
  agents: Agent[];
  projects: Project[];
  hosts: Host[];
  agentId: string;
  projectId: string | null;
  hostId: string | null;
  workspace: string | undefined;
  message: string;
}

export class NewSessionModal extends Modal {
  private readonly choices: NewSessionChoices;

  constructor(
    app: App,
    private readonly defaults: NewSessionDefaults,
    private readonly onSubmit: (choices: NewSessionChoices) => Promise<void>,
  ) {
    super(app);
    const agentId = defaults.agents.some((agent) => agent.id === defaults.agentId)
      ? defaults.agentId
      : (defaults.agents[0]?.id ?? "");
    this.choices = {
      agentId,
      projectId: defaults.projectId,
      hostId: defaults.hostId,
      workspace: defaults.workspace,
      message: defaults.message,
    };
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle("New Omnigent session");
    if (this.defaults.agents.length === 0) {
      contentEl.createEl("p", { text: "No agents are available on this server." });
      return;
    }
    new Setting(contentEl).setName("Agent").addDropdown((dropdown) => {
      for (const agent of this.defaults.agents) dropdown.addOption(agent.id, agent.name);
      dropdown.setValue(this.choices.agentId).onChange((value) => (this.choices.agentId = value));
    });
    new Setting(contentEl).setName("Project").addDropdown((dropdown) => {
      dropdown.addOption("", "No project");
      for (const project of this.defaults.projects) dropdown.addOption(project.id, project.name);
      dropdown.setValue(this.choices.projectId ?? "").onChange((value) => (this.choices.projectId = value || null));
    });
    const userHosts = this.defaults.hosts.filter((host) => !host.sandbox_provider);
    if (userHosts.length > 0) {
      new Setting(contentEl)
        .setName("Host")
        .setDesc("The machine that runs the agent. Use this computer to work on the vault.")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "Server default");
          for (const host of userHosts) {
            dropdown.addOption(host.host_id, `${host.name ?? host.host_id}${host.status === "online" ? "" : " (offline)"}`);
          }
          dropdown.setValue(this.choices.hostId ?? "").onChange((value) => (this.choices.hostId = value || null));
        });
    }
    new Setting(contentEl)
      .setName("Working directory")
      .setDesc("Absolute path on the host. Defaults to this vault.")
      .addText((text) =>
        text
          .setPlaceholder("Agent default")
          .setValue(this.choices.workspace ?? "")
          .onChange((value) => (this.choices.workspace = value.trim() || undefined)),
      );
    const message = new Setting(contentEl).setName("First message").setDesc("Optional. Use [[note]] to include a note.");
    message.settingEl.addClass("omnigent-setting-stacked");
    message.addTextArea((area) => {
      area.inputEl.rows = 5;
      area.setValue(this.choices.message).onChange((value) => (this.choices.message = value));
    });
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText("Start session")
        .setCta()
        .onClick(async () => {
          if (this.choices.workspace && !this.choices.hostId) {
            new Notice("Choose a host to run the session in that working directory, or clear the directory.");
            return;
          }
          button.setDisabled(true);
          try {
            await this.onSubmit(this.choices);
            this.close();
          } catch (error) {
            new Notice(`Could not start the session: ${error instanceof Error ? error.message : String(error)}`);
            button.setDisabled(false);
          }
        }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Single-line text prompt (rename session, new project). */
export class TextPromptModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly initial: string,
    private readonly onSubmit: (value: string) => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.title);
    let value = this.initial;
    const submit = async () => {
      if (!value.trim()) return;
      try {
        await this.onSubmit(value.trim());
        this.close();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      }
    };
    new Setting(this.contentEl).addText((text) => {
      text.setValue(value).onChange((next) => (value = next));
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void submit();
      });
      window.setTimeout(() => text.inputEl.select(), 0);
    });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Save").setCta().onClick(submit));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Confirmation dialog for destructive actions. */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirmText: string,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(this.confirmText)
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.onConfirm();
              this.close();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error));
              button.setDisabled(false);
            }
          }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
