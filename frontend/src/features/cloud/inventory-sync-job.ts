import type { QueryClient } from '@tanstack/react-query'
import {
  createProjectSyncResults,
  compactSyncProject,
  syncInventoryProjects,
  type SyncProject,
} from './inventory-project-sync'

// A background job owns compact project summaries, never a mounted page's state
// setters, query responses, VM rows, table instances or modal selection.
export function createInventorySyncJob(client: QueryClient) {
  const results = createProjectSyncResults()
  let state = { running: false, hasResults: false, projectCount: 0 }
  let visible = false
  const listeners = new Set<() => void>()
  const publish = (next: typeof state) => {
    state = next
    listeners.forEach((notify) => notify())
  }
  const clear = () => {
    if (state.running) return
    results.reset([])
    publish({ running: false, hasResults: false, projectCount: 0 })
  }
  const run = async (targets: SyncProject[], concurrency: number) => {
    results.reset(targets.map((project) => ({ ...project, status: 'queued' })))
    publish({ running: true, hasResults: true, projectCount: targets.length })
    try {
      await client.cancelQueries({
        queryKey: ['cloud', 'all-server-inventory', 'projects'],
        exact: true,
      })
      client.removeQueries({
        queryKey: ['cloud', 'all-server-inventory'],
        type: 'inactive',
      })
      client.setQueryData(['cloud', 'all-server-inventory', 'projects'], {
        items: [],
        total: 0,
      })
      await syncInventoryProjects(targets, concurrency, results.update)
    } finally {
      client.removeQueries({
        queryKey: ['cloud', 'all-server-inventory'],
        type: 'inactive',
      })
      publish({ ...state, running: false })
      if (!visible) clear()
      await client.invalidateQueries({
        queryKey: ['cloud', 'all-server-inventory'],
      })
    }
  }
  return {
    results,
    getSnapshot: () => state,
    subscribe: (notify: () => void) => {
      listeners.add(notify)
      return () => {
        listeners.delete(notify)
      }
    },
    clear,
    setVisible: (next: boolean) => {
      visible = next
      if (!visible && !state.running) clear()
    },
    start: (selected: SyncProject[], concurrency: number) => {
      if (state.running || !selected.length) return Promise.resolve()
      return run(selected.map(compactSyncProject), concurrency)
    },
  }
}

const jobs = new WeakMap<
  QueryClient,
  ReturnType<typeof createInventorySyncJob>
>()
export function getInventorySyncJob(client: QueryClient) {
  let job = jobs.get(client)
  if (!job) {
    job = createInventorySyncJob(client)
    jobs.set(client, job)
  }
  return job
}
