import { describe, expect, it } from "vitest";
import type { SessionListItem } from "../api/types";
import { CARD_HEIGHT, CARD_WIDTH, buildCanvas, canvasFileName, cardText, sessionsByProject, type CanvasData } from "./canvasFile";

const title = (session: SessionListItem) => session.title ?? session.id;

function session(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return { id, title: `Session ${id}`, status: "idle", ...overrides };
}

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) < CARD_WIDTH && Math.abs(a.y - b.y) < CARD_HEIGHT;
}

describe("buildCanvas", () => {
  it("lays out new cards on a grid with a link back to the session", () => {
    const canvas = buildCanvas([session("a"), session("b", { status: "running" })], title, null);
    expect(canvas.nodes).toHaveLength(2);
    expect(overlaps(canvas.nodes[0]!, canvas.nodes[1]!)).toBe(false);
    expect(canvas.nodes[0]!.text).toContain("](obsidian://omnigent?session=a)");
    expect(canvas.nodes[1]!.color).toBe("5");
  });

  it("keeps moved cards and user nodes, drops cards of departed sessions", () => {
    const existing: CanvasData = {
      nodes: [
        { id: "a", type: "text", x: 900, y: 600, width: 500, height: 200, text: "old" },
        { id: "gone", type: "text", x: 0, y: 0, width: 360, height: 140, text: cardText(session("gone"), "Gone") },
        { id: "note", type: "file", x: 0, y: 0, width: 400, height: 400, file: "Plans.md" },
      ],
      edges: [{ id: "e1", fromNode: "note", toNode: "a" }],
    };
    const canvas = buildCanvas([session("a", { title: "Renamed" }), session("new")], title, existing);
    const byId = new Map(canvas.nodes.map((node) => [node.id, node]));
    expect(byId.get("a")).toMatchObject({ x: 900, y: 600, width: 500, height: 200 });
    expect(byId.get("a")!.text).toContain("Renamed");
    expect(byId.has("gone")).toBe(false);
    expect(byId.get("note")).toMatchObject({ file: "Plans.md" });
    // The new card avoids the user's note at the origin.
    expect(overlaps(byId.get("new")!, byId.get("note")!)).toBe(false);
    expect(canvas.edges).toEqual(existing.edges);
  });

  it("escapes link brackets in titles and flags waiting approvals", () => {
    const text = cardText(session("a", { pending_elicitations_count: 2 }), "Fix [prod] bug");
    expect(text).toContain("### [Fix \\[prod\\] bug](obsidian://omnigent?session=a)");
    expect(text).toContain("2 approval(s) waiting");
  });
});

describe("sessionsByProject", () => {
  it("groups by project with null for unfiled", () => {
    const groups = sessionsByProject([session("a", { project_id: "p" }), session("b"), session("c", { project_id: "p" })]);
    expect(groups.get("p")!.map((s) => s.id)).toEqual(["a", "c"]);
    expect(groups.get(null)!.map((s) => s.id)).toEqual(["b"]);
  });
});

describe("canvasFileName", () => {
  it("strips characters Obsidian rejects in file names", () => {
    expect(canvasFileName('Q3: plans/ideas [draft]')).toBe("Q3 plans ideas draft");
    expect(canvasFileName("///")).toBe("Untitled");
  });
});
