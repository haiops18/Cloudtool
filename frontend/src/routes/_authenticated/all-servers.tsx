import { createFileRoute } from '@tanstack/react-router'
import { AllServersPage } from '@/features/cloud/all-servers-page'

export const Route = createFileRoute('/_authenticated/all-servers')({
  component: AllServersPage,
})
