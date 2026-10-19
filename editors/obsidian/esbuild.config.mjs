// Bundles src/main.ts -> main.js for Obsidian. `obsidian`, `electron` and the
// CodeMirror packages are provided by the app; Node builtins stay external so the
// desktop renderer resolves them with its own `require`.
import builtins from "builtin-modules";
import esbuild from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes("--production");

// Obsidian loads exactly one `styles.css`: the plugin's styles plus xterm's.
function writeStyles() {
  const xterm = readFileSync(path.resolve(here, "node_modules/@xterm/xterm/css/xterm.css"), "utf8");
  const own = readFileSync(path.resolve(here, "src/styles.css"), "utf8");
  writeFileSync(path.resolve(here, "styles.css"), `${own}\n/* xterm.js */\n${xterm}`);
}

const stylesPlugin = {
  name: "omnigent-styles",
  setup(build) {
    build.onStart(writeStyles);
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    // Optional native speedups `ws` probes for at runtime.
    "bufferutil",
    "utf-8-validate",
    ...builtins,
  ],
  // The web client's pure stream/transcript modules import each other via `@/`.
  alias: { "@": path.resolve(here, "../../web/src") },
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  logLevel: "info",
  plugins: [stylesPlugin],
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
