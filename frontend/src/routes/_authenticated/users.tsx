import { createFileRoute } from '@tanstack/react-router'
import { LocalUsersPage } from '@/features/users'

export const Route = createFileRoute('/_authenticated/users')({
  component: LocalUsersPage,
})
