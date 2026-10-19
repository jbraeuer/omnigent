import WebSocket from "ws";

/** Whether a WebSocket handshake to `url` completes within `timeoutMs`. Never throws. */
export function probeWebSocket(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, { handshakeTimeout: timeoutMs });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      // Swallow the error ws emits when closing a socket mid-handshake.
      socket.on("error", () => {});
      socket.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    socket.on("open", () => settle(true));
    socket.on("error", () => settle(false));
    socket.on("close", () => settle(false));
    socket.on("unexpected-response", () => settle(false));
  });
}
