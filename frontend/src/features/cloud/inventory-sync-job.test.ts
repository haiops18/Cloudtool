import { QueryClient } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/lib/api-client'
import {
  createInventorySyncJob,
  getInventorySyncJob,
} from './inventory-sync-job'

const originalAdapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
})

it('keeps only compact summaries and discards hidden completed results after leaving the page', async () => {
  const client = new QueryClient()
  const job = createInventorySyncJob(client)
  const targets = Array.from({ length: 120 }, (_, index) => ({
    id: `project-${index}`,
    name: `Project ${index}`,
    display_name: `Project ${index}`,
    organization: '',
    vm_payload: 'x'.repeat(100000),
  }))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let completed = 0
  let active = 0
  let maximum = 0
  apiClient.defaults.adapter = async (config) => {
    active++
    maximum = Math.max(maximum, active)
    await gate
    active--
    completed++
    return {
      config,
      data: {
        servers: 100000,
        last_synced_at: '2026-10-19T00:00:00Z',
        vm_payload: 'large VM response',
      },
      status: 200,
      statusText: 'OK',
      headers: {},
    }
  }
  job.setVisible(true)
  const renderPage = vi.fn()
  const renderRows = vi.fn()
  const leavePage = job.subscribe(renderPage)
  const leaveRows = job.results.subscribe(renderRows)
  const running = job.start(targets, 5)
  await vi.waitFor(() => expect(active).toBe(5))
  expect(JSON.stringify(job.results.getSnapshot()).length).toBeLessThan(30000)
  expect(JSON.stringify(job.results.getSnapshot())).not.toContain('vm_payload')
  leavePage()
  leaveRows()
  job.setVisible(false)
  renderPage.mockClear()
  renderRows.mockClear()
  release()
  await running
  expect(completed).toBe(120)
  expect(maximum).toBe(5)
  expect(renderPage).not.toHaveBeenCalled()
  expect(renderRows).not.toHaveBeenCalled()
  expect(job.results.getSnapshot()).toEqual([])
  expect(job.getSnapshot()).toEqual({
    running: false,
    hasResults: false,
    projectCount: 0,
  })
  client.clear()
})

it('reuses the running job across page mounts and keeps results only while the modal is visible', async () => {
  const client = new QueryClient()
  const job = getInventorySyncJob(client)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  apiClient.defaults.adapter = async (config) => {
    requests++
    await gate
    return {
      config,
      data: { servers: 90000, last_synced_at: '2026-10-19T00:00:00Z' },
      status: 200,
      statusText: 'OK',
      headers: {},
    }
  }
  job.setVisible(true)
  const running = job.start(
    [
      {
        id: 'project',
        name: 'Project',
        display_name: 'Project',
        organization: '',
      },
    ],
    5
  )
  await vi.waitFor(() => expect(requests).toBe(1))
  job.setVisible(false)
  const reopened = getInventorySyncJob(client)
  expect(reopened).toBe(job)
  expect(reopened.getSnapshot().running).toBe(true)
  await reopened.start(
    [
      {
        id: 'duplicate',
        name: 'Duplicate',
        display_name: 'Duplicate',
        organization: '',
      },
    ],
    5
  )
  expect(requests).toBe(1)
  reopened.setVisible(true)
  release()
  await running
  expect(reopened.results.getSnapshot()).toEqual([
    expect.objectContaining({
      id: 'project',
      status: 'succeeded',
      servers: 90000,
    }),
  ])
  reopened.setVisible(false)
  expect(reopened.results.getSnapshot()).toEqual([])
  client.clear()
})
