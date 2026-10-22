import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { SwitchVmProjectDialog } from './switch-vm-project-dialog'

const originalAdapter = apiClient.defaults.adapter
const target = {
  id: 'vm-project-id',
  name: 'vm-project',
  display_name: 'VM project',
}
afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
  useCloudStore.getState().clear()
})

it('requires confirmation and allows cancellation without changing the project', async () => {
  useCloudStore.getState().setProject({ id: 'original', name: 'Original' })
  const adapter = vi.fn()
  apiClient.defaults.adapter = adapter
  const close = vi.fn()
  const reload = vi.fn()
  const screen = await render(
    <QueryClientProvider client={new QueryClient()}>
      <SwitchVmProjectDialog
        project={target}
        serverName='VM Alpha'
        onClose={close}
        onComplete={reload}
      />
    </QueryClientProvider>
  )
  await expect
    .element(screen.getByText('vm-project-id', { exact: true }))
    .toBeVisible()
  expect(adapter).not.toHaveBeenCalled()
  await userEvent.click(
    screen.getByRole('button', { name: 'Cancel', exact: true })
  )
  expect(close).toHaveBeenCalledOnce()
  expect(reload).not.toHaveBeenCalled()
  expect(adapter).not.toHaveBeenCalled()
  expect(useCloudStore.getState().project?.id).toBe('original')
})

it('waits for session persistence before clearing Cloud cache, switching and reloading', async () => {
  useCloudStore.getState().setProject({ id: 'original', name: 'Original' })
  const client = new QueryClient()
  client.setQueryData(['cloud', 'original', 'servers'], ['old-vm'])
  client.setQueryData(['preferences'], { theme: 'dark' })
  let release: () => void = () => {}
  const requests: Array<{ id: unknown; header: unknown }> = []
  apiClient.defaults.adapter = async (config) => {
    expect(config.url).toBe('/cloud-authorizations/project')
    expect(config.method).toBe('post')
    const body = JSON.parse(config.data)
    requests.push({
      id: body.project_id,
      header: config.headers.get('X-Project-Id'),
    })
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      data: { project_id: body.project_id },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  }
  const reload = vi.fn(() => {
    expect(useCloudStore.getState().project).toEqual(target)
    expect(
      client.getQueryData(['cloud', 'original', 'servers'])
    ).toBeUndefined()
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <SwitchVmProjectDialog
        project={target}
        serverName='VM Alpha'
        onClose={vi.fn()}
        onComplete={reload}
      />
    </QueryClientProvider>
  )
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Switch project and reload',
      exact: true,
    })
  )
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toEqual({ id: target.id, header: target.id })
  expect(useCloudStore.getState().project?.id).toBe('original')
  expect(reload).not.toHaveBeenCalled()
  await expect
    .element(
      screen.getByRole('button', { name: 'Switching project…', exact: true })
    )
    .toBeDisabled()
  await expect
    .element(screen.getByRole('button', { name: 'Cancel', exact: true }))
    .toBeDisabled()
  release()
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
  expect(client.getQueryData(['preferences'])).toEqual({ theme: 'dark' })
})

it('keeps the old project and cache on API failure and supports retry', async () => {
  useCloudStore.getState().setProject({ id: 'original', name: 'Original' })
  const client = new QueryClient()
  client.setQueryData(['cloud', 'original', 'servers'], ['old-vm'])
  let fail = true
  apiClient.defaults.adapter = async (config) => {
    if (fail) throw { response: { data: { detail: 'Session expired' } } }
    return {
      data: { project_id: target.id },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  }
  const reload = vi.fn()
  const screen = await render(
    <QueryClientProvider client={client}>
      <SwitchVmProjectDialog
        project={target}
        serverName='VM Alpha'
        onClose={vi.fn()}
        onComplete={reload}
      />
    </QueryClientProvider>
  )
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Switch project and reload',
      exact: true,
    })
  )
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent('Session expired')
  expect(useCloudStore.getState().project?.id).toBe('original')
  expect(client.getQueryData(['cloud', 'original', 'servers'])).toEqual([
    'old-vm',
  ])
  expect(reload).not.toHaveBeenCalled()
  fail = false
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Switch project and reload',
      exact: true,
    })
  )
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
  expect(useCloudStore.getState().project?.id).toBe(target.id)
})
