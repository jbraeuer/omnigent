import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalPane } from "./terminalPane";

const copyText = vi.hoisted(() => vi.fn(async (_text: string) => {}));
vi.mock("@/lib/clipboard", () => ({ copyText: (text: string) => copyText(text) }));
const suppressReplies = vi.hoisted(() => vi.fn());
vi.mock("@/components/blocks/TerminalQueryReplies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/blocks/TerminalQueryReplies")>()),
  suppressRepliesTmuxSends: suppressReplies,
}));

function clipboardFrame(text: string): string {
  return JSON.stringify({ type: "clipboard-write", encoding: "base64", data: Buffer.from(text).toString("base64") });
}

function paneWithInputAt(lastInputAt: number): InstanceType<typeof TerminalPane> {
  const pane = Object.create(TerminalPane.prototype) as InstanceType<typeof TerminalPane>;
  (pane as unknown as { lastInputAt: number }).lastInputAt = lastInputAt;
  return pane;
}

describe("TerminalPane clipboard frames", () => {
  afterEach(() => {
    copyText.mockClear();
    vi.restoreAllMocks();
  });

  it("copies a tmux selection that follows local input", () => {
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    paneWithInputAt(9_000).handleControlFrame(clipboardFrame("selected λ"));
    expect(copyText).toHaveBeenCalledWith("selected λ");
  });

  it("ignores selections without recent input and unknown frames", () => {
    vi.spyOn(performance, "now").mockReturnValue(60_000);
    paneWithInputAt(9_000).handleControlFrame(clipboardFrame("someone else's copy"));
    paneWithInputAt(59_000).handleControlFrame(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    expect(copyText).not.toHaveBeenCalled();
  });
});

describe("TerminalPane keys", () => {
  function keyEvent(type: string, init: Partial<KeyboardEvent>): KeyboardEvent {
    return { type, key: "", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0, preventDefault: vi.fn(), ...init } as unknown as KeyboardEvent;
  }

  it("sends Shift+Enter once as CSI-u and leaves plain Enter to xterm", () => {
    const pane = paneWithInputAt(0);
    const send = vi.fn();
    (pane as unknown as { socket: unknown }).socket = { readyState: 1, send };

    expect(pane.handleKey(keyEvent("keydown", { key: "Enter", shiftKey: true }))).toBe(false);
    expect(pane.handleKey(keyEvent("keyup", { key: "Enter", shiftKey: true }))).toBe(false);
    expect(pane.handleKey(keyEvent("keydown", { key: "Enter" }))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].toString()).toBe("\x1b[13;2u");
  });
});

describe("TerminalPane tmux query replies", () => {
  it("suppresses the queries tmux answers and replaces the set on a newer list", () => {
    const first = { dispose: vi.fn() };
    suppressReplies.mockReturnValueOnce(first).mockReturnValueOnce({ dispose: vi.fn() });
    const pane = paneWithInputAt(0);
    const terminal = {};
    (pane as unknown as { terminal: unknown }).terminal = terminal;

    pane.handleControlFrame(JSON.stringify({ type: "tmux-replies", queries: ["da1", "dsr:6"] }));
    pane.handleControlFrame(JSON.stringify({ type: "tmux-replies", queries: ["osc:10"] }));

    expect(suppressReplies.mock.calls.map(([term, queries]) => [term, [...queries]])).toEqual([
      [terminal, ["da1", "dsr:6"]],
      [terminal, ["osc:10"]],
    ]);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(copyText).not.toHaveBeenCalled();
  });
});

describe("TerminalPane reconnect", () => {
  function paneWithHost(hostOnline: boolean | null) {
    const pane = paneWithInputAt(0);
    const getSession = vi.fn(async () => ({ id: "conv_1", host_online: hostOnline }));
    const statuses: [string, boolean | undefined][] = [];
    Object.assign(pane as object, {
      client: { getSession },
      sessionId: "conv_1",
      onStatus: (message: string, reconnectable?: boolean) => statuses.push([message, reconnectable]),
      reconnectSpent: false,
      disposed: false,
      socket: null,
    });
    const attachTo = vi.fn(async () => []);
    (pane as unknown as { attachTo: unknown }).attachTo = attachTo;
    return { pane, attachTo, statuses };
  }

  it("reattaches once while the host is online, then leaves it to the user", async () => {
    const { pane, attachTo, statuses } = paneWithHost(true);
    await pane.recover(false, "tui:main", "1006");
    await pane.recover(false, "tui:main", "1006");

    expect(attachTo).toHaveBeenCalledOnce();
    expect(attachTo).toHaveBeenCalledWith(false, "tui:main", false);
    expect(statuses).toEqual([
      ["Terminal disconnected; reconnecting…", undefined],
      ["Terminal disconnected (1006).", true],
    ]);
  });

  it("offers a manual reconnect while the host is offline", async () => {
    const { pane, attachTo, statuses } = paneWithHost(false);
    await pane.recover(true, "tui:main", "1001: going away");

    expect(attachTo).not.toHaveBeenCalled();
    expect(statuses).toEqual([["Terminal disconnected (1001: going away). The session's host is offline.", true]]);
  });
});
