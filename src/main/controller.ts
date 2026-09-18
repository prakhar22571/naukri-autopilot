import { utilityProcess, Notification } from 'electron'
import type { UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from './database'
import { SessionVault } from './session'
import { dueOccurrence, nextOccurrence } from '../core/scheduling'
import type { Snapshot, Workflow } from '../shared/types'
import type { WorkerInput, WorkerMessage, WorkerRequest } from '../shared/protocol'

export class Controller {
  private child: UtilityProcess | null = null
  private activeRunId: string | null = null
  private progress = ''
  private timer: NodeJS.Timeout | null = null
  private stopTimer: NodeJS.Timeout | null = null
  private connected = false
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
      connectionMessage: this.connectionMessage,
      runs: this.store.runs(),
      jobs: this.store.jobs(),
      todayCount: this.store.todayCount(settings.timezone),
      activeRunId: this.activeRunId,
      nextProfile: settings.active
        ? nextOccurrence(settings.profileSchedule, settings.timezone)
        : null,
      nextApplications: settings.active
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
    const auth = workflow === 'connect' ? null : this.vault.read()
    const run = this.store.createRun(workflow, trigger)
    this.activeRunId = run.id
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
    child.on('message', (message: WorkerMessage) => {
      if (this.child !== child) return
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
          this.connected = message.connected
          this.connectionMessage = message.message
          if (!message.connected)
            this.store.set('settings', { ...this.store.settings(), active: false })
          this.notify()
        } else if (message.type === 'done') this.complete(message)
      } catch {
        // A session write failure must not be reported as a successful connection.
        this.connected = false
        this.connectionMessage = 'Could not save the encrypted session. Reconnect to try again.'
        this.store.set('settings', { ...this.store.settings(), active: false })
        child.postMessage({ type: 'stop' })
        this.notify()
      }
    })
    child.on('exit', () => {
      if (this.child !== child || !this.activeRunId) return
      this.complete({
        type: 'done',
        status: 'failed',
        message:
          'Browser worker exited unexpectedly. Pending submissions will be reconciled next time.',
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
    child.postMessage(input)
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
    this.connected = false
    this.connectionMessage = 'Disconnected. Saved login session removed.'
    this.store.set('settings', { ...this.store.settings(), active: false })
    this.notify()
  }
  shutdown(): void {
    if (this.timer) clearInterval(this.timer)
    this.stop()
  }
}
