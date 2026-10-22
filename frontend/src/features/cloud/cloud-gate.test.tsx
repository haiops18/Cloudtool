import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { CloudGate } from './cloud-gate'

const adapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = adapter
  useCloudStore.getState().clear()
})
it('waits for restoration before showing authorization UI in a new tab', async () => {
  useCloudStore.getState().clear()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  apiClient.defaults.adapter = async (config) => {
    if (config.url === '/cloud-authorizations') await pending
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data:
        config.url === '/auth/me'
          ? {}
          : {
              items: [],
              has_session_authorization: true,
              active_project_id: 'project',
              active_project_name: 'Project',
            },
    }
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <CloudGate>
        <div>Restored content</div>
      </CloudGate>
    </QueryClientProvider>
  )
  await expect.element(screen.getByText('Restoring session...')).toBeVisible()
  await expect
    .element(screen.getByText('Connect Cloud Authorization'))
    .not.toBeInTheDocument()
  release()
  await expect.element(screen.getByText('Restored content')).toBeVisible()
  expect(useCloudStore.getState().project?.id).toBe('project')
  await screen.unmount()
  client.clear()
})
