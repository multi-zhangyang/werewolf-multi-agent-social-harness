import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "cockpitInteraction.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  use: {
    baseURL: process.env.PLAY_URL ?? "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  }
});
