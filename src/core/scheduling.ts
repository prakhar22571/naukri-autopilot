import { DateTime } from 'luxon'
import type { Schedule } from '../shared/types'

function occurrences(schedule: Schedule, zone: string, now: Date, direction: 1 | -1): DateTime[] {
  const local = DateTime.fromJSDate(now, { zone })
  const [hour, minute] = schedule.time.split(':').map(Number)
  return Array.from({ length: 9 }, (_, i) =>
    local
      .startOf('day')
      .plus({ days: i * direction })
      .set({ hour, minute }),
  ).filter((d) => d.isValid && schedule.days.includes(d.weekday))
}
export function nextOccurrence(schedule: Schedule, zone: string, now = new Date()): string | null {
  if (!schedule.enabled) return null
  return (
    occurrences(schedule, zone, now, 1)
      .find((d) => d.toMillis() > now.getTime())
      ?.toUTC()
      .toISO() ?? null
  )
}
export function dueOccurrence(
  schedule: Schedule,
  zone: string,
  lastHandled: string,
  now = new Date(),
): string | null {
  if (!schedule.enabled) return null
  const latest = occurrences(schedule, zone, now, -1).find((d) => d.toMillis() <= now.getTime())
  return latest && latest.toMillis() > Date.parse(lastHandled) ? latest.toUTC().toISO() : null
}
export function dayBounds(zone: string, now = new Date()): { start: string; end: string } {
  const day = DateTime.fromJSDate(now, { zone }).startOf('day')
  return { start: day.toUTC().toISO()!, end: day.plus({ days: 1 }).toUTC().toISO()! }
}
