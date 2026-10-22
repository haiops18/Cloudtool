import { useRouterState } from '@tanstack/react-router'
import { ServersPage } from '@/features/cloud/pages'
import { TerraformServersPage } from './terraform-servers-page'

export function ServersEntryPage() {
  const hash = useRouterState({ select: (state) => state.location.hash })
  return hash === 'terraform' ? <TerraformServersPage /> : <ServersPage />
}
