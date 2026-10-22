import { createFileRoute } from '@tanstack/react-router'
import { VpcPeeringsPage } from '@/features/cloud/vpc-peerings-page'

export const Route = createFileRoute('/_authenticated/vpc-peerings')({
  component: VpcPeeringsPage,
})
