import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Unit tests run without the Obsidian app; UI-free modules never touch it,
      // and the few that do get this minimal stand-in.
      obsidian: resolve(__dirname, "test/obsidianMock.ts"),
      "@": resolve(__dirname, "../../web/src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
