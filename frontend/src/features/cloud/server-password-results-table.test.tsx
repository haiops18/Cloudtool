import { expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { ServerPasswordResultsTable } from './server-password-results-table'

it('shows names, distinct results and only upstream details without exposing server IDs', async () => {
  const screen = await render(
    <ServerPasswordResultsTable
      rows={[
        { server_id: 'hidden-id-1', name: 'Web VM', status: 'completed' },
        {
          server_id: 'hidden-id-2',
          name: 'DB VM',
          status: 'failed',
          error: 'Gateway wrapper',
          error_detail: {
            message: 'Gateway wrapper',
            upstream_detail: {
              message: 'Password change is not supported',
              code: 'not_supported',
            },
          },
        },
        { server_id: 'hidden-id-3', name: 'Worker VM', status: 'processing' },
        { server_id: 'hidden-id-4', name: 'API VM', status: 'accepted' },
      ]}
    />
  )
  await expect
    .element(screen.getByText('Web VM', { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText('Success', { exact: true }))
    .toBeVisible()
  await expect.element(screen.getByText('Error', { exact: true })).toBeVisible()
  await expect
    .element(screen.getByText('Processing', { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText('Accepted', { exact: true }))
    .toBeVisible()
  await expect
    .element(
      screen.getByText('Password change is not supported', { exact: true })
    )
    .toBeVisible()
  expect(document.body.textContent).not.toContain('hidden-id-')
  expect(document.body.textContent).not.toContain('Gateway wrapper')
  expect(document.body.textContent).not.toContain('not_supported')
  expect(document.body.textContent).not.toContain('New password')
  const name = [...document.querySelectorAll('p')].find(
    (node) => node.textContent === 'Web VM'
  )!
  expect(name.className).toContain('text-foreground')
  expect(document.querySelector('svg.animate-spin')).not.toBeNull()
})

it('preserves all error fields when no upstream detail is present', async () => {
  const error = {
    message: 'Validation failed',
    code: 'invalid_request',
    reasons: ['Invalid VM state'],
  }
  const screen = await render(
    <ServerPasswordResultsTable
      rows={[
        {
          server_id: 'hidden-id',
          name: 'VM',
          status: 'failed',
          error_detail: error,
        },
      ]}
    />
  )
  await expect
    .element(screen.getByText(JSON.stringify(error, null, 2), { exact: true }))
    .toBeVisible()
})
