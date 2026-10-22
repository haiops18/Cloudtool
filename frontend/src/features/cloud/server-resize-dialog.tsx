import { useEffect, useMemo, useRef, useState } from 'react'
import { AxiosError } from 'axios'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Download, FileUp, Loader2, Maximize2 } from 'lucide-react'
import { toast } from 'sonner'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { downloadXlsx } from '@/lib/xlsx-export'
import { parseXlsxRows, rowsFromHeader } from '@/lib/xlsx-import'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { CloudDataTable } from '@/components/cloud-data-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SortableHeader } from '@/components/sortable-header'
import { resizeErrorMessage } from './resize-error-message'
import type { ServerRow } from './types'

const SERVER_RESIZE_REQUEST_BATCH_SIZE = 1

type ResizeRow = {
  server_id: string
  name: string
  zone_id: string
  zone_name: string
  power_state?: string
  server_type?: string
  ram?: number
  vcpus?: number
  current_flavor_name?: string
  loading?: boolean
  current_ram?: number
  current_vcpus?: number
  flavor_name?: string
  error?: string
}

type ResizeResult = {
  server_id: string
  name?: string
  flavor?: string
  flavor_name?: string
  status: string
  error?: unknown
  upstream_status?: number
  response?: unknown
}

function serverResizeZone(server: ServerRow) {
  const record = server as ServerRow & {
    zone?: string | { id?: string; name?: string; display_name?: string }
    zone_id?: string
  }
  const zone = record.zone
  const zoneId =
    record.zone_id || (typeof zone === 'string' ? zone : zone?.id) || ''
  const zoneName =
    record.zone_display_name ||
    (typeof zone === 'object' ? zone.display_name || zone.name : '') ||
    zoneId
  return { id: zoneId, name: zoneName }
}

function resizeRow(server: ServerRow & Record<string, unknown>): ResizeRow {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const specs = object(server.specs)
  const flavor = object(server.flavor ?? specs.flavor)
  const family = [specs.server_type, flavor.family, server.server_type].find(
    (value) => value === 'basic' || value === 'gpu'
  )
  const ram = Number(specs.ram ?? flavor.ram ?? server.ram ?? 0)
  const vcpus = Number(specs.vcpus ?? flavor.vcpus ?? server.vcpus ?? 0)
  const power = String(server.power_state || '').toLowerCase()
  const zone = serverResizeZone(server)
  return {
    server_id: server.id,
    name: server.name,
    zone_id: zone.id,
    zone_name: zone.name,
    power_state: power,
    server_type: String(family || ''),
    ram,
    vcpus,
    current_ram: ram,
    current_vcpus: vcpus,
    current_flavor_name: String(
      server.flavor_name ??
        specs.flavor_name ??
        flavor.display_name ??
        flavor.name ??
        (ram && vcpus ? 'Custom' : '-')
    ),
    error: !['running', 'shutdown', 'shutoff', 'stopped', 'off'].includes(power)
      ? 'VM must be running or shutdown.'
      : undefined,
  }
}

async function readResizeRows(
  servers: ServerRow[],
  projectId: string,
  signal: AbortSignal,
  onRow: (row: ResizeRow) => void
) {
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(3, servers.length) }, async () => {
      while (!signal.aborted && cursor < servers.length) {
        const server = servers[cursor++]
        try {
          const { data } = await apiClient.get<
            ServerRow & Record<string, unknown>
          >(`/cloud/servers/${server.id}`, {
            headers: { 'X-Project-Id': projectId },
            timeout: 60000,
            signal,
          })
          if (!signal.aborted)
            onRow(
              resizeRow({
                ...data,
                id: server.id,
                name: data.name || server.name,
              })
            )
        } catch (error) {
          if (!signal.aborted)
            onRow({
              ...resizeRow(server as ServerRow & Record<string, unknown>),
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to load VM details.',
            })
        }
      }
    })
  )
}

