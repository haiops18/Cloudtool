import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { SecurityGroupsPage } from './security-groups-page'

const observed = vi.hoisted(() => ({
  tableRenders: 0,
  reviewRows: [] as Array<Record<string, unknown>>,
}))
vi.mock('./page-shell', () => ({
  CloudPageShell: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./security-group-rule-quota', () => ({
  SecurityGroupRuleQuota: () => null,
}))
vi.mock('@/components/cloud-data-table', () => ({
  CloudDataTable: ({
    data,
    entityName,
  }: {
    data: Array<Record<string, unknown>>
    entityName: string
  }) => {
    observed.tableRenders++
    if (entityName === 'rule in review list') observed.reviewRows = data
    return <div>{data.length} rows</div>
  },
}))

const adapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = adapter
  useCloudStore.getState().clear()
})

it('keeps typing local to the editor and still expands the submitted rules correctly', async () => {
  useCloudStore.getState().setProject({ id: 'project', name: 'Project' })
  let requests = 0
  apiClient.defaults.adapter = async (config) => {
    requests++
    return {
      data:
        config.url === '/cloud/security-groups'
          ? [{ id: 'sg', name: 'Application' }]
          : config.url?.endsWith('/scheduled-rules')
            ? { items: [] }
            : [],
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <SecurityGroupsPage />
    </QueryClientProvider>
  )
  await screen
    .getByRole('button', { name: 'Add rule to Application', exact: true })
    .click()
  await screen.getByRole('button', { name: 'Add rule', exact: true }).click()
  await expect
    .element(screen.getByRole('dialog', { name: 'Add rule', exact: true }))
    .toBeVisible()
  await vi.waitFor(() => expect(client.isFetching()).toBe(0))
  const rendersBeforeTyping = observed.tableRenders
  const requestsBeforeTyping = requests
  await expect
    .element(screen.getByRole('button', { name: 'Add to review' }))
    .toBeDisabled()
  await userEvent.type(
    screen.getByPlaceholder('22, 80, 443, 1000-2000'),
    '22,443'
  )
  await userEvent.type(
    screen.getByPlaceholder('10.0.0.0/24, 192.168.1.0/24\n2001:db8::/64'),
    '10.0.0.0/24'
  )
  await userEvent.type(
    screen.getByPlaceholder('For example: Allow management access'),
    'Allow management access'
  )
  const deleteAt = screen
    .getByRole('dialog', { name: 'Add rule', exact: true })
    .element()
    .querySelector<HTMLInputElement>('input[type="datetime-local"]')!
  await userEvent.fill(deleteAt, '2026-12-01T10:30')
  await screen
    .getByRole('button', { name: 'Both (in/out)', exact: true })
    .click()
  await screen.getByRole('button', { name: 'udp', exact: true }).click()
  expect(observed.tableRenders).toBe(rendersBeforeTyping)
  expect(requests).toBe(requestsBeforeTyping)
  await expect
    .element(screen.getByRole('button', { name: 'Add to review' }))
    .toBeEnabled()

  // Cancel/reopen keeps the draft within the same review session.
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click()
  await screen.getByRole('button', { name: 'Add rule', exact: true }).click()
  await expect
    .element(screen.getByPlaceholder('For example: Allow management access'))
    .toHaveValue('Allow management access')
  await screen.getByRole('button', { name: 'Add to review' }).click()
  await vi.waitFor(() => expect(observed.reviewRows).toHaveLength(8))
  expect(new Set(observed.reviewRows.map((row) => row.direction))).toEqual(
    new Set(['ingress', 'egress'])
  )
  expect(new Set(observed.reviewRows.map((row) => row.protocol))).toEqual(
    new Set(['tcp', 'udp'])
  )
  expect(new Set(observed.reviewRows.map((row) => row.port_range_min))).toEqual(
    new Set(['22', '443'])
  )
  expect(
    observed.reviewRows.every(
      (row) =>
        row.ready &&
        row.remote_ip_prefix === '10.0.0.0/24' &&
        row.description === 'Allow management access'
    )
  ).toBe(true)
  expect(
    observed.reviewRows.every((row) => row.delete_at === '2026-12-01T10:30')
  ).toBe(true)
  // A new review session starts with the original empty defaults.
  await screen
    .getByRole('dialog', { name: /Add rules/ })
    .getByRole('button', { name: 'Close', exact: true })
    .click()
  await expect
    .element(screen.getByRole('dialog', { name: /Add rules/ }))
    .not.toBeInTheDocument()
  await screen
    .getByRole('button', { name: 'Add rule to Application', exact: true })
    .click()
  await screen.getByRole('button', { name: 'Add rule', exact: true }).click()
  await expect
    .element(screen.getByPlaceholder('22, 80, 443, 1000-2000'))
    .toHaveValue('')
  await expect
    .element(screen.getByPlaceholder('For example: Allow management access'))
    .toHaveValue('')
  await expect
    .element(screen.getByRole('button', { name: 'Add to review' }))
    .toBeDisabled()
  await screen.unmount()
  client.clear()
})
