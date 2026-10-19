// Shared by the integration tests and scripts/e2e-obsidian.mjs.
import { gzipSync } from "node:zlib";

/** A one-file ustar archive, gzipped: the agent bundle format `POST /v1/sessions` accepts. */
export function agentBundle(fileName, content) {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  const field = (offset, length, value) => header.write(value, offset, length, "ascii");
  field(0, 100, fileName);
  field(100, 8, "0000644\0");
  field(108, 8, "0000000\0");
  field(116, 8, "0000000\0");
  field(124, 12, `${body.length.toString(8).padStart(11, "0")}\0`);
  field(136, 12, "00000000000\0");
  field(148, 8, "        ");
  field(156, 1, "0");
  field(257, 6, "ustar\0");
  field(263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  field(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return new Uint8Array(gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)])));
}
