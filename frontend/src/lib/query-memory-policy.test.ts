import {
  MutationObserver,
  QueryClient,
  QueryObserver,
} from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { installQueryMemoryPolicy } from './query-memory-policy'

it('releases hundreds of old pages while preserving observed and disabled data', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  // Include queries created with the old five-minute GC before installation.
  const active = new QueryObserver(client, {
    queryKey: ['active'],
    enabled: false,
  })
  const unsubscribe = active.subscribe(() => {})
  client.setQueryData(['active'], ['visible data'])
  const dispose = installQueryMemoryPolicy(client)
  try {
    for (let page = 0; page < 200; page++) {
      const observer = new QueryObserver(client, {
        queryKey: ['page', page],
        enabled: false,
      })
      const leavePage = observer.subscribe(() => {})
      client.setQueryData(['page', page], {
        rows: Array(1000).fill('old server data'),
      })
      leavePage()
    }
    await vi.waitFor(() =>
      expect(client.getQueryCache().getAll()).toHaveLength(1)
    )
    expect(client.getQueryData(['active'])).toEqual(['visible data'])
    expect(client.getDefaultOptions().queries?.staleTime).toBe(Infinity)
    expect(client.getDefaultOptions().queries?.retry).toBe(false)
    unsubscribe()
    await vi.waitFor(() =>
      expect(client.getQueryCache().getAll()).toHaveLength(0)
    )
  } finally {
    dispose()
    client.clear()
  }
})

it('allows a background request to finish then releases its unobserved result', async () => {
  const client = new QueryClient()
  const dispose = installQueryMemoryPolicy(client)
  let finish!: (value: string[]) => void
  const pending = new Promise<string[]>((resolve) => {
    finish = resolve
  })
  // The deferred promise controls completion timing; it is not a query input.
  /* eslint-disable @tanstack/query/exhaustive-deps */
  const request = client.fetchQuery({
    queryKey: ['background'],
    queryFn: () => pending,
  })
  /* eslint-enable @tanstack/query/exhaustive-deps */
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.getQueryCache().getAll()).toHaveLength(1)
    finish(['done'])
    await expect(request).resolves.toEqual(['done'])
    await vi.waitFor(() =>
      expect(client.getQueryCache().getAll()).toHaveLength(0)
    )
  } finally {
    dispose()
    client.clear()
  }
})

it('keeps pending mutations running and releases completed payloads after their consumer leaves', async () => {
  const client = new QueryClient()
  const dispose = installQueryMemoryPolicy(client)
  let finish!: (value: string) => void
  const pending = new Promise<string>((resolve) => {
    finish = resolve
  })
  const observer = new MutationObserver(client, { mutationFn: () => pending })
  const unsubscribe = observer.subscribe(() => {})
  const request = observer.mutate()
  unsubscribe()
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.getMutationCache().getAll()).toHaveLength(1)
    finish('finished job')
    await expect(request).resolves.toBe('finished job')
    await vi.waitFor(
      () => expect(client.getMutationCache().getAll()).toHaveLength(0),
      { timeout: 3000 }
    )
  } finally {
    dispose()
    client.clear()
  }
})
