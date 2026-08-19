import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Test-only vite config: tests run in a plain node environment without the
 * React/Tailwind plugin chain. The "@" alias mirrors vite.config.ts so test
 * files may import frontend-adjacent modules with the same paths.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 60_000
  }
});