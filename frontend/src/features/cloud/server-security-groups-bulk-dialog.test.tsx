import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { apiClient } from '@/lib/api-client'
import { ServerSecurityGroupsBulkDialog } from './server-security-groups-bulk-dialog'

const originalAdapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
})
const servers = [
  { id: 'vm1', name: 'VM 1', server_type: 'basic' },
  { id: 'vm2', name: 'VM 2', server_type: 'basic' },
]

it('loads existing SGs, confirms changes, scopes each VM request, and keeps conflicts separate', async () => {
  const submitted: {
    vm?: string
    project: unknown
    body: unknown
    timeout?: number
  }[] = []
  let updated = false
  apiClient.defaults.adapter = async (config) => {
    let data: unknown
    if (config.method === 'post') {
      submitted.push({
        vm: config.url,
        project: config.headers.get('X-Project-Id'),
        body: JSON.parse(config.data),
        timeout: config.timeout,
      })
      if (config.url?.includes('/vm2/'))
        throw Object.assign(new Error('Conflict'), {
          response: {
            status: 409,
            data: {
              error: {
                message: 'Cloud API request failed',
                upstream_detail: 'Security groups changed elsewhere.',
              },
            },
          },
        })
      updated = true
      data = {
        status: 'accepted',
        upstream_status: 202,
        response: { message: 'queued' },
      }
    } else if (config.url === '/cloud/security-groups') {
      data = [
        { id: 'old', name: 'Original SG' },
        { id: 'new', name: 'New SG' },
      ]
    } else {
      data = {
        security_groups:
          updated && config.url?.endsWith('/vm1') ? ['old', 'new'] : ['old'],
      }
    }
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const screen = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ServerSecurityGroupsBulkDialog
        servers={servers}
        projectId='project'
        projectName='Project'
        onClose={() => {}}
      />
    </QueryClientProvider>
  )
  await expect
    .element(
      screen.getByRole('combobox', { name: 'Add SG to VM 1', exact: true })
    )
    .toBeEnabled()
  await expect
    .element(
      screen.getByRole('button', { name: 'Apply 0 change(s)', exact: true })
    )
    .not.toBeInTheDocument()
  await userEvent.click(
    screen.getByRole('combobox', {
      name: 'Bulk security group',
      exact: true,
    })
  )
  await userEvent.click(
    screen.getByRole('option', { name: 'New SG', exact: true })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Add to all loaded VMs', exact: true })
  )
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Select all rows', exact: true })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Apply 2 change(s)', exact: true })
  )
  expect(submitted).toHaveLength(0)
  await userEvent.click(
    screen.getByRole('button', { name: 'Apply changes', exact: true })
  )
  await expect
    .element(screen.getByText('Unchanged', { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText('Modified', { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText('Success', { exact: true }))
    .toBeVisible()
  await expect.element(screen.getByText('Error', { exact: true })).toBeVisible()
  await expect
    .element(
      screen.getByText('Security groups changed elsewhere.', { exact: true })
    )
    .toBeVisible()
  expect(submitted).toHaveLength(2)
  expect(
    submitted.every(
      (request) => request.project === 'project' && request.timeout === 0
    )
  ).toBe(true)
  expect(
    submitted.every(
      (request) =>
        JSON.stringify(request.body) ===
        JSON.stringify({
          security_groups: ['new', 'old'],
          expected_security_groups: ['old'],
        })
    )
  ).toBe(true)
  await expect
    .element(
      screen.getByRole('combobox', { name: 'Add SG to VM 2', exact: true })
    )
    .toBeDisabled()
  await expect
    .element(
      screen.getByRole('button', { name: 'Apply 0 change(s)', exact: true })
    )
    .toBeDisabled()
})

it('keeps VM rows with failed detail reads locked and reloads with the existing GET API', async () => {
  let fail = true
  let writes = 0
  apiClient.defaults.adapter = async (config) => {
    if (config.method === 'post') writes++
    if (config.url?.endsWith('/vm1') && fail)
      throw new Error('Cloud unavailable')
    const data =
      config.url === '/cloud/security-groups'
        ? [{ id: 'old', name: 'Original SG' }]
        : { security_groups: ['old'] }
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const screen = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ServerSecurityGroupsBulkDialog
        servers={servers}
        projectId='project'
        projectName='Project'
        onClose={() => {}}
      />
    </QueryClientProvider>
  )
  await expect.element(screen.getByText('Error', { exact: true })).toBeVisible()
  await expect
    .element(
      screen.getByRole('combobox', { name: 'Add SG to VM 1', exact: true })
    )
    .toBeDisabled()
  fail = false
  await userEvent.click(
    screen.getByRole('button', { name: 'Reload VM 1', exact: true })
  )
  await expect
    .element(
      screen.getByRole('combobox', { name: 'Add SG to VM 1', exact: true })
    )
    .toBeEnabled()
  expect(writes).toBe(0)
})

it('limits concurrent VM reads and writes to three when processing many VMs', async () => {
  const many = Array.from({ length: 6 }, (_, index) => ({
    id: `vm-${index}`,
    name: `VM ${index}`,
    server_type: 'basic',
  }))
  let activeReads = 0,
    maxReads = 0,
    loaded = 0,
    activeWrites = 0,
    maxWrites = 0,
    completed = 0
  const current = new Map(many.map((vm) => [vm.id, ['old']]))
  apiClient.defaults.adapter = async (config) => {
    let data: unknown
    const id = config.url?.split('/')[3] ?? ''
    if (config.method === 'post') {
      activeWrites++
      maxWrites = Math.max(maxWrites, activeWrites)
      await new Promise((resolve) => setTimeout(resolve, 30))
      current.set(id, JSON.parse(config.data).security_groups)
      activeWrites--
      completed++
      data = { status: 'accepted' }
    } else if (config.url === '/cloud/security-groups') {
      data = [
        { id: 'old', name: 'Original SG' },
        { id: 'new', name: 'New SG' },
      ]
    } else {
      activeReads++
      maxReads = Math.max(maxReads, activeReads)
      await new Promise((resolve) => setTimeout(resolve, 20))
      activeReads--
      loaded++
      data = { security_groups: current.get(id) }
    }
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const screen = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ServerSecurityGroupsBulkDialog
        servers={many}
        projectId='project'
        projectName='Project'
        onClose={() => {}}
      />
    </QueryClientProvider>
  )
  await expect
    .element(
      screen.getByRole('combobox', { name: 'Add SG to VM 5', exact: true })
    )
    .toBeEnabled()
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Bulk security group', exact: true })
  )
  await userEvent.click(
    screen.getByRole('option', { name: 'New SG', exact: true })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Add to all loaded VMs', exact: true })
  )
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Select all rows', exact: true })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Apply 6 change(s)', exact: true })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Apply changes', exact: true })
  )
  await expect.poll(() => completed).toBe(6)
  await expect
    .element(screen.getByText('Success', { exact: true }).first())
    .toBeVisible()
  expect(loaded).toBeGreaterThanOrEqual(12)
  expect(completed).toBe(6)
  expect(maxReads).toBeLessThanOrEqual(3)
  expect(maxWrites).toBeLessThanOrEqual(3)
})

