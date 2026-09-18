import { describe, expect, it } from 'vitest'
import { dayBounds, dueOccurrence, nextOccurrence } from '../../src/core/scheduling'
const daily = { enabled: true, time: '09:00', days: [1, 2, 3, 4, 5, 6, 7] }
describe('durable scheduling', () => {
  it('schedules in the configured timezone', () => {
    expect(nextOccurrence(daily, 'Asia/Kolkata', new Date('2026-09-18T02:00Z'))).toBe(
      '2026-09-18T03:30:00.000Z',
    )
  })
  it('skips weekends for weekday schedules', () => {
    expect(
      nextOccurrence(
        { ...daily, days: [1, 2, 3, 4, 5] },
        'Asia/Kolkata',
        new Date('2026-09-18T04:00Z'),
      ),
    ).toBe('2026-09-21T03:30:00.000Z')
  })
  it('catches up only the most recent occurrence after days asleep', () => {
    const now = new Date('2026-09-18T08:00Z')
    const due = dueOccurrence(daily, 'Asia/Kolkata', '2026-09-01T00:00Z', now)
    expect(due).toBe('2026-09-18T03:30:00.000Z')
    expect(dueOccurrence(daily, 'Asia/Kolkata', due!, now)).toBeNull()
  })
  it('does not replay pre-activation schedules or disabled tasks', () => {
    expect(
      dueOccurrence(daily, 'Asia/Kolkata', '2026-09-18T08:00Z', new Date('2026-09-18T08:01Z')),
    ).toBeNull()
    expect(nextOccurrence({ ...daily, enabled: false }, 'UTC')).toBeNull()
  })
  it('uses local calendar days for daily limits', () => {
    expect(dayBounds('Asia/Kolkata', new Date('2026-09-18T00:00Z'))).toEqual({
      start: '2026-09-17T18:30:00.000Z',
      end: '2026-09-18T18:30:00.000Z',
    })
  })
  it('handles DST days without assuming 24 hours', () => {
    const spring = dayBounds('America/New_York', new Date('2026-03-08T12:00Z'))
    expect((Date.parse(spring.end) - Date.parse(spring.start)) / 3600000).toBe(23)
    const autumn = dayBounds('America/New_York', new Date('2026-11-01T12:00Z'))
    expect((Date.parse(autumn.end) - Date.parse(autumn.start)) / 3600000).toBe(25)
  })
})
