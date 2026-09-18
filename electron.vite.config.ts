import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts'), worker: resolve('src/automation/worker.ts') },
      },
    },
  },
  preload: {},
  renderer: {
    plugins: [
      react(),
      {
        name: 'development-csp',
        apply: 'serve',
        transformIndexHtml(html) {
          return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        },
      },
    ],
  },
})
