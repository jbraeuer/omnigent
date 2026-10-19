/**
 * Session canvases as Obsidian `.canvas` files (JSON Canvas 1.0).
 *
 * Mirrors the web Canvas page: one canvas per project plus "Main" for unfiled
 * sessions, one card per top-level session. Cards link back through the
 * `obsidian://omnigent?session=<id>` URI, and positions the user moved survive
 * regeneration because node ids are session ids.
 */
import type { SessionListItem } from "../api/types";

export interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  color?: string;
  [key: string]: unknown;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: unknown[];
  [key: string]: unknown;
}

export const CARD_WIDTH = 360;
export const CARD_HEIGHT = 140;
const GAP = 40;
const COLUMNS = 4;

/** JSON Canvas preset colors: 1 red, 4 green, 5 cyan. */
const STATUS_COLORS: Record<string, string | undefined> = {
  running: "5",
  waiting: "1",
  failed: "1",
};

export function sessionUri(sessionId: string): string {
  return `obsidian://omnigent?session=${encodeURIComponent(sessionId)}`;
}

/** Markdown for one session card. */
export function cardText(session: SessionListItem, title: string): string {
  const escapedTitle = title.replace(/[[\]]/g, "\\$&");
  const details = [session.status ?? "idle", session.agent_name, session.git_branch ?? undefined]
    .filter(Boolean)
    .join(" · ");
  const approvals = session.pending_elicitations_count
    ? `\n\n**${session.pending_elicitations_count} approval(s) waiting**`
    : "";
  return `### [${escapedTitle}](${sessionUri(session.id)})\n${details}${approvals}`;
}

function isSessionCard(node: CanvasNode): boolean {
  return typeof node.text === "string" && node.text.includes("obsidian://omnigent?session=");
}

function nextFreeSlot(taken: CanvasNode[], index: number): { x: number; y: number } {
  const occupied = (x: number, y: number) =>
    taken.some((node) => Math.abs(node.x - x) < CARD_WIDTH && Math.abs(node.y - y) < CARD_HEIGHT);
  for (let slot = index; ; slot++) {
    const x = (slot % COLUMNS) * (CARD_WIDTH + GAP);
    const y = Math.floor(slot / COLUMNS) * (CARD_HEIGHT + GAP);
    if (!occupied(x, y)) return { x, y };
  }
}

/**
 * Build canvas data for `sessions`, keeping position/size of cards already in
 * `existing` and any nodes/edges the user added themselves.
 */
export function buildCanvas(
  sessions: SessionListItem[],
  titleOf: (session: SessionListItem) => string,
  existing: CanvasData | null,
): CanvasData {
  const wanted = new Set(sessions.map((session) => session.id));
  const previous = new Map((existing?.nodes ?? []).map((node) => [node.id, node]));
  // Keep nodes the user added; drop cards of sessions that left this canvas.
  const userNodes = (existing?.nodes ?? []).filter((node) => !isSessionCard(node) && !wanted.has(node.id));
  const placed: CanvasNode[] = [...userNodes];
  const nodes: CanvasNode[] = [];
  sessions.forEach((session, index) => {
    const prior = previous.get(session.id);
    const position = prior ? { x: prior.x, y: prior.y } : nextFreeSlot(placed, index);
    const node: CanvasNode = {
      ...(prior ?? {}),
      id: session.id,
      type: "text",
      x: position.x,
      y: position.y,
      width: prior?.width ?? CARD_WIDTH,
      height: prior?.height ?? CARD_HEIGHT,
      text: cardText(session, titleOf(session)),
    };
    const color = STATUS_COLORS[session.status ?? ""];
    if (color) node.color = color;
    else delete node.color;
    placed.push(node);
    nodes.push(node);
  });
  return { ...(existing ?? {}), nodes: [...userNodes, ...nodes], edges: existing?.edges ?? [] };
}

/** Group sessions into canvases: one per project id, `null` for unfiled. */
export function sessionsByProject(sessions: SessionListItem[]): Map<string | null, SessionListItem[]> {
  const groups = new Map<string | null, SessionListItem[]>();
  for (const session of sessions) {
    const key = session.project_id ?? null;
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  return groups;
}

/** File-name-safe canvas name, e.g. `"Q3: plans/ideas"` → `"Q3 plans ideas"`. */
export function canvasFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
}
