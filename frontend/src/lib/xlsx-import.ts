import { strFromU8, unzipSync } from 'fflate'

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function columnIndex(reference: string) {
  const letters = reference.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? 'A'
  return (
    [...letters].reduce(
      (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
      0
    ) - 1
  )
}

function textNodes(xml: string) {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => decodeXml(match[1]))
    .join('')
}

export function parseXlsxRows(buffer: ArrayBuffer) {
  const archive = unzipSync(new Uint8Array(buffer))
  const sheetBytes = archive['xl/worksheets/sheet1.xml']
  if (!sheetBytes)
    throw new Error('The Excel file does not contain a worksheet.')
  const sharedBytes = archive['xl/sharedStrings.xml']
  const sharedStrings = sharedBytes
    ? [...strFromU8(sharedBytes).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
        (match) => textNodes(match[1])
      )
    : []
  const sheet = strFromU8(sheetBytes)
  return [...sheet.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)].map(
    (rowMatch) => {
      const row: string[] = []
      // Excel writes empty cells as self-closing nodes (`<c r="T7"/>`).
      // They still occupy a column and must be parsed to preserve alignment;
      // ignoring them shifts every following value into the wrong header.
      for (const cell of rowMatch[1].matchAll(
        /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
      )) {
        const attributes = cell[1]
        const content = cell[2] ?? ''
        const reference = attributes.match(/\br="([^"]+)"/)?.[1] ?? 'A1'
        const type = attributes.match(/\bt="([^"]+)"/)?.[1]
        const rawValue = content.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? ''
        row[columnIndex(reference)] =
          type === 's'
            ? (sharedStrings[Number(rawValue)] ?? '')
            : type === 'inlineStr'
              ? textNodes(content)
              : decodeXml(rawValue)
      }
      return row.map((value) => value ?? '')
    }
  )
}

export function rowsFromHeader(rows: string[][], requiredHeaders: string[]) {
  const normalizedRequired = requiredHeaders.map((header) =>
    header.trim().toUpperCase()
  )
  const headerIndex = rows.findIndex((row) => {
    const normalized = row.map((value) => value.trim().toUpperCase())
    return normalizedRequired.every((header) => normalized.includes(header))
  })
  if (headerIndex < 0)
    throw new Error(`Excel headers not found: ${requiredHeaders.join(', ')}.`)
  const headers = rows[headerIndex].map((header) => header.trim().toUpperCase())
  return rows
    .slice(headerIndex + 1)
    .filter((row) => row.some((value) => value?.trim()))
    .map((row) =>
      Object.fromEntries(
        headers.map((header, index) => [header, row[index]?.trim() ?? ''])
      )
    )
}
