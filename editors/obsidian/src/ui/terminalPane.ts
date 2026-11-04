/**
 * Console mode: the session's live terminal (e.g. the Claude Code or Codex TUI)
 * in xterm.js, attached over `WS …/resources/terminals/{id}/attach`.
 * Server → client frames are binary terminal output; client → server binary
 * frames are keystrokes and text frames are JSON control (`resize`).
 * When the runner is on this machine, attach to its loopback listener directly
 * so keystrokes skip the server relay's round trips.
 * Server text frames carry tmux copy-mode selections for the local clipboard and
 * the queries tmux answers itself, which xterm must then not answer a second time.
 * An unexpected disconnect reattaches once by itself while the session's host is online.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Notice } from "obsidian";
import WebSocket from "ws";
import { parseTmuxRepliesMessage, suppressRepliesTmuxSends } from "@/components/blocks/TerminalQueryReplies";
import { loadWebglRenderer } from "@/components/blocks/webglRenderer";
import { copyText } from "@/lib/clipboard";
import { hadRecentTerminalInput, parseTerminalClipboardMessage } from "@/lib/terminalClipboard";
import { terminalKeyEventPayload } from "@/lib/terminalKeys";
import { DIRECT_PROBE_TIMEOUT_MS, directProbeUrl } from "@/lib/terminals";
import type { OmnigentClient } from "../api/client";
import { WRONG_REPLICA_WS_CLOSE } from "../api/routing";
import { directAttachUrl, pickTerminal, terminalLabel } from "../api/terminals";
import { HttpError } from "../transport/http";
import { probeWebSocket } from "../transport/socket";
import type { TerminalResource } from "../api/types";
import { closeQuietly } from "../state/sessionsStore";

/** A connection that stayed open this long earns a fresh automatic reconnect. */
const STABLE_CONNECTION_MS = 10_000;

/** Status line updates; `reconnectable` asks the view to offer a manual Reconnect. */
export type TerminalStatusListener = (message: string, reconnectable?: boolean) => void;

