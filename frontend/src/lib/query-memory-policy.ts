import type { QueryClient } from '@tanstack/react-query'

// Retain data while observed, but release old pages, filters and completed
// mutations as soon as their last consumer leaves. Pending jobs are not cleared.
export const queryMemoryPolicy = {
  queries: { gcTime: 0 },
  // Pending, detached mutations reschedule GC; avoid a zero-delay timer loop.
  mutations: { gcTime: 1000 },
} as const

export function installQueryMemoryPolicy(client: QueryClient) {
  const defaults = client.getDefaultOptions()
  client.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, ...queryMemoryPolicy.queries },
    mutations: { ...defaults.mutations, ...queryMemoryPolicy.mutations },
  })
  const cache = client.getQueryCache()
  let timer: ReturnType<typeof setTimeout> | undefined
  const releaseUnused = () => {
    timer = undefined
    for (const query of cache.getAll()) {
      // Disabled observers can still consume data. Never remove these or
      // interrupt a request/job that is still running without an observer.
      if (!query.getObserversCount() && query.state.fetchStatus === 'idle') {
        cache.remove(query)
      }
    }
  }
  const schedule = () => {
    timer ??= setTimeout(releaseUnused, 0)
  }
  const unsubscribe = cache.subscribe((event) => {
    if (
      (event.type === 'observerRemoved' || event.type === 'updated') &&
      !event.query.getObserversCount() &&
      event.query.state.fetchStatus === 'idle'
    )
      schedule()
  })
  // Also cover queries created before the layout mounted with older GC options.
  schedule()
  const dispose = () => {
    unsubscribe()
    if (timer !== undefined) clearTimeout(timer)
  }
  return Object.assign(dispose, { releaseUnused: schedule })
}
