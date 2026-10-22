import { resizeErrorMessage } from './resize-error-message'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { ServerResizeDialog } from './server-resize-dialog'

const adapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = adapter
  useCloudStore.getState().clear()
})

it('submits custom specs with live and offline modes only after confirmation', async () => {
  useCloudStore.getState().setProject({ id: 'project', name: 'Project' })
  const submitted: Array<{
    specs: { server_type: string; kind: string; ram: number; vcpus: number }
    live_resize: boolean
  }> = []
  apiClient.defaults.adapter = async (config) => {
    expect(config.url).toMatch(/^\/cloud\/servers(?:\/|$)/)
    expect(config.headers['X-Project-Id']).toBe('project')
    const running = config.url?.endsWith('/running')
    let data: unknown = {
      id: running ? 'running' : 'stopped',
      name: running ? 'Running VM' : 'Stopped VM',
      server_type: 'on_demand',
      power_state: running ? 'running' : 'shutdown',
      flavor: {
        name: running ? 'custom-basic' : 'custom-gpu',
        family: running ? 'basic' : 'gpu',
        ram: 4,
        vcpus: 2,
      },
    }
    if (config.method === 'post') {
      const body = JSON.parse(config.data)
      expect(config.timeout).toBe(0)
      expect(body.items).toHaveLength(1)
      submitted.push(body.items[0])
      data = {
        items: [
          {
            server_id: body.items[0].server_id,
            status:
              body.items[0].server_id === 'stopped' ? 'failed' : 'accepted',
            error:
              body.items[0].server_id === 'stopped'
                ? {
                    message: 'Gateway failure',
                    upstream_detail: 'Not enough memory in compute host',
                  }
                : undefined,
            flavor_name: '2 vCPU / 6 GB',
          },
        ],
      }
    }
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const { getByRole, getByText } = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ServerResizeDialog
        open
        targets={[
          {
            id: 'running',
            name: 'Running VM',
            server_type: 'on_demand',
            power_state: 'running',
          },
          {
            id: 'stopped',
            name: 'Stopped VM',
            server_type: 'on_demand',
            power_state: 'shutdown',
          },
        ]}
        onOpenChange={() => {}}
      />
    </QueryClientProvider>
  )
  await expect.element(getByText('Live resize', { exact: true })).toBeVisible()
  await expect
    .element(getByText('Offline resize', { exact: true }))
    .toBeVisible()
  await expect
    .element(getByRole('spinbutton', { name: 'ram for Running VM' }))
    .toHaveValue(4)
  await expect
    .element(getByRole('spinbutton', { name: 'vcpus for Stopped VM' }))
    .toHaveValue(2)
  await expect.element(getByText('custom-basic', { exact: true })).toBeVisible()
  await expect.element(getByText('custom-gpu', { exact: true })).toBeVisible()
  expect(document.querySelector('[placeholder="Search flavors..."]')).toBeNull()
  await userEvent.fill(
    getByRole('spinbutton', { name: 'ram for Running VM' }),
    '6'
  )
  await userEvent.fill(
    getByRole('spinbutton', { name: 'ram for Stopped VM' }),
    '6'
  )
  await userEvent.click(getByRole('checkbox', { name: 'Select all rows' }))
  await userEvent.click(getByRole('button', { name: 'Resize selected (2)' }))
  expect(submitted).toHaveLength(0)
  await userEvent.click(
    getByRole('button', { name: 'Submit resize', exact: true })
  )
  await expect.poll(() => submitted.length).toBe(2)
  await expect
    .element(getByText('Not enough memory in compute host', { exact: true }))
    .toBeVisible()
  expect(document.body.textContent).not.toContain('Gateway failure')
  expect(submitted.map((row) => row.live_resize)).toEqual([true, false])
  expect(submitted.map((row) => row.specs)).toEqual([
    { server_type: 'basic', kind: 'custom', ram: 6, vcpus: 2 },
    { server_type: 'gpu', kind: 'custom', ram: 6, vcpus: 2 },
  ])
})

it('keeps a VM locked when detail loading fails instead of trusting list data', async () => {
  useCloudStore.getState().setProject({ id: 'project', name: 'Project' })
  apiClient.defaults.adapter = async () => {
    throw new Error('VM detail unavailable')
  }
  const { getByText, getByRole } = await render(
    <QueryClientProvider client={new QueryClient()}>
      <ServerResizeDialog
        open
        targets={[
          {
            id: 'vm',
            name: 'VM',
            server_type: 'basic',
            power_state: 'running',
            specs: { ram: 4, vcpus: 2 },
          },
        ]}
        onOpenChange={() => {}}
      />
    </QueryClientProvider>
  )
  await expect
    .element(getByText('VM detail unavailable', { exact: true }))
    .toBeVisible()
  await expect
    .element(getByRole('checkbox', { name: 'Select row' }))
    .toBeDisabled()
})

it('prefers upstream detail in nested or serialized errors and preserves the full fallback', () => {
  expect(
    resizeErrorMessage({
      detail: { upstream_detail: 'Cloud error', message: 'Gateway error' },
    })
  ).toBe('Cloud error')
  expect(
    resizeErrorMessage(
      JSON.stringify({
        upstream_detail: { ram: ['Quota exceeded'] },
        message: 'Gateway error',
      })
    )
  ).toBe(JSON.stringify({ ram: ['Quota exceeded'] }, null, 2))
  expect(
    resizeErrorMessage({ detail: 'Validation error', code: 'invalid' })
  ).toBe(
    JSON.stringify({ detail: 'Validation error', code: 'invalid' }, null, 2)
  )
  expect(resizeErrorMessage('Connection closed')).toBe('Connection closed')
})
