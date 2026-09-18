import type { Job, JobFilters } from '../../src/shared/types'
import { defaultSettings } from '../../src/shared/settings'
export const now = new Date('2026-09-18T08:00:00.000Z')
export const filters: JobFilters = {
  ...structuredClone(defaultSettings.filters),
  titles: ['Frontend Developer'],
  requiredSkills: ['React', 'TypeScript'],
  experienceYears: 4,
  locations: ['Bengaluru'],
}
export function makeJob(patch: Partial<Job> = {}): Job {
  return {
    id: '123456789012',
    url: 'https://www.naukri.com/job-listings-frontend-developer-acme-123456789012',
    title: 'Senior Frontend Developer',
    company: 'Acme',
    description: 'Build accessible React and TypeScript applications with C++ services.',
    skills: ['React', 'TypeScript'],
    locations: ['Bengaluru'],
    workMode: 'hybrid',
    experienceMin: 3,
    experienceMax: 6,
    salaryMinLpa: 20,
    salaryMaxLpa: 30,
    postedAt: '2026-09-17T08:00:00.000Z',
    discoveredAt: now.toISOString(),
    status: 'matched',
    reasons: [],
    ...patch,
  }
}
