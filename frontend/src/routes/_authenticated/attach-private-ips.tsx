import { createFileRoute } from '@tanstack/react-router'
import { SecurityGroupsPage } from '@/features/cloud/security-groups-page'

const securityGroupsRoute = createFileRoute(
  '/_authenticated/attach-private-ips'
)({
  component: SecurityGroupsPage,
})

// routeTree.gen.ts is retained by the Windows runtime in this installation.
// Override the generated legacy path at registration time so direct loads and
// browser refreshes resolve the canonical URL as a real router route.
const updateRoute = securityGroupsRoute.update.bind(securityGroupsRoute)
securityGroupsRoute.update = ((options) =>
  updateRoute({
    ...options,
    id: '/security-groups',
    path: '/security-groups',
  } as Parameters<typeof updateRoute>[0])) as typeof securityGroupsRoute.update

export const Route = securityGroupsRoute
