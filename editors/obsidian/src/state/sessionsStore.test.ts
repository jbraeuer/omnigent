import { describe, expect, it } from "vitest";
import type { SessionListItem } from "../api/types";
import { applyUpdatesFrame, matchesFilter, pendingApprovalCount, sortedTopLevelSessions } from "./sessionsStore";

function row(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return { id, title: id, status: "idle", updated_at: 100, ...overrides };
}

describe("applyUpdatesFrame", () => {
  it("overlays changed rows, including explicitly cleared fields", () => {
    const rows = new Map([["a", row("a", { project_id: "p1", title: "Old" })]]);
    const changed = applyUpdatesFrame(rows, {
      type: "changed",
      items: [row("a", { project_id: null, title: "New" }), row("b")],
    });
    expect(changed).toBe(true);
    expect(rows.get("a")).toMatchObject({ project_id: null, title: "New" });
    expect(rows.has("b")).toBe(true);
  });

  it("removes rows and ignores heartbeats", () => {
    const rows = new Map([["a", row("a")]]);
    expect(applyUpdatesFrame(rows, { type: "heartbeat" })).toBe(false);
    expect(applyUpdatesFrame(rows, { type: "removed", ids: ["missing"] })).toBe(false);
    expect(applyUpdatesFrame(rows, { type: "removed", ids: ["a"] })).toBe(true);
    expect(rows.size).toBe(0);
  });
});

describe("sortedTopLevelSessions", () => {
  it("drops sub-agent children and archived rows, newest first", () => {
    const rows = [
      row("old", { updated_at: 1 }),
      row("child", { parent_session_id: "old", updated_at: 9 }),
      row("archived", { archived: true, updated_at: 8 }),
      row("new", { updated_at: 5 }),
    ];
    expect(sortedTopLevelSessions(rows, false).map((r) => r.id)).toEqual(["new", "old"]);
    expect(sortedTopLevelSessions(rows, true).map((r) => r.id)).toEqual(["archived", "new", "old"]);
  });
});

describe("pendingApprovalCount", () => {
  it("sums approvals on active sessions only", () => {
    const rows = [
      row("a", { pending_elicitations_count: 2 }),
      row("b", { pending_elicitations_count: 1, archived: true }),
      row("c"),
    ];
    expect(pendingApprovalCount(rows)).toBe(2);
  });
});

describe("matchesFilter", () => {
  it("matches every word against title and agent name", () => {
    const session = row("conv_1", { title: "Setup JPMC performance project", agent_name: "claude-native" });
    expect(matchesFilter(session, "")).toBe(true);
    expect(matchesFilter(session, "jpmc perf")).toBe(true);
    expect(matchesFilter(session, "claude setup")).toBe(true);
    expect(matchesFilter(session, "jpmc codex")).toBe(false);
  });
});
