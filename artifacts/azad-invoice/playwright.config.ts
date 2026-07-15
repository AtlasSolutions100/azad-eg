import { defineConfig } from "@playwright/test";
import { execSync } from "node:child_process";

// The dev proxy serves the web app at "/" and the API at "/api".
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:80";

// Playwright's bundled Chromium does not run on NixOS; use the system one.
function systemChromium(): string | undefined {
  if (process.env.E2E_CHROMIUM_PATH) return process.env.E2E_CHROMIUM_PATH;
  try {
    return execSync("which chromium").toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global.setup.ts",
  use: {
    baseURL,
    launchOptions: { executablePath: systemChromium() },
    screenshot: "only-on-failure",
  },
});
