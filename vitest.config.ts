import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Deterministic unit/integration suite only. Playwright e2e lives under
    // `e2e/` and must be run with `npm run test:e2e`, not Vitest discovery.
    include: ["tests/**/*.{test,spec}.{ts,tsx,js,jsx}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "e2e/**",
      "**/e2e/**",
      "**/*.e2e.*"
    ]
  }
});
