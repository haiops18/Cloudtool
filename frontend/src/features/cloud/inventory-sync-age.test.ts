import { expect, it } from 'vitest'
import {
  inventorySyncAge,
  inventorySyncElapsedDays,
} from './inventory-sync-age'

it('counts Bangkok calendar days without including hours', () => {
  expect(
    inventorySyncAge(
      '2026-10-04T23:59:00+07:00',
      new Date('2026-10-05T00:01:00+07:00')
    )
  ).toEqual({ days: 1, tone: 'recent' })
})
it('uses yellow only after 60 days', () => {
  const synced = '2026-01-01T12:00:00+07:00'
  expect(
    inventorySyncAge(synced, new Date('2026-03-02T12:00:00+07:00'))
  ).toEqual({ days: 60, tone: 'recent' })
  expect(
    inventorySyncAge(synced, new Date('2026-03-03T12:00:00+07:00'))
  ).toEqual({ days: 61, tone: 'old' })
})
it('uses red after six calendar months with month-end clamping', () => {
  const synced = '2026-03-31T12:00:00+07:00'
  expect(
    inventorySyncAge(synced, new Date('2026-09-30T12:00:00+07:00'))?.tone
  ).toBe('old')
  expect(
    inventorySyncAge(synced, new Date('2026-10-01T00:00:00+07:00'))?.tone
  ).toBe('stale')
})
it('handles unsynced, invalid and future timestamps', () => {
  expect(inventorySyncAge(null)).toBeNull()
  expect(inventorySyncAge('invalid')).toBeNull()
  expect(
    inventorySyncAge(
      '2026-10-06T12:00:00+07:00',
      new Date('2026-10-05T12:00:00+07:00')
    )
  ).toEqual({ days: 0, tone: 'recent' })
})

it('computes fractional elapsed days independently of calendar-day boundaries', () => {
  expect(
    inventorySyncElapsedDays(
      '2026-10-04T06:00:00+07:00',
      new Date('2026-10-05T12:00:00+07:00')
    )
  ).toBe(1.25)
  expect(inventorySyncElapsedDays(null)).toBeNull()
  expect(inventorySyncElapsedDays('invalid')).toBeNull()
  expect(
    inventorySyncElapsedDays(
      '2026-10-06T12:00:00+07:00',
      new Date('2026-10-05T12:00:00+07:00')
    )
  ).toBe(0)
})
