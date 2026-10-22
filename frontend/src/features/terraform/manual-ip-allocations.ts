import type { TerraformServerDraft } from './types'

export type IpAllocation = {
  status: 'completed' | 'failed'
  ip_id?: string
  ip_address?: string
  error?: string
}
export type ManualIpResult = {
  server_draft_id: string
  server_name: string
  private?: IpAllocation
  elastic?: IpAllocation
}

export function needsManualIps(server: TerraformServerDraft) {
  return (
    server.private_ip_mode === 'manual' || server.elastic_ip_mode === 'manual'
  )
}

export function applyManualIps(
  server: TerraformServerDraft,
  result: ManualIpResult,
  original: TerraformServerDraft
) {
  if (server.id !== result.server_draft_id) return server
  const next = { ...server }
  if (
    server.private_ip_mode === 'manual' &&
    server.subnet_id === original.subnet_id &&
    result.private?.status === 'completed' &&
    result.private.ip_id &&
    result.private.ip_address
  ) {
    next.private_ip_mode = 'existing'
    next.eni_id = result.private.ip_id
    next.eni_address = result.private.ip_address
  }
  if (
    server.elastic_ip_mode === 'manual' &&
    server.region_id === original.region_id &&
    result.elastic?.status === 'completed' &&
    result.elastic.ip_id &&
    result.elastic.ip_address
  ) {
    next.elastic_ip_mode = 'existing'
    next.elastic_ip_id = result.elastic.ip_id
    next.elastic_ip_address = result.elastic.ip_address
  }
  return next
}
