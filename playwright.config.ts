import { defineConfig } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
mkdirSync('.local', { recursive: true });
const data = mkdtempSync(path.resolve('.local/e2e-data-'));
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  use: {
    actionTimeout: 10000,
    baseURL: 'http://127.0.0.1:4319',
    channel: 'msedge',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --import tsx server/index.ts --dev',
    url: 'http://127.0.0.1:4319',
    reuseExistingServer: false,
    env: { PORT: '4319', CONTROL_CENTER_DATA_DIR: data },
    timeout: 30000,
  },
});
