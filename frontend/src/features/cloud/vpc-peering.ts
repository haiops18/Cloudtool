export type PeeringReference =
  | string
  | {
      id: string
      name?: string
      display_name?: string
      slug?: string
    }

export interface VpcPeering {
  id: string
  name?: string
  display_name?: string
  description?: string
  requester_project: PeeringReference
  accepter_project: PeeringReference
  requester_vpc: PeeringReference
  accepter_vpc: PeeringReference
  status: string
  created_at?: string
  updated_at?: string
}

export function referenceId(value: PeeringReference) {
  return typeof value === 'string' ? value : value.id
}

export function referenceName(value: PeeringReference) {
  return typeof value === 'string'
    ? value
    : value.display_name || value.name || value.id
}

export function orientPeering(row: VpcPeering, currentProjectId: string) {
  const requester = referenceId(row.requester_project) === currentProjectId
  const accepter = referenceId(row.accepter_project) === currentProjectId
  if (!requester && !accepter) return null
  return {
    sourceProject: requester ? row.requester_project : row.accepter_project,
    sourceVpc: requester ? row.requester_vpc : row.accepter_vpc,
    peerProject: requester ? row.accepter_project : row.requester_project,
    peerVpc: requester ? row.accepter_vpc : row.requester_vpc,
    direction:
      requester && accepter
        ? 'Within project'
        : requester
          ? 'Outgoing request'
          : 'Incoming request',
  }
}
