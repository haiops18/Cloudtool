import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api-client'
import { downloadXlsx } from '@/lib/xlsx-export'
import { AllServersPage } from './all-servers-page'

vi.mock('@/lib/xlsx-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/xlsx-export')>()),
  downloadXlsx: vi.fn(),
}))

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
  vi.mocked(downloadXlsx).mockClear()
})

it('confirms matching projects before refreshing and opens their results', async () => {
  const loadedPages: number[] = []
  const syncedProjects: string[] = []
  let catalogRequests = 0
  apiClient.defaults.adapter = async (config) => {
    let data: unknown
    if (config.url === '/cloud/all-server-inventory/projects') {
      catalogRequests++
      data = { items: [], total: 0 }
    } else if (config.url === '/cloud/all-server-inventory/sync-project') {
      syncedProjects.push(JSON.parse(config.data).project_id)
      data = { servers: 10, last_synced_at: '2026-10-19T00:00:00Z' }
    } else {
      const collecting = config.params?.page_size === 500
      const page = config.params?.page ?? 1
      if (collecting) {
        loadedPages.push(page)
        expect(config.params.q).toBe('10.0.0.1')
      }
      data = {
        items: Array.from({ length: collecting && page === 1 ? 500 : 1 }, (_, index) => ({
          id: `row-${page}-${index}`, server_id: `vm-${page}-${index}`, server_name: `VM ${page}-${index}`,
          project_id: page === 2 ? 'second-project' : 'first-project',
          project_name: page === 2 ? 'Second' : 'First',
        })),
        total: 501, page, page_size: collecting ? 500 : 50,
      }
    }
    return { config, data, status: 200, statusText: 'OK', headers: {} }
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const screen = await render(<QueryClientProvider client={client}><AllServersPage /></QueryClientProvider>)
  await screen.getByPlaceholder('Search all columns').fill('10.0.0.1')
  await screen.getByRole('button', { name: 'Run search', exact: true }).click()
  const refresh = screen.getByRole('button', { name: 'Refresh projects in search results', exact: true })
  await expect.element(refresh).toBeEnabled()
  await refresh.click()
  const confirmation = screen.getByRole('alertdialog')
  await expect.element(confirmation).toBeVisible()
  await expect.element(confirmation.getByText('first-project', { exact: true })).toBeVisible()
  await expect.element(confirmation.getByText('second-project', { exact: true })).toBeVisible()
  expect(loadedPages).toEqual([1, 2])
  expect(catalogRequests).toBe(0)
  expect(syncedProjects).toHaveLength(0)
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(syncedProjects).toHaveLength(0)
  await refresh.click()
  client.setQueryData(['cloud', 'all-server-inventory', 'old-search'], { items: ['old data'] })
  client.setQueryData(['other-page'], { keep: true })
  await confirmation.getByRole('button', { name: 'Start sync', exact: true }).click()
  const dialog = screen.getByRole('dialog', { name: 'Refresh organization inventory', exact: true })
  await expect.element(dialog).toBeVisible()
  await vi.waitFor(() => expect([...syncedProjects].sort()).toEqual(['first-project', 'second-project']))
  await vi.waitFor(() => expect(client.isFetching()).toBe(0))
  await vi.waitFor(() => expect(client.getQueryData(['cloud', 'all-server-inventory', 'old-search'])).toBeUndefined())
  expect(client.getQueryData(['other-page'])).toEqual({ keep: true })
  await dialog.getByRole('button', { name: 'Close inventory modal', exact: true }).click()
  await expect.element(screen.getByRole('alertdialog')).toHaveTextContent('Close inventory modal?')
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Keep open', exact: true }).click()
  await expect.element(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Close inventory modal', exact: true }).click()
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Close modal', exact: true }).click()
  await expect.element(dialog).not.toBeInTheDocument()
  await screen.unmount()
  client.clear()
})

it('searches immediately while initial loading is pending and replaces slower searches', async () => {
  let releaseSlowRequests!: () => void
  const slowRequests = new Promise<void>((resolve) => { releaseSlowRequests = resolve })
  const requested: string[] = []
  const aborted: string[] = []
  let slowResponses = 0
  const errorToast = vi.spyOn(toast, 'error')
  apiClient.defaults.adapter = async (config) => {
    const query = config.params?.q || 'initial'
    requested.push(query)
    config.signal?.addEventListener?.('abort', () => aborted.push(query))
    if (query !== '10.0.0.2') {
      await slowRequests
      slowResponses++
    }
    return { config, status: 200, statusText: 'OK', headers: {}, data: {
      items: [{ id: query, server_id: query, server_name: query === '10.0.0.2' ? 'Latest search result' : 'Stale result',
        project_id: 'project', project_name: 'Project' }],
      total: 1, page: 1, page_size: 50,
    } }
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const screen = await render(<QueryClientProvider client={client}><AllServersPage /></QueryClientProvider>)
  try {
    await vi.waitFor(() => expect(requested).toEqual(['initial']))
    const search = screen.getByPlaceholder('Search all columns')
    const run = screen.getByRole('button', { name: 'Run search', exact: true })
    await expect.element(search).toBeEnabled()
    await expect.element(run).toBeEnabled()
    await search.fill('10.0.0.1')
    await run.click()
    await vi.waitFor(() => expect(requested).toContain('10.0.0.1'))
    expect(slowResponses).toBe(0)
    await expect.element(run).toBeEnabled()
    await search.fill('10.0.0.2')
    await userEvent.keyboard('{Enter}')
    await expect.element(screen.getByText('Latest search result', { exact: true })).toBeVisible()
    expect(aborted).toEqual(['initial', '10.0.0.1'])
    releaseSlowRequests()
    await vi.waitFor(() => expect(slowResponses).toBe(2))
    await expect.element(screen.getByText('Stale result', { exact: true })).not.toBeInTheDocument()
    expect(errorToast).not.toHaveBeenCalled()
  } finally {
    releaseSlowRequests()
    await screen.unmount()
    client.clear()
    errorToast.mockRestore()
  }
})

it('searches projects by name, display name and ID, then exports every matching database page', async () => {
  const exportedPages: number[] = []
  const project = {
    id: 'uuid-project-123',
    name: 'internal-project-name',
    display_name: 'Friendly project label',
  }
  apiClient.defaults.adapter = async (config) => {
    let data: unknown
    if (config.url === '/cloud/all-server-inventory/project-options') {
      data = { items: [project], total: 1 }
    } else {
      const exporting = config.params?.page_size === 500
      const page = config.params?.page ?? 1
      if (exporting) {
        exportedPages.push(page)
        expect(config.params.q).toBe('web')
        expect(config.params.project_ids).toBe(project.id)
        expect(config.params.zone).toBe('Hanoi')
        expect(config.params.power_state).toBe('running')
      }
      const start = (page - 1) * 500
      data = {
        items: Array.from(
          { length: exporting ? Math.min(500, 501 - start) : 1 },
          (_, index) => ({
            id: `row-${start + index}`,
            server_id: `vm-${start + index}`,
            server_name: `web-${start + index}`,
            project_id: project.id,
            project_name: project.name,
            project_display_name: project.display_name,
          })
        ),
        total: 501,
        page,
        page_size: exporting ? 500 : 50,
      }
    }
    return { config, data, status: 200, statusText: 'OK', headers: {} }
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <AllServersPage />
    </QueryClientProvider>
  )
  await screen.getByPlaceholder('Search all columns').fill('web')
  await screen.getByPlaceholder('Zone', { exact: true }).fill('Hanoi')
  await screen.getByPlaceholder('Power state', { exact: true }).fill('running')
  await screen.getByRole('button', { name: 'Run search', exact: true }).click()
  await screen
    .getByRole('combobox', { name: 'Filter projects', exact: true })
    .click()
  const search = screen.getByPlaceholder(
    'Search project name, display name or ID...'
  )
  for (const value of [project.name, project.display_name, project.id]) {
    await search.fill(value)
    await expect
      .element(
        screen.getByRole('option', { name: project.display_name, exact: true })
      )
      .toBeVisible()
    await expect.element(screen.getByRole('option', { name: project.display_name, exact: true }).getByText(project.name, { exact: true })).toBeVisible()
  }
  await screen
    .getByRole('option', { name: project.display_name, exact: true })
    .click()
  await screen.getByRole('button', { name: 'Apply', exact: true }).click()
  const exportButton = screen.getByRole('button', {
    name: 'Export all matching servers',
    exact: true,
  })
  await expect.element(exportButton).toBeEnabled()
  await exportButton.click()
  await vi.waitFor(() => expect(downloadXlsx).toHaveBeenCalledOnce())
  expect(exportedPages).toEqual([1, 2])
  const [headers, rows] = vi.mocked(downloadXlsx).mock.calls[0]
  expect(rows).toHaveLength(501)
  expect(rows[500][headers.indexOf('server_id')]).toBe('vm-500')
  await screen.unmount()
  client.clear()
})

it('keeps the outside table unchanged and shows row numbers, Project ID and sync state inside the refresh dialog', async () => {
  let synced = false
  let syncRequests = 0
  let vipSearchRequests = 0
  let detailRequests = 0
  let teleportRequests = 0
  const projectFilters: (string | undefined)[] = []
  let finishSync: () => void = () => {}
  const time = '2026-10-05T12:30:00+07:00'
  apiClient.defaults.adapter = async (config) => {
    let data: unknown
    if (
      config.url === '/cloud/all-server-inventory/projects' ||
      config.url === '/cloud/all-server-inventory/project-options'
    ) {
      data = {
        items: [
          {
            id: 'new-project',
            name: 'New project',
            display_name: 'New project',
            organization: 'Org',
            is_synced: synced,
            last_synced_at: synced ? time : null,
          },
          {
            id: 'old-project',
            name: 'Old project',
            display_name: 'Old project',
            organization: 'Org',
            is_synced: true,
            last_synced_at: '2026-10-04T11:00:00+07:00',
          },
        ],
        total: 2,
      }
    } else if (config.url === '/cloud/all-server-inventory/sync-project') {
      syncRequests += 1
      expect(JSON.parse(config.data).project_id).toBe('new-project')
      await new Promise<void>((resolve) => {
        finishSync = resolve
      })
      synced = true
      data = { servers: 0, last_synced_at: time }
    } else if (config.url === '/cloud/all-server-inventory') {
      projectFilters.push(config.params?.project_ids)
      if (config.params?.elastic_ip === '171.253.170.168')
        vipSearchRequests += 1
      data = {
        items: [
          {
            id: 'row1',
            server_id: 'vm1',
            server_name: 'VM Alpha',
            refreshed_at: new Date(Date.now() - 1.2 * 86_400_000).toISOString(),
            project_id: 'new-project',
            project_name: 'New project',
            private_ip: ['10.0.0.1'],
            elastic_ip: ['171.253.170.167'],
            elastic_vip_ip: ['171.253.170.168'],
          },
        ],
        total: 1,
        page: 1,
        page_size: 50,
      }
    } else if (
      config.url === '/cloud/all-server-inventory/servers/new-project/vm1'
    ) {
      detailRequests += 1
      expect(config.params?.include_network_details).toBe(true)
      data = {
        item: {
          id: 'vm1',
          name: 'VM Alpha',
          user_data: '#cloud-config\npackages: [curl]',
          network_details: {
            private_ips: [
              {
                ip_address: '10.0.0.1',
                subnet: { name: 'Production subnet', cidr: '10.0.0.0/24' },
                vip_ips: ['10.0.0.4'],
              },
            ],
            elastic_ips: [
              { ip_address: '171.253.170.167', vip_ips: ['171.253.170.168'] },
            ],
          },
        },
      }
    } else if (config.url === '/teleport-links') {
      teleportRequests += 1
      data = []
    } else throw new Error(`Unexpected URL: ${config.url}`)
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <AllServersPage />
    </QueryClientProvider>
  )
  await expect
    .element(screen.getByText('VM Alpha', { exact: true }))
    .toBeVisible()
  expect(detailRequests).toBe(0)
  expect(teleportRequests).toBe(0)
  const rowMenu = screen
    .getByRole('row')
    .filter({ hasText: 'VM Alpha' })
    .getByRole('button')
  await userEvent.click(rowMenu)
  await userEvent.click(
    screen.getByRole('menuitem', { name: 'View details', exact: true })
  )
  const details = screen.getByRole('dialog', {
    name: 'Server details',
    exact: true,
  })
  await expect
    .element(details.getByText('Production subnet', { exact: true }))
    .toBeVisible()
  await expect
    .element(details.getByLabelText('Server user data'))
    .toHaveValue('#cloud-config\npackages: [curl]')
  expect(detailRequests).toBe(1)
  await userEvent.click(
    details.getByRole('button', { name: 'Close', exact: true }).first()
  )
  await userEvent.click(rowMenu)
  await userEvent.click(
    screen.getByRole('menuitem', { name: 'Open in Teleport', exact: true })
  )
  const teleport = screen.getByRole('dialog', {
    name: 'Open in Teleport',
    exact: true,
  })
  await expect
    .element(teleport.getByLabelText('VM private IP', { exact: true }))
    .toHaveValue('10.0.0.1')
  await vi.waitFor(() => expect(teleportRequests).toBe(1))
  await userEvent.click(
    teleport.getByRole('button', {
      name: 'Close Teleport terminal',
      exact: true,
    })
  )
  await userEvent.click(
    screen
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Close terminal', exact: true })
  )
  const headers = Array.from(document.querySelectorAll('table thead th')).map(
    (element) => element.textContent?.trim()
  )
  expect(headers[0]).toBe('')
  expect(headers[1]).toBe('#')
  expect(headers).not.toContain('Project ID')
  expect(headers).toContain('Days')
  expect(headers.indexOf('Elastic VIP IPs')).toBe(
    headers.indexOf('Elastic IPs') + 1
  )
  await expect
    .element(screen.getByText('171.253.170.168', { exact: true }))
    .toBeVisible()
  await userEvent.fill(
    screen.getByPlaceholder('Elastic IP', { exact: true }),
    '171.253.170.168'
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Run search', exact: true })
  )
  await vi.waitFor(() => expect(vipSearchRequests).toBe(1))
  await expect
    .element(screen.getByPlaceholder('Elastic VIP IP', { exact: true }))
    .not.toBeInTheDocument()
  expect(projectFilters[projectFilters.length - 1]).toBeUndefined()
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Filter projects', exact: true })
  )
  await expect
    .element(screen.getByRole('button', { name: 'Clear all', exact: true }))
    .toBeDisabled()
  await userEvent.click(
    screen.getByRole('option', { name: 'Old project', exact: true })
  )
  await vi.waitFor(() => {
    const options = Array.from(document.querySelectorAll('[cmdk-item]')).map(
      (item) => item.getAttribute('aria-label') || item.textContent?.trim()
    )
    expect(options).toEqual(['All projects', 'Old project', 'New project'])
  })
  await userEvent.fill(
    screen.getByPlaceholder('Search project name, display name or ID...'),
    'project'
  )
  await vi.waitFor(() => {
    const options = Array.from(document.querySelectorAll('[cmdk-item]')).map(
      (item) => item.getAttribute('aria-label') || item.textContent?.trim()
    )
    expect(options).toEqual(['All projects', 'Old project', 'New project'])
  })
  await userEvent.click(
    screen.getByRole('option', { name: 'New project', exact: true })
  )
  expect(projectFilters[projectFilters.length - 1]).toBeUndefined()
  await userEvent.click(
    screen.getByRole('button', { name: 'Apply', exact: true })
  )
  await vi.waitFor(() =>
    expect(projectFilters[projectFilters.length - 1]).toBe(
      'new-project,old-project'
    )
  )
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Filter projects', exact: true })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Clear all', exact: true })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Apply', exact: true })
  )
  await vi.waitFor(() =>
    expect(projectFilters[projectFilters.length - 1]).toBeUndefined()
  )
  await expect.element(screen.getByText('1,2', { exact: true })).toBeVisible()
  const numberCell = document.querySelector('table tbody tr td:nth-child(2)')
  expect(numberCell?.textContent?.trim()).toBe('1')
  await userEvent.click(
    screen.getByRole('button', { name: 'Refresh inventory', exact: true })
  )
  const dialog = screen.getByRole('dialog', {
    name: 'Refresh organization inventory',
    exact: true,
  })
  await expect
    .element(dialog.getByText('Not synced', { exact: true }))
    .toBeVisible()
  await expect
    .element(dialog.getByText('Synced', { exact: true }))
    .toBeVisible()
  await expect
    .element(dialog.getByText('Never synced', { exact: true }))
    .toBeVisible()
  await expect
    .element(dialog.getByText('Last sync (GMT+7)', { exact: true }))
    .toBeVisible()
  await expect
    .element(dialog.getByText('Days since sync', { exact: true }))
    .toBeVisible()
  const rows = Array.from(
    document.querySelectorAll('[role="dialog"] tbody tr')
  ).map((element) => element.textContent)
  expect(rows[0]).toContain('New project')
  const modalHeaders = Array.from(
    document.querySelectorAll('[role="dialog"] thead th')
  ).map((element) => element.textContent?.trim())
  expect(modalHeaders[0]).toBe('')
  expect(modalHeaders[1]).toBe('#')
  expect(modalHeaders[2]).toContain('Project ID')
  expect(
    document
      .querySelector('[role="dialog"] tbody tr td:nth-child(2)')
      ?.textContent?.trim()
  ).toBe('1')
  const newProject = dialog.getByRole('row').filter({ hasText: 'new-project' })
  await userEvent.click(
    newProject.getByRole('checkbox', { name: 'Select row', exact: true })
  )
  await userEvent.click(
    dialog.getByRole('button', { name: 'Sync VM (1)', exact: true })
  )
  await expect
    .element(screen.getByRole('alertdialog'))
    .toHaveTextContent('Synchronize selected projects?')
  expect(syncRequests).toBe(0)
  await userEvent.click(
    screen.getByRole('button', { name: 'Cancel', exact: true })
  )
  expect(syncRequests).toBe(0)
  await userEvent.click(
    dialog.getByRole('button', { name: 'Sync VM (1)', exact: true })
  )
  const confirmation = screen.getByRole('alertdialog')
  await expect.element(confirmation).toHaveTextContent('new-project')
  await userEvent.click(
    confirmation.getByRole('button', { name: 'Start sync', exact: true })
  )
  await vi.waitFor(() => expect(syncRequests).toBe(1))
  await expect
    .element(dialog.getByText('syncing', { exact: true }))
    .toBeVisible()
  await expect
    .element(dialog.getByLabelText('Parallel project workflows'))
    .toBeDisabled()
  await userEvent.click(
    dialog.getByRole('button', { name: 'Close inventory modal', exact: true })
  )
  await expect
    .element(screen.getByRole('alertdialog'))
    .toHaveTextContent('Synchronization will continue in the background.')
  await userEvent.click(
    screen.getByRole('button', { name: 'Keep watching', exact: true })
  )
  await expect.element(dialog).toBeVisible()
  await userEvent.click(
    dialog.getByRole('button', { name: 'Close inventory modal', exact: true })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Close modal', exact: true })
  )
  await expect.element(dialog).not.toBeInTheDocument()
  await userEvent.click(
    screen.getByRole('button', { name: 'Refresh inventory', exact: true })
  )
  await expect
    .element(dialog.getByText('syncing', { exact: true }))
    .toBeVisible()
  finishSync()
  await expect
    .element(dialog.getByText('succeeded', { exact: true }))
    .toBeVisible()
  await expect
    .element(dialog.getByText('Synced', { exact: true }))
    .toBeVisible()
  await expect
    .element(dialog.getByText('Never synced', { exact: true }))
    .not.toBeInTheDocument()
})
