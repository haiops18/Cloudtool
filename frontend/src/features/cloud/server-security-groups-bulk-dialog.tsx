import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Loader2, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { CloudDataTable } from '@/components/cloud-data-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SearchableSelectV2 } from '@/components/searchable-select-v2'
import type { SecurityGroupOption } from './server-security-groups-dialog'
import type { ServerRow } from './types'

type Row = {
  id: string
  index: number
  name: string
  original: string[]
  groups: string[]
  status: string
  error?: string
  apiStatus?: string
  apiCode?: number
  apiResult?: string
  result?: 'success' | 'error' | 'pending'
}
const ids = (value: unknown): string[] => {
  if (!Array.isArray(value))
    throw new Error(
      'The VM did not return its security groups. Reload to retry.'
    )
  return [
    ...new Set(
      value.map((group) => {
        const id =
          typeof group === 'string' ? group : (group as { id?: string })?.id
        if (!id)
          throw new Error('An attached security group could not be identified.')
        return id
      })
    ),
  ].sort()
}
const same = (a: string[], b: string[]) =>
  [...a].sort().join('|') === [...b].sort().join('|')
const editable = (row: Row) =>
  ['ready', 'failed', 'updated'].includes(row.status)
const changed = (row: Row) => editable(row) && !same(row.original, row.groups)
const detailText = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() || undefined
  if (Array.isArray(value))
    return value.map(detailText).filter(Boolean).join('; ') || undefined
  if (value && typeof value === 'object') {
    const detail = value as Record<string, unknown>
    for (const key of [
      'upstream_detail',
      'detail',
      'message',
      'error',
      'non_field_errors',
    ]) {
      const text = detailText(detail[key])
      if (text) return text
    }
    return JSON.stringify(value)
  }
  return undefined
}
const errorText = (error: unknown) => {
  const data = (
    error as {
      response?: { data?: { detail?: unknown; error?: unknown } }
    }
  )?.response?.data
  return (
    detailText(data?.error ?? data?.detail) ||
    (error instanceof Error ? error.message : 'Request failed.')
  )
}
async function workers<T>(items: T[], run: (item: T) => Promise<void>) {
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(3, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        await run(items[index])
      }
    })
  )
}

