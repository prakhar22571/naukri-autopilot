import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('packaged app and isolated browser worker run without a Node installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autopilot-package-'))
  const app = await electron.launch({
    executablePath: resolve('release/win-unpacked/Naukri Autopilot.exe'),
    env: { ...process.env, LOCALAPPDATA: directory, PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Make your next move.' })).toBeVisible()
    const snapshot = await page.evaluate(() => window.autopilot.snapshot())
    expect(snapshot.settings.active).toBe(false)
    expect(snapshot.settings.dailyLimit).toBe(10)
    expect(snapshot.dataDirectory.startsWith(directory)).toBe(true)
    const workerReady = await app.evaluate(({ utilityProcess, app }) => new Promise<boolean>((resolveReady, reject) => {
      const child = utilityProcess.fork(`${app.getAppPath()}/out/main/worker.js`, [], { stdio: 'ignore' })
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Packaged browser worker did not initialize')) }, 15000)
      let ready = false
      child.on('message', message => {
        if (message.type === 'ready') { ready = true; clearTimeout(timeout); child.kill(); resolveReady(true) }
      })
      child.on('exit', () => { if (!ready) { clearTimeout(timeout); reject(new Error('Packaged browser worker exited before initialization')) } })
    }))
    expect(workerReady).toBe(true)
    await page.screenshot({ path: 'test-results/packaged-dashboard.png', fullPage: true })
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
