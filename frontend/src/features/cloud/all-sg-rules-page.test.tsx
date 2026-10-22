import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { AllSgRulesPage } from './all-sg-rules-page'

vi.mock('./page-shell', () => ({
  CloudPageShell: ({
    children,
    actions,
  }: {
    children: ReactNode
    actions: ReactNode
  }) => (
    <>
      {actions}
      {children}
    </>
  ),
}))
const originalAdapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
  useCloudStore.getState().clear()
})

it('requests each page from the backend and loads project options only when opened', async () => {
  const queries: Record<string, unknown>[] = []
  let projectRequests = 0
  apiClient.defaults.adapter = async (config) => {
    let data: unknown
    if (config.url?.endsWith('/all/project-names')) {
      data = {
        items: [
          { id: 'project-a', name: 'Project A', display_name: 'Display A' },
        ],
      }
    } else if (config.url?.endsWith('/all/projects')) {
      projectRequests++
      data = { items: [{ id: 'project-a' }] }
    } else {
      queries.push(config.params)
      data = { items: [], total: 101, due: 0, upcoming: 101 }
    }
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const screen = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AllSgRulesPage />
    </QueryClientProvider>
  )
  await expect
    .element(screen.getByText('Page 1 / 3', { exact: true }))
    .toBeVisible()
  expect(projectRequests).toBe(0)
  await userEvent.click(
    screen.getByRole('button', { name: 'Next page', exact: true })
  )
  await vi.waitFor(() =>
    expect(
      queries.some((params) => params.page === 2 && params.page_size === 50)
    ).toBe(true)
  )
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Filter projects', exact: true })
  )
  await expect
    .element(screen.getByRole('option', { name: 'Display A', exact: true }))
    .toBeVisible()
  expect(projectRequests).toBe(1)
  await userEvent.click(
    screen.getByRole('option', { name: 'Display A', exact: true })
  )
  await vi.waitFor(() =>
    expect(
      queries.some(
        (params) =>
          params.page === 1 &&
          JSON.stringify(params.project_ids) === '["project-a"]'
      )
    ).toBe(true)
  )
})

