import { expect, it } from 'vitest'
import { orientPeering, type VpcPeering } from './vpc-peering'

const row: VpcPeering = {
  id: 'connection',
  status: 'pending',
  requester_project: { id: 'project-a', name: 'A' },
  accepter_project: { id: 'project-b', name: 'B' },
  requester_vpc: { id: 'vpc-a', name: 'VPC A' },
  accepter_vpc: { id: 'vpc-b', name: 'VPC B' },
}

it('keeps the current project on the source side for either role', () => {
  const outgoing = orientPeering(row, 'project-a')!
  expect(outgoing.sourceVpc).toEqual(row.requester_vpc)
  expect(outgoing.peerProject).toEqual(row.accepter_project)
  expect(outgoing.direction).toBe('Outgoing request')
  const incoming = orientPeering(row, 'project-b')!
  expect(incoming.sourceVpc).toEqual(row.accepter_vpc)
  expect(incoming.peerProject).toEqual(row.requester_project)
  expect(incoming.peerVpc).toEqual(row.requester_vpc)
  expect(incoming.direction).toBe('Incoming request')
})

it('handles same-project connections and string references without inventing a source', () => {
  const sameProject = {
    ...row,
    requester_project: 'project-a',
    accepter_project: 'project-a',
  }
  expect(orientPeering(sameProject, 'project-a')?.direction).toBe(
    'Within project'
  )
  expect(orientPeering(row, 'unrelated')).toBeNull()
})
