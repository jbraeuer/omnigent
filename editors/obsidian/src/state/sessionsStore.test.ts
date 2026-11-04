import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmnigentClient } from "../api/client";
import type { SessionListItem } from "../api/types";
import {
  HEARTBEAT_WATCHDOG_MS,
  RECONCILE_INTERVAL_MS,
  SessionsStore,
  applyUpdatesFrame,
  matchesFilter,
  pendingApprovalCount,
  sortedTopLevelSessions,
} from "./sessionsStore";

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

describe("SessionsStore liveness", () => {
  function fakeSocket() {
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(() => socket.emit("close")),
    });
    return socket;
  }

  function fakeClient(pages: SessionListItem[][], sockets: ReturnType<typeof fakeSocket>[]) {
    let call = 0;
    return {
      listProjects: vi.fn(async () => []),
      getProjectOrder: vi.fn(async () => null),
      listSessions: vi.fn(async () => ({ data: pages[Math.min(call++, pages.length - 1)]! })),
      openSessionUpdates: vi.fn(async () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket;
      }),
      routing: { learn: vi.fn() },
    } as unknown as OmnigentClient;
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-lists periodically, so sessions whose discovery push was missed still appear", async () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const store = new SessionsStore();
    await store.connect(fakeClient([[{ id: "a" }], [{ id: "a" }, { id: "b" }]], sockets));
    expect([...store.sessions.keys()]).toEqual(["a"]);

    sockets[0]!.emit("message", Buffer.from(JSON.stringify({ type: "heartbeat" })));
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS / 2);
    sockets[0]!.emit("message", Buffer.from(JSON.stringify({ type: "heartbeat" })));
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS / 2 + 10_000);
    expect([...store.sessions.keys()]).toEqual(["a", "b"]);
    expect(sockets).toHaveLength(1);
    store.disconnect();
  });

  it("keeps a pushed new session through a re-list that doesn't include it yet", async () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const store = new SessionsStore();
    await store.connect(fakeClient([[{ id: "a" }]], sockets));
    sockets[0]!.emit("message", Buffer.from(JSON.stringify({ type: "changed", items: [{ id: "new" }] })));

    await store.refresh();
    expect([...store.sessions.keys()].sort()).toEqual(["a", "new"]);
    await vi.advanceTimersByTimeAsync(60_000);
    await store.refresh();
    expect([...store.sessions.keys()]).toEqual(["a"]);
    store.disconnect();
  });

  it("drops a pushed session archived elsewhere once a re-list has included it", async () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const store = new SessionsStore();
    await store.connect(fakeClient([[{ id: "a" }], [{ id: "a" }, { id: "new" }], [{ id: "a" }]], sockets));
    sockets[0]!.emit("message", Buffer.from(JSON.stringify({ type: "changed", items: [{ id: "new" }] })));

    await store.refresh();
    expect([...store.sessions.keys()].sort()).toEqual(["a", "new"]);
    await store.refresh();
    expect([...store.sessions.keys()]).toEqual(["a"]);
    store.disconnect();
  });

  it("replaces a socket that stopped heartbeating", async () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const store = new SessionsStore();
    await store.connect(fakeClient([[{ id: "a" }]], sockets));

    await vi.advanceTimersByTimeAsync(HEARTBEAT_WATCHDOG_MS + 10_000);
    expect(sockets[0]!.terminate).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    store.disconnect();
  });
});
