import { createFileRoute } from '@tanstack/react-router'
import { PasswordProfilesPage } from '@/features/cloud/pages'

export const Route = createFileRoute('/_authenticated/password-profiles')({
  component: PasswordProfilesPage,
})
