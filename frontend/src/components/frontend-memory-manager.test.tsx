import { useEffect } from 'react'
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from '@tanstack/react-router'
import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { apiClient } from '@/lib/api-client'
import { FrontendMemoryManager } from './frontend-memory-manager'

it('automatically releases the old page and aborts its read request on every navigation', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const adapter = apiClient.defaults.adapter
  const signals: AbortSignal[] = []
  let mounted = 0
  let unmounted = 0
  apiClient.defaults.adapter = async (config) => {
    signals.push(config.signal as AbortSignal)
    // Real transport cancellation is driven by the signal supplied by the query.
    await new Promise<void>((resolve) =>
      config.signal?.addEventListener?.('abort', () => resolve())
    )
    return {
      config,
      data: { items: [] },
      status: 200,
      statusText: 'OK',
      headers: {},
    }
  }
  function Page() {
    const pathname = useLocation({ select: (location) => location.pathname })
    useQuery({
      queryKey: ['navigation-memory', pathname],
      queryFn: ({ signal }) =>
        apiClient.get('/cloud/memory-fixture', { signal }),
    })
    useEffect(() => {
      mounted++
      return () => {
        unmounted++
      }
    }, [])
    return <div>{pathname}</div>
  }
  function Root() {
    const pathname = useLocation({ select: (location) => location.pathname })
    return (
      <>
        <FrontendMemoryManager />
        <Outlet key={pathname} />
      </>
    )
  }
  const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: Root,
  })
  const page = createRoute({
    getParentRoute: () => root,
    path: '/memory/$visit',
    component: Page,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ['/memory/0'] }),
    context: { queryClient: client },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  try {
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    for (let visit = 1; visit <= 20; visit++) {
      await router.navigate({ href: `/memory/${visit}` })
      await vi.waitFor(() => expect(signals).toHaveLength(visit + 1))
      expect(signals[visit - 1].aborted).toBe(true)
      await vi.waitFor(() =>
        expect(
          client.getQueryCache().findAll({ queryKey: ['navigation-memory'] })
        ).toHaveLength(1)
      )
      expect(router.stores.cachedMatches.get()).toHaveLength(0)
      expect(mounted - unmounted).toBe(1)
    }
  } finally {
    await screen.unmount()
    apiClient.defaults.adapter = adapter
    client.clear()
  }
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect(mounted).toBe(unmounted)
})
