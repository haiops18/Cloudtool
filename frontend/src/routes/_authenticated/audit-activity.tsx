import { createFileRoute } from '@tanstack/react-router'
import { AuditLogPage } from '@/features/cloud/pages'

export const Route = createFileRoute('/_authenticated/audit-activity')({
  component: () => <AuditLogPage kind='activity' />,
})
