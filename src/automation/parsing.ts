export function parseExperience(text: string): { min: number | null; max: number | null } {
  const range = text.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)/i)
  if (range) return { min: Number(range[1]), max: Number(range[2]) }
  const single = text.match(/(?:^|\b)(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\b/i)
  return single ? { min: Number(single[1]), max: Number(single[1]) } : { min: null, max: null }
}
export function parseSalary(text: string): { min: number | null; max: number | null } {
  if (!text || /not disclosed|competitive|USD|\$|EUR|GBP|month|hour|negotiable/i.test(text))
    return { min: null, max: null }
  if (!/LPA|(?:lakhs?|lacs?)\s*(?:p\.?\s*a\.?|per annum)|INR|₹/i.test(text))
    return { min: null, max: null }
  const normalized = text.replace(/,/g, '')
  const range = normalized.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/i)
  const single = normalized.match(/(\d+(?:\.\d+)?)/)
  const divisor = /LPA|lakhs?|lacs?/i.test(text)
    ? 1
    : /year|annum|p\.?\s*a\.?/i.test(text)
      ? 100000
      : null
  if (!divisor || !single) return { min: null, max: null }
  return {
    min: Number(range?.[1] ?? single[1]) / divisor,
    max: Number(range?.[2] ?? single[1]) / divisor,
  }
}
export function parsePostingDate(text: string, now = new Date()): string | null {
  if (!text) return null
  if (
    /today|just posted|just now|few hours?|\d+\s*(?:hours?|hrs?|minutes?|mins?)\s*ago/i.test(text)
  )
    return now.toISOString()
  if (/yesterday/i.test(text)) return new Date(now.getTime() - 86_400_000).toISOString()
  const relative = text.match(/(\d+)\s*(days?|weeks?|months?)\s*ago/i)
  if (relative)
    return new Date(
      now.getTime() -
        Number(relative[1]) *
          (/week/i.test(relative[2]) ? 7 : /month/i.test(relative[2]) ? 30 : 1) *
          86_400_000,
    ).toISOString()
  if (/^\d{4}-\d{2}-\d{2}/.test(text.trim())) {
    const time = Date.parse(text)
    if (Number.isFinite(time)) return new Date(time).toISOString()
  }
  return null
}
export function jobIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      !(url.hostname === 'naukri.com' || url.hostname.endsWith('.naukri.com'))
    )
      return null
    if (!url.pathname.includes('job-listings-')) return null
    return url.pathname.match(/-(\d{8,})(?:\/)?$/)?.[1] ?? null
  } catch {
    return null
  }
}
export function isNaukriUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'naukri.com' || url.hostname.endsWith('.naukri.com'))
    )
  } catch {
    return false
  }
}
