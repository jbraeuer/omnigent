import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseSseStream } from "@/lib/sse";
import { HttpError, joinUrl, openByteStream, requestJson, summarizeErrorBody } from "./http";

let server: Server | null = null;

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe("joinUrl", () => {
  it("keeps a server path prefix and drops empty query values", () => {
    const url = joinUrl("https://ws.example.com/api/2.0/omnigent/", "/v1/sessions", {
      limit: 5,
      search_query: "",
      after: undefined,
    });
    expect(url.toString()).toBe("https://ws.example.com/api/2.0/omnigent/v1/sessions?limit=5");
  });
});

describe("summarizeErrorBody", () => {
  it.each([
    ['{"error":{"message":"no runner bound"}}', "no runner bound"],
    ['{"message":"Credential was not sent"}', "Credential was not sent"],
    ['{"detail":"Not Found"}', "Not Found"],
    ["plain failure", "plain failure"],
  ])("extracts the message from %s", (body, expected) => {
    expect(summarizeErrorBody(body)).toBe(expected);
  });
});

describe("requestJson", () => {
  it("sends JSON with headers and parses the reply, without an Origin header", async () => {
    let seen: { method?: string; body: string; auth?: string; origin?: string } | null = null;
    const base = await serve((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen = { method: req.method, body, auth: req.headers.authorization, origin: req.headers.origin };
        res.setHeader("Content-Type", "application/json");
        res.end('{"queued":true}');
      });
    });
    const result = await requestJson<{ queued: boolean }>(joinUrl(base, "/v1/x"), {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: { a: 1 },
    });
    expect(result).toEqual({ queued: true });
    expect(seen).toEqual({ method: "POST", body: '{"a":1}', auth: "Bearer t", origin: undefined });
  });

  it.each([401, 302, 500])("rejects status %i with an HttpError carrying the body", async (status) => {
    const base = await serve((_req, res) => {
      res.statusCode = status;
      res.end('{"message":"nope"}');
    });
    const error = await requestJson(joinUrl(base, "/v1/x")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(status);
    expect((error as HttpError).message).toContain("nope");
  });
});

describe("openByteStream", () => {
  it("feeds the shared SSE parser, including events split across chunks", async () => {
    const base = await serve((_req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","del');
      setTimeout(() => {
        res.write('ta":"Hel"}\n\nevent: response.output_text.delta\ndata: {"delta":"lo"}\n\n');
        res.end("data: [DONE]\n\n");
      }, 10);
    });
    const result = { sawDone: false };
    const deltas: string[] = [];
    for await (const event of parseSseStream(await openByteStream(joinUrl(base, "/stream")), result)) {
      if (event.type === "text_delta") deltas.push(event.delta);
    }
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result.sawDone).toBe(true);
  });
});
