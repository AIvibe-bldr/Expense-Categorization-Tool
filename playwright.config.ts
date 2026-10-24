import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3100",
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      GALAPAGOS_LOCAL_MODE: "1",
      GALAPAGOS_DATA_DIR: `/tmp/galapagos-e2e-${process.pid}`,
      APP_ORIGIN: "http://127.0.0.1:3100",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
