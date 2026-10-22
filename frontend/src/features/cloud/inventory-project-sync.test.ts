import { afterEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/lib/api-client'
import {
  syncInventoryProjects,
  type ProjectSyncResult,
} from './inventory-project-sync'

const originalAdapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
})

it('bounds concurrency for hundreds of projects and retains only batched compact results', async () => {
  const projects = Array.from({ length: 350 }, (_, index) => ({
    id: String(index),
    name: `Project ${index}`,
    display_name: `Project ${index}`,
    organization: '',
  }))
  let active = 0
  let maximum = 0
  let completed = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  apiClient.defaults.adapter = async (config) => {
    active++
    maximum = Math.max(maximum, active)
    await gate
    active--
    completed++
    if (JSON.parse(config.data).project_id === '12') {
      throw Object.assign(new Error('x'.repeat(10000)), {
        response: { data: 'large upstream response' },
      })
    }
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        servers: 10,
        last_synced_at: '2026-10-19T00:00:00Z',
        unused_payload: 'large VM payload',
      },
    }
  }
  const results = new Map<string, Partial<ProjectSyncResult>>()
  const onProgress = vi.fn(
    (patches: Map<string, Partial<ProjectSyncResult>>) => {
      for (const [id, patch] of patches)
        results.set(id, { ...results.get(id), ...patch })
    }
  )
  const running = syncInventoryProjects(projects, 5, onProgress)
  await vi.waitFor(() => expect(active).toBe(5))
  release()
  await running
  expect(maximum).toBe(5)
  expect(completed).toBe(350)
  expect(results.size).toBe(350)
  expect(
    [...results.values()].filter((row) => row.status === 'succeeded')
  ).toHaveLength(349)
  expect(results.get('12')).toEqual({
    status: 'failed',
    error: 'x'.repeat(2000),
  })
  expect(onProgress.mock.calls.length).toBeLessThan(175)
  expect(JSON.stringify([...results])).not.toContain('unused_payload')
})

it('rejects an unexpected VM list instead of storing it as a server count', async () => {
  apiClient.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: {
      servers: [{ id: 'vm', cloud_init: 'large VM content' }],
      last_synced_at: null,
    },
  })
  const patches = new Map<string, Partial<ProjectSyncResult>>()
  await syncInventoryProjects(
    [
      {
        id: 'project',
        name: 'Project',
        display_name: 'Project',
        organization: '',
      },
    ],
    1,
    (updates) => {
      for (const [id, patch] of updates) patches.set(id, patch)
    }
  )
  expect(patches.get('project')).toEqual({
    status: 'failed',
    error: 'Invalid sync response: expected a server count.',
  })
})
