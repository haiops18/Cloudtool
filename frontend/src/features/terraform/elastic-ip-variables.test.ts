import { expect, it } from 'vitest'
import {
  elasticIpVariableError,
  elasticIpVariables,
} from './elastic-ip-variables'

it('uses only the actual selected address and clears stale addresses when disabled', () => {
  expect(
    elasticIpVariables({
      elastic_ip_mode: 'existing',
      elastic_ip_address: ' 203.0.113.42 ',
    })
  ).toEqual({ elastic_ip_enabled: 'true', elastic_ip_address: '203.0.113.42' })
  expect(
    elasticIpVariables({
      elastic_ip_mode: 'none',
      elastic_ip_address: '203.0.113.42',
    })
  ).toEqual({ elastic_ip_enabled: 'false', elastic_ip_address: '' })
})

it('does not invent an automatic address or substitute labels for an IP', () => {
  const auto = {
    elastic_ip_mode: 'auto' as const,
    elastic_ip_address: '203.0.113.42',
  }
  expect(elasticIpVariables(auto)).toEqual({ elastic_ip_enabled: 'true' })
  expect(
    elasticIpVariableError(auto, 'flag={{elastic_ip_enabled}}')
  ).toBeUndefined()
  expect(elasticIpVariableError(auto, 'ip={{ elastic_ip_address }}')).toContain(
    'existing Elastic IP'
  )
  const invalid = {
    elastic_ip_mode: 'existing' as const,
    elastic_ip_address: 'EIP resource label',
  }
  expect(elasticIpVariables(invalid).elastic_ip_address).toBeUndefined()
  expect(elasticIpVariableError(invalid, '{{elastic_ip_address}}')).toContain(
    'valid IP address'
  )
})
