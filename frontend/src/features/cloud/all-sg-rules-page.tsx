import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SearchableSelectV2 } from '@/components/searchable-select-v2'
import { CloudPageShell } from './page-shell'
import type { ServerSecurityRule } from './server-security-groups-dialog'

type ScheduledRule = {
  id: string
  project_id: string
  security_group_id: string
  rule_id: string
  delete_at: string
  rule_created_at: string | null
  last_error: string | null
  is_due: boolean
}
type RulePage = {
  items: ScheduledRule[]
  total: number
  due: number
  upcoming: number
}
const endpoint = '/cloud/security-groups/scheduled-rules'
const dateText = (value: string | null) =>
  value ? new Date(value).toLocaleString() : '—'
const errorText = (error: unknown) => {
  const data = (
    error as {
      response?: { data?: { detail?: unknown; error?: { message?: string } } }
    }
  )?.response?.data
  return (
    data?.error?.message ||
    (typeof data?.detail === 'string'
      ? data.detail
      : error instanceof Error
        ? error.message
        : 'Request failed.')
  )
}
export function AllSgRulesPage() {
  const client = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [projects, setProjects] = useState<string[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [timing, setTiming] = useState('all')
  const [selected, setSelected] = useState<string[]>([])
  const [confirmItems, setConfirmItems] = useState<ScheduledRule[]>([])
  const [dueOpen, setDueOpen] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  useEffect(() => {
    if (query.trim() === search) return
    const timer = setTimeout(() => {
      setSearch(query.trim())
      setPage(1)
      setSelected([])
    }, 300)
    return () => clearTimeout(timer)
  }, [query, search])
  const inventory = useQuery({
    queryKey: [
      'all-sg-rules',
      'list',
      page,
      pageSize,
      search,
      projects,
      timing,
    ],
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<RulePage>(`${endpoint}/all/list`, {
          signal,
          params: {
            page,
            page_size: pageSize,
            search,
            project_ids: projects,
            timing,
          },
          paramsSerializer: { indexes: null },
        })
      ).data,
    staleTime: 30_000,
  })
  const projectOptions = useQuery({
    queryKey: ['all-sg-rules', 'projects'],
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<{ items: { id: string }[] }>(
          `${endpoint}/all/projects`,
          { signal }
        )
      ).data,
    enabled: pickerOpen,
    staleTime: 60_000,
  })
  const visibleProjects = [
    ...new Set((inventory.data?.items ?? []).map((row) => row.project_id)),
  ].sort()
  const names = useQuery({
    queryKey: ['all-sg-rules', 'project-names'],
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<{
          items: { id: string; name: string; display_name: string }[]
        }>(`${endpoint}/all/project-names`, { signal })
      ).data.items,
    enabled: visibleProjects.length > 0 || pickerOpen,
    staleTime: 60_000,
  })
  // The query client is stable cache infrastructure, not part of the data identity.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const ruleInfo = useQuery({
    queryKey: ['all-sg-rules', 'page-details', visibleProjects],
    enabled: visibleProjects.length > 0,
    staleTime: 30_000,
    queryFn: async ({ signal: pageSignal }) => {
      const result: Record<
        string,
        {
          items?: {
            rule_id: string
            security_group_name?: string
            rule?: ServerSecurityRule
          }[]
          error?: string
        }
      > = {}
      const queue = [...visibleProjects]
      // At most three project requests at a time; reuse existing details API and cache.
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
          while (queue.length && !pageSignal.aborted) {
            const project = queue.shift()!
            try {
              result[project] = await client.fetchQuery({
                queryKey: ['all-sg-rules', 'project-details', project],
                queryFn: async ({ signal }) =>
                  (
                    await apiClient.get<{
                      items: {
                        rule_id: string
                        security_group_name?: string
                        rule?: ServerSecurityRule
                      }[]
                    }>(endpoint, {
                      signal: AbortSignal.any([pageSignal, signal]),
                      params: { include_rule_details: true },
                      headers: { 'X-Project-Id': project },
                    })
                  ).data,
                staleTime: 30_000,
                retry: false,
              })
            } catch (error) {
              if (pageSignal.aborted) throw error
              result[project] = { error: errorText(error) }
            }
          }
        })
      )
      return result
    },
  })
  const remove = useMutation({
    mutationFn: async (items: ScheduledRule[]) => {
      if (items.some((item) => !isEligible(item)))
        throw new Error(
          'Some selected rules could not be verified. Refresh and try again.'
        )
      const groups = new Map<string, ScheduledRule[]>()
      for (const item of items)
        groups.set(item.project_id, [
          ...(groups.get(item.project_id) ?? []),
          item,
        ])
      const failures: string[] = []
      let deleted = 0
      for (const [project, rules] of groups) {
        try {
          const response = await apiClient.post<{
            items: { rule_id: string; status: string; error?: string }[]
          }>(
            `${endpoint}/delete`,
            {
              rule_ids: rules.map((rule) => rule.rule_id),
              verify_exists: true,
            },
            { headers: { 'X-Project-Id': project } }
          )
          for (const result of response.data.items) {
            if (result.status === 'deleted') deleted++
            else
              failures.push(
                `${project} / ${result.rule_id}: ${result.error || 'Deletion failed'}`
              )
          }
        } catch (error) {
          failures.push(`${project}: ${errorText(error)}`)
        }
        await client.invalidateQueries({
          queryKey: ['cloud', project, 'security-groups'],
        })
        await client.invalidateQueries({
          queryKey: ['cloud', project, 'server-security-group-rules'],
        })
      }
      return { deleted, failures }
    },
    onError: (error) => toast.error(errorText(error)),
    onSuccess: async ({ deleted, failures }) => {
      setConfirmItems([])
      setSelected([])
      setPage(1)
      if (deleted) toast.success(`Deleted ${deleted} rule(s).`)
      if (failures.length) toast.error(failures.join('\n'), { duration: 10000 })
      await client.invalidateQueries({ queryKey: ['all-sg-rules'] })
    },
  })
  const duePreview = useQuery({
    queryKey: ['all-sg-rules', 'due-preview'],
    enabled: dueOpen,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<{
          schedule_ids: string[]
          eligible: number
          skipped: number
        }>(`${endpoint}/all/due-preview`, { signal, timeout: 120000 })
      ).data,
    staleTime: 0,
    retry: false,
  })
  const deleteDue = useMutation({
    mutationFn: async () =>
      (
        await apiClient.post<{ items: { status: string }[]; skipped: number }>(
          `${endpoint}/all/delete-due`,
          {
            confirmation,
            schedule_ids: duePreview.data?.schedule_ids ?? [],
          },
          { timeout: 120000 }
        )
      ).data,
    onError: (error) => toast.error(errorText(error)),
    onSuccess: async (response) => {
      const deleted = response.items.filter(
        (item) => item.status === 'deleted'
      ).length
      const failed = response.items.length - deleted
      toast.success(`Deleted ${deleted} rule(s). Skipped ${response.skipped}.`)
      if (failed) toast.error(`${failed} deletion(s) failed. Refresh to retry.`)
      setDueOpen(false)
      setConfirmation('')
      setSelected([])
      setPage(1)
      await client.invalidateQueries({ queryKey: ['all-sg-rules'] })
      await client.invalidateQueries({ queryKey: ['cloud'] })
    },
  })
  const isEligible = (row: ScheduledRule) => {
    const project = names.data?.find((item) => item.id === row.project_id)
    const info = ruleInfo.data?.[row.project_id]
    const item = info?.items?.find((item) => item.rule_id === row.rule_id)
    const group = item?.rule?.security_group
    const groupId = typeof group === 'string' ? group : group?.id
    return (
      !names.isError &&
      !info?.error &&
      Boolean(
        project?.name &&
        project.name !== project.id &&
        item?.security_group_name &&
        item.security_group_name !== row.security_group_id &&
        item.rule?.id === row.rule_id &&
        groupId === row.security_group_id
      )
    )
  }
  const rows = inventory.data?.items ?? []
  const eligibleRows = rows.filter(isEligible)
  const selectedRows = eligibleRows.filter((row) => selected.includes(row.id))
  const pages = Math.max(1, Math.ceil((inventory.data?.total ?? 0) / pageSize))
  return (
    <CloudPageShell
      title='ALL SG Rule'
      description='Scheduled security group rules across all projects. Due rules appear first.'
      actions={
        <Button
          size='icon'
          variant='outline'
          aria-label='Refresh scheduled rules'
          disabled={inventory.isFetching || remove.isPending}
          onClick={() => {
            setSelected([])
            void client.invalidateQueries({ queryKey: ['all-sg-rules'] })
          }}
        >
          <RefreshCw className={inventory.isFetching ? 'animate-spin' : ''} />
        </Button>
      }
    >
      <div className='mb-3 flex flex-wrap gap-2 text-sm'>
        <Badge variant='outline'>Scheduled: {inventory.data?.total ?? 0}</Badge>
        <Badge variant='destructive'>Due: {inventory.data?.due ?? 0}</Badge>
        <Badge variant='secondary'>
          Upcoming: {inventory.data?.upcoming ?? 0}
        </Badge>
      </div>
      <Card className='min-h-0 flex-1 gap-0 overflow-hidden py-0'>
        <CardContent className='flex min-h-0 flex-1 flex-col gap-3 p-3'>
          <div className='flex flex-wrap items-center gap-2'>
            <SearchableSelectV2
              multiple
              values={projects}
              onValuesChange={(values) => {
                setProjects([...values].sort())
                setPage(1)
                setSelected([])
              }}
              onOpenChange={(open) => {
                setPickerOpen(open)
                if (open && projectOptions.isError)
                  void projectOptions.refetch()
              }}
              ariaLabel='Filter projects'
              allItemsLabel='All projects'
              placeholder='All projects'
              searchPlaceholder='Search project name...'
              className='w-60'
              items={(projectOptions.data?.items ?? []).map((item) => ({
                value: item.id,
                label:
                  names.data?.find((project) => project.id === item.id)
                    ?.display_name ||
                  names.data?.find((project) => project.id === item.id)?.name ||
                  '-',
              }))}
              isPending={projectOptions.isFetching && !projectOptions.data}
              emptyMessage={
                projectOptions.isError
                  ? 'Unable to load projects. Reopen to retry.'
                  : 'No matching project.'
              }
            />
            <div className='relative min-w-48 flex-1'>
              <Search className='absolute top-2.5 left-2.5 size-4 text-muted-foreground' />
              <Input
                aria-label='Search scheduled rules'
                placeholder='Search saved project, SG, rule ID or error...'
                className='pl-8'
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <select
              aria-label='Deletion schedule filter'
              className='h-9 rounded-md border bg-background px-3 text-sm'
              value={timing}
              onChange={(event) => {
                setTiming(event.target.value)
                setPage(1)
                setSelected([])
              }}
            >
              <option value='all'>All scheduled</option>
              <option value='due'>Due now</option>
              <option value='upcoming'>Upcoming</option>
            </select>
            <Button
              variant='destructive'
              disabled={remove.isPending || deleteDue.isPending}
              onClick={() => {
                setConfirmation('')
                setDueOpen(true)
              }}
            >
              <Trash2 />
              Delete all due rules
            </Button>
          </div>
          {(names.isError ||
            Object.values(ruleInfo.data ?? {}).some((info) => info.error)) && (
            <div
              role='alert'
              className='flex items-center justify-between gap-3 rounded-md border p-3 text-sm text-destructive'
            >
              Some project names or rule details could not be loaded.
              <Button
                variant='outline'
                size='sm'
                onClick={() =>
                  void client.invalidateQueries({ queryKey: ['all-sg-rules'] })
                }
              >
                Retry details
              </Button>
            </div>
          )}
          {inventory.isError ? (
            <div
              role='alert'
              className='rounded-md border p-4 text-destructive'
            >
              {errorText(inventory.error)}{' '}
              <Button
                variant='outline'
                onClick={() => void inventory.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <>
              <div className='min-h-0 flex-1 overflow-hidden rounded-md border [&>[data-slot=table-container]]:h-full [&>[data-slot=table-container]]:max-h-none'>
                <Table>
                  <TableHeader className='sticky top-0 z-10 bg-background'>
                    <TableRow>
                      <TableHead className='w-10'>
                        <Checkbox
                          aria-label='Select all rows'
                          checked={
                            eligibleRows.length > 0 &&
                            selectedRows.length === eligibleRows.length
                              ? true
                              : selectedRows.length > 0
                                ? 'indeterminate'
                                : false
                          }
                          disabled={
                            !eligibleRows.length ||
                            remove.isPending ||
                            deleteDue.isPending
                          }
                          onCheckedChange={(checked) =>
                            setSelected(
                              checked ? eligibleRows.map((row) => row.id) : []
                            )
                          }
                        />
                      </TableHead>
                      <TableHead className='w-10'>#</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Project</TableHead>
                      <TableHead>Security group</TableHead>
                      <TableHead>Direction</TableHead>
                      <TableHead>Protocol</TableHead>
                      <TableHead>Ports</TableHead>
                      <TableHead>Remote IP / CIDR</TableHead>
                      <TableHead>IP version</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Delete at</TableHead>
                      <TableHead>Created at</TableHead>
                      <TableHead>Last error</TableHead>
                      <TableHead className='w-20'>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inventory.isPending ? (
                      <TableRow>
                        <TableCell colSpan={15} className='h-32 text-center'>
                          <Loader2 className='mx-auto animate-spin' />
                          Loading scheduled rules...
                        </TableCell>
                      </TableRow>
                    ) : !rows.length ? (
                      <TableRow>
                        <TableCell
                          colSpan={15}
                          className='h-32 text-center text-muted-foreground'
                        >
                          No scheduled rules match these filters.
                        </TableCell>
                      </TableRow>
                    ) : (
                      rows.map((row, index) => (
                        <TableRow
                          key={row.id}
                          data-state={
                            selected.includes(row.id) ? 'selected' : undefined
                          }
                        >
                          <TableCell>
                            <Checkbox
                              aria-label={`Select rule ${row.rule_id}`}
                              checked={selected.includes(row.id)}
                              disabled={
                                remove.isPending ||
                                deleteDue.isPending ||
                                !isEligible(row)
                              }
                              onCheckedChange={(checked) =>
                                setSelected((current) =>
                                  checked
                                    ? [...current, row.id]
                                    : current.filter((id) => id !== row.id)
                                )
                              }
                            />
                          </TableCell>
                          <TableCell className='text-xs text-muted-foreground'>
                            {(page - 1) * pageSize + index + 1}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={row.is_due ? 'destructive' : 'secondary'}
                            >
                              {row.is_due ? 'Due' : 'Upcoming'}
                            </Badge>
                          </TableCell>
                          {(() => {
                            const project = names.data?.find(
                              (item) => item.id === row.project_id
                            )
                            const info = ruleInfo.data?.[row.project_id]
                            const item = info?.items?.find(
                              (item) => item.rule_id === row.rule_id
                            )
                            const rule = item?.rule
                            const fallback = '-'
                            const ports = rule
                              ? rule.port_range_min == null &&
                                rule.port_range_max == null
                                ? 'Any'
                                : rule.port_range_min === rule.port_range_max
                                  ? String(rule.port_range_min)
                                  : `${rule.port_range_min ?? 'Any'}–${rule.port_range_max ?? 'Any'}`
                              : fallback
                            return (
                              <>
                                <TableCell>
                                  <div
                                    className='max-w-60 truncate font-medium'
                                    title={
                                      project?.display_name || project?.name
                                    }
                                  >
                                    {project?.display_name ||
                                      project?.name ||
                                      (names.isPending ? 'Loading…' : '-')}
                                  </div>
                                  {project?.name &&
                                    project.name !== project.display_name && (
                                      <div
                                        className='max-w-60 truncate text-xs text-muted-foreground'
                                        title={project.name}
                                      >
                                        {project.name}
                                      </div>
                                    )}
                                </TableCell>
                                <TableCell title={info?.error}>
                                  {item?.security_group_name && item.security_group_name !== row.security_group_id ? item.security_group_name : fallback}
                                </TableCell>
                                <TableCell>
                                  {rule
                                    ? rule.direction === 'ingress'
                                      ? 'Inbound'
                                      : 'Outbound'
                                    : fallback}
                                </TableCell>
                                <TableCell className='uppercase'>
                                  {rule ? rule.protocol || 'Any' : fallback}
                                </TableCell>
                                <TableCell className='font-mono text-xs whitespace-nowrap'>
                                  {ports}
                                </TableCell>
                                <TableCell className='font-mono text-xs'>
                                  {rule
                                    ? rule.remote_ip_prefix || 'Any'
                                    : fallback}
                                </TableCell>
                                <TableCell>
                                  {rule ? rule.ethertype || '-' : fallback}
                                </TableCell>
                                <TableCell>
                                  <span
                                    className='block max-w-60 truncate'
                                    title={rule?.description || undefined}
                                  >
                                    {rule ? rule.description || '—' : fallback}
                                  </span>
                                </TableCell>
                              </>
                            )
                          })()}
                          <TableCell
                            className={
                              row.is_due
                                ? 'whitespace-nowrap text-destructive'
                                : 'whitespace-nowrap'
                            }
                          >
                            {dateText(row.delete_at)}
                          </TableCell>
                          <TableCell className='text-xs whitespace-nowrap'>
                            {dateText(row.rule_created_at)}
                          </TableCell>
                          <TableCell
                            className='max-w-60 truncate text-xs text-destructive'
                            title={row.last_error || ''}
                          >
                            {row.last_error || '—'}
                          </TableCell>
                          <TableCell>
                            <div className='flex gap-1'>
                              <Button
                                size='icon'
                                variant='ghost'
                                className='text-destructive'
                                aria-label={`Delete rule ${row.rule_id}`}
                                disabled={
                                  remove.isPending ||
                                  deleteDue.isPending ||
                                  !isEligible(row)
                                }
                                onClick={() => setConfirmItems([row])}
                              >
                                <Trash2 />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className='flex flex-wrap items-center justify-between gap-2 text-sm'>
                <span className='text-muted-foreground'>
                  {inventory.data?.total ?? 0} rule(s){' '}
                  {inventory.isFetching && (
                    <Loader2 className='inline size-3 animate-spin' />
                  )}
                </span>
                <div className='flex items-center gap-2'>
                  <select
                    aria-label='Rows per page'
                    className='h-8 rounded border bg-background px-2'
                    value={pageSize}
                    onChange={(event) => {
                      setPageSize(Number(event.target.value))
                      setPage(1)
                      setSelected([])
                    }}
                  >
                    {[50, 100, 200, 500].map((size) => (
                      <option key={size} value={size}>
                        {size} / page
                      </option>
                    ))}
                  </select>
                  <span>
                    Page {page} / {pages}
                  </span>
                  <Button
                    size='icon'
                    variant='outline'
                    aria-label='Previous page'
                    disabled={
                      page <= 1 || inventory.isFetching || remove.isPending
                    }
                    onClick={() => {
                      setPage(page - 1)
                      setSelected([])
                    }}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    size='icon'
                    variant='outline'
                    aria-label='Next page'
                    disabled={
                      page >= pages || inventory.isFetching || remove.isPending
                    }
                    onClick={() => {
                      setPage(page + 1)
                      setSelected([])
                    }}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      {selectedRows.length > 0 && (
        <div
          role='toolbar'
          aria-label='Selected rule actions'
          className='fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-xl border bg-background/95 p-2 shadow-xl'
        >
          <Badge variant='secondary'>{selectedRows.length} selected</Badge>
          <Button
            size='sm'
            variant='destructive'
            disabled={remove.isPending}
            onClick={() => setConfirmItems(selectedRows)}
          >
            <Trash2 />
            Delete selected
          </Button>
          <Button
            size='sm'
            variant='ghost'
            disabled={remove.isPending}
            onClick={() => setSelected([])}
          >
            Clear
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={dueOpen}
        onOpenChange={(open) => {
          if (!deleteDue.isPending) setDueOpen(open)
        }}
        title='Delete all due security group rules?'
        desc='Applies to every project and every page, regardless of the current filters. Only due rules with verified project and SG names and matching rule membership will be deleted.'
        destructive
        confirmText='Delete all due rules'
        isLoading={deleteDue.isPending}
        disabled={
          confirmation !== 'DELETE ALL DUE SG RULES' ||
          duePreview.isFetching ||
          duePreview.isError ||
          !duePreview.data?.eligible
        }
        handleConfirm={() => deleteDue.mutate()}
      >
        <p className='text-sm'>
          {duePreview.isFetching
            ? 'Verifying due rules?'
            : duePreview.isError
              ? errorText(duePreview.error)
              : `${duePreview.data?.eligible ?? 0} verified rule(s); ${duePreview.data?.skipped ?? 0} skipped.`}
        </p>
        {duePreview.isError && (
          <Button variant='outline' onClick={() => void duePreview.refetch()}>
            Retry verification
          </Button>
        )}
        <label htmlFor='confirm-delete-due' className='text-sm'>
          Type DELETE ALL DUE SG RULES to confirm
        </label>
        <Input
          id='confirm-delete-due'
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete='off'
          disabled={deleteDue.isPending}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmItems.length > 0}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setConfirmItems([])
        }}
        title={`Delete ${confirmItems.length} security group rule(s)?`}
        desc={`This removes the selected rules from their own cloud projects. ${confirmItems.filter((item) => !item.is_due).length} rule(s) have a future deletion date and will be deleted now. Failed deletions remain listed for retry.`}
        destructive
        confirmText='Delete rules'
        disabled={confirmItems.some((item) => !isEligible(item))}
        isLoading={remove.isPending}
        handleConfirm={() => remove.mutate(confirmItems)}
      />
    </CloudPageShell>
  )
}
