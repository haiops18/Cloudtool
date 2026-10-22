import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { VpcPeeringsPage } from './vpc-peerings-page'

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
afterEach(async () => {
  await cleanup()
  apiClient.defaults.adapter = originalAdapter
  useCloudStore.getState().clear()
  useAuthStore.getState().auth.reset()
})

it('loads peer projects on demand and loads VPCs only after selecting a peer project', async () => {
  useCloudStore.getState().setProject({ id: 'local', name: 'Local project' })
  useAuthStore.getState().auth.setUser({
    id: 'user',
    email: 'user@example.test',
    full_name: 'User',
    role: 'operator',
    is_active: true,
    cloud_api_access: 'full',
  })
  const requests: Array<{ url?: string; target?: string }> = []
  apiClient.defaults.adapter = async (config) => {
    requests.push({ url: config.url, target: config.params?.project_id })
    const data = config.url?.endsWith('/projects')
      ? [{ id: 'remote', name: 'Remote project' }]
      : config.url?.endsWith('/vpcs')
        ? [
            {
              id: '14a657f1-aeaf-4673-9fd0-645eaf632c0d',
              name: config.params?.project_id ? 'Remote VPC' : 'Local VPC',
            },
          ]
        : []
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const screen = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <VpcPeeringsPage />
    </QueryClientProvider>
  )
  await screen
    .getByRole('button', { name: 'Create peering', exact: true })
    .click()
  await expect.element(screen.getByLabelText('Peer VPC ID')).toBeVisible()
  expect(requests.some((request) => request.url?.endsWith('/projects'))).toBe(
    false
  )
  await screen.getByRole('tab', { name: 'Choose project & VPC' }).click()
  await expect
    .element(screen.getByRole('combobox', { name: 'Peer project' }))
    .toBeVisible()
  expect(requests.some((request) => request.target)).toBe(false)
  await screen.getByRole('combobox', { name: 'Peer project' }).click()
  await screen
    .getByRole('button', { name: 'Remote project', exact: true })
    .click()
  await expect
    .element(screen.getByRole('combobox', { name: 'Peer VPC' }))
    .toBeVisible()
  expect(requests).toContainEqual({
    url: '/cloud/vpc-peerings/vpcs',
    target: 'remote',
  })
  expect(useCloudStore.getState().project?.id).toBe('local')
  await screen.getByRole('tab', { name: 'Paste VPC ID' }).click()
  await expect.element(screen.getByLabelText('Peer VPC ID')).toHaveValue('')
})

it('shows the local accepter as source and confirms a pending accept with the current project header', async () => {
  useCloudStore.getState().setProject({ id: 'local', name: 'Local project' })
  useAuthStore.getState().auth.setUser({
    id: 'user',
    email: 'user@example.test',
    full_name: 'User',
    role: 'operator',
    is_active: true,
    cloud_api_access: 'full',
  })
  const requests: Array<{ method?: string; url?: string; project: unknown }> =
    []
  const row = {
    id: 'connection',
    display_name: 'Test connection',
    status: 'pending',
    requester_project: { id: 'remote', name: 'Remote project' },
    requester_vpc: { id: 'remote-vpc', name: 'Remote VPC' },
    accepter_project: { id: 'local', name: 'Local project' },
    accepter_vpc: { id: 'local-vpc', name: 'Local VPC' },
  }
  apiClient.defaults.adapter = async (config) => {
    requests.push({
      method: config.method,
      url: config.url,
      project: config.headers.get('X-Project-Id'),
    })
    return {
      data: config.method === 'get' ? [row] : null,
      status: config.method === 'get' ? 200 : 202,
      statusText: 'OK',
      headers: {},
      config,
    }
  }
  const screen = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <VpcPeeringsPage />
    </QueryClientProvider>
  )
  await expect
    .element(screen.getByText('Local VPC', { exact: true }))
    .toBeVisible()
  const cells = Array.from(document.querySelectorAll('tbody tr td')).map(
    (cell) => cell.textContent || ''
  )
  expect(cells.findIndex((text) => text.includes('Local VPC'))).toBeLessThan(
    cells.findIndex((text) => text.includes('Remote VPC'))
  )
  await screen
    .getByRole('button', { name: 'Actions for Test connection' })
    .click()
  await screen.getByRole('menuitem', { name: 'Accept peering' }).click()
  await expect
    .element(screen.getByText('Accept VPC peering?', { exact: true }))
    .toBeVisible()
  expect(requests.some((request) => request.method === 'post')).toBe(false)
  await screen
    .getByRole('button', { name: 'Accept peering', exact: true })
    .click()
  await vi.waitFor(() =>
    expect(requests).toContainEqual({
      method: 'post',
      url: '/cloud/vpc-peerings/connection/accept',
      project: 'local',
    })
  )
})
