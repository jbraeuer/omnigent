/**
 * Render transcript blocks (from the web client's `itemsToBlocks`) as Obsidian
 * DOM: assistant and user text through `MarkdownRenderer`, tool activity as
 * collapsible details, and status lines for errors, retries and policy denials.
 */
import { App, Component, MarkdownRenderer } from "obsidian";
import { isTextBlock, type AnyBlock, type ToolExecution } from "@/lib/blocks";
import { isSystemUserContent } from "@/lib/systemMessage";
import { splitContext } from "../vault/context";

const MAX_TOOL_OUTPUT_CHARS = 20_000;

export interface RenderContext {
  app: App;
  /** Owns the markdown render children; unloaded when the view re-renders or closes. */
  component: Component;
  /** Vault path links resolve against, e.g. the active note. */
  sourcePath: string;
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (${text.length - MAX_TOOL_OUTPUT_CHARS} more characters)`
    : text;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function markdown(ctx: RenderContext, parent: HTMLElement, text: string, cls: string): void {
  const el = parent.createDiv({ cls: ["omnigent-message", cls] });
  void MarkdownRenderer.render(ctx.app, text, el, ctx.sourcePath, ctx.component);
}

function details(parent: HTMLElement, summary: string, cls: string, body: (el: HTMLElement) => void): void {
  const el = parent.createEl("details", { cls: ["omnigent-details", cls] });
  el.createEl("summary", { text: summary });
  // Bodies of long transcripts are built lazily, on first expand.
  let built = false;
  el.addEventListener("toggle", () => {
    if (built || !el.open) return;
    built = true;
    body(el.createDiv({ cls: "omnigent-details-body" }));
  });
}

function pre(parent: HTMLElement, text: string): void {
  parent.createEl("pre", { cls: "omnigent-pre" }).createEl("code", { text: truncate(text) });
}

function renderExecution(parent: HTMLElement, execution: ToolExecution): void {
  const summary = execution.argsSummary ? `${execution.name}  ${execution.argsSummary}` : execution.name;
  details(parent, summary, "omnigent-tool", (body) => {
    if (Object.keys(execution.arguments).length > 0) pre(body, stringify(execution.arguments));
    if (execution.output !== null) {
      body.createDiv({ cls: "omnigent-label", text: "Output" });
      pre(body, execution.output);
    }
  });
}

/** Render `blocks` into `container` (cleared first). */
export function renderBlocks(ctx: RenderContext, container: HTMLElement, blocks: AnyBlock[]): void {
  container.empty();
  const shownCallIds = new Set<string>();
  for (const block of blocks) {
    switch (block.type) {
      case "user_message": {
        if (isSystemUserContent(block.content)) break;
        const text = block.content
          .filter(isTextBlock)
          .map((part) => part.text)
          .join("\n\n");
        if (!text.trim()) break;
        const { text: typed, context, notePaths } = splitContext(text);
        markdown(ctx, container, typed, "omnigent-message-user");
        if (context) {
          details(container, `Context: ${notePaths.join(", ") || "vault notes"}`, "omnigent-context", (body) =>
            markdown(ctx, body, context, "omnigent-message-context"),
          );
        }
        break;
      }
      case "text_done":
        if (block.fullText.trim()) markdown(ctx, container, block.fullText, "omnigent-message-assistant");
        break;
      case "reasoning_block": {
        const text = block.summaryText || block.reasoningText;
        if (text.trim()) {
          details(container, "Thinking", "omnigent-reasoning", (body) =>
            markdown(ctx, body, text, "omnigent-message-reasoning"),
          );
        }
        break;
      }
      case "tool_group":
        for (const execution of block.executions) {
          shownCallIds.add(execution.callId);
          renderExecution(container, execution);
        }
        break;
      case "tool_result":
        if (shownCallIds.has(block.callId)) break;
        details(container, `${block.name} result`, "omnigent-tool", (body) => pre(body, block.output));
        break;
      case "native_tool":
        details(container, block.label || block.toolType, "omnigent-tool", (body) => pre(body, stringify(block.data)));
        break;
      case "terminal_command": {
        const text = block.kind === "input" ? `$ ${block.input ?? ""}` : [block.stdout, block.stderr].filter(Boolean).join("\n");
        if (text.trim()) pre(container.createDiv({ cls: "omnigent-terminal-command" }), text);
        break;
      }
      case "slash_command":
        container.createDiv({ cls: "omnigent-status", text: `/${block.name} ${block.arguments}`.trim() });
        break;
      case "elicitation":
        container.createDiv({
          cls: "omnigent-status",
          text:
            block.status === "pending"
              ? `Approval requested: ${block.message}`
              : `Approval ${block.response?.action ?? "answered"}: ${block.message}`,
        });
        break;
      case "error":
        container.createDiv({ cls: ["omnigent-status", "omnigent-error"], text: block.title ?? block.message });
        break;
      case "policy_denied":
        container.createDiv({ cls: ["omnigent-status", "omnigent-error"], text: `Blocked by policy: ${block.reason}` });
        break;
      case "retry":
        container.createDiv({
          cls: "omnigent-status",
          text: `Retrying (${block.attempt}/${block.maxAttempts}) in ${block.delaySeconds}s…`,
        });
        break;
      case "compaction":
        container.createDiv({ cls: "omnigent-status", text: "Context compacted" });
        break;
      case "file":
        container.createDiv({ cls: "omnigent-status", text: `File: ${block.filename ?? block.fileId}` });
        break;
      default:
        // response_start/end, routing decisions and streaming fragments carry no transcript content.
        break;
    }
  }
}
