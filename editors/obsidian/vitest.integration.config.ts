import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: resolve(__dirname, "test/obsidianMock.ts"),
      "@": resolve(__dirname, "../../web/src"),
    },
  },
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
