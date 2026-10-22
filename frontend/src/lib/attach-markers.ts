const STORAGE_PREFIX = 'cloudtool:server-attach-markers:'

export function readAttachMarkers(projectId: string) {
  try {
    const value = localStorage.getItem(`${STORAGE_PREFIX}${projectId}`)
    if (!value) return {}
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([serverId, timestamp]) =>
          Boolean(serverId) && typeof timestamp === 'string'
      )
    )
  } catch {
    return {}
  }
}

export function writeAttachMarkers(
  projectId: string,
  markers: Record<string, string>
) {
  localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, JSON.stringify(markers))
}
