import { expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { ServerNetworkDetails } from './server-network-details'

it('shows each private IP with its own subnet and keeps private and elastic VIPs associated', async () => {
  const screen = await render(
    <ServerNetworkDetails
      networks={{
        private_ips: [
          {
            id: 'private',
            ip_address: '10.0.0.2',
            subnet: {
              id: 'subnet1',
              display_name: 'Production',
              cidr: '10.0.0.0/24',
            },
            vip_ips: ['10.0.0.4'],
          },
          {
            id: 'private2',
            ip_address: '10.1.0.2',
            subnet: {
              id: 'subnet2',
              display_name: 'Management',
              cidr: '10.1.0.0/24',
            },
            vip_ips: [],
          },
        ],
        elastic_ips: [
          { id: 'elastic', ip_address: '171.1.1.1', vip_ips: ['171.1.1.2'] },
        ],
      }}
    />
  )
  await expect
    .element(screen.getByText('Production', { exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByText('Management', { exact: true }))
    .toBeVisible()
  const privateCard = screen
    .getByText('10.0.0.2', { exact: true })
    .element()
    .closest('tr')!
  expect(privateCard.textContent).toContain('10.0.0.0/24')
  expect(privateCard.textContent).toContain('10.0.0.4')
  expect(privateCard.textContent).not.toContain('10.1.0.0/24')
  const elasticCard = screen
    .getByText('171.1.1.1', { exact: true })
    .element()
    .closest('tr')!
  expect(elasticCard.textContent).toContain('171.1.1.2')
  expect(elasticCard.textContent).not.toContain('10.0.0.4')
})
