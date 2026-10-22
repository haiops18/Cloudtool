export function resizeErrorMessage(
  value: unknown,
  preferUpstreamMessage = false
): string {
  const upstream = (item: unknown, depth = 0): unknown => {
    if (depth > 8) return undefined
    if (typeof item === 'string') {
      try {
        return upstream(JSON.parse(item), depth + 1)
      } catch {
        return undefined
      }
    }
    if (!item || typeof item !== 'object') return undefined
    const record = item as Record<string, unknown>
    if (record.upstream_detail != null) return record.upstream_detail
    for (const child of Object.values(record)) {
      const found = upstream(child, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const found = upstream(value)
  if (
    preferUpstreamMessage &&
    found &&
    typeof found === 'object' &&
    'message' in found &&
    typeof found.message === 'string'
  )
    return found.message
  const detail = found ?? value
  return typeof detail === 'string'
    ? detail
    : (JSON.stringify(detail, null, 2) ?? '')
}