it('updates only selected modified rows and keeps the confirmation loading until results arrive', async () => {
  const writes: string[] = []
  let finish: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  let updated = false
  apiClient.defaults.adapter = async (config) => {
    let data: unknown
    if (config.method === 'post') {
      writes.push(config.url || '')
      await gate
      updated = true
      data = {
        status: 'accepted',
        upstream_status: 202,
        response: { message: 'Update queued' },
      }
    } else if (config.url === '/cloud/security-groups') {
      data = [
        { id: 'old', name: 'Original SG' },
        { id: 'new', name: 'New SG' },
      ]
    } else {
      data = {
        security_groups:
          updated && config.url?.endsWith('/vm1') ? ['old', 'new'] : ['old'],
      }
    }
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const screen = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ServerSecurityGroupsBulkDialog
        servers={servers}
        projectId='project'
        projectName='Project'
        onClose={() => {}}
      />
    </QueryClientProvider>
  )
  await expect
    .element(
      screen.getByRole('combobox', { name: 'Add SG to VM 2', exact: true })
    )
    .toBeEnabled()
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Bulk security group', exact: true })
  )
  await userEvent.click(
    screen.getByRole('option', { name: 'New SG', exact: true })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Add to all loaded VMs', exact: true })
  )
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Select row', exact: true }).first()
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Apply 1 change(s)', exact: true })
  )
  expect(writes).toHaveLength(0)
  await userEvent.click(
    screen.getByRole('button', { name: 'Apply changes', exact: true })
  )
  await expect
    .element(screen.getByRole('button', { name: 'Apply changes', exact: true }))
    .toBeDisabled()
  expect(
    document.querySelector('[role="alertdialog"] .animate-spin')
  ).not.toBeNull()
  finish()
  await expect
    .element(screen.getByText('Unchanged', { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText('Success', { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText('Modified', { exact: true }))
    .toBeVisible()
  expect(writes).toEqual(['/cloud/servers/vm1/security-groups'])
})

it('adds a security group using the compact plus button at the start of the cell', async () => {
  apiClient.defaults.adapter = async (config) => {
    const data =
      config.url === '/cloud/security-groups'
        ? [
            { id: 'old', name: 'Original SG' },
            { id: 'new', name: 'New SG' },
          ]
        : { security_groups: ['old'] }
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const screen = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ServerSecurityGroupsBulkDialog
        servers={servers}
        projectId='project'
        projectName='Project'
        onClose={() => {}}
      />
    </QueryClientProvider>
  )
  const add = screen.getByRole('combobox', {
    name: 'Add SG to VM 1',
    exact: true,
  })
  await expect.element(add).toBeEnabled()
  const trigger = document.querySelector('[aria-label="Add SG to VM 1"]')!
  expect(trigger.closest('td')?.querySelector('button')).toBe(trigger)
  expect(trigger.textContent).toBe('')
  await userEvent.click(add)
  await userEvent.click(screen.getByRole('option', { name: /New SG/ }))
  await expect
    .element(
      screen.getByRole('button', {
        name: 'Remove New SG from VM 1',
        exact: true,
      })
    )
    .toBeVisible()
  await expect
    .element(screen.getByText('Modified', { exact: true }))
    .toBeVisible()
})
