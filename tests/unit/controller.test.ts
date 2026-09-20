import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/main/database'
import { Controller } from '../../src/main/controller'
import { SessionVault } from '../../src/main/session'
import { defaultSettings } from '../../src/shared/settings'
import type { WorkerMessage } from '../../src/shared/protocol'

const mocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({
  utilityProcess: { fork: mocks.fork },
  Notification: { isSupported: () => false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))
class Worker extends EventEmitter {
  messages: any[] = []
  postMessage(message: unknown) {
    this.messages.push(message)
  }
  kill() {
    this.emit('exit', 1)
    return true
  }
}
let store: Store, controller: Controller, directory: string, workers: Worker[]
const done: WorkerMessage = {
  type: 'done',
  status: 'succeeded',
  message: 'Fixture completed',
  steps: [],
  inspected: 0,
  submitted: 0,
  screenshotPath: null,
  evidenceNote: 'Fixture',
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'autopilot-controller-'))
  workers = []
  mocks.fork.mockImplementation(() => {
    const worker = new Worker()
    workers.push(worker)
    return worker
  })
  store = new Store(directory)
  const path = join(directory, 'resumes', 'resume.pdf')
  writeFileSync(path, 'fixture')
  store.set('resume', {
    name: 'resume.pdf',
    path,
    sha256: 'test',
    importedAt: new Date().toISOString(),
  })
  store.set('settings', {
    ...defaultSettings,
    filters: { ...defaultSettings.filters, titles: ['Developer'] },
  })
  new SessionVault(directory).write({ cookies: [], origins: [] })
  controller = new Controller(store, () => undefined)
})
afterEach(() => {
  if (controller.snapshot().activeRunId) workers.at(-1)?.emit('message', done)
  controller.shutdown()
  store.close()
  rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
})
describe('worker supervision and scheduling', () => {
  it('shares a single lock between manual workflows', async () => {
    await controller.start('profile')
    await expect(controller.start('applications')).rejects.toThrow('already running')
    expect(workers).toHaveLength(1)
    workers[0].emit('message', done)
    await controller.start('preview')
    expect(workers).toHaveLength(2)
  })
  it('claims a missed schedule once, without replaying every missed day', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-18T08:00:00Z'))
    store.set('settings', {
      ...store.settings(),
      active: true,
      applicationSchedule: { ...defaultSettings.applicationSchedule, enabled: false },
    })
    store.set('schedule:profile', '2026-09-01T00:00:00.000Z')
    await controller.tick()
    expect(workers).toHaveLength(1)
    expect(store.get('schedule:profile')).toBe('2026-09-18T03:30:00.000Z')
    workers[0].emit('message', done)
    await controller.tick()
    expect(workers).toHaveLength(1)
  })
  it('pauses scheduling when the browser requires attention', async () => {
    store.set('settings', { ...store.settings(), active: true })
    await controller.start('profile')
    workers[0].emit('message', { type: 'connection', connected: false, message: 'Session expired' })
    expect(store.settings().active).toBe(false)
    expect(controller.snapshot().connected).toBe(false)
  })
  it('asks the worker to stop and recovers a worker crash', async () => {
    await controller.start('profile')
    const id = controller.snapshot().activeRunId!
    controller.stop()
    expect(workers[0].messages.at(-1)).toEqual({ type: 'stop' })
    workers[0].emit('exit', 1)
    expect(controller.snapshot().activeRunId).toBeNull()
    expect(store.run(id)?.status).toBe('stopped')
  })
  it('retains saved sessions when access is blocked and remembers the problem after restart', async () => {
    store.set('settings', { ...store.settings(), active: true, backgroundBrowser: true })
    await controller.start('preview')
    workers[0].emit('message', { type: 'connection', connected: false, status: 'blocked', message: 'Access denied' })
    expect(controller.snapshot()).toMatchObject({ connected: false, connectionStatus: 'blocked', hasSavedSession: true })
    expect(store.settings()).toMatchObject({ active: false, backgroundBrowser: false })
    workers[0].emit('message', done)
    controller.shutdown()
    controller = new Controller(store, () => undefined)
    expect(controller.snapshot().connectionStatus).toBe('blocked')
    await controller.start('verify')
    expect(workers[1].messages[0]).toMatchObject({ workflow: 'verify', auth: { cookies: [], origins: [] } })
    workers[1].emit('message', { type: 'connection', connected: true, message: 'Verified' })
    expect(controller.snapshot().connectionStatus).toBe('connected')
    expect(store.settings().active).toBe(false)
  })
  it('does not present an unchecked saved session as verified', () => {
    expect(controller.snapshot()).toMatchObject({ connectionStatus: 'saved', hasSavedSession: true })
  })
  it('checks a connection without requiring a resume or job preferences', async () => {
    store.set('resume', null)
    store.set('settings', defaultSettings)
    await controller.start('verify')
    expect(workers[0].messages[0]).toMatchObject({ workflow: 'verify', resume: null })
  })
  it('fails a worker that never starts instead of leaving the UI running forever', async () => {
    vi.useFakeTimers()
    await controller.start('preview')
    vi.advanceTimersByTime(30_000)
    expect(controller.snapshot().activeRunId).toBeNull()
    expect(store.runs()[0].status).toBe('failed')
  })
  it('does not disconnect a saved session on a worker crash', async () => {
    await controller.start('preview')
    workers[0].emit('exit', 1)
    expect(controller.snapshot().hasSavedSession).toBe(true)
    expect(store.runs()[0].status).toBe('failed')
  })
})
