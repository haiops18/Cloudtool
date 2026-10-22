import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  type ColumnDef,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  ListFilter,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { downloadXlsx } from '@/lib/xlsx-export'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SearchableSelect } from '@/components/searchable-select'

interface CloudDataTableProps<T> {
  data: T[]
  columns: ColumnDef<T>[]
  getRowId: (row: T) => string
  searchPlaceholder?: string
  emptyText?: string
  loading?: boolean
  entityName?: string
  exportFileName?: string
  toolbar?: (selectedRows: T[], clearSelection: () => void) => ReactNode
  onSelectedRowsChange?: (selectedRows: T[]) => void
  /** Initial selection for tables whose selected rows are meaningful domain state. */
  initialSelectedRowIds?: string[]
  /** Controlled selection for callers that must retain selections across modal opens. */
  selectedRowIds?: string[]
  isRowSelectable?: (row: T) => boolean
  enableSelection?: boolean
  /** Select every filtered row while rendering only the current page. */
  selectAllMatchingRows?: boolean
  selectionColumnPosition?: 'first' | 'after-first-column'
  serverPagination?: {
    pagination: PaginationState
    totalRows: number
    onChange: (pagination: PaginationState) => void
  }
  pageSizeOptions?: number[]
  initialPageSize?: number
  fillHeight?: boolean
  serverFiltering?: {
    search: string
    onSearchChange: (value: string) => void
    advanced?: AdvancedSearch
    onAdvancedChange: (value?: AdvancedSearch) => void
  }
}

type AdvancedSearchMode = 'values' | 'comparison'

interface AdvancedSearch {
  columnId: string
  values: string[]
  mode?: AdvancedSearchMode
  expression?: string
}

function columnId<T>(column: ColumnDef<T>, index: number) {
  if ('id' in column && column.id) return column.id
  if ('accessorKey' in column && typeof column.accessorKey === 'string')
    return column.accessorKey
  return `column_${index + 1}`
}

function columnValue<T>(column: ColumnDef<T>, row: T, index: number): unknown {
  if ('accessorFn' in column && typeof column.accessorFn === 'function')
    return column.accessorFn(row, index)
  if ('accessorKey' in column && typeof column.accessorKey === 'string')
    return (row as Record<string, unknown>)[column.accessorKey]
  return ''
}

