import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { apiClient } from '@/lib/api-client'
import { SecurityGroupRuleQuota } from './security-group-rule-quota'

const adapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = adapter
})

it('uses project quota and recalculates the shortfall as selection changes without extra requests', async () => {
  let calls = 0
  apiClient.defaults.adapter = async (config) => {
    calls++
    expect(config.url).toBe('/cloud/quotas')
    expect(config.headers['X-Project-Id']).toBe('project')
    return {
      data: {
        items: [
          { name: 'Security Groups', used: 3, limit: 100 },
          { name: 'Security Group Rules', used: '16', limit: '20' },
        ],
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const view = (planned: number) => (
    <QueryClientProvider client={client}>
      <SecurityGroupRuleQuota
        projectId='project'
        planned={planned}
        plannedLabel='Selected'
      />
    </QueryClientProvider>
  )
  const screen = await render(view(5))
  await expect
    .element(
      screen.getByText('Insufficient quota: 1 more rule(s) needed.', {
        exact: true,
      })
    )
    .toBeVisible()
  expect(screen.getByRole('alert').element().className).toContain(
    'text-destructive'
  )
  await screen.rerender(view(3))
  await expect
    .element(screen.getByText('Enough quota', { exact: true }))
    .toBeVisible()
  expect(calls).toBe(1)
})

it.each([
  [
    { name: 'Security Group Rules', used: 20, limit: 20 },
    0,
    'No rule quota remaining.',
  ],
  [{ name: 'security_group_rules', used: 20, limit: -1 }, 1000, 'Enough quota'],
  [
    { name: 'Security Groups', used: 1, limit: 10 },
    1,
    'Quota unavailable; capacity could not be checked.',
  ],
] as const)(
  'handles exhausted, unlimited or missing rule quota correctly (%j)',
  async (quota, planned, message) => {
    apiClient.defaults.adapter = async (config) => ({
      data: { items: [quota] },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })
    const screen = await render(
      <QueryClientProvider client={new QueryClient()}>
        <SecurityGroupRuleQuota projectId='project' planned={planned} />
      </QueryClientProvider>
    )
    await expect
      .element(screen.getByText(message, { exact: true }))
      .toBeVisible()
  }
)
