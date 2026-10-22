export interface Page<T> {
  items: T[]
  total: number
}

export interface CloudCurrentUser {
  id: string
  display_name: string
  username: string
  first_name: string
  last_name: string
  email: string
  bypass_billing: boolean
  max_projects: number
  remaining_projects: number
  time_zone: string
  locale: string
}

export interface ServerRow {
  id: string
  name: string
  server_type: string
  specs?: { server_type?: string; ram?: number; vcpus?: number }
  power_state?: string
  zone_display_name?: string
  bandwidth?: number
  elastic_ip?: Array<{ id: string; ip_address: string }>
  private_ip?: Array<{
    id: string
    ip_address: string
    subnet?: string | { id?: string }
    vips?: Array<{ ip_address?: string }> | string[] | string
  }>
}

export interface Subnet {
  id: string
  name: string
  display_name: string
  cidr: string
  region: string
  project?: string
}

export interface PrivateIp {
  id: string
  ip_address: string
  region?: string
  description?: string
  subnet?: string | { id?: string; name?: string; cidr?: string }
  project?: string
  created_at?: string
  updated_at?: string
  server?: { id: string; name: string } | null
  [key: string]: unknown
}

export interface Profile {
  id: string
  name: string
  username: string
  is_active: boolean
  created_at?: string
}

export interface LogRow {
  id: string
  created_at: string
  action?: string
  method?: string
  endpoint?: string
  actor_email?: string
  status?: string
  result?: string
  project_id?: string
  correlation_id: string
  role?: string
  target_type?: string
  target_id?: string
  metadata_json?: Record<string, unknown>
  completed_at?: string
  http_status?: number
  latency_ms?: number
  error_code?: string
  request_meta?: Record<string, unknown>
  response_meta?: Record<string, unknown>
  [key: string]: unknown
}
