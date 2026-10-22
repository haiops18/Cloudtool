import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { apiClient } from '@/lib/api-client'
import { ServerDetailsDialog } from './server-details-dialog'

const originalAdapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
})

it.each([false, true])(
  'reuses server details with crossProject=%s and loads only when opened',
  async (crossProject) => {
    const requests: string[] = []
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const detail = {
      id: 'vm',
      name: 'VM Shared',
      user_data: 'full userdata',
      mapped_references: { zone: 'VM project zone' },
      network_details: {
        private_ips: [
          {
            ip_address: '10.0.0.2',
            subnet: { name: 'VM project subnet' },
            vip_ips: ['10.0.0.4'],
          },
        ],
        elastic_ips: [],
      },
    }
    const endpoint = crossProject
      ? '/cloud/all-server-inventory/servers/vm-project/vm'
      : '/cloud/servers/vm'
    apiClient.defaults.adapter = async (config) => {
      requests.push(config.url!)
      let data: unknown
      if (config.url === endpoint) {
        expect(config.params.include_network_details).toBe(true)
        data = crossProject ? { item: detail } : detail
      } else if (!crossProject && config.url === '/cloud/zones') {
        data = { items: [], total: 0 }
      } else throw new Error(`Unexpected API call: ${config.url}`)
      return { data, status: 200, statusText: 'OK', headers: {}, config }
    }
    const screen = await render(
      <QueryClientProvider client={client}>
        <ServerDetailsDialog
          projectId='vm-project'
          crossProject={crossProject}
          onOpenChange={() => {}}
        />
      </QueryClientProvider>
    )
    expect(requests).toEqual([])
    await screen.rerender(
      <QueryClientProvider client={client}>
        <ServerDetailsDialog
          server={{ id: 'vm', name: 'VM Shared' }}
          projectId='vm-project'
          crossProject={crossProject}
          onOpenChange={() => {}}
        />
      </QueryClientProvider>
    )
    const dialog = screen.getByRole('dialog', {
      name: 'Server details',
      exact: true,
    })
    await expect
      .element(dialog.getByText('VM project subnet', { exact: true }))
      .toBeVisible()
    await expect
      .element(dialog.getByText('10.0.0.4', { exact: true }))
      .toBeVisible()
    await expect
      .element(dialog.getByLabelText('Server user data'))
      .toHaveValue('full userdata')
    expect(requests.filter((url) => url === endpoint)).toHaveLength(1)
    if (crossProject) expect(requests).toEqual([endpoint])
  }
)
