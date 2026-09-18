export type Workflow = 'profile' | 'applications' | 'preview' | 'connect'
export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'stopped' | 'attention'
export type JobStatus =
  'matched' | 'rejected' | 'attention' | 'submitting' | 'applied' | 'unknown' | 'closed'
export interface Schedule {
  enabled: boolean
  time: string
  days: number[]
}
export interface JobFilters {
  titles: string[]
  requiredSkills: string[]
  preferredSkills: string[]
  experienceYears: number | null
  locations: string[]
  workModes: ('remote' | 'hybrid' | 'office')[]
  minimumSalaryLpa: number | null
  maximumAgeDays: number
  excludedCompanies: string[]
  excludedKeywords: string[]
}
export interface CandidateFacts {
  totalExperience: number | null
  currentCtc: number | null
  expectedCtc: number | null
  noticePeriodDays: number | null
  currentLocation: string
}
export interface SavedAnswer {
  id: string
  question: string
  type: 'text' | 'select' | 'radio'
  options: string[]
  answer: string
}
export interface Settings {
  active: boolean
  launchAtLogin: boolean
  backgroundBrowser: boolean
  timezone: string
  dailyLimit: number
  screenshotRetentionDays: number
  profileSchedule: Schedule
  applicationSchedule: Schedule
  headlines: string[]
  rotateHeadlines: boolean
  filters: JobFilters
  candidate: CandidateFacts
  answers: SavedAnswer[]
}
export interface ResumeInfo {
  name: string
  path: string
  sha256: string
  importedAt: string
}
export interface Job {
  id: string
  url: string
  title: string
  company: string
  description: string
  skills: string[]
  locations: string[]
  workMode: 'remote' | 'hybrid' | 'office' | null
  experienceMin: number | null
  experienceMax: number | null
  salaryMinLpa: number | null
  salaryMaxLpa: number | null
  postedAt: string | null
  discoveredAt: string
  status: JobStatus
  reasons: string[]
  question?: ScreeningQuestion
  externalUrl?: string
}
export interface ScreeningQuestion {
  question: string
  type: 'text' | 'select' | 'radio'
  options: string[]
}
export interface MatchResult {
  status: 'matched' | 'rejected' | 'attention'
  reasons: string[]
  preferredMatches: number
}
export interface StepResult {
  name: string
  status: 'succeeded' | 'failed' | 'skipped' | 'unknown'
  message: string
}
export interface Run {
  id: string
  workflow: Workflow
  trigger: 'manual' | 'scheduled'
  startedAt: string
  finishedAt: string | null
  status: RunStatus
  message: string
  steps: StepResult[]
  submitted: number
  inspected: number
  screenshotId: string | null
  evidenceNote: string | null
}
export interface ApplicationAttempt {
  id: string
  jobId: string
  runId: string
  attemptedAt: string
  status: 'submitting' | 'applied' | 'unknown' | 'not_submitted'
}
export interface Artifact {
  id: string
  runId: string
  path: string
  createdAt: string
}
export interface Snapshot {
  settings: Settings
  resume: ResumeInfo | null
  connected: boolean
  connectionMessage: string
  runs: Run[]
  jobs: Job[]
  todayCount: number
  activeRunId: string | null
  nextProfile: string | null
  nextApplications: string | null
  progress: string
  dataDirectory: string
}
export interface AutopilotAPI {
  snapshot(): Promise<Snapshot>
  saveSettings(settings: Settings): Promise<void>
  importResume(): Promise<ResumeInfo | null>
  start(workflow: Workflow): Promise<void>
  stop(): Promise<void>
  disconnect(): Promise<void>
  openDataFolder(): Promise<void>
  openJob(jobId: string): Promise<void>
  screenshot(id: string): Promise<string>
  onChange(callback: () => void): () => void
}
