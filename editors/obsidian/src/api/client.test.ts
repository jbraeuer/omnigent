import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthProvider } from "../auth/auth";
import { OmnigentClient, sessionTitle, webUiBaseUrl } from "./client";

interface Seen {
  method?: string;
  url?: string;
  auth?: string;
  body: unknown;
  sliceKey?: string;
}

let server: Server | null = null;

async function serve(
  reply: (req: IncomingMessage, seen: Seen) => { status?: number; body: unknown },
  prefix = "/api/2.0/omnigent",
): Promise<{
  base: string;
  seen: Seen[];
}> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const sliceKey = req.headers["x-databricks-omnigent-slice-key"];
      const entry: Seen = {
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
        sliceKey: typeof sliceKey === "string" ? sliceKey : undefined,
      };
      seen.push(entry);
      const { status = 200, body } = reply(req, entry);
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}`, seen };
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

class CountingAuth implements AuthProvider {
  readonly label = "test";
  mints = 0;
  async headers() {
    return { Authorization: `Bearer t${this.mints}` };
  }
  invalidate() {
    this.mints++;
  }
}

describe("OmnigentClient", () => {
  it("shapes requests like the web client", async () => {
    // A self-hosted prefix: not workspace-hosted, so no replica routing.
    const { base, seen } = await serve(() => ({ body: { queued: true, data: [] } }), "/omni");
    const client = new OmnigentClient(base, new CountingAuth());
    await client.listSessions({ searchQuery: "jpmc" });
    await client.sendMessage("conv 1", [{ type: "input_text", text: "hi" }]);
    await client.interrupt("conv 1");
    await client.resolveElicitation("conv_c", "elicit_1", "decline");
    await client.updateSession("conv_1", { project_id: "" });
    expect(seen.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      {
        method: "GET",
        url: "/omni/v1/sessions?visibility=mine&search_query=jpmc&limit=100&order=desc",
        body: undefined,
      },
      {
        method: "POST",
        url: "/omni/v1/sessions/conv%201/events",
        body: { type: "message", data: { role: "user", content: [{ type: "input_text", text: "hi" }] } },
      },
      { method: "POST", url: "/omni/v1/sessions/conv%201/events", body: { type: "interrupt", data: {} } },
      {
        method: "POST",
        url: "/omni/v1/sessions/conv_c/elicitations/elicit_1/resolve",
        body: { action: "decline" },
      },
      { method: "PATCH", url: "/omni/v1/sessions/conv_1", body: { project_id: "" } },
    ]);
    expect(seen.every((entry) => entry.auth === "Bearer t0" && entry.sliceKey === undefined)).toBe(true);
  });

  it("keys session traffic by the session's host on workspace-hosted servers", async () => {
    const wrongReplica = { status: 400, body: { error: { code: "wrong_replica", message: "session runner is on another replica; retry" } } };
    const { base, seen } = await serve((req, entry) => {
      if (req.url === "/api/2.0/omnigent/v1/sessions/conv_1?include_items=false") return { body: { id: "conv_1", host_id: "h1" } };
      return entry.sliceKey === "h1" ? { body: { data: [], has_more: false } } : wrongReplica;
    });
    const client = new OmnigentClient(base, new CountingAuth());
    await client.listSessionItems("conv_1");
    await client.listTerminals("conv_1");
    // One host lookup through the host-agnostic snapshot, then keyed requests.
    expect(seen.map((entry) => [entry.url, entry.sliceKey])).toEqual([
      ["/api/2.0/omnigent/v1/sessions/conv_1?include_items=false", undefined],
      ["/api/2.0/omnigent/v1/sessions/conv_1/items?limit=200&order=desc", "h1"],
      ["/api/2.0/omnigent/v1/sessions/conv_1/resources/terminals", "h1"],
    ]);
  });

  it("re-addresses keyless once when a keyed request reaches the wrong replica", async () => {
    const { base, seen } = await serve((req, entry) => {
      if (req.url?.endsWith("include_items=false")) return { body: { id: "conv_1", host_id: "h1" } };
      return entry.sliceKey ? { status: 400, body: { error: { code: "wrong_replica" } } } : { body: { data: [] } };
    });
    const client = new OmnigentClient(base, new CountingAuth());
    await client.listTerminals("conv_1");
    await client.listTerminals("conv_1");
    expect(seen.slice(1).map((entry) => entry.sliceKey)).toEqual(["h1", undefined, undefined]);
  });

  it("keys session creation by the chosen host", async () => {
    const { base, seen } = await serve(() => ({ body: { id: "conv_new", host_id: "h2" } }));
    await new OmnigentClient(base, new CountingAuth()).createSession({ agent_id: "ag", host_id: "h2", workspace: "/v" });
    expect(seen[0]!.sliceKey).toBe("h2");
  });

  it("re-mints credentials once after a 401", async () => {
    const { base, seen } = await serve((_req, entry) =>
      entry.auth === "Bearer t0" ? { status: 401, body: { message: "expired" } } : { body: { hosts: [{ host_id: "h" }] } },
    );
    const auth = new CountingAuth();
    expect(await new OmnigentClient(base, auth).listHosts()).toEqual([{ host_id: "h" }]);
    expect(seen.map((entry) => entry.auth)).toEqual(["Bearer t0", "Bearer t1"]);
  });
});

describe("webUiBaseUrl", () => {
  it("maps workspace-hosted API URLs to the web UI", () => {
    expect(webUiBaseUrl("https://ws.cloud.databricks.com/api/2.0/omnigent/")).toBe("https://ws.cloud.databricks.com/omnigent");
    expect(webUiBaseUrl("http://127.0.0.1:6767")).toBe("http://127.0.0.1:6767");
  });
});

describe("sessionTitle", () => {
  it("falls back to the agent, then the id", () => {
    expect(sessionTitle({ id: "conv_1", title: " Plan ", agent_name: "polly" })).toBe("Plan");
    expect(sessionTitle({ id: "conv_1", title: "", agent_name: "polly" })).toBe("New polly session");
    expect(sessionTitle({ id: "conv_1" })).toBe("conv_1");
  });
});
