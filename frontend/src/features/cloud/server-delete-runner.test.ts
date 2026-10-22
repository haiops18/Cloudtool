import { AxiosError } from 'axios'
import { afterEach, expect, it } from 'vitest'
import { apiClient } from '@/lib/api-client'
import { runServerDeletions, type DeleteOutcome } from './server-delete-runner'

const adapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = adapter
})

it('publishes progress before the slow VM completes, bounds concurrency and never retries uncertain deletion', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let active = 0
  let peak = 0
  const calls: string[] = []
  const snapshots: DeleteOutcome[][] = []
  apiClient.defaults.adapter = async (config) => {
    expect(config.timeout).toBe(0)
    expect(config.headers['X-Project-Id']).toBe('project')
    const body = JSON.parse(config.data)
    expect(body.items).toHaveLength(1)
    const item = body.items[0]
    expect(item.volumes).toEqual(['volume-' + item.server_id])
    expect(item.eips).toEqual([])
    expect(item.private_ips).toEqual([])
    calls.push(item.server_id)
    peak = Math.max(peak, ++active)
    try {
      if (item.server_id === '0') await gate
      if (item.server_id === '2') throw new AxiosError('Connection lost')
      return {
        data: {
          items: [
            {
              server_id: item.server_id,
              status: item.server_id === '1' ? 'failed' : 'accepted',
              error: item.server_id === '1' ? 'Permission denied' : undefined,
            },
          ],
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    } finally {
      active--
    }
  }
  const pending = runServerDeletions(
    Array.from({ length: 30 }, (_, i) => ({
      server_id: String(i),
      name: 'VM ' + i,
      volumes: ['volume-' + i],
      eips: [],
      private_ips: [],
    })),
    'project',
    (rows) => snapshots.push(rows)
  )
  expect(snapshots[0]).toHaveLength(30)
  expect(snapshots[0].every((row) => row.status === 'queued')).toBe(true)
  await expect
    .poll(
      () =>
        snapshots[snapshots.length - 1]
          ?.filter((row) => !['queued', 'processing'].includes(row.status))
          .length
    )
    .toBe(29)
  expect(snapshots[snapshots.length - 1]?.[0].status).toBe('processing')
  release()
  const result = await pending
  expect(result[0].status).toBe('accepted')
  expect(result[1].status).toBe('failed')
  expect(result[2].status).toBe('unconfirmed')
  expect(calls).toHaveLength(30)
  expect(new Set(calls).size).toBe(30)
  expect(peak).toBeLessThanOrEqual(3)
  expect(result.map((row) => row.name)).toEqual(
    Array.from({ length: 30 }, (_, i) => 'VM ' + i)
  )
})
