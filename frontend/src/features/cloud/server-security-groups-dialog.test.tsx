import { useState } from 'react'
import type { AxiosAdapter } from 'axios'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { InventoryServerSecurityGroupsDialog } from './server-security-groups-dialog'

const originalAdapter = apiClient.defaults.adapter

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
  useCloudStore.getState().clear()
})

function Harness() {
  const [project, setProject] = useState<string | null>(null)
  return (
    <>
      <button onClick={() => setProject('project-a')}>Open A</button>
      <button onClick={() => setProject('project-b')}>Open B</button>
      {project && (
        <InventoryServerSecurityGroupsDialog
          key={project}
          server={{
            server_id: 'same-vm-id',
            server_name: 'VM',
            project_id: project,
            project_name: project,
          }}
          onClose={() => setProject(null)}
        />
      )}
    </>
  )
}

it('scopes every request and cache by VM project, supports direction filters and fast reopen', async () => {
  useCloudStore.getState().setProject({ id: 'global-project', name: 'Global' })
  const adapter = vi.fn<AxiosAdapter>(async (config) => {
    const project = String(config.headers.get('X-Project-Id'))
    const data = config.url?.endsWith('/same-vm-id')
      ? { security_groups: ['group-id', 'second-group'] }
      : config.url === '/cloud/security-groups'
        ? [
            { id: 'group-id', name: `SG ${project}` },
            { id: 'second-group', name: `Second SG ${project}` },
          ]
        : [
            {
              id: 'rule-id',
              direction:
                config.params.direction === 'egress' ? 'egress' : 'ingress',
              protocol: 'tcp',
              port_range_min: 22,
              port_range_max: 22,
              remote_ip_prefix: '10.0.0.0/24',
              description: `Rule ${project}`,
              delete_at: '2026-12-01T10:30:00',
            },
          ]
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  })
  apiClient.defaults.adapter = adapter
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Open A', exact: true })
  )
  await expect
    .element(screen.getByText('Rule project-a', { exact: true }))
    .toBeVisible()
  await expect
    .element(
      screen.getByText(new Date('2026-12-01T10:30:00').toLocaleString(), {
        exact: true,
      })
    )
    .toBeVisible()
  expect(
    adapter.mock.calls.every(
      ([config]) => config.headers.get('X-Project-Id') === 'project-a'
    )
  ).toBe(true)
  await userEvent.click(
    screen.getByRole('button', { name: 'Outbound', exact: true })
  )
  await vi.waitFor(() =>
    expect(
      adapter.mock.calls.some(
        ([config]) => config.params?.direction === 'egress'
      )
    ).toBe(true)
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Close', exact: true })
  )
  const count = adapter.mock.calls.length
  await userEvent.click(
    screen.getByRole('button', { name: 'Open A', exact: true })
  )
  await expect
    .element(screen.getByText('Rule project-a', { exact: true }))
    .toBeVisible()
  expect(adapter.mock.calls.length).toBe(count)
  await userEvent.click(
    screen.getByRole('button', { name: 'Close', exact: true })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Open B', exact: true })
  )
  await expect
    .element(screen.getByText('Rule project-b', { exact: true }))
    .toBeVisible()
  expect(
    adapter.mock.calls
      .slice(count)
      .every(([config]) => config.headers.get('X-Project-Id') === 'project-b')
  ).toBe(true)
  expect(
    adapter.mock.calls
      .filter(([config]) => config.url?.endsWith('/rules'))
      .every(
        ([config]) => config.url === '/cloud/security-groups/group-id/rules'
      )
  ).toBe(true)
  await userEvent.click(screen.getByRole('combobox').first())
  await userEvent.click(
    screen.getByText('All attached security groups', { exact: true })
  )
  await vi.waitFor(() =>
    expect(
      adapter.mock.calls.some(
        ([config]) => config.url === '/cloud/security-groups/second-group/rules'
      )
    ).toBe(true)
  )
  expect(useCloudStore.getState().project?.id).toBe('global-project')
})