function AddGroupButton({
  name,
  options,
  disabled,
  onSelect,
}: {
  name: string
  options: SecurityGroupOption[]
  disabled: boolean
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          size='icon'
          className='size-7 shrink-0 border-dashed'
          role='combobox'
          aria-expanded={open}
          aria-label={`Add SG to ${name}`}
          title={`Add SG to ${name}`}
          disabled={disabled}
        >
          <Plus className='size-4' />
        </Button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-72 p-0'>
        <Command>
          <CommandInput placeholder='Search security groups...' />
          <CommandList>
            <CommandEmpty>No security groups available.</CommandEmpty>
            <CommandGroup>
              {options.map((group) => (
                <CommandItem
                  key={group.id}
                  value={`${group.display_name || group.name} ${group.id}`}
                  onSelect={() => {
                    onSelect(group.id)
                    setOpen(false)
                  }}
                >
                  {group.display_name || group.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function ServerSecurityGroupsBulkDialog({
  servers,
  projectId,
  projectName,
  onClose,
}: {
  servers: ServerRow[]
  projectId: string
  projectName: string
  onClose: () => void
}) {
  const client = useQueryClient()
  const [rows, setRows] = useState<Row[]>(() =>
    servers.map((server, index) => ({
      id: server.id,
      index: index + 1,
      name: server.name,
      original: [],
      groups: [],
      status: 'loading',
    }))
  )
  const [running, setRunning] = useState(false)
  const [confirmRows, setConfirmRows] = useState<Row[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const onSelectedRowsChange = useCallback((selected: Row[]) => {
    setSelectedIds(selected.map((row) => row.id))
  }, [])
  const [discard, setDiscard] = useState(false)
  const [bulkGroup, setBulkGroup] = useState('')
  const groups = useQuery({
    queryKey: ['cloud', projectId, 'security-groups'],
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<SecurityGroupOption[]>('/cloud/security-groups', {
          signal,
          headers: { 'X-Project-Id': projectId },
        })
      ).data,
    staleTime: 30_000,
  })
  const update = useCallback(
    (id: string, fields: Partial<Row>) =>
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, ...fields } : row))
      ),
    []
  )
  const read = useCallback(
    async (id: string, signal?: AbortSignal) =>
      ids(
        (
          await apiClient.get<{ security_groups?: unknown }>(
            `/cloud/servers/${id}`,
            { signal, headers: { 'X-Project-Id': projectId }, timeout: 60000 }
          )
        ).data.security_groups
      ),
    [projectId]
  )
  useEffect(() => {
    const controller = new AbortController()
    void workers(servers, async (server) => {
      if (controller.signal.aborted) return
      try {
        const current = ids(
          (
            await apiClient.get<{ security_groups?: unknown }>(
              `/cloud/servers/${server.id}`,
              {
                signal: controller.signal,
                headers: { 'X-Project-Id': projectId },
                timeout: 60000,
              }
            )
          ).data.security_groups
        )
        if (!controller.signal.aborted)
          update(server.id, {
            original: current,
            groups: current,
            status: 'ready',
          })
      } catch (error) {
        if (!controller.signal.aborted)
          update(server.id, { status: 'load failed', error: errorText(error) })
      }
    })
    return () => controller.abort()
  }, [servers, projectId, update])
  const reload = useCallback(
    async (row: Row) => {
      update(row.id, { status: 'loading', error: undefined })
      try {
        const current = await read(row.id)
        update(row.id, { original: current, groups: current, status: 'ready' })
      } catch (error) {
        update(row.id, { status: 'load failed', error: errorText(error) })
      }
    },
    [read, update]
  )
  const edit = useCallback(
    (row: Row, next: string[]) =>
      update(row.id, {
        groups: [...new Set(next)].sort(),
        status: 'ready',
        error: undefined,
      }),
    [update]
  )
  const pending = rows.filter(changed)
  const save = async () => {
    const targets = confirmRows.map((row) => ({
      ...row,
      groups: [...row.groups],
    }))
    if (running || !targets.length) return
    setRunning(true)
    const targetIds = new Set(targets.map((row) => row.id))
    setRows((current) =>
      current.map((row) =>
        targetIds.has(row.id)
          ? {
              ...row,
              status: 'queued',
              error: undefined,
              result: undefined,
              apiStatus: undefined,
              apiCode: undefined,
              apiResult: undefined,
            }
          : row
      )
    )
    try {
      await workers(targets, async (row) => {
        update(row.id, { status: 'updating' })
        let submittedStatus: string | undefined
        try {
          const response = await apiClient.post<{
            status: string
            upstream_status?: number
            response?: unknown
          }>(
            `/cloud/servers/${row.id}/security-groups`,
            {
              security_groups: row.groups,
              expected_security_groups: row.original,
            },
            { headers: { 'X-Project-Id': projectId }, timeout: 0 }
          )
          submittedStatus = response.data.status
          update(row.id, {
            status: 'verifying',
            result: 'pending',
            apiStatus: response.data.status,
            apiCode: response.data.upstream_status ?? response.status,
            apiResult:
              response.data.response == null
                ? undefined
                : JSON.stringify(response.data.response),
          })
          for (let attempt = 0; attempt < 10; attempt++) {
            if (attempt)
              await new Promise((resolve) => setTimeout(resolve, 2000))
            if (same(await read(row.id), row.groups)) {
              update(row.id, {
                original: row.groups,
                status: 'updated',
                result: 'success',
              })
              return
            }
          }
          update(row.id, {
            status:
              response.data.status === 'accepted' ? 'accepted' : 'unknown',
            error:
              'The cloud has not confirmed the new groups yet. Reload to check; the update will not be sent again automatically.',
          })
        } catch (error) {
          if (submittedStatus) {
            update(row.id, {
              status: submittedStatus === 'accepted' ? 'accepted' : 'unknown',
              result: 'pending',
              error: `The update API returned ${submittedStatus}, but verification failed: ${errorText(error)} Reload to check the VM; the update will not be resent automatically.`,
            })
            return
          }
          const code = (error as { response?: { status?: number } })?.response
            ?.status
          if (code && code >= 400 && code < 500) {
            update(row.id, {
              status: code === 409 ? 'conflict' : 'failed',
              error: errorText(error),
              result: 'error',
              apiStatus: 'failed',
              apiCode: code,
              apiResult: errorText(error),
            })
          } else {
            try {
              if (same(await read(row.id), row.groups)) {
                update(row.id, {
                  original: row.groups,
                  status: 'updated',
                  result: 'success',
                })
                return
              }
            } catch {
              /* Keep an ambiguous write locked until the user reloads its state. */
            }
            update(row.id, {
              status: 'unknown',
              result: 'pending',
              apiStatus: 'unknown',
              apiCode: code,
              apiResult: errorText(error),
              error: `${errorText(error)} Reload this VM before retrying; the update may have been accepted.`,
            })
          }
        }
      })
    } finally {
      setRunning(false)
      setConfirmRows([])
      await client.invalidateQueries({
        queryKey: ['cloud', projectId, 'servers'],
      })
      await client.invalidateQueries({
        queryKey: ['cloud', projectId, 'server-security-groups'],
      })
      await client.invalidateQueries({
        queryKey: ['cloud', projectId, 'server-detail'],
      })
    }
  }
  const options = useMemo(() => groups.data ?? [], [groups.data])
  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      { accessorKey: 'index', header: '#', size: 40 },
      {
        accessorKey: 'name',
        header: 'VM name',
        cell: ({ row }) => (
          <span className='font-medium'>{row.original.name}</span>
        ),
      },
      {
        id: 'security_groups',
        header: 'Security groups',
        accessorFn: (row) =>
          row.groups
            .map(
              (id) =>
                options.find((group) => group.id === id)?.display_name ||
                options.find((group) => group.id === id)?.name ||
                id
            )
            .join(', '),
        cell: ({ row: { original: row } }) => (
          <div className='flex max-w-2xl min-w-64 flex-wrap items-center gap-1.5'>
            <AddGroupButton
              name={row.name}
              disabled={running || !editable(row) || !groups.data}
              options={options.filter(
                (group) => !row.groups.includes(group.id)
              )}
              onSelect={(id) => edit(row, [...row.groups, id])}
            />
            {row.groups.map((id) => (
              <Badge
                key={id}
                variant='outline'
                title={
                  !row.original.includes(id) ? 'New security group' : undefined
                }
                className={`gap-1 py-1 ${!row.original.includes(id) ? 'border-emerald-400 bg-emerald-100 text-emerald-950 dark:border-emerald-600 dark:bg-emerald-950 dark:text-emerald-200' : 'border-zinc-600 bg-zinc-800 text-zinc-100'}`}
              >
                {!row.original.includes(id) && <Plus className='size-3' />}
                {options.find((group) => group.id === id)?.display_name ||
                  options.find((group) => group.id === id)?.name ||
                  id}
                <button
                  type='button'
                  aria-label={`Remove ${options.find((group) => group.id === id)?.name || id} from ${row.name}`}
                  disabled={running || !editable(row)}
                  onClick={() =>
                    edit(
                      row,
                      row.groups.filter((value) => value !== id)
                    )
                  }
                  className='rounded-sm disabled:opacity-40'
                >
                  <X className='size-3' />
                </button>
              </Badge>
            ))}
            {!row.groups.length && (
              <span className='text-xs text-muted-foreground'>
                {row.status === 'loading'
                  ? 'Loading…'
                  : row.status === 'load failed'
                    ? 'Security groups could not be loaded'
                    : 'No security groups'}
              </span>
            )}
          </div>
        ),
      },
      {
        id: 'modified',
        accessorFn: (row) =>
          same(row.original, row.groups) ? 'Unchanged' : 'Modified',
        header: 'Status',
        cell: ({ row }) => (
          <Badge
            variant='outline'
            className={
              !same(row.original.original, row.original.groups)
                ? 'border-amber-400 bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-200'
                : 'text-muted-foreground'
            }
          >
            {same(row.original.original, row.original.groups)
              ? 'Unchanged'
              : 'Modified'}
          </Badge>
        ),
      },
      {
        id: 'result',
        header: 'Result',
        accessorFn: (row) =>
          [row.result, row.error, row.apiCode].filter(Boolean).join(' '),
        cell: ({ row: { original: row } }) => {
          const failed = row.result === 'error' || row.status === 'load failed'
          return (
            <div className='max-w-80 space-y-1'>
              {failed ? (
                <Badge variant='destructive'>Error</Badge>
              ) : row.result === 'success' ? (
                <Badge className='bg-emerald-600 text-white hover:bg-emerald-600'>
                  Success
                </Badge>
              ) : row.result === 'pending' ||
                ['queued', 'updating', 'verifying'].includes(row.status) ? (
                <Badge
                  variant='outline'
                  className='border-amber-500 text-amber-700 dark:text-amber-400'
                >
                  {row.status === 'unknown'
                    ? 'Unconfirmed'
                    : row.status === 'accepted'
                      ? 'Accepted'
                      : 'Processing'}
                </Badge>
              ) : (
                <span className='text-muted-foreground'>?</span>
              )}
              {row.error && (
                <p
                  className={`text-xs break-words whitespace-normal ${failed ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}`}
                >
                  {row.error}
                </p>
              )}
            </div>
          )
        },
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <Button
            variant='ghost'
            size='icon'
            aria-label={`Reload ${row.original.name}`}
            disabled={running || row.original.status === 'loading'}
            onClick={() => void reload(row.original)}
          >
            <RefreshCw />
          </Button>
        ),
      },
    ],
    [options, running, edit, reload, groups.data]
  )
  const close = () => {
    if (running) {
      toast.info('Wait for the current VM updates to finish before closing.')
      return
    }
    if (pending.length) setDiscard(true)
    else onClose()
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <DialogContent className='flex h-[var(--interface-dialog-max-height,84svh)] flex-col overflow-hidden sm:!w-[90vw] sm:!max-w-[90vw]'>
          <DialogHeader className='shrink-0 pr-6'>
            <DialogTitle className='flex items-center gap-2'>
              <ShieldCheck />
              Update security groups
            </DialogTitle>
            <DialogDescription>
              {servers.length} VM(s) · {projectName}. Add or remove groups per
              VM, then review and apply only modified rows.
            </DialogDescription>
          </DialogHeader>
          {groups.isError && (
            <div role='alert' className='text-sm text-destructive'>
              {errorText(groups.error)}{' '}
              <Button
                size='sm'
                variant='outline'
                onClick={() => void groups.refetch()}
              >
                Reload security groups
              </Button>
            </div>
          )}
          <div className='flex shrink-0 flex-wrap items-center gap-2 rounded-md border bg-muted/20 p-2'>
            <SearchableSelectV2
              isControlled
              defaultValue={bulkGroup}
              ariaLabel='Bulk security group'
              onValueChange={setBulkGroup}
              placeholder='Choose a security group'
              className='w-64'
              disabled={running || !groups.data}
              items={options.map((group) => ({
                value: group.id,
                label: group.display_name || group.name,
              }))}
            />
            <Button
              size='sm'
              variant='outline'
              disabled={!bulkGroup || running}
              onClick={() =>
                setRows((current) =>
                  current.map((row) =>
                    editable(row)
                      ? {
                          ...row,
                          groups: [
                            ...new Set([...row.groups, bulkGroup]),
                          ].sort(),
                          status: 'ready',
                          error: undefined,
                        }
                      : row
                  )
                )
              }
            >
              <Plus />
              Add to all loaded VMs
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={!bulkGroup || running}
              onClick={() =>
                setRows((current) =>
                  current.map((row) =>
                    editable(row)
                      ? {
                          ...row,
                          groups: row.groups.filter((id) => id !== bulkGroup),
                          status: 'ready',
                          error: undefined,
                        }
                      : row
                  )
                )
              }
            >
              <X />
              Remove from all loaded VMs
            </Button>
          </div>
          <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
            <CloudDataTable
              data={rows}
              columns={columns}
              getRowId={(row) => row.id}
              selectedRowIds={selectedIds}
              onSelectedRowsChange={onSelectedRowsChange}
              isRowSelectable={(row) => !running && editable(row)}
              selectionColumnPosition='first'
              toolbar={(selected) => {
                const targets = selected.filter(changed)
                return (
                  <Button
                    disabled={running || !targets.length || !groups.data}
                    onClick={() =>
                      setConfirmRows(
                        targets.map((row) => ({
                          ...row,
                          groups: [...row.groups],
                          original: [...row.original],
                        }))
                      )
                    }
                  >
                    {running && <Loader2 className='animate-spin' />}Apply{' '}
                    {running ? confirmRows.length : targets.length} change(s)
                  </Button>
                )
              }}
              fillHeight
              entityName='VM'
              initialPageSize={50}
              searchPlaceholder='Search VM, security group or status...'
            />
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmRows.length > 0}
        onOpenChange={(open) => {
          if (!open && !running) setConfirmRows([])
        }}
        title={`Update security groups for ${confirmRows.length} VM(s)?`}
        desc={`Only selected, modified VMs in ${projectName} will be updated, with at most three concurrent operations. ${confirmRows.filter((row) => !row.groups.length).length} VM(s) will have all security groups removed. This changes their firewall protection.`}
        isLoading={running}
        confirmText={
          <>{running && <Loader2 className='animate-spin' />}Apply changes</>
        }
        handleConfirm={() => void save()}
      >
        {running && (
          <p aria-live='polite' className='text-sm text-muted-foreground'>
            {confirmRows.length -
              rows.filter((row) =>
                ['queued', 'updating', 'verifying'].includes(row.status)
              ).length}{' '}
            / {confirmRows.length} VM(s) processed
          </p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title='Discard unsaved security group changes?'
        desc='Your changes have not been sent to the cloud.'
        destructive
        confirmText='Discard changes'
        handleConfirm={onClose}
      />
    </>
  )
}
