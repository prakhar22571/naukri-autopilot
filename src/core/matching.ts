import type { Job, JobFilters, MatchResult } from '../shared/types'

export function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}
export function containsTerm(text: string, term: string): boolean {
  const escaped = normalize(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(normalize(text))
}
export function matchJob(job: Job, filters: JobFilters, now = new Date()): MatchResult {
  const failed: string[] = [],
    missing: string[] = [],
    passed: string[] = []
  const skillsText = `${job.skills.join(' ')} ${job.description}`
  if (!filters.titles.length) missing.push('No target roles configured')
  else if (!filters.titles.some((t) => containsTerm(job.title, t)))
    failed.push('Title does not match your target roles')
  else passed.push('Target role matches')
  if (filters.excludedCompanies.some((c) => containsTerm(job.company, c)))
    failed.push('Company is excluded')
  if (filters.excludedCompanies.length && !job.company.trim())
    missing.push('Company name is missing; exclusions cannot be checked')
  if (filters.excludedKeywords.some((k) => containsTerm(`${job.title} ${job.description}`, k)))
    failed.push('Contains an excluded keyword')
  for (const skill of filters.requiredSkills) {
    if (!skillsText.trim()) missing.push(`Cannot verify required skill: ${skill}`)
    else if (!containsTerm(skillsText, skill)) failed.push(`Required skill not found: ${skill}`)
    else passed.push(`Required skill: ${skill}`)
  }
  if (filters.experienceYears !== null) {
    if (job.experienceMin === null || job.experienceMax === null)
      missing.push('Experience requirement is missing')
    else if (
      filters.experienceYears < job.experienceMin ||
      filters.experienceYears > job.experienceMax
    )
      failed.push('Experience outside the advertised range')
    else passed.push('Experience fits')
  }
  if (filters.locations.length) {
    if (!job.locations.length) missing.push('Location is missing')
    else if (!filters.locations.some((l) => job.locations.some((j) => containsTerm(j, l))))
      failed.push('Location does not match')
    else passed.push('Location matches')
  }
  if (filters.workModes.length) {
    if (!job.workMode) missing.push('Work mode is not stated')
    else if (!filters.workModes.includes(job.workMode)) failed.push('Work mode does not match')
    else passed.push('Work mode matches')
  }
  if (filters.minimumSalaryLpa !== null) {
    if (job.salaryMaxLpa === null) missing.push('Salary is not disclosed in annual INR')
    else if (job.salaryMaxLpa < filters.minimumSalaryLpa)
      failed.push('Advertised salary is below your minimum')
    else passed.push('Advertised salary range can meet your minimum')
  }
  const posted = job.postedAt ? new Date(job.postedAt).getTime() : NaN
  if (!Number.isFinite(posted)) missing.push('Posting date is missing')
  else if (now.getTime() - posted > filters.maximumAgeDays * 86_400_000)
    failed.push('Job is older than your posting-age limit')
  else if (posted > now.getTime() + 86_400_000) missing.push('Posting date could not be verified')
  else passed.push('Within posting-age limit')
  return {
    status: failed.length ? 'rejected' : missing.length ? 'attention' : 'matched',
    reasons: failed.length ? failed : missing.length ? missing : passed,
    preferredMatches: filters.preferredSkills.filter((s) => containsTerm(skillsText, s)).length,
  }
}
export function rankJobs(jobs: Job[], filters: JobFilters): Job[] {
  return [...jobs].sort(
    (a, b) =>
      (Date.parse(b.postedAt ?? '') || 0) - (Date.parse(a.postedAt ?? '') || 0) ||
      matchJob(b, filters).preferredMatches - matchJob(a, filters).preferredMatches ||
      a.id.localeCompare(b.id),
  )
}