function displayColumnName(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function searchableColumns<T>(columns: ColumnDef<T>[]) {
  return columns
    .map((column, index) => ({
      column,
      id: columnId(column, index),
      index,
    }))
    .filter(
      ({ column, id }) =>
        id !== 'actions' &&
        (('accessorFn' in column && Boolean(column.accessorFn)) ||
          ('accessorKey' in column && Boolean(column.accessorKey)))
    )
}

function normalizeCellValue(value: unknown) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

const numericToken = '[-+]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?'

function parseNumericToken(value: string) {
  const number = Number(value.replace(/,/g, ''))
  return Number.isFinite(number) ? number : undefined
}

function numericCellValue(value: unknown) {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined
  const token = normalizeCellValue(value).match(new RegExp(numericToken))?.[0]
  return token ? parseNumericToken(token) : undefined
}

function parseNumericComparison(expression: string) {
  const source = expression.trim()
  const single = source.match(
    new RegExp(
      `^(?:(?:[a-z_][\\w ]*)\\s+)?(>=|>|<=|<|=)\\s*(${numericToken})$`,
      'i'
    )
  )
  if (single) {
    const value = parseNumericToken(single[2])
    if (value === undefined) return undefined
    switch (single[1] || '=') {
      case '>':
        return (cell: number) => cell > value
      case '>=':
        return (cell: number) => cell >= value
      case '<':
        return (cell: number) => cell < value
      case '<=':
        return (cell: number) => cell <= value
      default:
        return (cell: number) => cell === value
    }
  }

  const between = source.match(
    new RegExp(
      `^(${numericToken})\\s*(<=|<)\\s*(?:[a-z_][\\w ]*|value)\\s*(<=|<)\\s*(${numericToken})$`,
      'i'
    )
  )
  if (!between) return undefined
  const lower = parseNumericToken(between[1])
  const upper = parseNumericToken(between[4])
  if (lower === undefined || upper === undefined || lower > upper)
    return undefined
  return (cell: number) =>
    (between[2] === '<' ? cell > lower : cell >= lower) &&
    (between[3] === '<' ? cell < upper : cell <= upper)
}

function parseTextComparison(expression: string) {
  const match = expression
    .trim()
    .match(/^(?:(?:[a-z_][\w ]*)\s+)?(!~|!=|>=|>|<=|<|~|=)\s*(.+)$/i)
  if (!match || !match[2].trim()) return undefined
  const operator = match[1]
  const expected = match[2].trim().toLocaleLowerCase()
  return (value: unknown) => {
    const actual = normalizeCellValue(value).trim().toLocaleLowerCase()
    switch (operator) {
      case '=':
        return actual === expected
      case '!=':
        return actual !== expected
      case '~':
        return actual.includes(expected)
      case '>':
        return actual > expected
      case '>=':
        return actual >= expected
      case '<':
        return actual < expected
      case '<=':
        return actual <= expected
      default:
        return !actual.includes(expected)
    }
  }
}

function parseComparison(expression: string) {
  const numeric = parseNumericComparison(expression)
  if (numeric) {
    return (value: unknown) => {
      const number = numericCellValue(value)
      return number !== undefined && numeric(number)
    }
  }
  return parseTextComparison(expression)
}

function exportExcel<T>(rows: T[], columns: ColumnDef<T>[], fileName: string) {
  const exportColumns = searchableColumns(columns)
  const normalizedFileName = fileName.replace(/[^a-z0-9-_]+/gi, '-')
  downloadXlsx(
    exportColumns.map(({ id }) => displayColumnName(id).toUpperCase()),
    rows.map((row, rowIndex) =>
      exportColumns.map(({ column }) => columnValue(column, row, rowIndex))
    ),
    `${normalizedFileName}.xlsx`,
    {
      title: normalizedFileName.replace(/-/g, ' ').toUpperCase(),
      metadata: [
        { label: 'Exported at', value: new Date().toLocaleString() },
        { label: 'Total rows', value: String(rows.length) },
      ],
      sheetName: 'Data',
    }
  )
}

function getPageNumbers(currentPage: number, totalPages: number) {
  if (totalPages <= 7)
    return Array.from({ length: totalPages }, (_, index) => index + 1)
  if (currentPage <= 4) return [1, 2, 3, 4, 5, '…', totalPages] as const
  if (currentPage >= totalPages - 3)
    return [
      1,
      '…',
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ] as const
  return [
    1,
    '…',
    currentPage - 1,
    currentPage,
    currentPage + 1,
    '…',
    totalPages,
  ] as const
}

export function CloudDataTable<T>({
  data,
  columns,
  getRowId,
  searchPlaceholder = 'Search...',
  emptyText = 'No results found.',
  loading,
  exportFileName = 'data-export',
  toolbar,
  onSelectedRowsChange,
  initialSelectedRowIds,
  selectedRowIds: controlledSelectedRowIds,
  isRowSelectable,
  enableSelection = true,
  selectAllMatchingRows = false,
  selectionColumnPosition = 'first',
  serverPagination,
  pageSizeOptions = [10, 20, 50, 100, 500, 1000],
  initialPageSize = 100,
  fillHeight = false,
  serverFiltering,
}: CloudDataTableProps<T>) {
  const tableRootRef = useRef<HTMLDivElement>(null)
  const [usesViewportHeight, setUsesViewportHeight] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [globalFilter, setGlobalFilter] = useState('')
  const deferredGlobalFilter = useDeferredValue(globalFilter)
  const [rowSelection, setRowSelection] = useState<RowSelectionState>(() =>
    Object.fromEntries((initialSelectedRowIds ?? []).map((id) => [id, true]))
  )
  const controlledSelectionKey = (controlledSelectedRowIds ?? [])
    .slice()
    .sort()
    .join('\u0000')
  useEffect(() => {
    if (controlledSelectedRowIds === undefined) return
    setRowSelection((current) => {
      const next = Object.fromEntries(
        controlledSelectedRowIds.map((id) => [id, true])
      )
      const currentIds = Object.keys(current)
        .filter((id) => current[id])
        .sort()
        .join('\u0000')
      return currentIds === controlledSelectionKey ? current : next
    })
  }, [controlledSelectionKey, controlledSelectedRowIds])
  const selectionAnchorRef = useRef<string | undefined>(undefined)
  const modifierKeysRef = useRef({ shift: false, additive: false })
  const [clientPagination, setClientPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: initialPageSize,
  })
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedColumnId, setAdvancedColumnId] = useState('')
  const [advancedInput, setAdvancedInput] = useState('')
  const [advancedMode, setAdvancedMode] = useState<AdvancedSearchMode>('values')
  const [advancedSearch, setAdvancedSearch] = useState<AdvancedSearch>()
  const advancedColumns = useMemo(() => searchableColumns(columns), [columns])
  const parsedAdvancedValues = useMemo(
    () =>
      Array.from(
        new Set(
          advancedInput
            .split(/[\n,]+/)
            .map((value) => value.trim())
            .filter(Boolean)
        )
      ),
    [advancedInput]
  )
  const filteredData = useMemo(() => {
    if (serverFiltering) return data
    if (!advancedSearch) return data
    const target = advancedColumns.find(
      (item) => item.id === advancedSearch.columnId
    )
    if (!target) return data
    if (advancedSearch.mode === 'comparison') {
      const matches = parseComparison(advancedSearch.expression ?? '')
      if (!matches) return data
      return data.filter((row, rowIndex) => {
        return matches(columnValue(target.column, row, rowIndex))
      })
    }
    const needles = advancedSearch.values.map((value) => value.toLowerCase())
    return data.filter((row, rowIndex) => {
      const cell = normalizeCellValue(
        columnValue(target.column, row, rowIndex)
      ).toLowerCase()
      return needles.some((needle) => cell.includes(needle))
    })
  }, [advancedColumns, advancedSearch, data, serverFiltering])
  const activeAdvancedSearch = serverFiltering?.advanced ?? advancedSearch
  const searchValue = serverFiltering?.search ?? globalFilter
  const comparisonMatcher = useMemo(
    () => parseComparison(advancedInput),
    [advancedInput]
  )
  const advancedSearchReady =
    advancedMode === 'comparison'
      ? Boolean(comparisonMatcher)
      : parsedAdvancedValues.length > 0
  const selectableColumns = useMemo<ColumnDef<T>[]>(() => {
    const actionColumns = columns.filter(
      (column) => 'id' in column && column.id === 'actions'
    )
    const dataColumns = columns.filter(
      (column) => !('id' in column && column.id === 'actions')
    )
    return [
      ...(selectionColumnPosition === 'after-first-column'
        ? dataColumns.slice(0, 1)
        : []),
      ...(enableSelection
        ? [
            {
              id: 'select',
              header: ({ table }) => (
                <Checkbox
                  aria-label='Select all rows'
                  checked={
                    (selectAllMatchingRows
                      ? table.getIsAllRowsSelected()
                      : table.getIsAllPageRowsSelected()) ||
                    ((selectAllMatchingRows
                      ? table.getFilteredSelectedRowModel().rows.length > 0
                      : table.getIsSomePageRowsSelected()) && 'indeterminate')
                  }
                  onCheckedChange={(value) => {
                    selectionAnchorRef.current = undefined
                    if (selectAllMatchingRows)
                      table.toggleAllRowsSelected(Boolean(value))
                    else table.toggleAllPageRowsSelected(Boolean(value))
                  }}
                />
              ),
              cell: ({ row }) => (
                <Checkbox
                  aria-label='Select row'
                  checked={row.getIsSelected()}
                  disabled={!row.getCanSelect()}
                  onPointerDown={(event) => {
                    // Radix's checked callback does not receive the pointer
                    // event, so capture modifiers at the actual click target.
                    modifierKeysRef.current = {
                      shift: event.shiftKey,
                      additive: event.ctrlKey || event.metaKey,
                    }
                  }}
                  onKeyDown={(event) => {
                    modifierKeysRef.current = {
                      shift: event.shiftKey,
                      additive: event.ctrlKey || event.metaKey,
                    }
                  }}
                  onCheckedChange={(value) => {
                    const visibleRows = table.getRowModel().rows
                    const anchorIndex = visibleRows.findIndex(
                      (item) => item.id === selectionAnchorRef.current
                    )
                    const rowIndex = visibleRows.findIndex(
                      (item) => item.id === row.id
                    )
                    if (
                      modifierKeysRef.current.shift &&
                      anchorIndex >= 0 &&
                      rowIndex >= 0
                    ) {
                      const [start, end] =
                        anchorIndex < rowIndex
                          ? [anchorIndex, rowIndex]
                          : [rowIndex, anchorIndex]
                      setRowSelection((current) => {
                        const next = modifierKeysRef.current.additive
                          ? { ...current }
                          : {}
                        visibleRows.slice(start, end + 1).forEach((item) => {
                          if (item.getCanSelect()) next[item.id] = true
                        })
                        return next
                      })
                      return
                    }
                    selectionAnchorRef.current = row.id
                    row.toggleSelected(Boolean(value))
                  }}
                />
              ),
              enableSorting: false,
              enableHiding: false,
            } as ColumnDef<T>,
          ]
        : []),
      ...(selectionColumnPosition === 'after-first-column'
        ? dataColumns.slice(1)
        : dataColumns),
      ...actionColumns,
    ]
  }, [columns, enableSelection, selectAllMatchingRows, selectionColumnPosition])
  // TanStack Table intentionally exposes non-memoizable table methods.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: filteredData,
    columns: selectableColumns,
    state: {
      sorting,
      columnVisibility,
      globalFilter: serverFiltering ? '' : deferredGlobalFilter,
      rowSelection,
      pagination: serverPagination?.pagination ?? clientPagination,
    },
    getRowId,
    enableRowSelection:
      enableSelection &&
      (isRowSelectable ? (row) => isRowSelectable(row.original) : true),
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    onPaginationChange: (updater) => {
      const current = serverPagination?.pagination ?? clientPagination
      const next = typeof updater === 'function' ? updater(current) : updater
      if (serverPagination) serverPagination.onChange(next)
      else setClientPagination(next)
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualPagination: Boolean(serverPagination),
    rowCount: serverPagination?.totalRows,
  })
  const selectedRowModel = table.getFilteredSelectedRowModel()
  const selectedRows = useMemo(
    () => selectedRowModel.rows.map((row) => row.original),
    [selectedRowModel.rows]
  )
  const selectedRowIds = selectedRows.map(getRowId).join('\u0000')
  const clearSelection = () => {
    selectionAnchorRef.current = undefined
    setRowSelection({})
  }

  useEffect(() => {
    onSelectedRowsChange?.(selectedRows)
    // Row ids are sufficient here: selection changes are what consumers need
    // to react to, while avoiding a parent render loop from a new array value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelectedRowsChange, selectedRowIds])
  const shouldFillTableHeight =
    usesViewportHeight && table.getRowModel().rows.length >= 12

  useEffect(() => {
    const root = tableRootRef.current
    if (!root) return
    // Dialog tables and intentionally constrained panels retain their own
    // height. Standalone page tables can use the remaining viewport space.
    const inDialog = Boolean(root.closest('[role="dialog"]'))
    let ancestor = root.parentElement
    let hasHeightConstraint = false
    while (ancestor && ancestor !== document.body) {
      const maxHeight = window.getComputedStyle(ancestor).maxHeight
      if (maxHeight !== 'none' && maxHeight !== '0px') {
        hasHeightConstraint = true
        break
      }
      ancestor = ancestor.parentElement
    }
    setUsesViewportHeight(fillHeight || (!inDialog && !hasHeightConstraint))
  }, [fillHeight])

  useEffect(() => {
    const updateModifiers = (event: KeyboardEvent) => {
      modifierKeysRef.current = {
        shift: event.shiftKey,
        additive: event.ctrlKey || event.metaKey,
      }
    }
    const resetModifiers = () => {
      modifierKeysRef.current = { shift: false, additive: false }
    }
    window.addEventListener('keydown', updateModifiers)
    window.addEventListener('keyup', updateModifiers)
    window.addEventListener('blur', resetModifiers)
    return () => {
      window.removeEventListener('keydown', updateModifiers)
      window.removeEventListener('keyup', updateModifiers)
      window.removeEventListener('blur', resetModifiers)
    }
  }, [])

  return (
    <div
      ref={tableRootRef}
      className={
        shouldFillTableHeight
          ? 'cloud-data-table-fill flex h-full min-h-0 flex-1 flex-col gap-3 self-stretch [&_[data-slot=table-container]]:!h-full [&_[data-slot=table-container]]:!max-h-none'
          : 'space-y-3'
      }
    >
      <div className='flex shrink-0 items-center gap-1.5 sm:gap-2'>
        <div className='relative min-w-0 flex-1 sm:max-w-sm sm:flex-none'>
          <Search className='absolute start-2.5 top-2.5 size-4 text-muted-foreground' />
          <Input
            value={searchValue}
            onChange={(event) =>
              serverFiltering
                ? serverFiltering.onSearchChange(event.target.value)
                : setGlobalFilter(event.target.value)
            }
            placeholder={searchPlaceholder}
            className='ps-8'
          />
          {searchValue && (
            <Button
              type='button'
              variant='ghost'
              size='icon'
              className='absolute end-0 top-0 size-9'
              onClick={() =>
                serverFiltering
                  ? serverFiltering.onSearchChange('')
                  : setGlobalFilter('')
              }
              aria-label='Clear search'
            >
              <X className='size-4' />
            </Button>
          )}
        </div>
        <div className='flex shrink-0 items-center gap-1.5 sm:flex-1 sm:flex-wrap sm:gap-2'>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant='outline'
                size='icon'
                className='relative'
                aria-label='Advanced search'
                onClick={() => {
                  if (activeAdvancedSearch) {
                    setAdvancedColumnId(activeAdvancedSearch.columnId)
                    setAdvancedMode(activeAdvancedSearch.mode ?? 'values')
                    setAdvancedInput(
                      activeAdvancedSearch.mode === 'comparison'
                        ? (activeAdvancedSearch.expression ?? '')
                        : activeAdvancedSearch.values.join('\n')
                    )
                  }
                  setAdvancedOpen(true)
                }}
              >
                <ListFilter />
                {activeAdvancedSearch && (
                  <Badge className='absolute -end-1.5 -top-1.5 size-4 justify-center rounded-full p-0 text-[10px]'>
                    {activeAdvancedSearch.mode === 'comparison'
                      ? '±'
                      : activeAdvancedSearch.values.length}
                  </Badge>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Advanced search</TooltipContent>
          </Tooltip>
          {activeAdvancedSearch && (
            <Button
              variant='ghost'
              size='icon'
              className='sm:w-auto sm:px-3'
              onClick={() => {
                if (serverFiltering) serverFiltering.onAdvancedChange(undefined)
                else setAdvancedSearch(undefined)
                setAdvancedColumnId('')
                setAdvancedInput('')
                setAdvancedMode('values')
              }}
            >
              <X />
              <span className='hidden sm:inline'>Clear advanced filter</span>
            </Button>
          )}
          <div className='flex items-center gap-1.5 sm:ms-auto sm:gap-2'>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='outline'
                  size='icon'
                  aria-label='Export Excel'
                  onClick={() =>
                    exportExcel(
                      table
                        .getFilteredRowModel()
                        .rows.map((row) => row.original),
                      columns,
                      exportFileName
                    )
                  }
                  disabled={!table.getFilteredRowModel().rows.length}
                >
                  <Download />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Export Excel</TooltipContent>
            </Tooltip>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant='outline'
                  size='icon'
                  aria-label='View columns'
                  title='View columns'
                >
                  <SlidersHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end' className='w-44'>
                <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {table
                  .getAllColumns()
                  .filter((column) => column.getCanHide())
                  .map((column) => (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      checked={column.getIsVisible()}
                      onCheckedChange={(value) =>
                        column.toggleVisibility(Boolean(value))
                      }
                      className='capitalize'
                    >
                      {column.id.replace(/_/g, ' ')}
                    </DropdownMenuCheckboxItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div
        className={`w-full overflow-hidden rounded-md border ${shouldFillTableHeight ? 'min-h-0 flex-1' : ''}`}
      >
        <div
          className={`w-full overflow-x-auto ${shouldFillTableHeight ? 'h-full overflow-y-auto' : ''}`}
        >
          <Table
            className={`w-max min-w-full ${shouldFillTableHeight ? 'h-full' : ''}`}
          >
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className={[
                        header.column.id === 'actions'
                          ? 'sticky right-0 z-20 bg-muted whitespace-nowrap shadow-[-6px_0_8px_-8px_rgba(0,0,0,0.45)]'
                          : 'whitespace-nowrap',
                        (
                          header.column.columnDef.meta as
                            { className?: string } | undefined
                        )?.className,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() && 'selected'}
                    className={
                      enableSelection && row.getCanSelect()
                        ? 'cursor-pointer'
                        : undefined
                    }
                    onClick={(event) => {
                      if (!enableSelection || !row.getCanSelect()) return
                      const target = event.target as HTMLElement
                      if (
                        target.closest(
                          'button, input, textarea, select, a, [role="button"], [role="checkbox"], [role="combobox"], [role="menuitem"]'
                        )
                      )
                        return

                      const visibleRows = table.getRowModel().rows
                      const anchorIndex = visibleRows.findIndex(
                        (item) => item.id === selectionAnchorRef.current
                      )
                      const rowIndex = visibleRows.findIndex(
                        (item) => item.id === row.id
                      )
                      const additive = event.ctrlKey || event.metaKey

                      if (event.shiftKey && anchorIndex >= 0 && rowIndex >= 0) {
                        const [start, end] =
                          anchorIndex < rowIndex
                            ? [anchorIndex, rowIndex]
                            : [rowIndex, anchorIndex]
                        setRowSelection((current) => {
                          const next = additive ? { ...current } : {}
                          visibleRows.slice(start, end + 1).forEach((item) => {
                            if (item.getCanSelect()) next[item.id] = true
                          })
                          return next
                        })
                        return
                      }

                      selectionAnchorRef.current = row.id
                      if (additive) {
                        row.toggleSelected()
                        return
                      }
                      table.setRowSelection({ [row.id]: true })
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={[
                          cell.column.id === 'actions'
                            ? 'sticky right-0 z-10 bg-background whitespace-nowrap shadow-[-6px_0_8px_-8px_rgba(0,0,0,0.45)]'
                            : 'whitespace-nowrap',
                          (
                            cell.column.columnDef.meta as
                              { className?: string } | undefined
                          )?.className,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={selectableColumns.length}
                    className='h-28 text-center text-muted-foreground'
                  >
                    {loading ? 'Loading data...' : emptyText}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className='flex shrink-0 flex-col gap-4 px-2 text-sm xl:flex-row xl:items-center xl:justify-between'>
        <div className='flex flex-wrap items-center gap-4'>
          <span className='text-muted-foreground'>
            {serverPagination?.totalRows ??
              table.getFilteredRowModel().rows.length}{' '}
            result(s)
          </span>
          <div className='flex items-center gap-2'>
            <SearchableSelect
              value={String(table.getState().pagination.pageSize)}
              onValueChange={(value) => {
                table.setPageSize(Number(value))
                table.setPageIndex(0)
              }}
              className='h-8 w-24'
              searchPlaceholder='Rows...'
              options={pageSizeOptions.map((pageSize) => ({
                value: String(pageSize),
                label: String(pageSize),
              }))}
            />
            <span className='font-medium whitespace-nowrap'>Rows per page</span>
          </div>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='w-24 text-center font-medium'>
            Page {table.getState().pagination.pageIndex + 1} of{' '}
            {Math.max(table.getPageCount(), 1)}
          </span>
          <Button
            variant='outline'
            size='icon'
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.setPageIndex(0)}
            aria-label='First page'
          >
            <ChevronsLeft />
          </Button>
          <Button
            variant='outline'
            size='icon'
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
            aria-label='Previous page'
          >
            <ChevronLeft />
          </Button>
          {getPageNumbers(
            table.getState().pagination.pageIndex + 1,
            Math.max(table.getPageCount(), 1)
          ).map((pageNumber, index) =>
            pageNumber === '…' ? (
              <span
                key={`ellipsis-${index}`}
                className='px-1 text-muted-foreground'
              >
                …
              </span>
            ) : (
              <Button
                key={pageNumber}
                variant={
                  table.getState().pagination.pageIndex + 1 === pageNumber
                    ? 'default'
                    : 'outline'
                }
                className='h-9 min-w-9 px-2'
                onClick={() => table.setPageIndex(pageNumber - 1)}
              >
                <span className='sr-only'>Go to page </span>
                {pageNumber}
              </Button>
            )
          )}
          <Button
            variant='outline'
            size='icon'
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
            aria-label='Next page'
          >
            <ChevronRight />
          </Button>
          <Button
            variant='outline'
            size='icon'
            disabled={!table.getCanNextPage()}
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            aria-label='Last page'
          >
            <ChevronsRight />
          </Button>
        </div>
      </div>

      {selectedRows.length > 0 && (
        <div
          role='toolbar'
          aria-label={`Bulk actions for ${selectedRows.length} selected rows`}
          className='fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border bg-background/95 p-2 shadow-xl backdrop-blur-lg'
        >
          <div className='flex max-w-[calc(100vw-2rem)] items-center gap-2 overflow-x-auto'>
            <Button
              variant='outline'
              size='icon'
              className='size-7 shrink-0 rounded-full'
              onClick={clearSelection}
              aria-label='Clear selection'
            >
              <X />
            </Button>
            <Separator orientation='vertical' className='h-5' />
            <div className='flex shrink-0 items-center gap-1.5 text-sm'>
              <Badge className='min-w-8 rounded-lg'>
                {selectedRows.length}
              </Badge>
            </div>
            <Separator orientation='vertical' className='h-5' />
            {toolbar?.(selectedRows, clearSelection)}
            <Button
              variant='outline'
              size='sm'
              onClick={() =>
                exportExcel(selectedRows, columns, `${exportFileName}-selected`)
              }
            >
              <Download />
              Export selected
            </Button>
          </div>
        </div>
      )}

      <Dialog open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <DialogContent className='sm:max-w-xl'>
          <DialogHeader>
            <DialogTitle>Advanced multi-value search</DialogTitle>
            <DialogDescription>
              Filter by multiple values or compare a text or numeric column.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-[minmax(0,19rem)_1fr] sm:items-end'>
              <div className='space-y-2'>
                <Label>Search column</Label>
                <SearchableSelect
                  value={advancedColumnId}
                  onValueChange={setAdvancedColumnId}
                  placeholder='Select a column'
                  searchPlaceholder='Search columns...'
                  options={advancedColumns.map(({ id }) => ({
                    value: id,
                    label: displayColumnName(id),
                  }))}
                />
              </div>
              <div className='space-y-2 sm:justify-self-end'>
                <Label>Filter mode</Label>
                <div className='inline-flex rounded-md border bg-muted/30 p-1'>
                  <Button
                    type='button'
                    size='sm'
                    variant={advancedMode === 'values' ? 'secondary' : 'ghost'}
                    onClick={() => setAdvancedMode('values')}
                  >
                    Multiple values
                  </Button>
                  <Button
                    type='button'
                    size='sm'
                    variant={
                      advancedMode === 'comparison' ? 'secondary' : 'ghost'
                    }
                    onClick={() => setAdvancedMode('comparison')}
                  >
                    Comparison
                  </Button>
                </div>
              </div>
            </div>
            <div className='space-y-2'>
              <Label htmlFor='advanced-search-values'>
                {advancedMode === 'comparison'
                  ? 'Comparison expression'
                  : 'Values to find'}
              </Label>
              {advancedMode === 'comparison' ? (
                <Input
                  id='advanced-search-values'
                  value={advancedInput}
                  onChange={(event) => setAdvancedInput(event.target.value)}
                  className='font-mono text-sm'
                  placeholder='= running, ~ timeout, or 20 < value < 30'
                />
              ) : (
                <Textarea
                  id='advanced-search-values'
                  value={advancedInput}
                  onChange={(event) => setAdvancedInput(event.target.value)}
                  className='min-h-48 font-mono text-sm'
                  placeholder={'value-1, value-2\nvalue-3\nvalue-4'}
                />
              )}
              <p
                className={
                  advancedMode === 'comparison' &&
                  advancedInput &&
                  !comparisonMatcher
                    ? 'text-xs text-destructive'
                    : 'text-xs text-muted-foreground'
                }
              >
                {advancedMode === 'comparison'
                  ? comparisonMatcher
                    ? 'Valid: = running, > running, ~ timeout, > 20, or 20 < value < 30.'
                    : 'Text: =, !=, >, >=, <, <=, ~ contains, !~ excludes. Number: > 20 or 20 < value < 30.'
                  : `${parsedAdvancedValues.length} unique value(s) detected. Matching is case-insensitive and supports partial values.`}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => {
                if (serverFiltering) serverFiltering.onAdvancedChange(undefined)
                else setAdvancedSearch(undefined)
                setAdvancedColumnId('')
                setAdvancedInput('')
                setAdvancedMode('values')
                setAdvancedOpen(false)
              }}
            >
              Clear
            </Button>
            <Button
              disabled={!advancedColumnId || !advancedSearchReady}
              onClick={() => {
                const nextAdvancedSearch = {
                  columnId: advancedColumnId,
                  values: advancedMode === 'values' ? parsedAdvancedValues : [],
                  mode: advancedMode,
                  expression:
                    advancedMode === 'comparison'
                      ? advancedInput.trim()
                      : undefined,
                }
                if (serverFiltering)
                  serverFiltering.onAdvancedChange(nextAdvancedSearch)
                else setAdvancedSearch(nextAdvancedSearch)
                setRowSelection({})
                table.setPageIndex(0)
                setAdvancedOpen(false)
              }}
            >
              {advancedMode === 'comparison'
                ? 'Apply comparison'
                : `Search ${parsedAdvancedValues.length || ''} value(s)`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
