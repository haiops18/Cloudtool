import { createFileRoute } from '@tanstack/react-router'
import { ServersEntryPage } from '@/features/terraform/servers-entry-page'

export const Route = createFileRoute('/_authenticated/')({
  component: ServersEntryPage,
})
