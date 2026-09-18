import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  dialog,
  Tray,
  Menu,
  nativeImage,
  shell,
  powerMonitor,
} from 'electron'
import { basename, extname, join, resolve, sep } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { Store } from './database'
import { Controller } from './controller'
import { settingsSchema } from '../shared/settings'
import { isNaukriUrl } from '../automation/parsing'
import type { ResumeInfo } from '../shared/types'

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])
app.setAppUserModelId('local.naukri.autopilot')
let window: BrowserWindow | null = null,
  tray: Tray | null = null,
  controller: Controller,
  store: Store,
  quitting = false
const testing = process.env.AUTOPILOT_TEST === '1' && !app.isPackaged
const dataDirectory =
  testing && process.env.AUTOPILOT_TEST_DATA
    ? resolve(process.env.AUTOPILOT_TEST_DATA)
    : join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'NaukriAutopilot')
const assetsDirectory = app.isPackaged
  ? join(process.resourcesPath, 'assets')
  : resolve(__dirname, '../../resources')
app.setPath('userData', dataDirectory)
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

function changed(): void {
  if (window && !window.isDestroyed()) window.webContents.send('autopilot:changed')
  updateTray()
}
function showWindow(): void {
  if (window && !window.isDestroyed()) {
    window.show()
    window.focus()
    return
  }
  window = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 1050,
    minHeight: 700,
    show: false,
    title: 'Naukri Autopilot',
    icon: join(assetsDirectory, 'icon.ico'),
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!trustedUrl(url)) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  window.once('ready-to-show', () => {
    if (!process.argv.includes('--background') || testing) window?.show()
  })
  window.on('close', (event) => {
    if (!quitting && !testing) {
      event.preventDefault()
      window?.hide()
    }
  })
  window.on('closed', () => {
    window = null
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadURL('app://autopilot/index.html')
}
function trustedUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.origin === 'null' && url.protocol === 'app:' && url.hostname === 'autopilot')
      return true
    if (url.protocol === 'app:' && url.hostname === 'autopilot') return true
    return (
      !app.isPackaged &&
      !!process.env.ELECTRON_RENDERER_URL &&
      url.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    )
  } catch {
    return false
  }
}
function updateTray(): void {
  if (!tray || !controller) return
  const active = store.settings().active
  tray.setToolTip(`Naukri Autopilot · ${active ? 'Active' : 'Paused'}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open dashboard', click: showWindow },
      {
        label: 'Pause autopilot',
        enabled: active,
        click: () => {
          store.set('settings', { ...store.settings(), active: false })
          controller.stop()
          changed()
        },
      },
      {
        label: 'Stop current run',
        enabled: !!controller.snapshot().activeRunId,
        click: () => controller.stop(),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}
function registerIPC(): void {
  const handle = (name: string, callback: (...args: any[]) => unknown) =>
    ipcMain.handle(`autopilot:${name}`, (event, ...args) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !trustedUrl(event.senderFrame.url)
      )
        throw new Error('Untrusted caller')
      return callback(...args)
    })
  handle('snapshot', () => controller.snapshot())
  handle('saveSettings', (raw: unknown) => {
    const parsed = settingsSchema.safeParse(raw)
    if (!parsed.success) throw new Error(parsed.error.issues[0].message)
    const settings = parsed.data,
      previous = store.settings()
    if (settings.active) {
      if (!controller.snapshot().connected)
        throw new Error('Connect your Naukri account before starting autopilot.')
      if (
        (settings.profileSchedule.enabled || settings.applicationSchedule.enabled) &&
        !store.resume()
      )
        throw new Error('Choose a resume in Profile first.')
    }
    if (settings.launchAtLogin !== previous.launchAtLogin && !testing) {
      if (!app.isPackaged && settings.launchAtLogin)
        throw new Error('Launch at login is available in the installed app.')
      app.setLoginItemSettings({
        openAtLogin: settings.launchAtLogin,
        path: process.execPath,
        args: ['--background'],
      })
    }
    const now = new Date().toISOString()
    for (const workflow of ['profile', 'applications'] as const) {
      const key = workflow === 'profile' ? 'profileSchedule' : 'applicationSchedule'
      if (
        (!previous.active && settings.active) ||
        JSON.stringify(settings[key]) !== JSON.stringify(previous[key]) ||
        settings.timezone !== previous.timezone
      )
        store.set(`schedule:${workflow}`, now)
    }
    store.set('settings', settings)
    if (controller.snapshot().activeRunId && JSON.stringify(previous) !== JSON.stringify(settings))
      controller.stop()
    store.cleanupArtifacts(settings.screenshotRetentionDays)
    changed()
  })
  handle('importResume', async (): Promise<ResumeInfo | null> => {
    if (controller.snapshot().activeRunId)
      throw new Error('Wait for the current run to finish before replacing the resume.')
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose your resume',
      filters: [{ name: 'Resume', extensions: ['pdf', 'doc', 'docx'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const source = result.filePaths[0],
      extension = extname(source).toLowerCase()
    if (!['.pdf', '.doc', '.docx'].includes(extension))
      throw new Error('Choose a PDF, DOC, or DOCX resume.')
    const size = statSync(source).size
    if (size === 0 || size > 10 * 1024 * 1024)
      throw new Error(
        'Choose a non-empty resume under 10 MB. Naukri may enforce a smaller upload limit.',
      )
    const sha256 = createHash('sha256').update(readFileSync(source)).digest('hex')
    const directory = join(dataDirectory, 'resumes', sha256)
    mkdirSync(directory, { recursive: true })
    const target = join(directory, basename(source))
    if (resolve(source) !== resolve(target)) copyFileSync(source, target)
    const resume = {
      name: basename(source),
      path: target,
      sha256,
      importedAt: new Date().toISOString(),
    }
    store.set('resume', resume)
    changed()
    return resume
  })
  handle('start', (workflow: unknown) =>
    controller.start(z.enum(['profile', 'applications', 'preview', 'connect']).parse(workflow)),
  )
  handle('stop', () => controller.stop())
  handle('disconnect', () => controller.disconnect())
  handle('openDataFolder', async () => {
    const error = await shell.openPath(dataDirectory)
    if (error) throw new Error('Could not open the data folder.')
  })
  handle('openJob', async (raw: unknown) => {
    const job = store.job(z.string().max(100).parse(raw))
    if (!job || !isNaukriUrl(job.url)) throw new Error('Job link is unavailable.')
    await shell.openExternal(job.url)
  })
  handle('screenshot', (raw: unknown) => {
    const artifact = store.artifact(z.string().uuid().parse(raw))
    const root = resolve(dataDirectory, 'screenshots') + sep
    if (!artifact || !resolve(artifact.path).startsWith(root) || !existsSync(artifact.path))
      throw new Error('This screenshot is no longer available.')
    return `data:image/png;base64,${readFileSync(artifact.path).toString('base64')}`
  })
}
if (gotLock) {
  app.on('second-instance', showWindow)
  app
    .whenReady()
    .then(() => {
      const rendererRoot = resolve(__dirname, '../renderer')
      protocol.handle('app', (request) => {
        const url = new URL(request.url)
        if (url.hostname !== 'autopilot') return new Response('Not found', { status: 404 })
        let path: string
        try {
          path = resolve(
            rendererRoot,
            `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`,
          )
        } catch {
          return new Response('Invalid path', { status: 400 })
        }
        if (!path.startsWith(rendererRoot + sep)) return new Response('Forbidden', { status: 403 })
        return net.fetch(pathToFileURL(path).toString())
      })
      store = new Store(dataDirectory)
      controller = new Controller(store, changed)
      registerIPC()
      const icon = nativeImage.createFromPath(join(assetsDirectory, 'tray.png'))
      tray = new Tray(icon)
      tray.on('double-click', showWindow)
      updateTray()
      showWindow()
      if (!testing) controller.startScheduler()
      powerMonitor.on('resume', () => {
        void controller.tick()
      })
    })
    .catch((error) => {
      dialog.showErrorBox(
        'Naukri Autopilot could not start',
        error instanceof Error ? error.message : 'Initialization failed.',
      )
      app.exit(1)
    })
}
app.on('before-quit', (event) => {
  if (controller?.snapshot().activeRunId) {
    event.preventDefault()
    quitting = true
    controller.shutdown()
    const interval = setInterval(() => {
      if (!controller.snapshot().activeRunId) {
        clearInterval(interval)
        app.quit()
      }
    }, 250)
    return
  }
  quitting = true
  controller?.shutdown()
})
app.on('will-quit', () => {
  store?.close()
  tray?.destroy()
})
app.on('window-all-closed', () => {
  if (testing) app.quit()
})
app.on('activate', showWindow)
