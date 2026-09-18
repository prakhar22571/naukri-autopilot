import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/desktop',
  timeout: 60_000,
  workers: 1,
  use: { trace: 'off' },
  reporter: 'list',
})
