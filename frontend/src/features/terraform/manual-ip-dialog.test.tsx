import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from 'vitest-browser-react'
import { apiClient } from '@/lib/api-client'
import { ManualIpDialog } from './manual-ip-dialog'
import { emptyTerraformServer } from './server-draft'

const originalAdapter = apiClient.defaults.adapter
afterEach(async () => {
  await cleanup()
  apiClient.defaults.adapter = originalAdapter
})

it('links partial successes immediately and retries only the failed allocation type', async () => {
  const server = {
    ...emptyTerraformServer(),
    id: 'draft',
    name: 'app',
    subnet_id: 'subnet',
    region_id: 'region',
    zone_id: 'zone',
    private_ip_mode: 'manual' as const,
    elastic_ip_mode: 'manual' as const,
  }
  const requests: Array<{
    request_id: string
    items: Array<{ create_private: boolean; create_elastic: boolean }>
  }> = []
  const apply = vi.fn()
  apiClient.defaults.adapter = async (config) => {
    requests.push(JSON.parse(config.data))
    expect(config.headers.get('X-Project-Id')).toBe('source-project')
    const item =
      requests.length === 1
        ? {
            server_draft_id: 'draft',
            server_name: 'app',
            private: {
              status: 'completed',
              ip_id: 'pip',
              ip_address: '10.0.0.42',
            },
            elastic: { status: 'failed', error: 'Quota denied' },
          }
        : {
            server_draft_id: 'draft',
            server_name: 'app',
            elastic: {
              status: 'completed',
              ip_id: 'eip',
              ip_address: '203.0.113.42',
            },
          }
    return {
      data: { items: [item] },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  }
  const screen = await render(
    <QueryClientProvider client={new QueryClient()}>
      <ManualIpDialog
        servers={[server]}
        projectId='source-project'
        onApply={apply}
        onClose={vi.fn()}
      />
    </QueryClientProvider>
  )
  await screen.getByRole('button', { name: 'Create IPs', exact: true }).click()
  await expect
    .element(screen.getByText('10.0.0.42', { exact: true }))
    .toBeVisible()
  expect(apply).toHaveBeenCalledTimes(1)
  await screen.getByRole('button', { name: 'Retry failed IPs' }).click()
  await expect
    .element(screen.getByText('203.0.113.42', { exact: true }))
    .toBeVisible()
  expect(requests[0].items[0]).toMatchObject({
    create_private: true,
    create_elastic: true,
    zone_id: 'zone',
  })
  expect(requests[1].items[0]).toMatchObject({
    create_private: false,
    create_elastic: true,
  })
  expect(requests[1].request_id).not.toBe(requests[0].request_id)
  expect(apply).toHaveBeenCalledTimes(2)
  await expect
    .element(screen.getByRole('button', { name: 'Retry failed IPs' }))
    .toBeDisabled()
})
