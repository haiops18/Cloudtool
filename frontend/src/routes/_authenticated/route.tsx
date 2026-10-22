import { createFileRoute, redirect } from '@tanstack/react-router'
import { type AuthUser, useAuthStore } from '@/stores/auth-store'
import { apiClient, setCsrfToken } from '@/lib/api-client'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ location }) => {
    const auth = useAuthStore.getState().auth
    if (!auth.user) {
      try {
        const user = (await apiClient.get<AuthUser>('/auth/me')).data
        setCsrfToken(user.csrf_token)
        auth.setUser(user)
      } catch {
        auth.reset()
        throw redirect({
          to: '/sign-in',
          search: { redirect: location.href },
        })
      }
    }
  },
  component: AuthenticatedLayout,
})
