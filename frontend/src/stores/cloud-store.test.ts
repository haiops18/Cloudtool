import { expect, it, vi } from 'vitest'

it('keeps private token only in current module memory and clears project with it', async () => {
  const { useCloudStore } = await import('./cloud-store')
  useCloudStore.getState().setToken('private-runtime-token')
  useCloudStore.getState().setProject({ id: 'project-1', name: 'Project 1' })
  expect(useCloudStore.getState().token).toBe('private-runtime-token')
  useCloudStore.getState().clear()
  expect(useCloudStore.getState().token).toBe('')
  expect(useCloudStore.getState().project).toBeNull()
  vi.resetModules()
  const reloaded = await import('./cloud-store')
  expect(reloaded.useCloudStore.getState().token).toBe('')
})
