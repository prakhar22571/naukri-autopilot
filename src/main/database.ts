import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { defaultSettings, settingsSchema } from '../shared/settings'
import { dayBounds } from '../core/scheduling'
import type {
  ApplicationAttempt,
  Artifact,
  Job,
  ResumeInfo,
  Run,
  Settings,
  Workflow,
} from '../shared/types'

export class Store {
  readonly db: Database.Database
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true })
    mkdirSync(join(directory, 'screenshots'), { recursive: true })
    mkdirSync(join(directory, 'resumes'), { recursive: true })
    this.db = new Database(join(directory, 'autopilot.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.transaction(() => {
      const version = this.db.pragma('user_version', { simple: true }) as number
      if (version > 1)
        throw new Error(
          'This database belongs to a newer app version. Install that version to continue.',
        )
      if (version < 1) {
        this.db.exec(`
          CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, data TEXT NOT NULL);
          CREATE TABLE jobs (id TEXT PRIMARY KEY, discovered_at TEXT NOT NULL, data TEXT NOT NULL);
          CREATE TABLE attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), run_id TEXT NOT NULL REFERENCES runs(id), attempted_at TEXT NOT NULL, status TEXT NOT NULL);
          CREATE INDEX attempts_date ON attempts(attempted_at, status);
          CREATE UNIQUE INDEX one_unresolved_attempt ON attempts(job_id) WHERE status IN ('submitting','applied','unknown');
          CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), path TEXT NOT NULL, created_at TEXT NOT NULL);
          PRAGMA user_version = 1;
        `)
      }
    })()
    if (!this.get('settings')) this.set('settings', defaultSettings)
    for (const workflow of ['profile', 'applications']) {
      if (!this.get(`schedule:${workflow}`))
        this.set(`schedule:${workflow}`, new Date().toISOString())
    }
  }
  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
      { value: string } | undefined
    return row ? JSON.parse(row.value) : null
  }
  set(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value))
  }
  settings(): Settings {
    return settingsSchema.parse(this.get('settings'))
  }
  resume(): ResumeInfo | null {
    return this.get('resume')
  }
  runs(): Run[] {
    return (
      this.db.prepare('SELECT data FROM runs ORDER BY started_at DESC LIMIT 1000').all() as {
        data: string
      }[]
    ).map((r) => JSON.parse(r.data))
  }
  run(id: string): Run | null {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id) as
      { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }
  saveRun(run: Run): void {
    this.db
      .prepare(
        'INSERT INTO runs(id,started_at,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(run.id, run.startedAt, JSON.stringify(run))
  }
  createRun(workflow: Workflow, trigger: Run['trigger']): Run {
    const run: Run = {
      id: randomUUID(),
      workflow,
      trigger,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      message: 'Starting browser',
      steps: [],
      submitted: 0,
      inspected: 0,
      screenshotId: null,
      evidenceNote: null,
    }
    this.saveRun(run)
    return run
  }
  jobs(): Job[] {
    return (
      this.db.prepare('SELECT data FROM jobs ORDER BY discovered_at DESC LIMIT 5000').all() as {
        data: string
      }[]
    ).map((r) => JSON.parse(r.data))
  }
  job(id: string): Job | null {
    const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id) as
      { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }
  saveJob(job: Job): void {
    const old = this.job(job.id)
    // Discovery must never erase the durable submission state.
    if (old && ['applied', 'submitting', 'unknown'].includes(old.status)) {
      job = { ...job, status: old.status, reasons: old.reasons }
    }
    this.writeJob(job)
  }
  private writeJob(job: Job): void {
    this.db
      .prepare(
        'INSERT INTO jobs(id,discovered_at,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(job.id, job.discoveredAt, JSON.stringify(job))
  }
  todayCount(zone: string, now = new Date()): number {
    const { start, end } = dayBounds(zone, now)
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM attempts WHERE attempted_at >= ? AND attempted_at < ? AND status IN ('submitting','applied','unknown')",
        )
        .get(start, end) as { count: number }
    ).count
  }
  reserve(jobId: string, runId: string, limit: number, zone: string): string | null {
    return this.db.transaction(() => {
      if (this.todayCount(zone) >= limit) return null
      const job = this.job(jobId)
      if (!job || job.status !== 'matched') return null
      if (
        this.db
          .prepare(
            "SELECT id FROM attempts WHERE job_id=? AND status IN ('submitting','applied','unknown')",
          )
          .get(jobId)
      )
        return null
      const id = randomUUID()
      this.db
        .prepare('INSERT INTO attempts VALUES (?,?,?,?,?)')
        .run(id, jobId, runId, new Date().toISOString(), 'submitting')
      this.writeJob({
        ...job,
        status: 'submitting',
        reasons: ['Submission started; waiting for confirmation'],
      })
      return id
    })()
  }
  finishAttempt(id: string, status: ApplicationAttempt['status'], reason: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT job_id FROM attempts WHERE id=?').get(id) as
        { job_id: string } | undefined
      if (!row) throw new Error('Application attempt not found')
      this.db.prepare('UPDATE attempts SET status=? WHERE id=?').run(status, id)
      const job = this.job(row.job_id)!
      this.writeJob({
        ...job,
        status: status === 'not_submitted' ? 'attention' : status,
        reasons: [reason],
      })
    })()
  }
  unresolved(): Array<{ id: string; job: Job }> {
    return (
      this.db
        .prepare("SELECT id,job_id FROM attempts WHERE status IN ('submitting','unknown')")
        .all() as { id: string; job_id: string }[]
    ).map((a) => ({ id: a.id, job: this.job(a.job_id)! }))
  }
  recover(): void {
    this.db.transaction(() => {
      for (const attempt of this.unresolved())
        this.finishAttempt(
          attempt.id,
          'unknown',
          'Interrupted submission. Naukri status must be verified before retrying.',
        )
      for (const run of this.runs().filter((r) => r.status === 'running'))
        this.saveRun({
          ...run,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          message: 'The app closed before this run finished.',
          evidenceNote: run.screenshotId ? null : 'Browser was unavailable after interruption.',
        })
    })()
  }
  artifact(id: string): Artifact | null {
    const row = this.db
      .prepare('SELECT id,run_id AS runId,path,created_at AS createdAt FROM artifacts WHERE id=?')
      .get(id) as Artifact | undefined
    return row ?? null
  }
  addArtifact(runId: string, path: string): string {
    const root = resolve(this.directory, 'screenshots') + sep
    if (!resolve(path).startsWith(root) || !existsSync(path))
      throw new Error('Invalid screenshot path')
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO artifacts VALUES (?,?,?,?)')
      .run(id, runId, path, new Date().toISOString())
    return id
  }
  cleanupArtifacts(days: number): void {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
    const rows = this.db
      .prepare('SELECT id,path,run_id AS runId FROM artifacts WHERE created_at < ?')
      .all(cutoff) as { id: string; path: string; runId: string }[]
    const root = resolve(this.directory, 'screenshots') + sep
    for (const row of rows) {
      if (!resolve(row.path).startsWith(root)) continue
      try {
        if (existsSync(row.path)) unlinkSync(row.path)
      } catch {
        continue
      }
      this.db.prepare('DELETE FROM artifacts WHERE id=?').run(row.id)
      const run = this.run(row.runId)
      if (run?.screenshotId === row.id)
        this.saveRun({
          ...run,
          screenshotId: null,
          evidenceNote: 'Screenshot removed under your retention setting.',
        })
    }
  }
  close(): void {
    this.db.close()
  }
}
