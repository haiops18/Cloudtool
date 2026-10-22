import { create } from 'zustand'

export interface CloudProject {
  id: string
  name: string
  display_name?: string
  status?: string
}
interface CloudState {
  token: string
  project: CloudProject | null
  lastActivity: number
  setToken: (value: string) => void
  setProject: (value: CloudProject | null) => void
  touch: () => void
  clear: () => void
}

export const useCloudStore = create<CloudState>()((set) => ({
  token: '',
  project: null,
  lastActivity: Date.now(),
  setToken: (token) => set({ token, lastActivity: Date.now() }),
  setProject: (project) => set({ project, lastActivity: Date.now() }),
  touch: () => set({ lastActivity: Date.now() }),
  clear: () => set({ token: '', project: null, lastActivity: Date.now() }),
}))
