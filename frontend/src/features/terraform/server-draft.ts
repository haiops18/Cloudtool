import { elasticIpVariableError } from './elastic-ip-variables'
import type { TerraformServerDraft, TerraformServerFieldErrors } from './types'

export const terraformTemplateHeaders = [
  'SERVER NAME',
  'SERVER TYPE',
  'ZONE',
  'SPECS MODE',
  'FLAVOR',
  'RAM GB',
  'VCPUS',
  'PUBLIC IMAGE',
  'KEY PAIR',
  'BANDWIDTH',
  'ELASTIC IP ENABLED',
  'ELASTIC IP MODE',
  'ELASTIC IP',
  'ENABLE IPV4',
  'PRIVATE IP MODE',
  'SUBNET',
  'PRIVATE IP',
  'SECURITY GROUPS',
  'PLACEMENT GROUP',
  'ROOT VOLUME',
  'OTHER VOLUMES',
  'CLOUD INIT ENABLED',
  'CLOUD INIT TEMPLATE',
  'TELEPORT_ENABLE',
  'TP_REGION',
  'TP_SYSTEM',
  'TP_HOSTNAME',
  'TP_SUBNET',
  'TP_MONITOR_IP',
] as const

export type TemplateLookupItem = {
  id: string
  text: string
  name?: string
  region_id?: string
  zone_id?: string
  family?: string
  subnet_id?: string
  cidr?: string
  vpc_cidr?: string
  extra?: string
}
export type TerraformTemplateLookups = {
  zones: TemplateLookupItem[]
  flavors: TemplateLookupItem[]
  images: TemplateLookupItem[]
  keypairs: TemplateLookupItem[]
  elasticIps: TemplateLookupItem[]
  subnets: TemplateLookupItem[]
  privateIps: TemplateLookupItem[]
  groups: TemplateLookupItem[]
  placementGroups: TemplateLookupItem[]
  volumeTypes: TemplateLookupItem[]
  cloudInitTemplates: TemplateLookupItem[]
}

export function emptyTerraformServer(): TerraformServerDraft {
  return {
    id: crypto.randomUUID(),
    name: '',
    zone_id: '',
    zone_name: '',
    region_id: '',
    instance_family: 'basic',
    specs_kind: 'predefined',
    flavor_name: '',
    ram: 4,
    vcpus: 2,
    boot_source: 'public_image',
    image_id: '',
    image_name: '',
    image_display_name: '',
    key_pair_id: '',
    key_pair_name: '',
    bandwidth: 300,
    enable_ipv4: true,
    elastic_ip_mode: 'none',
    elastic_ip_id: '',
    elastic_ip_address: '',
    private_network_mode: 'subnet',
    private_ip_mode: 'auto',
    subnet_id: '',
    subnet_display_name: '',
    subnet_cidr: '',
    vpc_cidr: '',
    eni_id: '',
    eni_address: '',
    security_group_ids: [],
    security_group_names: [],
    placement_group_id: '',
    placement_group_name: '',
    volumes: [
      {
        id: crypto.randomUUID(),
        volume_type: '',
        volume_type_name: '',
        size: 50,
        mount_as: 'root',
      },
    ],
    cloud_init_enabled: false,
    cloud_init_content: '',
    cloud_init_template_id: '',
    cloud_init_template_name: '',
    cloud_init_variables: {},
    teleport_enabled: false,
    teleport_region: 'public',
    teleport_system: '',
    teleport_hostname: '',
    teleport_monitor_subnet_id: '',
    teleport_monitor_subnet_name: '',
    teleport_monitor_ip: '',
  }
}

