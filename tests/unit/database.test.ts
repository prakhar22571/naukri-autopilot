import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/main/database'
import { makeJob } from '../fixtures/data'
let store: Store, directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'autopilot-test-'))
  store = new Store(directory)
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})
describe('application ledger', () => {
  it('reserves daily capacity before submitting and prevents duplicates', () => {
    const run = store.createRun('applications', 'manual')
    store.saveJob(makeJob())
    const attempt = store.reserve(makeJob().id, run.id, 1, 'Asia/Kolkata')
    expect(attempt).not.toBeNull()
    expect(store.todayCount('Asia/Kolkata')).toBe(1)
    expect(store.reserve(makeJob().id, run.id, 1, 'Asia/Kolkata')).toBeNull()
    store.saveJob(makeJob({ id: 'second' }))
    expect(store.reserve('second', run.id, 1, 'Asia/Kolkata')).toBeNull()
  })
  it('releases a slot only when known not to have submitted', () => {
    const run = store.createRun('applications', 'manual')
    store.saveJob(makeJob())
    const id = store.reserve(makeJob().id, run.id, 10, 'UTC')!
    store.finishAttempt(id, 'not_submitted', 'Screening answer required')
    expect(store.todayCount('UTC')).toBe(0)
    expect(store.job(makeJob().id)?.status).toBe('attention')
  })
  it('recovers interrupted runs without submitting again', () => {
    const run = store.createRun('applications', 'manual')
    store.saveJob(makeJob())
    const id = store.reserve(makeJob().id, run.id, 10, 'UTC')!
    store.close()
    store = new Store(directory)
    store.recover()
    expect(store.job(makeJob().id)?.status).toBe('unknown')
    expect(store.run(run.id)?.status).toBe('failed')
    expect(store.todayCount('UTC')).toBe(1)
    store.saveJob(makeJob())
    expect(store.job(makeJob().id)?.status).toBe('unknown')
    expect(store.reserve(makeJob().id, run.id, 10, 'UTC')).toBeNull()
    store.finishAttempt(id, 'applied', 'Verified on Naukri')
    expect(store.job(makeJob().id)?.status).toBe('applied')
  })
  it('does not erase confirmed applications during new discovery', () => {
    store.saveJob(makeJob({ status: 'applied' }))
    store.saveJob(makeJob({ status: 'matched' }))
    expect(store.job(makeJob().id)?.status).toBe('applied')
  })
  it('uses parameterized SQL for job data', () => {
    const title = "Developer'); DROP TABLE jobs; --"
    store.saveJob(makeJob({ title }))
    expect(store.jobs()[0].title).toBe(title)
  })
  it('cleans screenshots without removing job deduplication history', () => {
    const run = store.createRun('profile', 'manual')
    const path = join(directory, 'screenshots', 'old.png')
    writeFileSync(path, 'fixture')
    const id = store.addArtifact(run.id, path)
    store.saveRun({ ...run, screenshotId: id })
    store.db.prepare('UPDATE artifacts SET created_at=?').run('2020-01-01T00:00:00.000Z')
    store.saveJob(makeJob({ status: 'applied' }))
    store.cleanupArtifacts(30)
    expect(existsSync(path)).toBe(false)
    expect(store.run(run.id)?.screenshotId).toBeNull()
    expect(store.job(makeJob().id)?.status).toBe('applied')
  })
})