export class TerminalPane {
  private readonly terminal: Terminal;
  private readonly fit = new FitAddon();
  private socket: WebSocket | null = null;
  private readonly resizeObserver: ResizeObserver;
  private disposed = false;
  /** `performance.now()` of the last keystroke or mouse report; gates clipboard writes. */
  private lastInputAt = 0;
  /** Drops xterm's replies to the queries tmux answers, once the runner lists them. */
  private queryReplies: { dispose: () => void } | null = null;
  /** Whether the automatic reconnect was spent since the last stable connection. */
  private reconnectSpent = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly client: OmnigentClient,
    private readonly sessionId: string,
    private readonly onStatus: TerminalStatusListener,
  ) {
    const styles = getComputedStyle(document.body);
    this.terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: styles.getPropertyValue("--font-monospace").trim() || "Menlo, monospace",
      fontSize: 13,
      theme: {
        background: styles.getPropertyValue("--background-primary").trim() || undefined,
        foreground: styles.getPropertyValue("--text-normal").trim() || undefined,
      },
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.open(host);
    // GPU rendering, as in the web UI; the DOM renderer stays as the fallback.
    loadWebglRenderer(this.terminal);
    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe(host);
    this.terminal.onData((data) => this.sendInput(Buffer.from(data, "utf8")));
    this.terminal.onBinary((data) => this.sendInput(Buffer.from(data, "binary")));
    this.terminal.attachCustomKeyEventHandler((event) => this.handleKey(event));
    // Copy xterm's own selection (e.g. Option-drag past the TUI's mouse mode) on ⌘C.
    host.addEventListener(
      "copy",
      (event) => {
        const selection = this.terminal.getSelection();
        if (!selection) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        event.clipboardData?.setData("text/plain", selection);
      },
      { capture: true },
    );
  }

  /**
   * Attach to `terminalId` (default: the agent's own terminal UI) and return the
   * session's terminals for a picker; `readOnly` drops keystrokes server-side.
   */
  attach(readOnly: boolean, terminalId?: string): Promise<TerminalResource[]> {
    this.reconnectSpent = false;
    return this.attachTo(readOnly, terminalId, false);
  }

  /** `isReplicaRetry` marks the one keyless re-attach after a wrong-replica close. */
  private async attachTo(readOnly: boolean, terminalId: string | undefined, isReplicaRetry: boolean): Promise<TerminalResource[]> {
    this.detach();
    let terminals: TerminalResource[];
    try {
      terminals = await this.client.listTerminals(this.sessionId);
    } catch (error) {
      if (error instanceof HttpError && /is offline/.test(error.body)) {
        this.onStatus("The agent isn't running right now. Send it a message to start it, then reconnect.", true);
        return [];
      }
      throw error;
    }
    const target = terminals.find((terminal) => terminal.id === terminalId) ?? pickTerminal(terminals);
    if (!target) {
      this.onStatus("This session has no terminal yet. It appears once the agent starts.", true);
      return terminals;
    }
    if (this.disposed) return terminals;
    const { socket, direct } = await this.connect(target, readOnly);
    if (this.disposed) {
      closeQuietly(socket);
      return terminals;
    }
    this.terminal.reset();
    this.socket = socket;
    socket.binaryType = "nodebuffer";
    let openedAt: number | null = null;
    socket.on("open", () => {
      openedAt = performance.now();
      const label = terminalLabel(target) + (direct ? ", direct" : "");
      this.onStatus(readOnly ? `Watching ${label} (read-only)` : `Attached to ${label}`);
      this.refit();
      this.terminal.focus();
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) this.terminal.write(new Uint8Array(data as Buffer));
      else this.handleControlFrame((data as Buffer).toString("utf8"));
    });
    socket.on("close", (code, reason) => {
      if (this.socket !== socket || this.disposed) return;
      this.socket = null;
      // The client now dials this host keyless; re-attach once on the default replica.
      if (code === WRONG_REPLICA_WS_CLOSE && !isReplicaRetry) {
        void this.attachTo(readOnly, target.id, true).catch((error: unknown) =>
          this.onStatus(`Could not attach: ${errorMessage(error)}`, true),
        );
        return;
      }
      if (openedAt !== null && performance.now() - openedAt >= STABLE_CONNECTION_MS) this.reconnectSpent = false;
      void this.recover(readOnly, target.id, `${code}${reason.length ? `: ${reason.toString()}` : ""}`);
    });
    socket.on("error", (error) => this.onStatus(`Terminal error: ${error.message}`));
    this.attachedId = target.id;
    return terminals;
  }

  /** The runner's loopback listener when it answers, else the server relay. */
  private async connect(target: TerminalResource, readOnly: boolean): Promise<{ socket: WebSocket; direct: boolean }> {
    const directUrl = directAttachUrl(target, readOnly);
    const probeUrl = directUrl && directProbeUrl(directUrl);
    if (directUrl && probeUrl && (await probeWebSocket(probeUrl, DIRECT_PROBE_TIMEOUT_MS))) {
      return { socket: new WebSocket(directUrl, { perMessageDeflate: false }), direct: true };
    }
    return { socket: await this.client.openTerminal(this.sessionId, target.id, readOnly), direct: false };
  }

  /**
   * Visible for tests: after an unexpected close, reattach once while the host is
   * online. A pane that keeps dropping (e.g. reaped while idle) is left for a manual Reconnect.
   */
  async recover(readOnly: boolean, terminalId: string, detail: string): Promise<void> {
    const disconnected = `Terminal disconnected (${detail}).`;
    if (this.reconnectSpent) {
      this.onStatus(disconnected, true);
      return;
    }
    let hostOnline = false;
    try {
      hostOnline = (await this.client.getSession(this.sessionId)).host_online !== false;
    } catch {
      // Unknown host state; leave reconnecting to the user.
    }
    if (this.disposed || this.socket) return;
    if (!hostOnline) {
      this.onStatus(`${disconnected} The session's host is offline.`, true);
      return;
    }
    this.reconnectSpent = true;
    this.onStatus("Terminal disconnected; reconnecting…");
    try {
      await this.attachTo(readOnly, terminalId, false);
    } catch (error) {
      this.onStatus(`Could not reconnect: ${errorMessage(error)}`, true);
    }
  }

  /** Id of the terminal currently attached, if any. */
  attachedId: string | null = null;

  detach(): void {
    closeQuietly(this.socket);
    this.socket = null;
    this.queryReplies?.dispose();
    this.queryReplies = null;
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
    this.resizeObserver.disconnect();
    this.terminal.dispose();
  }

  private refit(): void {
    if (this.disposed || this.host.clientWidth === 0) return;
    this.fit.fit();
    if (this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify({ type: "resize", cols: this.terminal.cols, rows: this.terminal.rows }));
    }
  }

  private sendInput(bytes: Buffer): void {
    this.lastInputAt = performance.now();
    if (this.socket?.readyState === 1) this.socket.send(bytes, { binary: true });
  }

  /**
   * Visible for tests: send keys xterm doesn't encode (Shift+Enter as CSI-u, so the TUI
   * inserts a newline instead of submitting). Returns `false` when the key was handled.
   */
  handleKey(event: KeyboardEvent): boolean {
    const payload = terminalKeyEventPayload(event);
    if (payload === null) return true;
    // xterm calls this for keydown, keypress and keyup; send once, suppress all three.
    if (event.type === "keydown") {
      event.preventDefault();
      this.sendInput(Buffer.from(payload, "utf8"));
    }
    return false;
  }

  /** Visible for tests: apply a server text frame; only recent-input clipboard writes land. */
  handleControlFrame(message: string): void {
    const tmuxAnswers = parseTmuxRepliesMessage(message);
    if (tmuxAnswers !== null) {
      this.queryReplies?.dispose();
      this.queryReplies = suppressRepliesTmuxSends(this.terminal, tmuxAnswers);
      return;
    }
    const text = parseTerminalClipboardMessage(message);
    if (text === null || !hadRecentTerminalInput(this.lastInputAt, performance.now())) return;
    copyText(text).catch(() => new Notice("Could not copy the terminal selection to the clipboard."));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
