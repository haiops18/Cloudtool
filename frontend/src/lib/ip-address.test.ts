import { describe, expect, it } from 'vitest'
import { buildIpRange, isUsableIpInCidr, nextIpAddress } from './ip-address'

describe('IP address range helpers', () => {
  it('builds an inclusive range', () => {
    expect(buildIpRange('10.0.0.10', '10.0.0.12')).toEqual([
      '10.0.0.10',
      '10.0.0.11',
      '10.0.0.12',
    ])
  })

  it('builds a requested count and finds the next address', () => {
    expect(buildIpRange('10.0.0.254', '', 2)).toEqual([
      '10.0.0.254',
      '10.0.0.255',
    ])
    expect(nextIpAddress('10.0.0.255')).toBe('10.0.1.0')
  })

  it('rejects invalid and oversized ranges', () => {
    expect(() => buildIpRange('invalid', '', 2)).toThrow()
    expect(() => buildIpRange('10.0.0.10', '', 1001)).toThrow()
  })

  it('checks usable addresses against a subnet CIDR', () => {
    expect(isUsableIpInCidr('10.0.0.10', '10.0.0.0/24')).toBe(true)
    expect(isUsableIpInCidr('10.0.0.0', '10.0.0.0/24')).toBe(false)
    expect(isUsableIpInCidr('10.0.0.255', '10.0.0.0/24')).toBe(false)
    expect(isUsableIpInCidr('10.0.1.1', '10.0.0.0/24')).toBe(false)
  })
})
