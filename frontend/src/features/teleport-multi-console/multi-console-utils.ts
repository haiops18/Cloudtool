const SPECIAL_KEYSYMS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Insert: 0xff63,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffe7,
  CapsLock: 0xffe5,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
}

export function keyboardKeysym(key: string): number | undefined {
  if (SPECIAL_KEYSYMS[key]) return SPECIAL_KEYSYMS[key]
  const points = Array.from(key)
  if (points.length !== 1) return undefined
  const point = points[0].codePointAt(0)
  if (point === undefined) return undefined
  return point <= 0xff ? point : 0x01000000 | point
}

export function consoleWebSocketUrl(consoleUrl: string): string {
  const parsed = new URL(consoleUrl)
  const path = parsed.searchParams.get('path')
  if (!path) throw new Error('The console URL does not contain a noVNC path.')
  const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${protocol}//${parsed.host}${normalized}`
}

export type SendKey = (keysym: number, code?: string, down?: boolean) => void

export function dispatchNoVncKey(
  broadcast: boolean,
  sourceId: string,
  targets: Map<string, SendKey>,
  keysym: number,
  code: string,
  down: boolean
) {
  if (broadcast) {
    for (const sendKey of targets.values()) sendKey(keysym, code, down)
    return
  }
  targets.get(sourceId)?.(keysym, code, down)
}

type TemplateServer = {
  id: string
  name: string
  server_type?: string
  zone_display_name?: string
  bandwidth?: number
  elastic_ip?: Array<{ ip_address: string }>
  private_ip?: Array<{ ip_address: string; subnet?: string | { id?: string } }>
  gw_private_ip?: Array<{ ip_address: string }>
}

const BASE_SERVER_COMMAND_VARIABLES = [
  ['server.name', 'Server name'],
  ['server.id', 'Server ID'],
  ['server.server_type', 'Server type'],
  ['server.zone', 'Zone'],
  ['server.bandwidth', 'Bandwidth'],
  ['server.elastic_ip', 'All elastic IPs'],
  ['server.private_ip', 'All private IPs'],
  ['server.gw_private_ip', 'All private IP gateways'],
] as const

export function serverCommandVariables(servers: TemplateServer[] = []) {
  const maxElasticIps = Math.max(
    1,
    ...servers.map((server) => server.elastic_ip?.length ?? 0)
  )
  const maxPrivateIps = Math.max(
    1,
    ...servers.map((server) => server.private_ip?.length ?? 0)
  )
  const indexed = (
    field: 'elastic_ip' | 'private_ip' | 'gw_private_ip',
    label: string,
    count: number
  ): Array<readonly [string, string]> =>
    Array.from({ length: count }, (_, index) => index + 1).flatMap((index) => [
      [`server.${field}_${index}`, `${label} ${index}`] as const,
      [`server.${field}[${index}]`, `${label} ${index} (list syntax)`] as const,
    ])
  return [
    ...BASE_SERVER_COMMAND_VARIABLES,
    ...indexed('elastic_ip', 'Elastic IP', maxElasticIps),
    ...indexed('private_ip', 'Private IP', maxPrivateIps),
    ...indexed('gw_private_ip', 'Private IP gateway', maxPrivateIps),
  ]
}

export const SERVER_COMMAND_VARIABLES = serverCommandVariables()

export function renderSharedVariableValue(
  value: string,
  server: TemplateServer,
  serverIndex = 0
): string {
  const sequenced = value.replace(/\[in(?::([^\]]+))?\]/gi, (_, raw = '') => {
    let start = 1
    let step = 1
    let pad = 2
    const config = String(raw).trim()
    if (/^-?\d+$/.test(config)) start = Number(config)
    else {
      for (const entry of config.split(',')) {
        const [key, rawValue] = entry.split('=').map((item) => item.trim())
        const parsed = Number(rawValue)
        if (!Number.isInteger(parsed)) continue
        if (key === 'start') start = parsed
        if (key === 'step') step = parsed
        if (key === 'pad') pad = Math.max(1, Math.min(12, parsed))
      }
    }
    const current = start + serverIndex * step
    const sign = current < 0 ? '-' : ''
    return `${sign}${String(Math.abs(current)).padStart(pad, '0')}`
  })
  return renderServerCommand(sequenced, server, {}, {}, serverIndex)
}

