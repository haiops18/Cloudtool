import { createFileRoute } from '@tanstack/react-router'
import { PrivateIpsPage } from '@/features/cloud/pages'

export const Route = createFileRoute('/_authenticated/private-ips')({
  component: PrivateIpsPage,
})
