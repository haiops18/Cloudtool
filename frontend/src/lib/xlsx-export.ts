import { strToU8, zipSync } from 'fflate'

function escapeXml(value: unknown) {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function columnName(index: number) {
  let value = index + 1
  let result = ''
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

export interface XlsxReportOptions {
  title?: string
  metadata?: Array<{ label: string; value: string }>
  /** Optional per-header multiplier applied after automatic width calculation. */
  columnWidthMultipliers?: Record<string, number>
  sheetName?: string
  validations?: Array<{
    header: string
    values?: string[]
    type?: 'list' | 'whole' | 'custom'
    min?: number
    max?: number
    allowBlank?: boolean
    enforce?: boolean
    /** Excel formula relative to the first data row. Supports {row}/{cell}. */
    formula?: string
    prompt?: string
    error?: string
    /** 1-based data-row positions for a per-row validation list. */
    rowIndexes?: number[]
    /** Use the value list only for matching controller values; otherwise require blank. */
    enabledWhen?: { header: string; values: string[] }
  }>
  validationRowCount?: number
}

function displayLength(value: unknown) {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  return Math.max(...text.split(/\r?\n/).map((line) => line.length), 0)
}

function columnWidths(headers: string[], rows: unknown[][]) {
  return headers.map((header, columnIndex) =>
    Math.min(
      Math.max(
        displayLength(header),
        ...rows.map((row) => displayLength(row[columnIndex]))
      ) + 2,
      50
    )
  )
}

function worksheetXml(
  headers: string[],
  rows: unknown[][],
  options: XlsxReportOptions
) {
  const reportRows: Array<{
    values: unknown[]
    styles?: number[]
    height?: number
  }> = []
  if (options.title) {
    reportRows.push({ values: [options.title], styles: [2], height: 28 })
    for (const item of options.metadata ?? []) {
      reportRows.push({
        values: [item.label, item.value],
        styles: [3, 4],
        height: 20,
      })
    }
    reportRows.push({ values: [] })
  }
  const headerRowNumber = reportRows.length + 1
  reportRows.push({
    values: headers,
    styles: headers.map(() => 1),
    height: 30,
  })
  reportRows.push(
    ...rows.map((values) => ({
      values,
      styles: values.map(() => 5),
    }))
  )

  const body = reportRows
    .map(({ values, styles, height }, rowIndex) => {
      const cells = values
        .map(
          (value, columnIndex) =>
            `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"${
              styles?.[columnIndex] === undefined
                ? ''
                : ` s="${styles[columnIndex]}"`
            }><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
        )
        .join('')
      return `<row r="${rowIndex + 1}"${
        height ? ` ht="${height}" customHeight="1"` : ''
      }>${cells}</row>`
    })
    .join('')
  const lastColumn = columnName(Math.max(headers.length - 1, 0))
  const merges: string[] = []
  if (options.title && headers.length > 1)
    merges.push(`<mergeCell ref="A1:${lastColumn}1"/>`)
  if (options.title && headers.length > 2)
    for (let index = 0; index < (options.metadata?.length ?? 0); index++) {
      const row = index + 2
      merges.push(`<mergeCell ref="B${row}:${lastColumn}${row}"/>`)
    }
  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>`
    : ''
  const cols = columnWidths(headers, rows)
    .map(
      (width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${Math.max(
          width * (options.columnWidthMultipliers?.[headers[index]] ?? 1),
          10
        )}" customWidth="1"/>`
    )
    .join('')
  const lastDataRow = headerRowNumber + rows.length
  const validations = (options.validations ?? []).flatMap(
    (validation, index) => {
      const columnIndex = headers.indexOf(validation.header)
      const values = [...new Set((validation.values ?? []).map(String).filter(Boolean))]
      if (
        columnIndex < 0 ||
        (validation.type !== 'whole' &&
          validation.type !== 'custom' &&
          !values.length)
      )
        return []
      const column = columnName(columnIndex)
      const firstRow = headerRowNumber + 1
      const endRow =
        headerRowNumber +
        Math.max(options.validationRowCount ?? 500, rows.length, 1)
      const targets = validation.rowIndexes?.length
        ? validation.rowIndexes.map((rowIndex) => `${column}${headerRowNumber + rowIndex}`).join(' ')
        : `${column}${firstRow}:${column}${endRow}`
      if (validation.type === 'custom' && validation.formula) {
        const formula = validation.formula
          .split('{row}').join(String(firstRow))
          .split('{cell}').join(`${column}${firstRow}`)
        return `<dataValidation type="custom" allowBlank="${validation.allowBlank === false ? 0 : 1}" showInputMessage="1" promptTitle="Required fields" prompt="${escapeXml(validation.prompt ?? 'Enter a value valid for the selected resource type.')}" showErrorMessage="1" errorStyle="stop" errorTitle="Invalid field" error="${escapeXml(validation.error ?? 'This value is not valid for the selected resource type.')}" sqref="${targets}"><formula1>${escapeXml(formula)}</formula1></dataValidation>`
      }
      if (validation.type === 'whole') {
        return `<dataValidation type="whole" operator="between" allowBlank="${validation.allowBlank === false ? 0 : 1}" showInputMessage="1" promptTitle="Numeric value" prompt="Enter a whole number from ${validation.min ?? 1} to ${validation.max ?? 10000} Mbps." showErrorMessage="1" errorStyle="stop" errorTitle="Invalid value" error="Enter a valid whole number in the allowed range." sqref="${targets}"><formula1>${validation.min ?? 1}</formula1><formula2>${validation.max ?? 10000}</formula2></dataValidation>`
      }
      const listRange = `INDIRECT(&quot;Lists!$${columnName(index)}$1:$${columnName(index)}$${values.length}&quot;)`
      const blankRange = `INDIRECT(&quot;Lists!$${columnName(index)}$${values.length + 1}&quot;)`
      let formula = listRange
      if (validation.enabledWhen) {
        const controllerIndex = headers.indexOf(validation.enabledWhen.header)
        if (controllerIndex >= 0) {
          const controller = `$${columnName(controllerIndex)}${firstRow}`
          const checks = validation.enabledWhen.values
            .map((value) => `${controller}=&quot;${escapeXml(value)}&quot;`)
          const condition = checks.length === 1 ? checks[0] : `OR(${checks.join(',')})`
          formula = `IF(${condition},${listRange},${blankRange})`
        }
      }
      return `<dataValidation type="list" allowBlank="${validation.allowBlank === false ? 0 : 1}" showDropDown="0" showInputMessage="1" promptTitle="Project values" prompt="${escapeXml(validation.prompt ?? 'Choose a value from the project list.')}" showErrorMessage="${validation.enforce === false ? 0 : 1}" errorStyle="stop" errorTitle="Invalid value" error="${escapeXml(validation.error ?? 'Select a value from the project list.')}" sqref="${targets}"><formula1>${formula}</formula1></dataValidation>`
    }
  )
  const validationXml = validations.length
    ? `<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRowNumber}" topLeftCell="A${headerRowNumber + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>${body}</sheetData>
  <autoFilter ref="A${headerRowNumber}:${lastColumn}${lastDataRow}"/>
  ${mergeXml}
  ${validationXml}
</worksheet>`
}

function listWorksheetXml(
  validations: NonNullable<XlsxReportOptions['validations']>
) {
  const lists = validations.map((item) => [
    ...new Set((item.values ?? []).map(String).filter(Boolean)),
  ])
  const rowCount = Math.max(0, ...lists.map((items) => items.length))
  const rows = Array.from({ length: rowCount }, (_, rowIndex) => {
    const cells = lists.flatMap((items, columnIndex) =>
      items[rowIndex] === undefined
        ? []
        : [
            `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(items[rowIndex])}</t></is></c>`,
          ]
    )
    return `<row r="${rowIndex + 1}">${cells.join('')}</row>`
  })
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`
}

export function createXlsxBlob(
  headers: string[],
  rows: unknown[][],
  options: XlsxReportOptions = {}
) {
  const hasLists = Boolean(
    options.validations?.some((item) => (item.values ?? []).length)
  )
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  ${hasLists ? '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' : ''}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${escapeXml(options.sheetName ?? 'Report')}" sheetId="1" r:id="rId1"/>${hasLists ? '<sheet name="Lists" sheetId="2" state="hidden" r:id="rId2"/>' : ''}</sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  ${hasLists ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' : ''}
  <Relationship Id="${hasLists ? 'rId3' : 'rId2'}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
    ),
    'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4"><font/><font><b/><color rgb="FFFFFFFF"/></font><font><b/><sz val="16"/><color rgb="FF1F2937"/></font><font><b/><color rgb="FF1E3A5F"/></font></fonts>
  <fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFF6FF"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border/><border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom></border></borders>
  <cellStyleXfs count="1"><xf/></cellStyleXfs>
  <cellXfs count="6"><xf xfId="0"/><xf xfId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf xfId="0" fontId="2" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf xfId="0" fontId="3" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf xfId="0" fillId="4" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf><xf xfId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs>
</styleSheet>`),
    'xl/worksheets/sheet1.xml': strToU8(worksheetXml(headers, rows, options)),
    ...(hasLists
      ? {
          'xl/worksheets/sheet2.xml': strToU8(
            listWorksheetXml(options.validations ?? [])
          ),
        }
      : {}),
  }
  const bytes = zipSync(files, { level: 6 })
  return new Blob([bytes.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

export function downloadXlsx(
  headers: string[],
  rows: unknown[][],
  fileName: string,
  options: XlsxReportOptions = {}
) {
  const blob = createXlsxBlob(headers, rows, options)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`
  link.click()
  URL.revokeObjectURL(url)
}
