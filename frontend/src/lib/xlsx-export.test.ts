import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createXlsxBlob } from './xlsx-export'

describe('createXlsxBlob', () => {
  it('creates a valid XLSX archive with headers and row values', async () => {
    const blob = createXlsxBlob(
      ['NO.', 'ID', 'ELASTIC_IP_1'],
      [[1, 'server-1', '10.0.0.1, ip-1']],
      {
        title: 'SERVER REPORT',
        metadata: [
          { label: 'Exported at', value: '2026-07-30 18:00:00' },
          { label: 'Exported by', value: 'User (user@example.com)' },
        ],
        sheetName: 'Servers',
      }
    )
    const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()))

    expect(archive['[Content_Types].xml']).toBeDefined()
    expect(archive['xl/workbook.xml']).toBeDefined()
    expect(archive['xl/worksheets/sheet1.xml']).toBeDefined()

    const worksheet = strFromU8(archive['xl/worksheets/sheet1.xml'])
    const styles = strFromU8(archive['xl/styles.xml'])
    const workbook = strFromU8(archive['xl/workbook.xml'])
    expect(worksheet).toContain('SERVER REPORT')
    expect(worksheet).toContain('Exported at')
    expect(worksheet).toContain('User (user@example.com)')
    expect(worksheet).toContain('ELASTIC_IP_1')
    expect(worksheet).toContain('10.0.0.1, ip-1')
    expect(worksheet).toContain('mergeCell ref="A1:C1"')
    expect(worksheet).toContain('<cols>')
    expect(worksheet).toContain('customWidth="1"')
    expect(worksheet).toContain('<autoFilter')
    expect(worksheet).toContain('s="5"')
    expect(styles).toContain('<borders count="2">')
    expect(styles).toContain('style="thin"')
    expect(styles).toContain('horizontal="center"')
    expect(workbook).toContain('name="Servers"')
  })
})