it('shows an actionable error when rule loading fails instead of an empty successful table', async () => {
  let fail = true
  apiClient.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/rules') && fail)
      throw new Error('Rule request failed')
    const data = config.url?.endsWith('/same-vm-id')
      ? { security_groups: ['group-id'] }
      : config.url === '/cloud/security-groups'
        ? [{ id: 'group-id', name: 'SG' }]
        : [
            {
              id: 'rule',
              direction: 'ingress',
              protocol: 'tcp',
              description: 'Recovered rule',
            },
          ]
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Open A', exact: true })
  )
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent('Security groups or rules could not be loaded.')
  fail = false
  await userEvent.click(
    screen.getByRole('button', { name: 'Try again', exact: true })
  )
  await expect
    .element(screen.getByText('Recovered rule', { exact: true }))
    .toBeVisible()
})

it('creates reviewed rules in the VM project and retries only failed rows', async () => {
  useCloudStore.getState().setProject({ id: 'global-project', name: 'Global' })
  const batches: Array<{
    project: string
    items: Array<Record<string, unknown>>
  }> = []
  let created = false
  apiClient.defaults.adapter = async (config) => {
    let data: unknown
    if (config.method === 'post') {
      const body = JSON.parse(config.data) as {
        items: Array<Record<string, unknown>>
      }
      batches.push({
        project: String(config.headers.get('X-Project-Id')),
        items: body.items,
      })
      created = true
      data = {
        items: body.items.map((_, index) =>
          batches.length === 1 && index === body.items.length - 1
            ? { status: 'failed', error: { upstream_detail: 'CIDR rejected' } }
            : { status: 'created' }
        ),
      }
    } else {
      data = config.url?.endsWith('/same-vm-id')
        ? { security_groups: ['group-id'] }
        : config.url === '/cloud/security-groups'
          ? [{ id: 'group-id', name: 'VM SG' }]
          : [
              {
                id: 'rule',
                direction: 'ingress',
                protocol: 'tcp',
                description: created ? 'Updated rules' : 'Initial rules',
              },
            ]
    }
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Open B', exact: true })
  )
  await expect
    .element(screen.getByText('Initial rules', { exact: true }))
    .toBeVisible()
  await expect
    .element(
      screen.getByRole('button', {
        name: 'Refresh security group rules',
        exact: true,
      })
    )
    .toHaveTextContent('')
  await userEvent.click(
    screen.getByRole('button', { name: 'Add rule', exact: true })
  )
  await userEvent.fill(
    screen.getByLabelText('Delete at (optional)'),
    '2026-12-01T10:30'
  )
  await userEvent.fill(screen.getByLabelText('Port / range'), '22, 80-443')
  await userEvent.fill(
    screen.getByLabelText('Remote IP / CIDR', { exact: true }),
    '10.0.0.0/24, 192.168.1.0/24'
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Both', exact: true })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Add to review', exact: true })
  )
  expect(batches.length).toBe(0)
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Select all rows', exact: true })
  )
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Create 8 selected rule(s)',
      exact: true,
    })
  )
  expect(batches.length).toBe(0)
  await userEvent.click(
    screen.getByRole('button', { name: 'Create rules', exact: true })
  )
  await expect
    .element(screen.getByText('CIDR rejected', { exact: true }))
    .toBeVisible()
  expect(batches[0].project).toBe('project-b')
  expect(batches[0].items).toHaveLength(8)
  expect(
    batches[0].items.every((item) => item.delete_at === '2026-12-01T10:30')
  ).toBe(true)
  expect(new Set(batches[0].items.map((item) => item.direction))).toEqual(
    new Set(['ingress', 'egress'])
  )
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Create 1 selected rule(s)',
      exact: true,
    })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Create rules', exact: true })
  )
  await vi.waitFor(() => expect(batches).toHaveLength(2))
  expect(batches[1].items).toHaveLength(1)
  expect(batches[1].project).toBe('project-b')
  expect(batches[1].items[0]).not.toHaveProperty('status')
  expect(batches[1].items[0]).not.toHaveProperty('error')
  await expect
    .element(screen.getByText('CIDR rejected', { exact: true }))
    .not.toBeInTheDocument()
  await userEvent.click(
    screen.getByRole('button', { name: 'Close', exact: true }).last()
  )
  await expect
    .element(screen.getByText('Updated rules', { exact: true }))
    .toBeVisible()
  expect(useCloudStore.getState().project?.id).toBe('global-project')
})
