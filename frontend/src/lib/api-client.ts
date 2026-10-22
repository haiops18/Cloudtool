import axios from 'axios'
import { useCloudStore } from '@/stores/cloud-store'

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? '/api/v1'
let csrfToken = ''
export const setCsrfToken = (value?: string | null) => {
  csrfToken = value ?? ''
}

function csrfTokenFromCookie() {
  if (typeof document === 'undefined') return ''
  const prefix = 'cloudtool_csrf='
  const value = document.cookie
    .split('; ')
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length)
  return value ? decodeURIComponent(value) : ''
}

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
})

apiClient.interceptors.request.use((config) => {
  // Let the browser/Axios generate the multipart boundary for uploads. A
  // forced application/json header makes FastAPI see an empty form body.
  if (typeof FormData !== 'undefined' && config.data instanceof FormData)
    delete config.headers['Content-Type']
  const currentCsrf = csrfTokenFromCookie() || csrfToken
  if (currentCsrf && !['get', 'head', 'options'].includes(config.method ?? 'get'))
    config.headers['X-CSRF-Token'] = currentCsrf
  if (config.url?.startsWith('/cloud')) {
    const { project, touch } = useCloudStore.getState()
    if (project && !config.headers.has('X-Project-Id'))
      config.headers['X-Project-Id'] = project.id
    touch()
  }
  return config
})

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const approval =
      error.response?.status === 428 ? error.response?.data?.error : null
    if (
      approval?.approval_id &&
      window.confirm(
        `DEBUG APPROVAL\n${JSON.stringify(approval.preview, null, 2)}\n\nAllow this Cloud API request?`
      )
    ) {
      error.config.headers['X-Cloud-Approval'] = approval.approval_id
      return apiClient.request(error.config)
    }
    return Promise.reject(error)
  }
)
