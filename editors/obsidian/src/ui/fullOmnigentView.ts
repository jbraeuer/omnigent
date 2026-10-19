/**
 * The complete Omnigent web UI embedded in a tab, for everything the native
 * views don't cover (settings, files, pull requests, forms). Used for local
 * servers only; hosted servers open in the browser because their sign-in
 * cookies don't work inside a cross-origin frame.
 */
import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";

export const FULL_OMNIGENT_VIEW_TYPE = "omnigent-web";

export class FullOmnigentView extends ItemView {
  private url = "";
  private frame: HTMLIFrameElement | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string {
    return FULL_OMNIGENT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Omnigent";
  }

  override getIcon(): string {
    return "globe";
  }

  override getState(): Record<string, unknown> {
    return { url: this.url };
  }

  override async setState(state: { url?: string }, result: ViewStateResult): Promise<void> {
    if (state.url && state.url !== this.url) {
      this.url = state.url;
      this.renderFrame();
    }
    await super.setState(state, result);
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("omnigent-web-view");
    this.renderFrame();
  }

  private renderFrame(): void {
    if (!this.contentEl || !this.url) return;
    if (!this.frame) {
      this.contentEl.empty();
      this.frame = this.contentEl.createEl("iframe", {
        cls: "omnigent-web-frame",
        attr: { allow: "clipboard-read; clipboard-write" },
      });
    }
    this.frame.src = this.url;
  }
}