export function validateTerraformServer(
  server: TerraformServerDraft,
  all: TerraformServerDraft[] = []
) {
  const errors: TerraformServerFieldErrors = {}
  if (!server.name.trim()) errors.name = 'Server name is required.'
  if (!server.zone_id) errors.zone_id = 'Zone is required.'
  if (server.specs_kind === 'predefined' && !server.flavor_name)
    errors.flavor_name = 'Flavor is required.'
  if (
    server.specs_kind === 'custom' &&
    (!Number.isInteger(server.ram) || server.ram < 1)
  )
    errors.ram = 'RAM is required.'
  if (
    server.specs_kind === 'custom' &&
    (!Number.isInteger(server.vcpus) || server.vcpus < 1)
  )
    errors.vcpus = 'vCPUs are required.'
  if (!server.image_name) errors.image_name = 'Public image is required.'
  if (
    !Number.isInteger(server.bandwidth) ||
    server.bandwidth < 1 ||
    server.bandwidth > 10000
  )
    errors.bandwidth = 'Bandwidth must be a whole number from 1 to 10000 Mbps.'
  if (!server.subnet_id) errors.subnet_id = 'Subnet is required.'
  if (server.private_ip_mode === 'existing' && !server.eni_id)
    errors.eni_id = 'Private IP is required.'
  if (server.elastic_ip_mode === 'existing' && !server.elastic_ip_id)
    errors.elastic_ip_id = 'Elastic IP is required.'
  if (server.elastic_ip_mode !== 'none' && !server.enable_ipv4)
    errors.enable_ipv4 = 'IPv4 is required when Elastic IP is enabled.'
  if (!server.security_group_ids.length)
    errors.security_group_ids = 'Select at least one security group.'
  const configuredVolumes =
    server.instance_family === 'gpu'
      ? server.volumes.filter((item) => item.volume_type)
      : server.volumes
  if (
    (server.instance_family !== 'gpu' &&
      configuredVolumes.filter((item) => item.mount_as === 'root').length !==
        1) ||
    configuredVolumes.some(
      (item) =>
        item.size < 1 || (item.mount_as === 'data' && !item.mount_point?.trim())
    )
  )
    errors.volumes =
      server.instance_family === 'gpu'
        ? 'Configured data volumes must have a valid size and mount path.'
        : 'A valid root volume and valid data volumes are required.'
  if (server.cloud_init_enabled && !server.cloud_init_content.trim())
    errors.cloud_init_content = 'Select a template or enter cloud-init content.'
  if (server.cloud_init_enabled) {
    const variableError = elasticIpVariableError(
      server,
      server.cloud_init_content
    )
    if (variableError) errors.cloud_init_content = variableError
  }
  if (server.teleport_enabled && !server.cloud_init_enabled)
    errors.teleport_enabled = 'Cloud-init must be enabled before Teleport.'
  if (server.teleport_enabled && !server.teleport_monitor_subnet_id)
    errors.teleport_monitor_subnet_id = 'Select the Teleport monitor subnet.'
  if (server.teleport_enabled && !server.teleport_monitor_ip)
    errors.teleport_monitor_ip = 'Select an available Teleport monitor IP.'
  if (
    all.some(
      (item) =>
        item.id !== server.id &&
        item.name.trim().toLowerCase() === server.name.trim().toLowerCase()
    )
  )
    errors.name = 'Server name must be unique.'
  return errors
}

function normalize(value = '') {
  return value.trim().toLocaleLowerCase()
}

