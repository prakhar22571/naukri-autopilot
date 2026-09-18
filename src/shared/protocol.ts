import type { Job, ResumeInfo, Run, Settings, StepResult, Workflow } from './types'
import type { BrowserContext } from 'playwright-core'

export type AuthState = Awaited<ReturnType<BrowserContext['storageState']>>
export interface WorkerInput {
  type: 'start'
  runId: string
  workflow: Workflow
  settings: Settings
  resume: ResumeInfo | null
  auth: AuthState | null
  screenshotPath: string
  headlineIndex: number
  unresolved: { id: string; job: Job }[]
  retryJobs: Job[]
}
export type WorkerRequest =
  | { method: 'saveSession'; state: AuthState }
  | { method: 'saveJob'; job: Job }
  | { method: 'reserve'; jobId: string }
  | { method: 'remainingAllowance' }
  | {
      method: 'finishAttempt'
      attemptId: string
      status: 'applied' | 'unknown' | 'not_submitted'
      reason: string
    }
  | { method: 'headlineIndex'; value: number }
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'rpc'; id: number; request: WorkerRequest }
  | { type: 'progress'; message: string }
  | { type: 'connection'; connected: boolean; message: string }
  | {
      type: 'done'
      status: Run['status']
      message: string
      steps: StepResult[]
      inspected: number
      submitted: number
      screenshotPath: string | null
      evidenceNote: string | null
    }