export type RenderedCommandPart = {
  text: string
  variable?: string
  sourceFrom: number
  sourceTo: number
}

export function renderServerCommandParts(
  template: string,
  server: TemplateServer,
  customVariables: Record<string, string> = {},
  sharedVariables: Record<string, string> = {},
  serverIndex = 0
): RenderedCommandPart[] {
  const values: Record<string, string> = {
    'server.name': server.name,
    'server.id': server.id,
    'server.server_type': server.server_type ?? '',
    'server.zone': server.zone_display_name ?? '',
    'server.bandwidth': server.bandwidth?.toString() ?? '',
    'server.elastic_ip':
      server.elastic_ip?.map((item) => item.ip_address).join(',') ?? '',
    'server.private_ip':
      server.private_ip?.map((item) => item.ip_address).join(',') ?? '',
    'server.gw_private_ip':
      server.gw_private_ip?.map((item) => item.ip_address).join(',') ?? '',
  }
  const parts: RenderedCommandPart[] = []
  let cursor = 0
  for (const match of template.matchAll(
    /\{\{\s*([\w.]+(?:\[\d+\])?)\s*\}\}/g
  )) {
    const index = match.index ?? 0
    if (index > cursor)
      parts.push({
        text: template.slice(cursor, index),
        sourceFrom: cursor,
        sourceTo: index,
      })
    const key = match[1]
    let replacement: string | undefined
    if (Object.prototype.hasOwnProperty.call(values, key))
      replacement = values[key]
    const indexedIp = key.match(
      /^server\.(elastic_ip|private_ip|gw_private_ip)(?:_(\d+)|\[(\d+)\])$/
    )
    if (indexedIp) {
      const position = Number(indexedIp[2] ?? indexedIp[3])
      const addresses = server[indexedIp[1] as 'elastic_ip' | 'private_ip' | 'gw_private_ip']
      replacement =
        position > 0 ? (addresses?.[position - 1]?.ip_address ?? '') : ''
    }
    if (key.startsWith('custom.')) {
      const customKey = key.slice('custom.'.length)
      if (Object.prototype.hasOwnProperty.call(customVariables, customKey)) {
        replacement = customVariables[customKey]
      }
    }
    if (key.startsWith('shared.')) {
      const sharedKey = key.slice('shared.'.length)
      if (Object.prototype.hasOwnProperty.call(sharedVariables, sharedKey)) {
        replacement = renderSharedVariableValue(
          sharedVariables[sharedKey],
          server,
          serverIndex
        )
      }
    }
    parts.push(
      replacement === undefined
        ? {
            text: match[0],
            sourceFrom: index,
            sourceTo: index + match[0].length,
          }
        : {
            text: replacement,
            variable: key,
            sourceFrom: index,
            sourceTo: index + match[0].length,
          }
    )
    cursor = index + match[0].length
  }
  if (cursor < template.length)
    parts.push({
      text: template.slice(cursor),
      sourceFrom: cursor,
      sourceTo: template.length,
    })
  return parts
}

export function subnetGatewayIp(cidr: string): string {
  const [address, rawPrefix] = cidr.split('/')
  const octets = address?.split('.').map(Number)
  const prefix = Number(rawPrefix)
  if (!octets || octets.length !== 4 || octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255) || !Number.isInteger(prefix) || prefix < 0 || prefix > 30)
    return ''
  const value = octets.reduce((result, octet) => (result << 8) + octet, 0) >>> 0
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const gateway = ((value & mask) + 1) >>> 0
  return [24, 16, 8, 0].map((shift) => (gateway >>> shift) & 255).join('.')
}

export function renderServerCommand(
  template: string,
  server: TemplateServer,
  customVariables: Record<string, string> = {},
  sharedVariables: Record<string, string> = {},
  serverIndex = 0
): string {
  return renderServerCommandParts(
    template,
    server,
    customVariables,
    sharedVariables,
    serverIndex
  )
    .map((part) => part.text)
    .join('')
}
