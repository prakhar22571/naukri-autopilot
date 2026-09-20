import { utilityProcess, Notification } from 'electron'
import type { UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from './database'
import { SessionVault } from './session'
import { dueOccurrence, nextOccurrence } from '../core/scheduling'
import type { ConnectionStatus, Snapshot, Workflow } from '../shared/types'
import type { WorkerInput, WorkerMessage, WorkerRequest } from '../shared/protocol'

export class Controller {
  private child: UtilityProcess | null = null
  private activeRunId: string | null = null
  private progress = ''
  private timer: NodeJS.Timeout | null = null
  private stopTimer: NodeJS.Timeout | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private stopping = false
  private connected = false
  private connectionStatus: ConnectionStatus = 'disconnected'
  private connectionMessage = 'Connect your Naukri account to get started.'
  readonly vault: SessionVault
  constructor(
    readonly store: Store,
    private readonly notify: () => void,
  ) {
    this.vault = new SessionVault(store.directory)
    this.connectionMessage = this.vault.exists()
      ? 'Saved session available. It will be verified on the next run.'
      : this.connectionMessage
    this.connected = this.vault.exists()
    this.connectionStatus = this.connected ? 'saved' : 'disconnected'
    let previous = store.get<{ status: ConnectionStatus; message: string }>('connection')
    // Upgrade the old error format without treating an access denial as a lost login.
    const latest = store.runs()[0]
    if (!previous && this.connected && latest?.status === 'attention' &&
      latest.message === 'Naukri needs your attention. Reconnect in the visible browser to resolve the challenge.') {
      previous = { status: 'blocked', message: 'Naukri blocked the previous browser run. Your saved login is retained. Use Check connection in visible Chrome before resuming autopilot.' }
      store.set('connection', previous)
      store.set('settings', { ...store.settings(), active: false, backgroundBrowser: false })
    }
    if (this.connected && previous && ['expired', 'blocked', 'attention'].includes(previous.status)) {
      this.connectionStatus = previous.status
      this.connectionMessage = previous.message
      this.connected = false
    }
    store.recover()
    store.cleanupArtifacts(store.settings().screenshotRetentionDays)
  }
  startScheduler(): void {
    this.timer = setInterval(() => {
      void this.tick()
    }, 15_000)
    void this.tick()
  }
  async tick(): Promise<void> {
    if (this.activeRunId) return
    const settings = this.store.settings()
    if (!settings.active || !this.connected) return
    for (const workflow of ['profile', 'applications'] as const) {
      const schedule =
        workflow === 'profile' ? settings.profileSchedule : settings.applicationSchedule
      const due = dueOccurrence(
        schedule,
        settings.timezone,
        this.store.get<string>(`schedule:${workflow}`)!,
      )
      if (!due) continue
      // Claim first, including failures, so unavailable resources never cause a tight retry loop.
      this.store.set(`schedule:${workflow}`, due)
      try {
        await this.start(workflow, 'scheduled')
      } catch (error) {
        const run = this.store.createRun(workflow, 'scheduled')
        this.store.saveRun({
          ...run,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : 'Could not start run',
          evidenceNote: 'Browser did not start.',
        })
        this.notify()
      }
      return
    }
  }
  snapshot(): Snapshot {
    const settings = this.store.settings()
    return {
      settings,
      resume: this.store.resume(),
      connected: this.connected,
      connectionStatus: this.connectionStatus,
      hasSavedSession: this.vault.exists(),
      connectionMessage: this.connectionMessage,
      runs: this.store.runs(),
      jobs: this.store.jobs(),
      todayCount: this.store.todayCount(settings.timezone),
      activeRunId: this.activeRunId,
      nextProfile: settings.active && this.connected
        ? nextOccurrence(settings.profileSchedule, settings.timezone)
        : null,
      nextApplications: settings.active && this.connected
        ? nextOccurrence(settings.applicationSchedule, settings.timezone)
        : null,
      progress: this.progress,
      dataDirectory: this.store.directory,
    }
  }
  async start(workflow: Workflow, trigger: 'manual' | 'scheduled' = 'manual'): Promise<void> {
    if (this.activeRunId)
      throw new Error('A browser task is already running. Wait for it to finish or press Stop.')
    const settings = this.store.settings(),
      resume = this.store.resume()
    if (workflow !== 'connect' && !this.vault.exists()) throw new Error('Connect to Naukri first.')
    if (
      (workflow === 'profile' || workflow === 'applications') &&
      (!resume || !existsSync(resume.path))
    )
      throw new Error('Choose a resume in Profile before starting.')
    if ((workflow === 'applications' || workflow === 'preview') && !settings.filters.titles.length)
      throw new Error('Add at least one target role in Settings.')
    if (
      workflow === 'applications' &&
      this.store.todayCount(settings.timezone) >= settings.dailyLimit &&
      !this.store.unresolved().length
    )
      throw new Error(
        'Your daily application allowance has been used. Unknown outcomes also reserve a slot.',
      )
    let auth = null
    try {
      auth = this.vault.read()
    } catch (error) {
      if (workflow !== 'connect') {
        this.setConnection('expired', error instanceof Error ? error.message : 'Reconnect to Naukri.')
        throw error
      }
    }
    const run = this.store.createRun(workflow, trigger)
    this.activeRunId = run.id
    this.stopping = false
    this.progress =
      workflow === 'connect'
        ? 'Log in directly in the Chrome window. This app does not read your password.'
        : 'Opening Naukri…'
    this.notify()
    let child: UtilityProcess
    try {
      child = utilityProcess.fork(join(__dirname, 'worker.js'), [], {
        stdio: 'ignore',
        serviceName: 'Naukri browser worker',
      })
    } catch {
      this.complete({
        type: 'done',
        status: 'failed',
        message: 'Browser worker could not start.',
        steps: [],
        inspected: 0,
        submitted: 0,
        screenshotPath: null,
        evidenceNote: 'No browser was available.',
      })
      return
    }
    this.child = child
    this.startupTimer = setTimeout(() => {
      if (this.child !== child) return
      child.kill()
      if (this.activeRunId) this.complete({
        type: 'done', status: 'failed', message: 'The browser worker did not become ready. Try again.',
        steps: [], inspected: 0, submitted: 0, screenshotPath: null, evidenceNote: 'Browser worker startup timed out.',
      })
    }, 30_000)
    child.on('message', (message: WorkerMessage) => {
      if (this.child !== child) return
      if (this.startupTimer) {
        clearTimeout(this.startupTimer)
        this.startupTimer = null
      }
      try {
        if (message.type === 'rpc') {
          try {
            child.postMessage({
              type: 'reply',
              id: message.id,
              result: this.handleRequest(message.request),
            })
          } catch (error) {
            child.postMessage({
              type: 'reply',
              id: message.id,
              error: error instanceof Error ? error.message : 'Local persistence failed',
            })
          }
        } else if (message.type === 'progress') {
          this.progress = message.message
          this.notify()
        } else if (message.type === 'connection') {
          this.setConnection(message.status ?? (message.connected ? 'connected' : 'expired'), message.message)
        } else if (message.type === 'done') this.complete(message)
      } catch {
        // A session write failure must not be reported as a successful connection.
        this.progress = 'Could not process a browser update. Stopping the run; review its details.'
        this.stop()
      }
    })
    child.on('exit', () => {
      if (this.child !== child || !this.activeRunId) return
      this.complete({
        type: 'done',
        status: this.stopping ? 'stopped' : 'failed',
        message:
          this.stopping ? 'Stopped by you. Pending submissions will be checked before retrying.' : 'Browser worker exited unexpectedly. Pending submissions will be reconciled next time.',
        steps: [],
        inspected: 0,
        submitted: 0,
        screenshotPath: null,
        evidenceNote: 'Browser exited before evidence could be saved.',
      })
    })
    const input: WorkerInput = {
      type: 'start',
      runId: run.id,
      workflow,
      settings,
      resume,
      auth,
      screenshotPath: join(this.store.directory, 'screenshots', `${run.id}.png`),
      headlineIndex: this.store.get<number>('headlineIndex') ?? 0,
      unresolved: this.store.unresolved(),
      retryJobs: this.store
        .jobs()
        .filter((j) => ['attention', 'matched'].includes(j.status))
        .slice(0, 100),
    }
    try {
      child.postMessage(input)
    } catch {
      this.complete({ type: 'done', status: 'failed', message: 'Could not send the task to the browser worker. Try again.', steps: [], inspected: 0, submitted: 0, screenshotPath: null, evidenceNote: 'Browser worker communication failed.' })
      child.kill()
    }
  }
  private setConnection(status: ConnectionStatus, message: string): void {
    this.connectionStatus = status
    this.connected = status === 'connected' || status === 'saved'
    const settings = this.store.settings()
    if (status === 'blocked' && settings.backgroundBrowser)
      message += ' Background browsing has been turned off for the next run.'
    this.connectionMessage = message
    this.store.set('connection', { status, message })
    if (!this.connected)
      this.store.set('settings', { ...settings, active: false, backgroundBrowser: status === 'blocked' ? false : settings.backgroundBrowser })
    this.notify()
  }
  private handleRequest(request: WorkerRequest): unknown {
    if (!this.activeRunId) throw new Error('Run is no longer active')
    switch (request.method) {
      case 'saveSession':
        this.vault.write(request.state)
        return true
      case 'saveJob':
        this.store.saveJob(request.job)
        this.notify()
        return true
      case 'reserve': {
        const settings = this.store.settings()
        const result = this.store.reserve(
          request.jobId,
          this.activeRunId,
          settings.dailyLimit,
          settings.timezone,
        )
        this.notify()
        return result
      }
      case 'remainingAllowance': {
        const settings = this.store.settings()
        return Math.max(0, settings.dailyLimit - this.store.todayCount(settings.timezone))
      }
      case 'finishAttempt':
        this.store.finishAttempt(request.attemptId, request.status, request.reason)
        this.notify()
        return true
      case 'headlineIndex':
        this.store.set('headlineIndex', request.value)
        return true
    }
  }
  private complete(result: Extract<WorkerMessage, { type: 'done' }>): void {
    const run = this.activeRunId ? this.store.run(this.activeRunId) : null
    if (!run) return
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    let screenshotId: string | null = null
    let evidenceNote = result.evidenceNote
    if (result.screenshotPath) {
      try {
        screenshotId = this.store.addArtifact(run.id, result.screenshotPath)
      } catch {
        evidenceNote = 'Screenshot file was unavailable.'
      }
    }
    for (const unresolved of this.store.unresolved())
      this.store.finishAttempt(
        unresolved.id,
        'unknown',
        'Submission outcome requires verification before retrying.',
      )
    this.store.saveRun({
      ...run,
      ...result,
      id: run.id,
      screenshotId,
      evidenceNote,
      finishedAt: new Date().toISOString(),
    })
    this.activeRunId = null
    this.child = null
    this.progress = result.message
    this.store.cleanupArtifacts(this.store.settings().screenshotRetentionDays)
    if (['failed', 'attention', 'partial'].includes(result.status) && Notification.isSupported())
      new Notification({ title: 'Naukri Autopilot', body: result.message }).show()
    this.notify()
  }
  stop(): void {
    this.stopping = true
    this.child?.postMessage({ type: 'stop' })
    if (this.child && !this.stopTimer) {
      this.progress = 'Stopping after the current action is checked…'
      this.notify()
      this.stopTimer = setTimeout(() => this.child?.kill(), 45_000)
    }
  }
  disconnect(): void {
    if (this.activeRunId) throw new Error('Stop the current run before disconnecting.')
    this.vault.clear()
    this.setConnection('disconnected', 'Disconnected. Saved login session removed.')
  }
  shutdown(): void {
    if (this.timer) clearInterval(this.timer)
    this.stop()
  }
}