it('automatically displays project names and full rules, and confirms deletion in each project with partial failures', async () => {
  useCloudStore.getState().setProject({ id: 'global', name: 'Global' })
  const requests: {
    url?: string
    method?: string
    project: unknown
    body?: unknown
  }[] = []
  let removed = false
  const rows = ['a', 'b'].map((id) => ({
    id,
    rule_id: `rule-${id}`,
    project_id: `project-${id}`,
    security_group_id: `sg-${id}`,
    delete_at: '2026-12-01T10:30:00+07:00',
    rule_created_at: null,
    last_error: null,
    is_due: id === 'a',
  }))
  apiClient.defaults.adapter = async (config) => {
    requests.push({
      url: config.url,
      method: config.method,
      project: config.headers.get('X-Project-Id'),
      body: config.data ? JSON.parse(config.data) : undefined,
    })
    let data: unknown
    if (config.method === 'post') {
      const project = config.headers.get('X-Project-Id')
      if (project === 'project-a') removed = true
      data = {
        items: [
          {
            rule_id: project === 'project-a' ? 'rule-a' : 'rule-b',
            status: project === 'project-a' ? 'deleted' : 'failed',
            error: 'Cloud rejected deletion',
          },
        ],
      }
    } else if (config.url?.endsWith('/all/list')) {
      const items = removed ? rows.slice(1) : rows
      data = { items, total: items.length, due: removed ? 0 : 1, upcoming: 1 }
    } else if (config.url?.endsWith('/all/projects')) {
      data = { items: [{ id: 'project-a' }, { id: 'project-b' }] }
    } else if (config.url?.endsWith('/all/project-names')) {
      data = {
        items: ['a', 'b'].map((id) => ({
          id: `project-${id}`,
          name: `Project ${id}`,
          display_name: `Display ${id}`,
        })),
      }
    } else {
      const id = config.headers.get('X-Project-Id') === 'project-a' ? 'a' : 'b'
      data = {
        items: [
          {
            rule_id: `rule-${id}`,
            security_group_name: `Firewall ${id}`,
            rule: {
              id: `rule-${id}`,
              security_group: `sg-${id}`,
              direction: 'ingress',
              protocol: 'tcp',
              port_range_min: 22,
              port_range_max: 22,
              remote_ip_prefix: '10.0.0.0/24',
              ethertype: 'IPv4',
              description: `Rule detail ${id}`,
            },
          },
        ],
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
      <AllSgRulesPage />
    </QueryClientProvider>
  )
  await expect
    .element(screen.getByText('Rule detail a', { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText('Project a', { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText('Display a', { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText('Firewall a', { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText('project-a', { exact: true }))
    .not.toBeInTheDocument()
  await expect
    .element(screen.getByText('sg-a', { exact: true }))
    .not.toBeInTheDocument()
  expect(
    requests
      .filter(
        (request) => request.url === '/cloud/security-groups/scheduled-rules'
      )
      .map((request) => request.project)
      .sort()
  ).toEqual(['project-a', 'project-b'])
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Select all rows', exact: true })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Delete selected', exact: true })
  )
  expect(requests.filter((request) => request.method === 'post')).toHaveLength(
    0
  )
  await expect
    .element(screen.getByText(/1 rule\(s\) have a future deletion date/))
    .toBeVisible()
  await userEvent.click(
    screen.getByRole('button', { name: 'Delete rules', exact: true })
  )
  await expect
    .element(
      screen.getByRole('button', { name: 'Delete rule rule-a', exact: true })
    )
    .not.toBeInTheDocument()
  await expect
    .element(
      screen.getByRole('button', { name: 'Delete rule rule-b', exact: true })
    )
    .toBeVisible()
  expect(
    requests
      .filter((request) => request.method === 'post')
      .map((request) => ({ project: request.project, body: request.body }))
  ).toEqual([
    {
      project: 'project-a',
      body: { rule_ids: ['rule-a'], verify_exists: true },
    },
    {
      project: 'project-b',
      body: { rule_ids: ['rule-b'], verify_exists: true },
    },
  ])
  expect(useCloudStore.getState().project?.id).toBe('global')
})

it('locks unverifiable rows and requires the exact phrase before deleting all verified due rules', async () => {
  let deleted = false
  const posts: unknown[] = []
  apiClient.defaults.adapter = async (config) => {
    let data: unknown
    if (config.method === 'post') {
      posts.push(JSON.parse(config.data))
      deleted = true
      data = { items: [{ status: 'deleted' }], skipped: 1 }
    } else if (config.url?.endsWith('/all/due-preview')) {
      data = { schedule_ids: ['safe'], eligible: 1, skipped: 1 }
    } else if (config.url?.endsWith('/all/project-names')) {
      data = {
        items: [{ id: 'project', name: 'Project', display_name: 'Display' }],
      }
    } else if (config.url?.endsWith('/all/list')) {
      data = {
        items: deleted
          ? []
          : ['safe', 'missing'].map((id) => ({
              id,
              rule_id: id,
              project_id: 'project',
              security_group_id: 'sg',
              delete_at: '2026-10-01T00:00:00+07:00',
              is_due: true,
            })),
        total: deleted ? 0 : 2,
        due: deleted ? 0 : 2,
        upcoming: 0,
      }
    } else {
      data = {
        items: [
          {
            rule_id: 'safe',
            security_group_name: 'Firewall',
            rule: {
              id: 'safe',
              direction: 'ingress',
              protocol: 'tcp',
              security_group: 'sg',
              description: 'Verified',
            },
          },
        ],
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
      <AllSgRulesPage />
    </QueryClientProvider>
  )
  await expect
    .element(screen.getByText('Verified', { exact: true }))
    .toBeVisible()
  await expect
    .element(
      screen.getByRole('checkbox', { name: 'Select rule missing', exact: true })
    )
    .toBeDisabled()
  await expect
    .element(
      screen.getByRole('button', { name: 'Delete rule missing', exact: true })
    )
    .toBeDisabled()
  await expect
    .element(screen.getByText('Unavailable', { exact: true }))
    .not.toBeInTheDocument()
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Select all rows', exact: true })
  )
  await expect
    .element(
      screen.getByRole('checkbox', { name: 'Select rule safe', exact: true })
    )
    .toBeChecked()
  await expect
    .element(
      screen.getByRole('checkbox', { name: 'Select rule missing', exact: true })
    )
    .not.toBeChecked()
  await userEvent.click(
    screen.getByRole('button', { name: 'Delete all due rules', exact: true })
  )
  const dialog = screen.getByRole('alertdialog')
  const confirm = dialog.getByRole('button', {
    name: 'Delete all due rules',
    exact: true,
  })
  await expect.element(confirm).toBeDisabled()
  await userEvent.fill(
    screen.getByLabelText('Type DELETE ALL DUE SG RULES to confirm'),
    'DELETE'
  )
  await expect.element(confirm).toBeDisabled()
  expect(posts).toHaveLength(0)
  await userEvent.fill(
    screen.getByLabelText('Type DELETE ALL DUE SG RULES to confirm'),
    'DELETE ALL DUE SG RULES'
  )
  await expect.element(confirm).toBeEnabled()
  await userEvent.click(confirm)
  await vi.waitFor(() =>
    expect(posts).toEqual([
      { confirmation: 'DELETE ALL DUE SG RULES', schedule_ids: ['safe'] },
    ])
  )
})
