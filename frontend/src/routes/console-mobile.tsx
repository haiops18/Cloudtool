import { createFileRoute, redirect } from '@tanstack/react-router'
import { type AuthUser, useAuthStore } from '@/stores/auth-store'
import { apiClient, setCsrfToken } from '@/lib/api-client'
import { MobileConsolePage } from '@/features/cloud/mobile-console-page'

export const Route = createFileRoute('/console-mobile')({
  validateSearch: (search: Record<string, unknown>) => ({
    server_id: typeof search.server_id === 'string' ? search.server_id : '',
    project_id: typeof search.project_id === 'string' ? search.project_id : '',
  }),
  beforeLoad: async ({ location }) => {
    const auth = useAuthStore.getState().auth
    if (auth.user) return
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
  },
  component: MobileConsolePage,
})
