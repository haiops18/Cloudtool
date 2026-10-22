const DAY_MS = 86_400_000
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000

export function inventorySyncElapsedDays(
  value?: string | null,
  now = new Date()
): number | null {
  if (!value) return null
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp)
    ? Math.max(0, (now.getTime() - timestamp) / DAY_MS)
    : null
}

export function inventorySyncAge(
  value?: string | null,
  now = new Date()
): {
  days: number
  tone: 'recent' | 'old' | 'stale'
} | null {
  if (!value) return null
  const synced = new Date(value)
  if (!Number.isFinite(synced.getTime())) return null
  const syncedDay = Math.floor((synced.getTime() + BANGKOK_OFFSET_MS) / DAY_MS)
  const today = Math.floor((now.getTime() + BANGKOK_OFFSET_MS) / DAY_MS)
  const days = Math.max(0, today - syncedDay)
  const localDate = new Date(syncedDay * DAY_MS)
  const sixMonths = new Date(
    Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth() + 6, 1)
  )
  const lastDay = new Date(
    Date.UTC(sixMonths.getUTCFullYear(), sixMonths.getUTCMonth() + 1, 0)
  ).getUTCDate()
  sixMonths.setUTCDate(Math.min(localDate.getUTCDate(), lastDay))
  return {
    days,
    tone:
      today > sixMonths.getTime() / DAY_MS
        ? 'stale'
        : days > 60
          ? 'old'
          : 'recent',
  }
}
