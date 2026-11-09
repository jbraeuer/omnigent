/**
 * Keeps one approval card per pending elicitation across view re-renders, so a
 * half-answered question keeps its choices while the session streams updates.
 */
import { Component, MarkdownRenderer, type App } from "obsidian";
import type { InboxItem } from "@/lib/inbox";
import { renderApprovalCard, type ApprovalCardOptions } from "./approvalCard";

interface Card {
  el: HTMLElement;
  component: Component;
}

export class ApprovalCards {
  private cards = new Map<string, Card>();

  constructor(
    private readonly app: App,
    private readonly owner: Component,
  ) {}

  /**
   * The card for `item`, built on first sight by `build` (which adds caller rows
   * and buttons around the shared body). Cards for prompts not in `live` are dropped.
   */
  card(
    item: InboxItem,
    build: (card: HTMLElement, render: (options: Omit<ApprovalCardOptions, "renderMarkdown">) => HTMLElement) => void,
  ): HTMLElement {
    const id = item.elicitation.elicitationId;
    const existing = this.cards.get(id);
    if (existing) return existing.el;
    const component = this.owner.addChild(new Component());
    const el = createDiv({ cls: "omnigent-approval" });
    build(el, (options) =>
      renderApprovalCard(el, item, {
        ...options,
        renderMarkdown: (target, markdown) => void MarkdownRenderer.render(this.app, markdown, target, "", component),
      }),
    );
    this.cards.set(id, { el, component });
    return el;
  }

  /** Forget cards whose prompts are no longer pending. */
  retain(live: InboxItem[]): void {
    const ids = new Set(live.map((item) => item.elicitation.elicitationId));
    for (const [id, card] of this.cards) {
      if (ids.has(id)) continue;
      card.el.remove();
      this.owner.removeChild(card.component);
      this.cards.delete(id);
    }
  }

  clear(): void {
    this.retain([]);
  }
}
