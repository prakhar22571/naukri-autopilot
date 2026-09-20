import { describe, expect, it } from 'vitest'
import { containsTerm, matchJob, rankJobs } from '../../src/core/matching'
import {
  parseExperience,
  parseSalary,
  parsePostingDate,
  jobIdFromUrl,
} from '../../src/automation/parsing'
import { resolveAnswer } from '../../src/core/answers'
import { defaultSettings, settingsSchema } from '../../src/shared/settings'
import { filters, makeJob, now } from '../fixtures/data'

describe('job eligibility', () => {
  it('requires all configured conditions and explains matches', () => {
    expect(matchJob(makeJob(), filters, now)).toMatchObject({
      status: 'matched',
      reasons: expect.arrayContaining(['Experience fits', 'Location matches']),
    })
  })
  it('supports title alternatives and case-insensitive terms', () => {
    expect(
      matchJob(
        makeJob({ title: 'REACT ENGINEER' }),
        { ...filters, titles: ['Frontend Developer', 'React Engineer'] },
        now,
      ).status,
    ).toBe('matched')
  })
  it('does not confuse Java with JavaScript, and recognizes punctuation in skills', () => {
    expect(containsTerm('JavaScript engineer', 'Java')).toBe(false)
    expect(containsTerm('C++ developer and .NET', 'C++')).toBe(true)
    expect(containsTerm('React.js', 'React')).toBe(true)
  })
  it('rejects excluded companies and keywords', () => {
    expect(matchJob(makeJob(), { ...filters, excludedCompanies: ['acme'] }, now).status).toBe(
      'rejected',
    )
    expect(matchJob(makeJob(), { ...filters, excludedKeywords: ['accessible'] }, now).status).toBe(
      'rejected',
    )
  })
  it('requires every mandatory skill', () => {
    expect(
      matchJob(makeJob(), { ...filters, requiredSkills: ['React', 'Rust'] }, now).reasons,
    ).toContain('Required skill not found: Rust')
  })
  it('accepts experience boundaries and rejects outside the range', () => {
    for (const value of [3, 6])
      expect(matchJob(makeJob(), { ...filters, experienceYears: value }, now).status).toBe(
        'matched',
      )
    expect(matchJob(makeJob(), { ...filters, experienceYears: 7 }, now).status).toBe('rejected')
  })
  it('sends missing mandatory facts to attention', () => {
    expect(
      matchJob(makeJob({ experienceMin: null, experienceMax: null }), filters, now).status,
    ).toBe('attention')
    expect(matchJob(makeJob({ postedAt: null }), filters, now).status).toBe('attention')
  })
  it('requires disclosed salary only when a salary minimum is configured', () => {
    const job = makeJob({ salaryMaxLpa: null })
    expect(matchJob(job, filters, now).status).toBe('matched')
    expect(matchJob(job, { ...filters, minimumSalaryLpa: 25 }, now).status).toBe('attention')
    expect(matchJob(makeJob(), { ...filters, minimumSalaryLpa: 31 }, now).status).toBe('rejected')
  })
  it('checks work mode only when configured', () => {
    expect(
      matchJob(makeJob({ workMode: null }), { ...filters, workModes: ['remote'] }, now).status,
    ).toBe('attention')
    expect(matchJob(makeJob(), { ...filters, workModes: ['remote'] }, now).status).toBe('rejected')
  })
  it('rejects stale listings and never matches without target roles', () => {
    expect(matchJob(makeJob({ postedAt: '2026-08-01' }), filters, now).status).toBe('rejected')
    expect(matchJob(makeJob(), { ...filters, titles: [] }, now).status).toBe('attention')
  })
  it('orders by recency, preferred skills, and stable ID', () => {
    const old = makeJob({ id: 'old', postedAt: '2026-09-16' }),
      recent = makeJob({ id: 'recent', postedAt: '2026-09-18' }),
      preferred = makeJob({
        id: 'preferred',
        postedAt: '2026-09-18',
        description: 'React TypeScript GraphQL',
      })
    expect(
      rankJobs([old, recent, preferred], { ...filters, preferredSkills: ['GraphQL'] }).map(
        (j) => j.id,
      ),
    ).toEqual(['preferred', 'recent', 'old'])
  })
})
describe('conservative parsing', () => {
  it('normalizes experience ranges', () => {
    expect(parseExperience('3–6 years')).toEqual({ min: 3, max: 6 })
    expect(parseExperience('Not specified')).toEqual({ min: null, max: null })
  })
  it('normalizes annual rupees and lakhs, refusing other currencies and periods', () => {
    expect(parseSalary('20-30 LPA')).toEqual({ min: 20, max: 30 })
    expect(parseSalary('20-30 Lacs P.A.')).toEqual({ min: 20, max: 30 })
    expect(parseSalary('INR 20,00,000 - 30,00,000 per annum')).toEqual({ min: 20, max: 30 })
    for (const input of ['Not disclosed', 'USD 100000 per year', '₹ 50000 per month', '₹ 2500000'])
      expect(parseSalary(input).max).toBeNull()
  })
  it('parses relative and ISO posting dates', () => {
    expect(parsePostingDate('Posted: 2 days ago', now)).toBe('2026-09-16T08:00:00.000Z')
    expect(parsePostingDate('Today', now)).toBe(now.toISOString())
    expect(parsePostingDate('Not specified', now)).toBeNull()
  })
  it('extracts canonical job IDs only from Naukri job URLs', () => {
    expect(jobIdFromUrl(makeJob().url + '?src=test')).toBe('123456789012')
    expect(jobIdFromUrl('https://naukri.com.evil.test/job-listings-123456789012')).toBeNull()
    expect(jobIdFromUrl('javascript:alert(1)')).toBeNull()
  })
})
describe('screening answers', () => {
  const facts = {
    ...defaultSettings.candidate,
    totalExperience: 4,
    currentCtc: 20,
    noticePeriodDays: 0,
  }
  it('answers exact questions with explicit units, including zero', () => {
    expect(
      resolveAnswer(
        { question: 'Total experience (years)?', type: 'text', options: [] },
        [],
        facts,
      ),
    ).toBe('4')
    expect(
      resolveAnswer({ question: 'Notice period (in days)', type: 'text', options: [] }, [], facts),
    ).toBe('0')
  })
  it('does not infer skill experience, consent, or ambiguous salary units', () => {
    for (const question of [
      'Years of Java experience?',
      'Current salary?',
      'Do you agree to relocate?',
    ])
      expect(resolveAnswer({ question, type: 'text', options: [] }, [], facts)).toBeNull()
  })
  it('only reuses answers for matching input type and full option set', () => {
    const saved = {
      id: 'answer',
      question: 'Willing to relocate?',
      type: 'radio' as const,
      options: ['Yes', 'No'],
      answer: 'No',
    }
    expect(resolveAnswer({ ...saved, options: ['No', 'Yes'] }, [saved], facts)).toBe('No')
    expect(resolveAnswer({ ...saved, options: ['Yes', 'No', 'Maybe'] }, [saved], facts)).toBeNull()
    expect(resolveAnswer({ ...saved, type: 'text', options: [] }, [saved], facts)).toBeNull()
  })
})
describe('settings validation', () => {
  it('requires at least one schedule when autopilot is enabled', () => {
    expect(settingsSchema.safeParse({
      ...defaultSettings, active: true,
      profileSchedule: { ...defaultSettings.profileSchedule, enabled: false },
      applicationSchedule: { ...defaultSettings.applicationSchedule, enabled: false },
    }).success).toBe(false)
  })
  it('requires roles before automatic applications and two headlines for rotation', () => {
    expect(settingsSchema.safeParse({ ...defaultSettings, active: true }).success).toBe(false)
    expect(
      settingsSchema.safeParse({ ...defaultSettings, rotateHeadlines: true, headlines: ['One'] })
        .success,
    ).toBe(false)
  })
  it('rejects invalid timezone, time, weekdays and limits', () => {
    for (const patch of [
      { timezone: 'Invalid/Zone' },
      { dailyLimit: 0 },
      { profileSchedule: { enabled: true, time: '25:00', days: [1] } },
      { profileSchedule: { enabled: true, time: '09:00', days: [] } },
    ])
      expect(settingsSchema.safeParse({ ...defaultSettings, ...patch }).success).toBe(false)
  })
})
