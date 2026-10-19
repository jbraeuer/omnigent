/**
 * Node `http`/`https` transport.
 *
 * Obsidian's `fetch` is subject to CORS (the server sends no CORS headers) and
 * its `requestUrl` cannot stream, so every request goes through Node. Node sends
 * no `Origin` header, which the server's local-mode origin guard admits.
 */
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";

export type Headers = Record<string, string>;

export interface RequestOptions {
  method?: string;
  headers?: Headers;
  /** JSON-serialized when set. */
  body?: unknown;
  signal?: AbortSignal;
  /** Time allowed until response headers arrive, e.g. `15_000`. */
  timeoutMs?: number;
}

/** A non-2xx response; `body` is the raw text so callers can surface server messages. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}: ${summarizeErrorBody(body)}`);
    this.name = "HttpError";
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Join a server base URL (which may carry a path prefix) with an API path. */
export function joinUrl(baseUrl: string, apiPath: string, query?: Record<string, unknown>): URL {
  const url = new URL(baseUrl.replace(/\/+$/, "") + apiPath);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

/** Pull the most useful human message out of an error body. */
export function summarizeErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      detail?: unknown;
      message?: unknown;
      error?: { message?: unknown } | string;
    };
    const candidates = [
      typeof parsed.error === "object" ? parsed.error?.message : parsed.error,
      parsed.message,
      typeof parsed.detail === "string" ? parsed.detail : undefined,
    ];
    const message = candidates.find((value) => typeof value === "string" && value.length > 0);
    if (typeof message === "string") return message;
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return body.length > 300 ? `${body.slice(0, 300)}…` : body || "(empty body)";
}

/** Issue a request and resolve with the response once headers arrive. */
export function requestRaw(url: URL, options: RequestOptions = {}): Promise<http.IncomingMessage> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Headers = { Accept: "application/json", ...options.headers };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method: options.method ?? "GET", headers });
    const timer = setTimeout(() => {
      request.destroy(new Error(`Timed out connecting to ${url.origin}`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => request.destroy(new Error("Request aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("response", (response) => {
      clearTimeout(timer);
      response.on("close", () => options.signal?.removeEventListener("abort", onAbort));
      resolve(response);
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    if (options.signal?.aborted) onAbort();
    request.end(payload);
  });
}

async function readText(response: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Request JSON; throws {@link HttpError} on non-2xx (3xx included: login redirects mean "unauthenticated"). */
export async function requestJson<T>(url: URL, options: RequestOptions = {}): Promise<T> {
  const response = await requestRaw(url, options);
  const text = await readText(response);
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) throw new HttpError(status, text, url.toString());
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Open a streaming GET (e.g. SSE) and expose the body as a web `ReadableStream`. */
export async function openByteStream(
  url: URL,
  options: RequestOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  const response = await requestRaw(url, {
    ...options,
    headers: { Accept: "text/event-stream", ...options.headers },
  });
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    throw new HttpError(status, await readText(response), url.toString());
  }
  return Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
}
