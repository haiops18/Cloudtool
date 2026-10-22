import { AxiosError } from 'axios'
import { afterEach, expect, it, vi } from 'vitest'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { changeConsolePasswords } from './multi-console-password-runner'

const adapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = adapter
  useCloudStore.getState().clear()
})

it('limits concurrency, reports progress, and continues after failures without retrying VMs', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let active = 0
  let peak = 0
  const requested: string[] = []
  const onResult = vi.fn()
  const source = { password: 'ExamplePassword1!' }
  apiClient.defaults.adapter = async (config) => {
    const body = JSON.parse(config.data)
    expect(body.server_ids).toHaveLength(1)
    expect(body.password).toBe('ExamplePassword1!')
    expect(config.timeout).toBe(45_000)
    expect(config.headers['X-Project-Id']).toBe('original-project')
    const id = body.server_ids[0]
    requested.push(id)
    active++
    peak = Math.max(peak, active)
    await pending
    active--
    if (id === 'timeout') throw new AxiosError('Timeout', 'ECONNABORTED')
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        items:
          id === 'missing'
            ? []
            : [
                {
                  server_id: id,
                  status: id === 'rejected' ? 'failed' : 'accepted',
                  ...(id === 'rejected'
                    ? { error: 'VM refused the password' }
                    : {}),
                },
              ],
      },
    }
  }
  const serverIds = [
    'first',
    'timeout',
    'rejected',
    'fourth',
    'missing',
    'sixth',
    'seventh',
  ]
  const run = changeConsolePasswords({
    serverIds,
    source,
    projectId: 'original-project',
    onResult,
  })
  await vi.waitFor(() => expect(requested).toHaveLength(3))
  expect(onResult.mock.calls.map(([result]) => result.status)).toEqual([
    'processing',
    'processing',
    'processing',
  ])
  source.password = 'ChangedWhileRunning1!'
  useCloudStore.getState().setProject({ id: 'another-project', name: 'Other' })
  release()
  const results = await run
  expect(peak).toBe(3)
  expect(requested).toEqual(serverIds)
  expect(results.map((result) => result.status)).toEqual([
    'accepted',
    'unconfirmed',
    'failed',
    'accepted',
    'unconfirmed',
    'accepted',
    'accepted',
  ])
  expect(results[1].error).toContain('Check the VM or audit logs')
  expect(results[2].error).toBe('VM refused the password')
  expect(onResult).toHaveBeenCalledTimes(serverIds.length * 2)
})

it('sends the selected profile separately for each VM and matches results by server ID', async () => {
  apiClient.defaults.adapter = async (config) => {
    const body = JSON.parse(config.data)
    expect(body.profile_id).toBe('profile')
    expect(body).not.toHaveProperty('password')
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        items: [
          { server_id: 'unrelated', status: 'failed' },
          { server_id: body.server_ids[0], status: 'completed' },
        ],
      },
    }
  }
  const results = await changeConsolePasswords({
    serverIds: ['one', 'two'],
    source: { profile_id: 'profile' },
    onResult: () => undefined,
  })
  expect(results).toEqual([
    { server_id: 'one', status: 'completed' },
    { server_id: 'two', status: 'completed' },
  ])
})
