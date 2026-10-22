import { create } from 'zustand'

export interface AuthUser {
  id: string
  email: string
  username?: string
  full_name: string
  is_active: boolean
  role:
    | string
    | {
        name: string
        permissions: Array<{ code: string; description: string }>
      }
  csrf_token?: string | null
  permissions?: string[]
  cloud_api_access?: 'read' | 'full'
}

interface AuthState {
  auth: {
    user: AuthUser | null
    accessToken: string
    setUser: (user: AuthUser | null) => void
    setSession: (
      accessToken: string,
      refreshToken: string,
      remember: boolean
    ) => void
    setAccessToken: (value: string) => void
    resetAccessToken: () => void
    reset: () => void
  }
}

export const useAuthStore = create<AuthState>()((set) => ({
  auth: {
    user: null,
    accessToken: '',
    setUser: (user) => set((state) => ({ auth: { ...state.auth, user } })),
    setSession: (accessToken) =>
      set((state) => ({ auth: { ...state.auth, accessToken } })),
    setAccessToken: (accessToken) =>
      set((state) => ({ auth: { ...state.auth, accessToken } })),
    resetAccessToken: () =>
      set((state) => ({ auth: { ...state.auth, accessToken: '' } })),
    reset: () =>
      set((state) => ({
        auth: { ...state.auth, user: null, accessToken: '' },
      })),
  },
}))
