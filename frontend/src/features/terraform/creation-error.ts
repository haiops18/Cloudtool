type CreationResult = {
  error_message?: string | null
  result?: Record<string, unknown> | null
}

function upstreamDetail(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined
  if (typeof value === 'string') {
    try {
      return upstreamDetail(JSON.parse(value), depth + 1)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.upstream_detail != null) return record.upstream_detail
  for (const child of Object.values(record)) {
    const found = upstreamDetail(child, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

const detailText = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)

export function creationErrorText(server: CreationResult): string {
  const detail =
    upstreamDetail(server.result?.cloud_response ?? server.result) ??
    upstreamDetail(server.error_message)
  return detail !== undefined ? detailText(detail) : server.error_message || ''
}

export function creationResponseText(server: CreationResult): string {
  const response = server.result?.cloud_response ?? server.result
  const detail = upstreamDetail(response)
  return detail !== undefined
    ? detailText(detail)
    : response == null
      ? '—'
      : JSON.stringify(response, null, 2)
}
