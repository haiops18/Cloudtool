import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { MultiConsoleDialog } from './multi-console-page'
import type { ServerRow } from './types'

const adapter = apiClient.defaults.adapter
const authUser = useAuthStore.getState().auth.user
afterEach(() => {
  apiClient.defaults.adapter = adapter
  useCloudStore.getState().clear()
  useAuthStore.getState().auth.setUser(authUser)
})

it('shows incremental per-VM password results and locks the form while the queue runs', async () => {
  useCloudStore.getState().setProject({ id: 'project', name: 'Project' })
  useAuthStore.getState().auth.setUser({
    id: 'operator',
    email: 'operator@example.test',
    full_name: 'Operator',
    is_active: true,
    role: 'operator',
  })
  const releases = new Map<string, () => void>()
  const requested: string[] = []
  apiClient.defaults.adapter = async (config) => {
    let data: unknown =
      config.url === '/cloud/subnets' ? { items: [], total: 0 } : []
    if (config.url === '/cloud/servers/change-password') {
      const body = JSON.parse(config.data)
      expect(body.server_ids).toHaveLength(1)
      const id = body.server_ids[0]
      requested.push(id)
      await new Promise<void>((resolve) => releases.set(id, resolve))
      data = {
        items: [
          {
            server_id: id,
            status: id === 'vm2' ? 'failed' : 'accepted',
            ...(id === 'vm2' ? { error: 'VM rejected this request' } : {}),
          },
        ],
      }
    }
    return { config, data, status: 200, statusText: 'OK', headers: {} }
  }
  const servers: ServerRow[] = [1, 2, 3, 4].map((index) => ({
    id: `vm${index}`,
    name: `VM ${index}`,
    server_type: 'test',
  }))
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <MultiConsoleDialog
        open
        onOpenChange={() => undefined}
        servers={servers}
      />
    </QueryClientProvider>
  )
  await screen
    .getByRole('button', {
      name: 'Change password for selected servers',
      exact: true,
    })
    .click()
  const dialog = screen.getByRole('dialog', {
    name: 'Change server password',
    exact: true,
  })
  await dialog
    .getByRole('textbox', { name: 'New password' })
    .fill('ExamplePassword1!')
  await dialog
    .getByRole('button', { name: 'Change password', exact: true })
    .click()
  await vi.waitFor(() => expect(requested).toHaveLength(3))
  await expect
    .element(dialog.getByRole('status'))
    .toHaveTextContent('0/4 processed')
  await expect
    .element(dialog.getByRole('textbox', { name: 'New password' }))
    .toBeDisabled()
  await expect
    .element(dialog.getByRole('button', { name: 'Close', exact: true }).first())
    .toBeDisabled()
  releases.get('vm1')!()
  await vi.waitFor(() => expect(requested).toHaveLength(4))
  await expect
    .element(dialog.getByRole('status'))
    .toHaveTextContent('1/4 processed')
  for (const id of ['vm2', 'vm3', 'vm4']) releases.get(id)!()
  await expect
    .element(dialog.getByRole('status'))
    .toHaveTextContent('4/4 processed')
  await expect
    .element(dialog.getByText('VM rejected this request'))
    .toBeVisible()
  await expect
    .element(dialog.getByRole('button', { name: 'Close', exact: true }).first())
    .toBeEnabled()
  expect(requested).toEqual(['vm1', 'vm2', 'vm3', 'vm4'])
  await screen.unmount()
  client.clear()
})

it('updates active-server variable previews when subnet data arrives without switching servers', async () => {
  useCloudStore.getState().setProject({ id: 'project', name: 'Project' })
  let releaseSubnets!: () => void
  const pendingSubnets = new Promise<void>((resolve) => {
    releaseSubnets = resolve
  })
  let subnetRequests = 0
  apiClient.defaults.adapter = async (config) => {
    if (config.url === '/cloud/subnets') {
      subnetRequests++
      await pendingSubnets
    }
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data:
        config.url === '/cloud/subnets'
          ? { items: [{ id: 'subnet', cidr: '10.129.0.0/24' }], total: 1 }
          : { url: '' },
    }
  }
  const servers: ServerRow[] = [
    {
      id: 'server',
      name: 'Preview server',
      server_type: 'test',
      private_ip: [{ id: 'ip', ip_address: '10.129.0.10', subnet: 'subnet' }],
    },
  ]
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <MultiConsoleDialog
        open
        onOpenChange={() => undefined}
        servers={servers}
      />
    </QueryClientProvider>
  )
  await screen
    .getByRole('button', { name: 'Open 1 consoles', exact: true })
    .click()
  // Activating the console selects the implicit preview-server branch.
  await screen.getByText('Preview server', { exact: true }).nth(1).click()
  await screen
    .getByRole('button', { name: 'Open variables and preview', exact: true })
    .click()
  await expect
    .element(screen.getByRole('dialog', { name: 'CLI variables and preview' }))
    .toBeVisible()
  releaseSubnets()
  const row = (variable: string) =>
    screen.getByText(`{{${variable}}}`, { exact: true }).element()
      .parentElement!
  await vi.waitFor(() => {
    expect(row('server.private_ip.prefix').textContent).toContain(
      '10.129.0.10/24'
    )
    expect(row('server.private_ip.gw').textContent).toContain('10.129.0.1')
    expect(row('server.private_ip[1].prefix').textContent).toContain(
      '10.129.0.10/24'
    )
    expect(row('server.private_ip[1].gw').textContent).toContain('10.129.0.1')
  })
  expect(subnetRequests).toBe(1)
  await screen.unmount()
  client.clear()
})