export function ServerResizeDialog({
  open,
  targets,
  onOpenChange,
}: {
  open: boolean
  targets: ServerRow[]
  onOpenChange: (open: boolean) => void
}) {
  const activeProject = useCloudStore((state) => state.project)
  const project = activeProject ?? { id: '', name: '' }
  const queryClient = useQueryClient()
  const [rows, setRows] = useState<ResizeRow[]>([])
  const [pendingResizeRows, setPendingResizeRows] = useState<ResizeRow[]>([])
  const [results, setResults] = useState<ResizeResult[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const detailControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open || !project.id) return
    // Reset the editable plan each time the dialog opens or selection changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResults([])
    setPendingResizeRows([])
    const controller = new AbortController()
    detailControllerRef.current = controller
    setRows(
      targets.map((server) => ({
        ...resizeRow(server as ServerRow & Record<string, unknown>),
        loading: true,
      }))
    )
    void readResizeRows(targets, project.id, controller.signal, (row) =>
      setRows((current) =>
        current.map((item) => (item.server_id === row.server_id ? row : item))
      )
    )
    return () => controller.abort()
  }, [open, targets, project.id])

  const resize = useMutation({
    mutationFn: async (items: ResizeRow[]) => {
      const outcomes = new Map<string, ResizeResult>()
      setResults(
        items.map((item) => ({
          server_id: item.server_id,
          name: item.name,
          flavor_name: item.flavor_name,
          status: 'queued',
        }))
      )
      for (
        let start = 0;
        start < items.length;
        start += SERVER_RESIZE_REQUEST_BATCH_SIZE
      ) {
        const batch = items.slice(
          start,
          start + SERVER_RESIZE_REQUEST_BATCH_SIZE
        )
        batch.forEach((item) =>
          outcomes.set(item.server_id, {
            server_id: item.server_id,
            name: item.name,
            flavor_name: item.flavor_name,
            status: 'processing',
          })
        )
        setResults(
          items.map(
            (item) =>
              outcomes.get(item.server_id) ?? {
                server_id: item.server_id,
                name: item.name,
                status: 'queued',
              }
          )
        )
        try {
          const { data } = await apiClient.post<{ items: ResizeResult[] }>(
            '/cloud/servers/resize',
            {
              items: batch.map((item) => ({
                server_id: item.server_id,
                flavor_name: `${item.vcpus} vCPU / ${item.ram} GB`,
                specs: {
                  server_type: item.server_type,
                  kind: 'custom',
                  ram: item.ram,
                  vcpus: item.vcpus,
                },
                live_resize: item.power_state === 'running',
              })),
            },
            { timeout: 0, headers: { 'X-Project-Id': project.id } }
          )
          for (const result of data.items ?? [])
            outcomes.set(result.server_id, result)
        } catch (error) {
          const message =
            error instanceof AxiosError
              ? resizeErrorMessage(error.response?.data ?? error.message)
              : 'Resize request failed.'
          batch.forEach((item) =>
            outcomes.set(item.server_id, {
              server_id: item.server_id,
              name: item.name,
              flavor_name: `${item.vcpus} vCPU / ${item.ram} GB`,
              status: 'unconfirmed',
              error: message,
            })
          )
        }
        setResults(
          items.map(
            (item) =>
              outcomes.get(item.server_id) ?? {
                server_id: item.server_id,
                name: item.name,
                status: 'queued',
              }
          )
        )
      }
      return [...outcomes.values()]
    },
    onSuccess: (items) => {
      void queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'servers'],
      })
      const failed = items.filter((item) =>
        ['failed', 'unconfirmed'].includes(item.status)
      ).length
      toast[failed ? 'warning' : 'success'](
        failed
          ? `Resize submitted: ${items.length - failed} accepted, ${failed} failed or unconfirmed.`
          : `Resize submitted for ${items.length} server(s).`
      )
    },
    onError: () => toast.error('Server resize could not be submitted.'),
  })

  const downloadTemplate = async () => {
    if (!rows.length) {
      toast.error(
        'Select one or more servers first to create a resize template.'
      )
      return
    }
    downloadXlsx(
      ['SERVER ID', 'SERVER NAME', 'ZONE', 'VCPU', 'RAM GB'],
      rows.map((row) => [
        row.server_id,
        row.name,
        row.zone_name,
        row.vcpus || '',
        row.ram || '',
      ]),
      `server-resize-template-${(project.name || project.id).replace(/[^a-zA-Z0-9._-]+/g, '-')}.xlsx`,
      {
        title: 'SERVER RESIZE TEMPLATE',
        metadata: [
          { label: 'Project', value: project.name || project.id },
          {
            label: 'Usage',
            value: 'Keep SERVER ID. Enter VCPU and RAM GB.',
          },
        ],
        sheetName: 'Resize servers',
      }
    )
    toast.success('Resize template downloaded.')
  }

  const importTemplate = async (file?: File) => {
    if (!file) return
    detailControllerRef.current?.abort()
    setImporting(true)
    try {
      const source = rowsFromHeader(parseXlsxRows(await file.arrayBuffer()), [
        'SERVER ID',
      ])
      const requested = new Map<string, Record<string, string>>()
      const imported: ResizeRow[] = []
      for (const [index, sourceRow] of source.entries()) {
        const id = sourceRow['SERVER ID']?.trim()
        if (!id || requested.has(id)) {
          imported.push({
            server_id: `invalid-${index}`,
            name: sourceRow['SERVER NAME'] || '-',
            zone_id: '',
            zone_name: '',
            error: !id
              ? 'SERVER ID is required.'
              : `Duplicate SERVER ID: ${id}`,
          })
        } else requested.set(id, sourceRow)
      }
      const controller = new AbortController()
      await readResizeRows(
        [...requested.entries()].map(([id, row]) => ({
          id,
          name: row['SERVER NAME'] || id,
          server_type: '',
        })),
        project.id,
        controller.signal,
        (row) => {
          const input = requested.get(row.server_id)!
          imported.push({
            ...row,
            ram: Number(input['RAM GB'] || 0),
            vcpus: Number(input.VCPU || 0),
          })
        }
      )
      setRows(imported)
      setResults([])
      const invalid = imported.filter((row) => row.error).length
      toast[invalid ? 'warning' : 'success'](
        invalid
          ? `Imported ${imported.length} rows; ${invalid} need review.`
          : `Imported ${imported.length} server resize row(s).`
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Resize template could not be imported.'
      )
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const columns = useMemo<ColumnDef<ResizeRow>[]>(
    () => [
      {
        accessorKey: 'name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server' />
        ),
        cell: ({ row }) => (
          <div>
            <p className='font-medium'>{row.original.name || '—'}</p>
            <p className='font-mono text-xs text-muted-foreground'>
              {row.original.server_id}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'power_state',
        header: ({ column }) => (
          <SortableHeader column={column} title='Power state' />
        ),
        cell: ({ getValue }) => {
          const state = String(getValue() || 'unknown').toLowerCase()
          return (
            <span
              className={
                state === 'running'
                  ? 'font-medium text-amber-600 dark:text-amber-400'
                  : 'font-medium text-muted-foreground'
              }
            >
              {state}
            </span>
          )
        },
      },
      {
        accessorKey: 'server_type',
        header: 'Server type',
        cell: ({ row }) =>
          row.original.loading ? (
            <Loader2 className='size-4 animate-spin' />
          ) : (
            <Badge variant='outline'>{row.original.server_type || '-'}</Badge>
          ),
      },
      {
        accessorKey: 'current_flavor_name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Current flavor' />
        ),
        cell: ({ row }) => (
          <div className='max-w-52'>
            <p className='truncate text-sm'>
              {row.original.current_flavor_name || '—'}
            </p>
            <p className='truncate font-mono text-xs text-muted-foreground'>
              {row.original.current_vcpus && row.original.current_ram
                ? `${row.original.current_vcpus} vCPU / ${row.original.current_ram} GB`
                : '-'}
            </p>
          </div>
        ),
      },
      ...(['vcpus', 'ram'] as const).map((field): ColumnDef<ResizeRow> => ({
        accessorKey: field,
        header: field === 'vcpus' ? 'vCPU' : 'RAM (GB)',
        cell: ({ row }) => (
          <Input
            aria-label={`${field} for ${row.original.name}`}
            type='number'
            min={field === 'vcpus' ? 1 : 0.1}
            step={field === 'vcpus' ? 1 : 0.1}
            className='w-24'
            value={row.original[field] || ''}
            disabled={resize.isPending || importing || row.original.loading}
            onChange={(event) =>
              setRows((current) =>
                current.map((item) =>
                  item.server_id === row.original.server_id
                    ? { ...item, [field]: Number(event.target.value) }
                    : item
                )
              )
            }
          />
        ),
      })),
      {
        id: 'resize_mode',
        header: 'Mode',
        accessorFn: (row) =>
          row.power_state === 'running' ? 'Live resize' : 'Offline resize',
        cell: ({ row }) => (
          <Badge
            variant='outline'
            className={
              row.original.power_state === 'running'
                ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                : 'text-muted-foreground'
            }
          >
            {row.original.power_state === 'running'
              ? 'Live resize'
              : 'Offline resize'}
          </Badge>
        ),
      },
      {
        accessorKey: 'error',
        header: ({ column }) => (
          <SortableHeader column={column} title='Review' />
        ),
        cell: ({ getValue, row }) => {
          if (row.original.loading)
            return (
              <span className='text-muted-foreground'>
                Loading VM details...
              </span>
            )
          const validation = !['basic', 'gpu'].includes(
            row.original.server_type || ''
          )
            ? 'Server type is unavailable.'
            : !(
                  Number(row.original.ram) > 0 &&
                  Number.isInteger(row.original.vcpus) &&
                  Number(row.original.vcpus) > 0
                )
              ? 'Enter valid CPU and RAM.'
              : undefined
          const error = (getValue() as string | undefined) || validation
          return error ? (
            <span className='text-sm text-destructive'>{error}</span>
          ) : (
            <span className='font-medium text-emerald-600 dark:text-emerald-400'>
              Ready
            </span>
          )
        },
      },
    ],
    [resize.isPending, importing]
  )
  const resultColumns = useMemo<ColumnDef<ResizeResult>[]>(
    () => [
      {
        accessorKey: 'name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server' />
        ),
        cell: ({ row }) => (
          <div>
            <p className='font-medium'>{row.original.name || '—'}</p>
            <p className='font-mono text-xs text-muted-foreground'>
              {row.original.server_id}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'flavor_name',
        header: ({ column }) => (
          <SortableHeader column={column} title='CPU / RAM' />
        ),
        cell: ({ row }) => (
          <div>
            <p className='text-sm'>{row.original.flavor_name || '—'}</p>
            <p className='font-mono text-xs text-muted-foreground'>
              {row.original.flavor || '—'}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'status',
        header: ({ column }) => (
          <SortableHeader column={column} title='Status' />
        ),
        cell: ({ getValue }) => {
          const status = String(getValue())
          return (
            <span
              className={
                status === 'failed'
                  ? 'font-medium text-destructive'
                  : status === 'queued' ||
                      status === 'processing' ||
                      status === 'unconfirmed'
                    ? 'font-medium text-amber-600 dark:text-amber-400'
                    : 'font-medium text-emerald-600 dark:text-emerald-400'
              }
            >
              {status}
            </span>
          )
        },
      },
      {
        accessorKey: 'error',
        header: ({ column }) => (
          <SortableHeader column={column} title='Detail' />
        ),
        cell: ({ getValue }) => (
          <span
            className={
              getValue()
                ? 'text-sm break-words whitespace-pre-wrap text-destructive'
                : 'text-sm text-muted-foreground'
            }
          >
            {resizeErrorMessage(
              getValue() ?? 'Accepted by Cloud API; completion is asynchronous.'
            )}
          </span>
        ),
      },
    ],
    []
  )

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!resize.isPending && !importing) onOpenChange(next)
        }}
      >
        <DialogContent className='flex h-[var(--interface-dialog-max-height,84svh)] flex-col overflow-hidden sm:!w-[86vw] sm:!max-w-7xl'>
          <DialogHeader className='shrink-0 pr-6'>
            <DialogTitle>Resize servers</DialogTitle>
            <DialogDescription>
              Set CPU and RAM per VM. Current configuration is loaded from VM
              details. Running VMs use live resize; shutdown VMs use offline
              resize. Requests are accepted asynchronously.
            </DialogDescription>
          </DialogHeader>
          <div className='flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 p-3 text-sm'>
            <p className='text-muted-foreground'>
              {rows.length} VM(s). Enter CPU/RAM directly or import SERVER ID,
              VCPU and RAM GB.
            </p>
            <div className='flex gap-2'>
              <input
                ref={fileRef}
                className='hidden'
                type='file'
                accept='.xlsx'
                onChange={(event) =>
                  void importTemplate(event.target.files?.[0])
                }
              />
              <Button
                variant='outline'
                size='sm'
                disabled={importing || resize.isPending}
                onClick={() => void downloadTemplate()}
              >
                <Download />
                Template
              </Button>
              <Button
                size='sm'
                disabled={importing || resize.isPending}
                onClick={() => fileRef.current?.click()}
              >
                {importing ? <Loader2 className='animate-spin' /> : <FileUp />}
                Import Excel
              </Button>
            </div>
          </div>
          {results.length ? (
            <CloudDataTable
              fillHeight
              enableSelection={false}
              data={results}
              columns={resultColumns}
              getRowId={(row) => row.server_id}
              entityName='resize result'
              exportFileName='server-resize-results'
              searchPlaceholder='Search resize results...'
            />
          ) : (
            <>
              {!rows.length ? (
                <div className='flex min-h-48 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground'>
                  Select server rows in the Servers table, or import a resize
                  template.
                </div>
              ) : (
                <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
                  <CloudDataTable
                    fillHeight
                    data={rows}
                    columns={columns}
                    getRowId={(row) => row.server_id}
                    entityName='server'
                    searchPlaceholder='Search VM, current flavor or server type...'
                    isRowSelectable={(row) =>
                      Boolean(
                        !resize.isPending &&
                        !importing &&
                        !row.loading &&
                        !row.error &&
                        ['basic', 'gpu'].includes(row.server_type || '') &&
                        Number(row.ram) > 0 &&
                        Number.isInteger(row.vcpus) &&
                        Number(row.vcpus) > 0
                      )
                    }
                    toolbar={(selected) => (
                      <Button
                        size='sm'
                        disabled={
                          resize.isPending || importing || !selected.length
                        }
                        onClick={() => {
                          setPendingResizeRows(
                            selected.map((row) => ({ ...row }))
                          )
                          setConfirmOpen(true)
                        }}
                      >
                        <Maximize2 />
                        Resize selected ({selected.length})
                      </Button>
                    )}
                  />
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Resize ${pendingResizeRows.length} server(s)?`}
        desc={`${pendingResizeRows.filter((row) => row.power_state === 'running').length} live resize / ${pendingResizeRows.filter((row) => row.power_state !== 'running').length} offline resize. CPU/RAM will be changed for the selected VMs. Review results after submission.`}
        confirmText='Submit resize'
        isLoading={resize.isPending}
        handleConfirm={() => {
          setConfirmOpen(false)
          resize.mutate(pendingResizeRows)
        }}
      />
    </>
  )
}
