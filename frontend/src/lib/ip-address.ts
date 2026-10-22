export interface ParsedIp {
  version: 4 | 6
  value: bigint
}

export function parseIpAddress(input: string): ParsedIp | null {
  const text = input.trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    const parts = text.split('.').map(Number)
    if (parts.some((part) => part > 255)) return null
    return {
      version: 4,
      value: parts.reduce((value, part) => (value << 8n) + BigInt(part), 0n),
    }
  }

  if (!text.includes(':') || (text.match(/::/g)?.length ?? 0) > 1) return null
  const [leftText, rightText = ''] = text.split('::')
  const left = leftText ? leftText.split(':') : []
  const right = rightText ? rightText.split(':') : []
  const missing = 8 - left.length - right.length
  if ((!text.includes('::') && missing !== 0) || missing < 0) return null
  const parts = [...left, ...Array(missing).fill('0'), ...right]
  if (
    parts.length !== 8 ||
    parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))
  )
    return null
  return {
    version: 6,
    value: parts.reduce(
      (value, part) => (value << 16n) + BigInt(Number.parseInt(part, 16)),
      0n
    ),
  }
}

export function formatIpAddress(ip: ParsedIp) {
  if (ip.version === 4)
    return [24n, 16n, 8n, 0n]
      .map((shift) => Number((ip.value >> shift) & 255n))
      .join('.')
  const parts = Array.from({ length: 8 }, (_, index) =>
    Number((ip.value >> BigInt((7 - index) * 16)) & 65535n).toString(16)
  )
  return parts.join(':')
}

export function buildIpRange(
  startText: string,
  endText: string,
  count?: number
) {
  const start = parseIpAddress(startText)
  if (!start) throw new Error('Starting IP is invalid.')
  const end = endText ? parseIpAddress(endText) : null
  if (endText && (!end || end.version !== start.version))
    throw new Error('Ending IP is invalid or uses a different IP version.')
  const total = end
    ? Number(end.value - start.value + 1n)
    : Math.trunc(count ?? 0)
  if (total < 1 || total > 1000)
    throw new Error('The preview must contain between 1 and 1,000 IPs.')
  if (end && end.value < start.value)
    throw new Error('Ending IP must not be lower than starting IP.')
  const max = start.version === 4 ? (1n << 32n) - 1n : (1n << 128n) - 1n
  if (start.value + BigInt(total - 1) > max)
    throw new Error('The requested range exceeds the IP address space.')
  return Array.from({ length: total }, (_, offset) =>
    formatIpAddress({
      ...start,
      value: start.value + BigInt(offset),
    })
  )
}

export function nextIpAddress(input: string) {
  const parsed = parseIpAddress(input)
  if (!parsed) return null
  const max = parsed.version === 4 ? (1n << 32n) - 1n : (1n << 128n) - 1n
  if (parsed.value >= max) return null
  return formatIpAddress({ ...parsed, value: parsed.value + 1n })
}

export function isUsableIpInCidr(ipText: string, cidr: string) {
  const [networkText, prefixText] = cidr.trim().split('/')
  const ip = parseIpAddress(ipText)
  const networkIp = parseIpAddress(networkText)
  const prefix = Number(prefixText)
  if (
    !ip ||
    !networkIp ||
    ip.version !== networkIp.version ||
    !Number.isInteger(prefix)
  )
    return false
  const bits = ip.version === 4 ? 32 : 128
  if (prefix < 0 || prefix > bits) return false
  const hostBits = BigInt(bits - prefix)
  const mask =
    prefix === 0 ? 0n : ((1n << BigInt(bits)) - 1n) ^ ((1n << hostBits) - 1n)
  const network = networkIp.value & mask
  if ((ip.value & mask) !== network) return false
  if (ip.version === 4) {
    const broadcast = network + (1n << hostBits) - 1n
    if (ip.value === network || ip.value === broadcast) return false
  }
  return true
}
