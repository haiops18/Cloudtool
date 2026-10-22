import { expect, it } from 'vitest'
import { creationErrorText, creationResponseText } from './creation-error'

it.each([
  'Quota exceeded',
  { message: 'Invalid request', fields: ['image'] },
  ['Unavailable'],
  0,
  false,
])('shows only upstream detail for Cloud API errors: %j', (detail) => {
  const server = {
    error_message: '502: Full gateway log',
    result: {
      cloud_response: {
        error: {
          upstream_detail: detail,
          message: 'Gateway wrapper',
          request_id: 'internal',
        },
      },
    },
  }
  const expected =
    typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
  expect(creationErrorText(server)).toBe(expected)
  expect(creationResponseText(server)).toBe(expected)
})

it('falls back to the original full error and response if upstream detail is absent', () => {
  const server = {
    error_message: 'Full original error log',
    result: {
      cloud_response: { detail: { message: 'Full response', trace: 'log' } },
    },
  }
  expect(creationErrorText(server)).toBe(server.error_message)
  expect(creationResponseText(server)).toBe(
    JSON.stringify(server.result.cloud_response, null, 2)
  )
})

it('handles JSON-encoded upstream responses and null upstream detail', () => {
  expect(creationErrorText({ result: { error: { upstream_detail: 'Nested error' } } })).toBe('Nested error')
  const server = {
    result: {
      cloud_response: JSON.stringify({
        detail: { upstream_detail: { message: 'Upstream error' } },
      }),
    },
  }
  expect(creationResponseText(server)).toBe(
    JSON.stringify({ message: 'Upstream error' }, null, 2)
  )
  expect(
    creationErrorText({
      error_message: 'Original log',
      result: { cloud_response: { upstream_detail: null } },
    })
  ).toBe('Original log')
})
