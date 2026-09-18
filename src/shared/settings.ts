import { z } from 'zod'
import { DateTime } from 'luxon'
import type { Settings } from './types'

const list = z.array(z.string().trim().min(1).max(300)).max(100)
const numberOrNull = z.number().finite().min(0).max(100).nullable()
const schedule = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
})
export const settingsSchema = z
  .object({
    active: z.boolean(),
    launchAtLogin: z.boolean(),
    backgroundBrowser: z.boolean(),
    timezone: z
      .string()
      .refine((v) => DateTime.now().setZone(v).isValid, 'Choose a valid timezone'),
    dailyLimit: z.number().int().min(1).max(100),
    screenshotRetentionDays: z.number().int().min(1).max(365),
    profileSchedule: schedule,
    applicationSchedule: schedule,
    headlines: z.array(z.string().trim().min(1).max(250)).max(20),
    rotateHeadlines: z.boolean(),
    filters: z.object({
      titles: list,
      requiredSkills: list,
      preferredSkills: list,
      experienceYears: numberOrNull,
      locations: list,
      workModes: z.array(z.enum(['remote', 'hybrid', 'office'])).max(3),
      minimumSalaryLpa: z.number().min(0).max(10000).nullable(),
      maximumAgeDays: z.number().int().min(1).max(365),
      excludedCompanies: list,
      excludedKeywords: list,
    }),
    candidate: z.object({
      totalExperience: numberOrNull,
      currentCtc: z.number().min(0).max(10000).nullable(),
      expectedCtc: z.number().min(0).max(10000).nullable(),
      noticePeriodDays: z.number().int().min(0).max(365).nullable(),
      currentLocation: z.string().trim().max(200),
    }),
    answers: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          question: z.string().trim().min(1).max(1000),
          type: z.enum(['text', 'select', 'radio']),
          options: list,
          answer: z.string().trim().min(1).max(2000),
        }),
      )
      .max(500),
  })
  .superRefine((s, ctx) => {
    if (s.active && s.applicationSchedule.enabled && s.filters.titles.length === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['filters', 'titles'],
        message: 'Add at least one target role before enabling automatic applications',
      })
    if (s.rotateHeadlines && s.headlines.length < 2)
      ctx.addIssue({
        code: 'custom',
        path: ['headlines'],
        message: 'Add at least two headline variations',
      })
  })

export const defaultSettings: Settings = {
  active: false,
  launchAtLogin: false,
  backgroundBrowser: true,
  timezone: 'Asia/Kolkata',
  dailyLimit: 10,
  screenshotRetentionDays: 30,
  profileSchedule: { enabled: true, time: '09:00', days: [1, 2, 3, 4, 5, 6, 7] },
  applicationSchedule: { enabled: true, time: '09:15', days: [1, 2, 3, 4, 5] },
  headlines: [],
  rotateHeadlines: false,
  filters: {
    titles: [],
    requiredSkills: [],
    preferredSkills: [],
    experienceYears: null,
    locations: [],
    workModes: [],
    minimumSalaryLpa: null,
    maximumAgeDays: 7,
    excludedCompanies: [],
    excludedKeywords: [],
  },
  candidate: {
    totalExperience: null,
    currentCtc: null,
    expectedCtc: null,
    noticePeriodDays: null,
    currentLocation: '',
  },
  answers: [],
}
