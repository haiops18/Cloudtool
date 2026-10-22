import { expect, it } from 'vitest'
import { elasticIpVariableError } from './elastic-ip-variables'
import { applyManualIps, needsManualIps } from './manual-ip-allocations'
import {
  emptyTerraformServer,
  terraformServerFromTemplate,
  terraformServerTemplateRow,
  terraformTemplateHeaders,
  type TerraformTemplateLookups,
} from './server-draft'

it('applies successful IP types independently and leaves failed types manual', () => {
  const server = {
    ...emptyTerraformServer(),
    subnet_id: 'subnet',
    region_id: 'region',
    private_ip_mode: 'manual' as const,
    elastic_ip_mode: 'manual' as const,
  }
  const result = {
    server_draft_id: server.id,
    server_name: 'VM',
    private: {
      status: 'completed' as const,
      ip_id: 'pip',
      ip_address: '10.0.0.20',
    },
    elastic: { status: 'failed' as const, error: 'Quota' },
  }
  const next = applyManualIps(server, result, server)
  expect(next.private_ip_mode).toBe('existing')
  expect(next.eni_address).toBe('10.0.0.20')
  expect(next.elastic_ip_mode).toBe('manual')
  expect(needsManualIps(next)).toBe(true)
  expect(
    applyManualIps({ ...server, subnet_id: 'different' }, result, server)
      .private_ip_mode
  ).toBe('manual')
  expect(
    elasticIpVariableError(server, '{{elastic_ip_address}}')
  ).toBeUndefined()
})

it('round-trips both Manual create modes through Excel and imports older files without the new mode column', () => {
  const server = {
    ...emptyTerraformServer(),
    name: 'app',
    zone_id: 'zone',
    zone_name: 'zone',
    region_id: 'region',
    flavor_name: 'flavor',
    image_name: 'ubuntu',
    key_pair_name: 'key',
    subnet_display_name: 'subnet',
    security_group_names: ['sg'],
    private_ip_mode: 'manual' as const,
    elastic_ip_mode: 'manual' as const,
    volumes: [
      {
        id: 'root',
        mount_as: 'root' as const,
        volume_type: 'ssd',
        volume_type_name: 'ssd',
        size: 50,
        mount_point: '/',
      },
    ],
  }
  const values = terraformServerTemplateRow(server)
  const row = Object.fromEntries(
    terraformTemplateHeaders.map((header, index) => [
      header,
      String(values[index] ?? ''),
    ])
  )
  expect(row['ELASTIC IP MODE']).toBe('Manual create')
  expect(row['PRIVATE IP MODE']).toBe('Manual create')
  const lookups: TerraformTemplateLookups = {
    zones: [{ id: 'zone', text: 'zone', region_id: 'region' }],
    flavors: [
      { id: 'flavor', text: 'flavor', zone_id: 'zone', family: 'basic' },
    ],
    images: [{ id: 'ubuntu', text: 'ubuntu' }],
    keypairs: [{ id: 'key', text: 'key' }],
    subnets: [{ id: 'subnet', text: 'subnet' }],
    groups: [{ id: 'sg', text: 'sg', region_id: 'region' }],
    volumeTypes: [{ id: 'ssd', text: 'ssd', zone_id: 'zone' }],
    privateIps: [],
    elasticIps: [],
    placementGroups: [],
    cloudInitTemplates: [],
  }
  const imported = terraformServerFromTemplate(row, lookups, 1)
  expect(imported.elastic_ip_mode).toBe('manual')
  expect(imported.private_ip_mode).toBe('manual')
  delete row['ELASTIC IP MODE']
  row['PRIVATE IP MODE'] = 'Auto Allocate'
  const legacy = terraformServerFromTemplate(row, lookups, 1)
  expect(legacy.elastic_ip_mode).toBe('auto')
  expect(legacy.private_ip_mode).toBe('auto')
})
