import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

/**
 * Load the WebGL renderer onto *term*, returning the addon or ``null``
 * when WebGL is unavailable and the DOM renderer stays in use.
 *
 * xterm's default DOM renderer rebuilds spans on every paint, which
 * dominates the main thread on heavy output (large ``cat``, build logs,
 * a redrawing TUI); the WebGL renderer rasterizes glyphs on the GPU and
 * is dramatically faster for those bursts. Loaded *after*
 * {@link Terminal.open} because it needs the mounted ``<canvas>``. Both
 * the no-GPU and context-lost paths fall back to the DOM renderer rather
 * than freezing the canvas — see the inline comments below.
 */
export function loadWebglRenderer(term: Terminal): WebglAddon | null {
  let addon: WebglAddon;
  try {
    addon = new WebglAddon();
  } catch {
    return null;
  }
  // Dispose on context loss so xterm reverts to the DOM renderer; a
  // disposed WebGL addon left attached would freeze on its last frame.
  addon.onContextLoss(() => addon.dispose());
  try {
    term.loadAddon(addon);
  } catch {
    // WebGL unsupported in this environment (no GPU context, jsdom).
    // The DOM renderer stays active; correctness is unaffected.
    addon.dispose();
    return null;
  }
  return addon;
}