// Spreadsheet values are labels copied from the cloud API.  Depending on the
// API endpoint (and on Excel's formatting), the same resource can be rendered
// as e.g. `name - cidr`, `name (cidr)` or just its id.  Keep exact matching as
// the first choice, then use a conservative label comparison so importing a
// template does not silently turn a valid row into an empty draft.
function comparable(value = '') {
  return normalize(value)
    .replace(/[()\[\]{}]/g, ' ')
    .replace(/[|/\\,:;]+/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactComparable(value = '') {
  return comparable(value).replace(/[^a-z0-9]/g, '')
}
function bool(value: string, fallback = false) {
  if (!value.trim()) return fallback
  return ['true', 'yes', '1', 'y', 'enabled'].includes(normalize(value))
}
function findOne(
  items: TemplateLookupItem[],
  value: string,
  field: string,
  row: number,
  filter?: (item: TemplateLookupItem) => boolean
) {
  if (!value.trim()) throw new Error(`Row ${row}, ${field}: value is required.`)
  const matches = items.filter(
    (item) =>
      (!filter || filter(item)) &&
      [item.text, item.name, item.id].some(
        (candidate) => normalize(candidate) === normalize(value)
      )
  )
  // Labels in exported workbooks may contain a display-only suffix/prefix
  // (for example a subnet CIDR). Match token-normalized labels as a fallback,
  // while retaining the ambiguity check below.
  const fuzzyMatches = matches.length
    ? matches
    : items.filter(
        (item) =>
          (!filter || filter(item)) &&
          [item.text, item.name, item.id].some((candidate) => {
            const left = comparable(candidate)
            const right = comparable(value)
            const compactLeft = compactComparable(candidate)
            const compactRight = compactComparable(value)
            return (
              !!left &&
              !!right &&
              (left === right ||
                left.includes(right) ||
                right.includes(left) ||
                (!!compactLeft &&
                  !!compactRight &&
                  (compactLeft === compactRight ||
                    compactLeft.includes(compactRight) ||
                    compactRight.includes(compactLeft))))
            )
          })
      )
  if (!fuzzyMatches.length)
    throw new Error(
      `Row ${row}, ${field}: "${value}" is not available in this project.`
    )
  if (fuzzyMatches.length > 1)
    throw new Error(
      `Row ${row}, ${field}: "${value}" is ambiguous. Use the exact unique name from the template list.`
    )
  return fuzzyMatches[0]
}

export function terraformServerFromTemplate(
  row: Record<string, string>,
  lookups: TerraformTemplateLookups,
  rowNumber: number
): TerraformServerDraft {
  const base = emptyTerraformServer()
  const family = normalize(row['SERVER TYPE']) === 'gpu' ? 'gpu' : 'basic'
  if (!['basic', 'gpu'].includes(normalize(row['SERVER TYPE'])))
    throw new Error(`Row ${rowNumber}, SERVER TYPE: choose basic or gpu.`)
  const zone = findOne(lookups.zones, row.ZONE, 'ZONE', rowNumber)
  const specsKind =
    normalize(row['SPECS MODE']) === 'custom' ? 'custom' : 'predefined'
  if (!['predefined', 'custom'].includes(normalize(row['SPECS MODE'])))
    throw new Error(
      `Row ${rowNumber}, SPECS MODE: choose predefined or custom.`
    )
  const flavor =
    specsKind === 'predefined'
      ? findOne(
          lookups.flavors,
          row.FLAVOR,
          'FLAVOR',
          rowNumber,
          (x) => x.zone_id === zone.id && x.family === family
        )
      : undefined
  const image = findOne(
    lookups.images,
    row['PUBLIC IMAGE'],
    'PUBLIC IMAGE',
    rowNumber
  )
  const keypair = findOne(
    lookups.keypairs,
    row['KEY PAIR'],
    'KEY PAIR',
    rowNumber
  )
  const subnet = findOne(lookups.subnets, row.SUBNET, 'SUBNET', rowNumber)
  const privateMode = normalize(row['PRIVATE IP MODE']).startsWith('manual')
    ? 'manual'
    : normalize(row['PRIVATE IP MODE']).startsWith('create ordered')
      ? 'ordered'
      : normalize(row['PRIVATE IP MODE']).startsWith('select') ||
          normalize(row['PRIVATE IP MODE']) === 'existing'
        ? 'existing'
        : 'auto'
  const privateIp =
    privateMode === 'existing'
      ? findOne(
          lookups.privateIps,
          row['PRIVATE IP'],
          'PRIVATE IP',
          rowNumber,
          (x) => x.subnet_id === subnet.id
        )
      : undefined
  const elasticEnabled = bool(row['ELASTIC IP ENABLED'])
  const requestedElasticMode = normalize(row['ELASTIC IP MODE'] || '')
  const elasticMode = !elasticEnabled
    ? 'none'
    : requestedElasticMode.startsWith('manual')
      ? 'manual'
      : requestedElasticMode.startsWith('auto')
        ? 'auto'
        : requestedElasticMode.startsWith('select') ||
            requestedElasticMode === 'existing'
          ? 'existing'
          : row['ELASTIC IP'].trim()
            ? 'existing'
            : 'auto'
  const elasticIp =
    elasticMode === 'existing'
      ? findOne(lookups.elasticIps, row['ELASTIC IP'], 'ELASTIC IP', rowNumber)
      : undefined
  const groupNames = row['SECURITY GROUPS']
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  if (!groupNames.length)
    throw new Error(
      `Row ${rowNumber}, SECURITY GROUPS: select at least one value.`
    )
  const groups = groupNames.map((name) =>
    findOne(
      lookups.groups,
      name,
      'SECURITY GROUPS',
      rowNumber,
      (x) => !zone.region_id || x.region_id === zone.region_id
    )
  )
  const placement = row['PLACEMENT GROUP'].trim()
    ? findOne(
        lookups.placementGroups,
        row['PLACEMENT GROUP'],
        'PLACEMENT GROUP',
        rowNumber,
        (x) => !zone.region_id || x.region_id === zone.region_id
      )
    : undefined
  const parseVolume = (line: string, mount: 'root' | 'data', index: number) => {
    const parts = line.split(',').map((part) => part.trim())
    const label = mount === 'root' ? 'ROOT VOLUME' : 'OTHER VOLUMES'
    if (parts.length < 4)
      throw new Error(
        `Row ${rowNumber}, ${label} line ${index}: use mount_as,type,size,mount_point (example: ${mount},HDD,50,/u01).`
      )
    if (normalize(parts[0]) !== mount)
      throw new Error(
        `Row ${rowNumber}, ${label} line ${index}: mount_as must be ${mount}.`
      )
    const type = findOne(
      lookups.volumeTypes,
      parts[1],
      `${label} line ${index}`,
      rowNumber,
      (x) => x.zone_id === zone.id
    )
    const size = Number(parts[2])
    const mountPoint = parts[3]
    if (!mountPoint.startsWith('/'))
      throw new Error(
        `Row ${rowNumber}, ${label} line ${index}: mount_point must start with /.`
      )
    if (!Number.isInteger(size) || size < 1)
      throw new Error(
        `Row ${rowNumber}, ${label} line ${index}: size must be a positive whole number.`
      )
    return {
      id: crypto.randomUUID(),
      volume_type: type.id,
      volume_type_name: type.text,
      size,
      mount_as: mount,
      mount_point: mountPoint,
    }
  }
  const rootLine = row['ROOT VOLUME']?.trim()
  if (!rootLine)
    throw new Error(`Row ${rowNumber}, ROOT VOLUME: root volume is required.`)
  const volumes: TerraformServerDraft['volumes'] = [
    parseVolume(rootLine, 'root', 1),
  ]
  // OTHER VOLUMES is optional: an empty cell means that only the root disk
  // should be created. Spreadsheet readers may return null, undefined, or a
  // non-string cell value, so normalize before splitting.
  const otherVolumesCell = row['OTHER VOLUMES']
  const otherLines = (otherVolumesCell == null ? '' : String(otherVolumesCell))
    // Excel may encode Alt+Enter as LF, CRLF, or a lone CR depending on the
    // producer/version of the workbook.
    .split(/\r\n|\n|\r|\\r\\n|\\n|\\r|\u2028|\u2029/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        line.includes(',') &&
        !['-', '—', 'none', 'n/a', '0'].includes(normalize(line))
    )
  volumes.push(
    ...otherLines.map((line, index) => parseVolume(line, 'data', index + 1))
  )
  const ram = Number(row['RAM GB'] || 4)
  const vcpus = Number(row.VCPUS || 2)
  const bandwidth = Number(row.BANDWIDTH || row.BAND_WIDTH || 300)
  if (!Number.isInteger(bandwidth) || bandwidth < 1 || bandwidth > 10000)
    throw new Error(
      `Row ${rowNumber}, BANDWIDTH: enter a whole number from 1 to 10000 Mbps.`
    )
  if (
    specsKind === 'custom' &&
    (!Number.isInteger(ram) || ram < 1 || !Number.isInteger(vcpus) || vcpus < 1)
  )
    throw new Error(
      `Row ${rowNumber}, RAM GB/VCPUS: custom specs require positive whole numbers.`
    )
  const cloudInitEnabled = bool(row['CLOUD INIT ENABLED'], false)
  const cloudInitTemplate =
    cloudInitEnabled && row['CLOUD INIT TEMPLATE'].trim()
      ? findOne(
          lookups.cloudInitTemplates,
          row['CLOUD INIT TEMPLATE'],
          'CLOUD INIT TEMPLATE',
          rowNumber
        )
      : undefined
  const cloudInitContent = cloudInitTemplate?.extra || ''
  if (cloudInitEnabled && !cloudInitContent.trim())
    throw new Error(`Row ${rowNumber}, CLOUD INIT: select a managed template.`)
  const cloudInitVariables: Record<string, string> = {}
  const teleportEnabled = bool(row.TELEPORT_ENABLE, false)
  const teleportRegion = normalize(row.TP_REGION || 'public')
  const monitorSubnet = row.TP_SUBNET?.trim()
    ? findOne(lookups.subnets, row.TP_SUBNET, 'TP_SUBNET', rowNumber)
    : undefined
  if (teleportEnabled && !monitorSubnet)
    throw new Error(
      `Row ${rowNumber}, TP_SUBNET: select the subnet for TP_MONITOR_IP.`
    )
  const monitorIp = row.TP_MONITOR_IP?.trim()
    ? findOne(
        lookups.privateIps,
        row.TP_MONITOR_IP,
        'TP_MONITOR_IP',
        rowNumber,
        (x) => x.subnet_id === monitorSubnet?.id
      )
    : undefined
  if (teleportEnabled && !monitorIp)
    throw new Error(
      `Row ${rowNumber}, TP_MONITOR_IP: select an available IP from the selected subnet.`
    )
  if (teleportEnabled && !cloudInitEnabled)
    throw new Error(
      `Row ${rowNumber}, TELEPORT_ENABLE: cloud-init must also be enabled.`
    )
  if (!['public', 'vpublic'].includes(teleportRegion))
    throw new Error(`Row ${rowNumber}, TP_REGION: choose public or vpublic.`)
  return {
    ...base,
    name: row['SERVER NAME'].trim(),
    zone_id: zone.id,
    zone_name: zone.text,
    region_id: zone.region_id || '',
    instance_family: family,
    specs_kind: specsKind,
    flavor_name: flavor?.name || flavor?.text || '',
    ram,
    vcpus,
    image_id: image.id,
    image_name: image.name || image.text,
    image_display_name: image.text,
    key_pair_id: keypair.id,
    key_pair_name: keypair.text,
    bandwidth,
    enable_ipv4: bool(row['ENABLE IPV4'], true),
    elastic_ip_mode: elasticMode,
    elastic_ip_id: elasticIp?.id || '',
    elastic_ip_address: elasticIp?.text || '',
    private_ip_mode: privateMode,
    subnet_id: subnet.id,
    subnet_display_name: subnet.text,
    subnet_cidr: subnet.cidr || '',
    vpc_cidr: subnet.vpc_cidr || subnet.cidr || '',
    eni_id: privateIp?.id || '',
    eni_address: privateIp?.text || '',
    security_group_ids: groups.map((x) => x.id),
    security_group_names: groups.map((x) => x.text),
    placement_group_id: placement?.id || '',
    placement_group_name: placement?.text || '',
    volumes,
    cloud_init_enabled: cloudInitEnabled,
    cloud_init_template_id: cloudInitTemplate?.id || '',
    cloud_init_template_name: cloudInitTemplate?.text || '',
    cloud_init_content: cloudInitContent,
    cloud_init_variables: cloudInitVariables,
    teleport_enabled: teleportEnabled,
    teleport_region: teleportRegion as 'public' | 'vpublic',
    teleport_system: row.TP_SYSTEM || '',
    teleport_hostname: row.TP_HOSTNAME || row['SERVER NAME'].trim(),
    teleport_monitor_subnet_id: monitorSubnet?.id || '',
    teleport_monitor_subnet_name: monitorSubnet?.text || '',
    teleport_monitor_ip: monitorIp?.text || '',
  }
}

export function terraformServerTemplateRow(server: TerraformServerDraft) {
  const root = server.volumes.find((x) => x.mount_as === 'root')
  const data = server.volumes.filter((x) => x.mount_as === 'data')
  return [
    server.name,
    server.instance_family,
    server.zone_name,
    server.specs_kind,
    server.flavor_name,
    server.ram,
    server.vcpus,
    server.image_name,
    server.key_pair_name,
    server.bandwidth,
    server.elastic_ip_mode === 'none' ? 'no' : 'yes',
    server.elastic_ip_mode === 'manual'
      ? 'Manual create'
      : server.elastic_ip_mode === 'existing'
        ? 'Select Existing'
        : 'Auto Allocate',
    server.elastic_ip_address,
    server.enable_ipv4 ? 'yes' : 'no',
    server.private_ip_mode === 'manual'
      ? 'Manual create'
      : server.private_ip_mode === 'existing'
        ? 'Select Existing'
        : server.private_ip_mode === 'ordered'
          ? 'Create ordered'
          : 'Auto Allocate',
    server.subnet_display_name,
    server.eni_address,
    server.security_group_names.join(', '),
    server.placement_group_name,
    root
      ? `${root.mount_as},${root.volume_type_name},${root.size},${root.mount_point || '/'}`
      : '',
    data
      .map(
        (volume) =>
          `${volume.mount_as},${volume.volume_type_name},${volume.size},${volume.mount_point || '/data'}`
      )
      .join('\n'),
    server.cloud_init_enabled ? 'yes' : 'no',
    server.cloud_init_template_name,
    server.teleport_enabled ? 'yes' : 'no',
    server.teleport_region,
    server.teleport_system,
    server.teleport_hostname,
    server.teleport_monitor_subnet_name,
    server.teleport_monitor_ip,
  ]
}
