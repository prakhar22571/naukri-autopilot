import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { defaultSettings } from '../../src/shared/settings'
import type { WorkerInput, WorkerMessage } from '../../src/shared/protocol'

const adapter = vi.hoisted(() => ({
  open: vi.fn(), login: vi.fn(), verifySession: vi.fn(), state: vi.fn(), close: vi.fn(),
  screenshot: vi.fn(), uploadResume: vi.fn(), discover: vi.fn(), apply: vi.fn(),
}))
vi.mock('../../src/automation/naukri', () => {
  class AttentionError extends Error {}
  class StructureError extends Error {}
  return {
    NaukriAdapter: class { constructor() { return adapter } },
    AttentionError, ChallengeError: class extends AttentionError {}, StructureError,
    SubmissionNotStartedError: class extends StructureError {}, StoppedError: class extends Error {},
  }
})
import { AttentionError, ChallengeError, StructureError } from '../../src/automation/naukri'

let port: EventEmitter & { postMessage: (message: WorkerMessage) => void }
let messages: WorkerMessage[]
const previousPort = Object.getOwnPropertyDescriptor(process, 'parentPort')
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  messages = []
  for (const method of Object.values(adapter)) method.mockReset()
  adapter.state.mockResolvedValue({ cookies: [], origins: [] })
  adapter.close.mockResolvedValue(undefined)
  adapter.screenshot.mockResolvedValue(null)
  port = Object.assign(new EventEmitter(), {
    postMessage(message: WorkerMessage) {
      messages.push(message)
      if (message.type === 'rpc') queueMicrotask(() => port.emit('message', { data: { type: 'reply', id: message.id, result: true } }))
    },
  })
  Object.defineProperty(process, 'parentPort', { configurable: true, value: port })
  await import('../../src/automation/worker')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  if (previousPort) Object.defineProperty(process, 'parentPort', previousPort)
  else Reflect.deleteProperty(process, 'parentPort')
})

async function run(workflow: WorkerInput['workflow'] = 'verify') {
  const input: WorkerInput = {
    type: 'start', runId: 'fixture', workflow, settings: { ...defaultSettings, backgroundBrowser: true },
    auth: { cookies: [], origins: [] }, resume: null, screenshotPath: 'fixture.png',
    headlineIndex: 0, unresolved: [], retryJobs: [],
  }
  port.emit('message', { data: input })
  // Flush promise continuations without advancing the worker's process-exit timer.
  for (let i = 0; i < 100 && !messages.some((m) => m.type === 'done'); i++) await Promise.resolve()
  const result = messages.find((m) => m.type === 'done')
  expect(result).toBeDefined()
  return result
}

it('connection check opens visible Chrome and never uploads or applies', async () => {
  expect(await run()).toMatchObject({ status: 'succeeded', inspected: 0, submitted: 0 })
  expect(adapter.open).toHaveBeenCalledWith({ cookies: [], origins: [] }, false)
  expect(adapter.uploadResume).not.toHaveBeenCalled()
  expect(adapter.discover).not.toHaveBeenCalled()
  expect(adapter.apply).not.toHaveBeenCalled()
  expect(messages).toContainEqual(expect.objectContaining({ type: 'rpc', request: { method: 'saveSession', state: { cookies: [], origins: [] } } }))
})

it.each([
  [new ChallengeError('Access denied'), 'blocked'],
  [new AttentionError('Session expired'), 'expired'],
  [new StructureError('Unsupported profile'), 'attention'],
])('reports the distinct connection failure: %s', async (error, status) => {
  adapter.verifySession.mockRejectedValue(error)
  expect(await run('preview')).toMatchObject({ status: 'attention' })
  expect(messages).toContainEqual(expect.objectContaining({ type: 'connection', connected: false, status }))
  expect(adapter.discover).not.toHaveBeenCalled()
  expect(adapter.state).not.toHaveBeenCalled()
  expect(adapter.close).toHaveBeenCalled()
})

it('reports completion even if browser cleanup fails', async () => {
  adapter.close.mockRejectedValue(new Error('Already closed'))
  expect(await run()).toMatchObject({ status: 'succeeded' })
})
