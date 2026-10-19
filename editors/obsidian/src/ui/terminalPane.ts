/**
 * Console mode: the session's live terminal (e.g. the Claude Code or Codex TUI)
 * in xterm.js, attached over `WS …/resources/terminals/{id}/attach`.
 * Server → client frames are binary terminal output; client → server binary
 * frames are keystrokes and text frames are JSON control (`resize`).
 * When the runner is on this machine, attach to its loopback listener directly
 * so keystrokes skip the server relay's round trips.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import WebSocket from "ws";
import { loadWebglRenderer } from "@/components/blocks/webglRenderer";
import { DIRECT_PROBE_TIMEOUT_MS, directProbeUrl } from "@/lib/terminals";
import type { OmnigentClient } from "../api/client";
import { WRONG_REPLICA_WS_CLOSE } from "../api/routing";
import { directAttachUrl, pickTerminal, terminalLabel } from "../api/terminals";
import { HttpError } from "../transport/http";
import { probeWebSocket } from "../transport/socket";
import type { TerminalResource } from "../api/types";
import { closeQuietly } from "../state/sessionsStore";

export class TerminalPane {
  private readonly terminal: Terminal;
  private readonly fit = new FitAddon();
  private socket: WebSocket | null = null;
  private readonly resizeObserver: ResizeObserver;
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly client: OmnigentClient,
    private readonly sessionId: string,
    private readonly onStatus: (message: string) => void,
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
  }

  /**
   * Attach to `terminalId` (default: the agent's own terminal UI) and return the
   * session's terminals for a picker; `readOnly` drops keystrokes server-side.
   */
  async attach(readOnly: boolean, terminalId?: string, isRetry = false): Promise<TerminalResource[]> {
    this.detach();
    let terminals: TerminalResource[];
    try {
      terminals = await this.client.listTerminals(this.sessionId);
    } catch (error) {
      if (error instanceof HttpError && /is offline/.test(error.body)) {
        this.onStatus("The agent isn't running right now. Send it a message to start it, then open Console again.");
        return [];
      }
      throw error;
    }
    const target = terminals.find((terminal) => terminal.id === terminalId) ?? pickTerminal(terminals);
    if (!target) {
      this.onStatus("This session has no terminal yet. It appears once the agent starts.");
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
    socket.on("open", () => {
      const label = terminalLabel(target) + (direct ? ", direct" : "");
      this.onStatus(readOnly ? `Watching ${label} (read-only)` : `Attached to ${label}`);
      this.refit();
      this.terminal.focus();
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) this.terminal.write(new Uint8Array(data as Buffer));
    });
    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      // The client now dials this host keyless; re-attach once on the default replica.
      if (code === WRONG_REPLICA_WS_CLOSE && !isRetry) {
        void this.attach(readOnly, target.id, true).catch((error: unknown) =>
          this.onStatus(`Could not attach: ${error instanceof Error ? error.message : String(error)}`),
        );
        return;
      }
      this.onStatus(`Terminal disconnected (${code}${reason.length ? `: ${reason.toString()}` : ""})`);
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

  /** Id of the terminal currently attached, if any. */
  attachedId: string | null = null;

  detach(): void {
    closeQuietly(this.socket);
    this.socket = null;
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
    if (this.socket?.readyState === 1) this.socket.send(bytes, { binary: true });
  }
}
