import { apiClient } from '@/lib/api-client'

export type SyncProject = {
  id: string
  name: string
  display_name: string
  organization: string
  is_synced?: boolean
  last_synced_at?: string | null
}
export type ProjectSyncResult = SyncProject & {
  status: string
  servers?: number
  error?: string
}

export function compactSyncProject(project: SyncProject): SyncProject {
  return {
    id: project.id,
    name: project.name,
    display_name: project.display_name,
    organization: project.organization,
    is_synced: project.is_synced,
    last_synced_at: project.last_synced_at,
  }
}

async function syncOneProject(
  project: Pick<SyncProject, 'id' | 'name'>
): Promise<Partial<ProjectSyncResult>> {
  try {
    const { data } = await apiClient.post<{
      servers: unknown
      last_synced_at: unknown
    }>(
      '/cloud/all-server-inventory/sync-project',
      { project_id: project.id, project_name: project.name },
      { timeout: 180_000 }
    )
    if (typeof data.servers !== 'number' || !Number.isFinite(data.servers)) {
      throw new Error('Invalid sync response: expected a server count.')
    }
    return {
      status: 'succeeded',
      servers: data.servers,
      is_synced: true,
      last_synced_at:
        typeof data.last_synced_at === 'string' ? data.last_synced_at : null,
    }
  } catch (error) {
    return {
      status: 'failed',
      error: (error instanceof Error ? error.message : 'Sync failed.').slice(
        0,
        2000
      ),
    }
  }
}

export function createProjectSyncResults() {
  let rows: ProjectSyncResult[] = []
  const listeners = new Set<() => void>()
  const reset = (next: ProjectSyncResult[]) => {
    rows = next
    listeners.forEach((notify) => notify())
  }
  return {
    getSnapshot: () => rows,
    subscribe: (notify: () => void) => {
      listeners.add(notify)
      return () => {
        listeners.delete(notify)
      }
    },
    reset,
    update: (patches: Map<string, Partial<ProjectSyncResult>>) => {
      reset(
        rows.map((row) => {
          const patch = patches.get(row.id)
          return patch ? { ...row, ...patch } : row
        })
      )
    },
  }
}

// Keep only small result patches; never retain Axios responses or error objects.
export function syncInventoryProjects(
  projects: SyncProject[],
  concurrency: number,
  onProgress: (patches: Map<string, Partial<ProjectSyncResult>>) => void
) {
  const queue: Array<Pick<SyncProject, 'id' | 'name'> | undefined> =
    projects.map(({ id, name }) => ({ id, name }))
  return runInventorySyncQueue(queue, concurrency, onProgress)
}

async function runInventorySyncQueue(
  queue: Array<Pick<SyncProject, 'id' | 'name'> | undefined>,
  concurrency: number,
  onProgress: (patches: Map<string, Partial<ProjectSyncResult>>) => void
) {
  let cursor = 0
  let pending = new Map<string, Partial<ProjectSyncResult>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!pending.size) return
    const updates = pending
    pending = new Map()
    onProgress(updates)
  }
  const update = (id: string, patch: Partial<ProjectSyncResult>) => {
    pending.set(id, { ...pending.get(id), ...patch })
    timer ??= setTimeout(flush, 250)
  }
  const worker = async () => {
    while (cursor < queue.length) {
      const index = cursor++
      const project = queue[index]!
      queue[index] = undefined
      update(project.id, { status: 'syncing' })
      update(project.id, await syncOneProject(project))
    }
  }
  try {
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            queue.length,
            Math.max(1, Math.min(20, concurrency))
          ),
        },
        worker
      )
    )
  } finally {
    flush()
  }
}
