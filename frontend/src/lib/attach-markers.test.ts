import { beforeEach, describe, expect, it } from 'vitest'
import { readAttachMarkers, writeAttachMarkers } from './attach-markers'

describe('attach marker persistence', () => {
  beforeEach(() => localStorage.clear())

  it('stores timestamps independently for each project', () => {
    writeAttachMarkers('project-1', {
      'server-1': '2026-07-30T12:00:00.000Z',
    })

    expect(readAttachMarkers('project-1')).toEqual({
      'server-1': '2026-07-30T12:00:00.000Z',
    })
    expect(readAttachMarkers('project-2')).toEqual({})
  })
})
