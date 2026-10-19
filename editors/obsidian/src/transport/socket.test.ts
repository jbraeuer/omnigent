import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { probeWebSocket } from "./socket";

let server: WebSocketServer | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function listen(options: ConstructorParameters<typeof WebSocketServer>[0] = {}): Promise<string> {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0, ...options });
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/probe`;
}

describe("probeWebSocket", () => {
  it("reports a completed handshake", async () => {
    expect(await probeWebSocket(await listen(), 1_000)).toBe(true);
  });

  it("reports a rejected handshake", async () => {
    const url = await listen({ verifyClient: () => false });
    expect(await probeWebSocket(url, 1_000)).toBe(false);
  });

  it("reports nothing listening", async () => {
    const url = await listen();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    expect(await probeWebSocket(url, 1_000)).toBe(false);
  });
});
