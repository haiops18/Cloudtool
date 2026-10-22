import { ServerDetailsDialog } from './server-details-dialog'
import { TeleportSshDialog } from './teleport-ssh-dialog'
import type { ServerRow } from './types'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ProjectSyncResult } from './inventory-project-sync'
import { getInventorySyncJob } from './inventory-sync-job'
import { InventorySyncResultsTable } from './inventory-sync-results-table'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import {
  ArrowRightLeft,
  Building2,
  Download,
  ChevronLeft,
  ChevronRight,
  Eye,
  ExternalLink,
  KeyRound,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  Terminal,
  ShieldCheck,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api-client'
import { downloadXlsx } from '@/lib/xlsx-export'
import { fetchInventoryPage, loadAllInventory } from './all-server-inventory-export'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { CloudDataTable } from '@/components/cloud-data-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SearchableSelectV2 } from '@/components/searchable-select-v2'
import { SortableHeader } from '@/components/sortable-header'
import { CloudPageShell } from './page-shell'
import { InventoryServerSecurityGroupsDialog } from './server-security-groups-dialog'
import { SwitchVmProjectDialog } from './switch-vm-project-dialog'
import { inventorySyncAge, inventorySyncElapsedDays } from './inventory-sync-age'

type ProjectOption = {
  id: string
  name: string
  display_name: string
  organization: string
  is_synced?: boolean
  last_synced_at?: string | null
}
type InventoryServer = {
  id: string
  server_id: string
  server_name: string
  project_id: string
  project_name: string
  project_display_name?: string
  power_state?: string
  zone?: string
  region?: string
  status?: string
  refreshed_at?: string
  private_ip?: string[]
  vip_ip?: string[]
  elastic_ip?: string[]
  elastic_vip_ip?: string[]
}
type Page<T> = { items: T[]; total: number; page: number; page_size: number }
type PasswordProfile = { id: string; name: string; username?: string }
type PasswordMode = 'profile' | 'manual' | 'random'
type PasswordResult = {
  server_id: string
  name: string
  status: string
  error?: string
  password?: string
}
const inventorySyncTimeFormat = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Bangkok',
})
const syncTimeText = (value?: string | null) => value ? inventorySyncTimeFormat.format(new Date(value)) : 'Never synced'
const syncElapsedDaysFormat = new Intl.NumberFormat('vi-VN', {minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false})
const PASSWORD_CHANGE_CONCURRENCY = 3
const INVENTORY_PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const

const passwordResultDetail = (value: unknown): string => {
  if (typeof value === 'string') {
    try {
      return passwordResultDetail(JSON.parse(value))
    } catch {
      return value
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.upstream_detail !== undefined)
      return passwordResultDetail(record.upstream_detail)
    if (record.detail !== undefined) return passwordResultDetail(record.detail)
    return JSON.stringify(record)
  }
  return value == null ? '—' : String(value)
}

const apiErrorMessage = (error: unknown): string => {
  const response = (
    error as {
      response?: { data?: { detail?: unknown; error?: { message?: unknown } } }
    }
  ).response?.data
  const detail = response?.detail
  if (typeof detail === 'string' && detail) return detail
  if (detail && typeof detail === 'object') {
    const item = detail as {
      upstream_detail?: unknown
      message?: unknown
      code?: unknown
    }
    for (const value of [item.upstream_detail, item.message, item.code])
      if (typeof value === 'string' && value) return value
  }
  if (Array.isArray(detail))
    return detail
      .map((item) =>
        typeof item === 'string'
          ? item
          : typeof item === 'object' && item
            ? String((item as { msg?: unknown }).msg ?? '')
            : ''
      )
      .filter(Boolean)
      .join('; ')
  const message = response?.error?.message
  if (typeof message === 'string' && message) return message
  return error instanceof Error ? error.message : 'The server console could not be opened.'
}

const validServerPassword = (value: string) =>
  value.length > 8 &&
  /[A-Z]/.test(value) &&
  /[a-z]/.test(value) &&
  /\d/.test(value) &&
  /[^A-Za-z0-9]/.test(value)

const randomServerPassword = (length = 12) => {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '_&!@#$%*-+=']
  const all = groups.join('')
  const pick = (source: string) => source[crypto.getRandomValues(new Uint32Array(1))[0] % source.length]
  const characters = groups.map(pick)
  while (characters.length < Math.max(9, length)) characters.push(pick(all))
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swap = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1)
    ;[characters[index], characters[swap]] = [characters[swap], characters[index]]
  }
  return characters.join('')
}

export function AllServersPage() {
  const queryClient = useQueryClient()
  const [syncOpen, setSyncOpen] = useState(false)
  const [searchProjects, setSearchProjects] = useState<ProjectOption[] | null>(null)
  const [loadingSearchProjects, setLoadingSearchProjects] = useState(false)
  const [confirmSyncClose, setConfirmSyncClose] = useState(false)
  const [projectsToConfirmSync, setProjectsToConfirmSync] = useState<ProjectOption[]>([])
  const [concurrency, setConcurrency] = useState(5)
  const syncJob = useMemo(() => getInventorySyncJob(queryClient), [queryClient])
  const { running: syncing, hasResults: hasSyncResults, projectCount: syncProjectCount } = useSyncExternalStore(syncJob.subscribe, syncJob.getSnapshot)
  const syncResults = syncJob.results
  useEffect(() => () => syncJob.setVisible(false), [syncJob])
  const clearSyncResults = () => {
    syncJob.clear()
    setSearchProjects(null)
  }
  const closeSyncModal = () => {
    setSyncOpen(false)
    syncJob.setVisible(false)
    setSearchProjects(null)
  }
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<(typeof INVENTORY_PAGE_SIZE_OPTIONS)[number]>(50)
  const [pageInput, setPageInput] = useState('')
  const [query, setQuery] = useState('')
  const [q, setQ] = useState('')
  const [filters, setFilters] = useState({
    server_name: '',
    project_name: '',
    private_ip: '',
    elastic_ip: '',
    zone: '',
    power_state: '',
  })
  const [apiFilters, setApiFilters] = useState(filters)
  const [ipMatch, setIpMatch] = useState<'contains' | 'exact'>('contains')
  const [batchFields, setBatchFields] = useState('server_name')
  const [batchValues, setBatchValues] = useState('')
  const [sqlQuery, setSqlQuery] = useState(
    "SELECT * FROM all_server_inventory_snapshots WHERE power_state = 'running' ORDER BY server_name ASC"
  )
  const [appliedAdvanced, setAppliedAdvanced] = useState({
    batchFields: '',
    batchValues: '',
    ipMatch: 'contains' as 'contains' | 'exact',
    sqlQuery: '',
  })
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedTab, setAdvancedTab] = useState<'batch' | 'sql'>('batch')
  const [detailRow, setDetailRow] = useState<InventoryServer | null>(null)
  const [securityGroupsRow, setSecurityGroupsRow] = useState<InventoryServer | null>(null)
  const [switchProjectRow, setSwitchProjectRow] = useState<InventoryServer | null>(null)
  const [teleportServer, setTeleportServer] = useState<ServerRow>()
  const [teleportProjectId, setTeleportProjectId] = useState('')
  const [passwordRows, setPasswordRows] = useState<InventoryServer[]>([])
  const [passwordMode, setPasswordMode] = useState<PasswordMode>('profile')
  const [profileId, setProfileId] = useState('')
  const [manualPassword, setManualPassword] = useState('')
  const [randomPasswords, setRandomPasswords] = useState<Record<string, string>>({})
  const [showPassword, setShowPassword] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordResults, setPasswordResults] = useState<PasswordResult[]>([])
  const [sortBy, setSortBy] = useState('refreshed_at')
  const [sortDesc, setSortDesc] = useState(true)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [refreshingRows, setRefreshingRows] = useState(false)
  const [searchNonce, setSearchNonce] = useState(0)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([])
  const [appliedProjectIds, setAppliedProjectIds] = useState<string[]>([])
  const projectOptions = useQuery({
    queryKey: ['cloud', 'all-server-inventory', 'project-options'],
    enabled: projectPickerOpen,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async ({ signal }) => (await apiClient.get<Page<ProjectOption>>('/cloud/all-server-inventory/project-options', {signal})).data,
  })

  const projects = useQuery({
    queryKey: ['cloud', 'all-server-inventory', 'projects'],
    enabled: syncOpen && searchProjects === null && !hasSyncResults,
    gcTime: 0,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Page<ProjectOption>>(
          '/cloud/all-server-inventory/projects',
          { params: { page_size: 500 }, timeout: 90_000, signal }
        )
      ).data,
  })
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')
  const inventorySearchParams = {
    project_ids: appliedProjectIds.length
      ? appliedProjectIds.join(',')
      : undefined,
    sort_by: sortBy,
    sort_desc: sortDesc,
    ...(appliedAdvanced.sqlQuery
      ? { sql_query: appliedAdvanced.sqlQuery }
      : {
          q: q || undefined,
          ...Object.fromEntries(
            Object.entries(apiFilters).filter(([, value]) => value)
          ),
          ip_match: appliedAdvanced.ipMatch,
          batch_fields: appliedAdvanced.batchFields || undefined,
          batch_values: appliedAdvanced.batchValues || undefined,
        }),
  }
  const exportAllMatches = async () => {
    if (exporting) return
    setExporting(true)
    setExportProgress('Loading matching servers...')
    try {
      const rows = await loadAllInventory<InventoryServer>(
        inventorySearchParams,
        (loaded, total) =>
          setExportProgress(
            `Exporting ${loaded.toLocaleString()}/${total.toLocaleString()} servers`
          )
      )
      const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))]
      if (!rows.length) {
        toast.info('No matching servers to export.')
        return
      }
      downloadXlsx(
        headers,
        rows.map((row) =>
          headers.map((key) => (row as Record<string, unknown>)[key])
        ),
        'all-servers-search-results'
      )
      toast.success(
        `Exported ${rows.length.toLocaleString()} matching server(s).`
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not export matching servers.'
      )
    } finally {
      setExporting(false)
      setExportProgress('')
    }
  }
  const openSearchProjectRefresh = async () => {
    if (loadingSearchProjects || syncing) return
    setLoadingSearchProjects(true)
    try {
      const unique = new Map<string, ProjectOption>()
      let loaded = 0
      let total = 0
      let page = 1
      do {
        const data = await fetchInventoryPage<InventoryServer>({ ...inventorySearchParams, page, page_size: 500 })
        total = data.total
        if (!data.items.length && loaded < total) throw new Error('Inventory changed. Run the search again and retry.')
        for (const row of data.items) {
          if (row.project_id) unique.set(row.project_id, {
            id: row.project_id, name: row.project_name || row.project_id,
            display_name: row.project_display_name || row.project_name || row.project_id,
            organization: '', is_synced: true,
          })
        }
        loaded += data.items.length
        page++
      } while (loaded < total)
      const targets = [...unique.values()]
      if (!targets.length) { toast.info('No matching projects to refresh.'); return }
      setProjectsToConfirmSync(targets)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load matching projects.')
    } finally {
      setLoadingSearchProjects(false)
    }
  }
  const inventoryQueryKey = [
    'cloud',
    'all-server-inventory',
    page,
    pageSize,
    q,
    apiFilters,
    appliedProjectIds,
    appliedAdvanced,
    sortBy,
    sortDesc,
    searchNonce,
    inventorySearchParams,
  ] as const
  const inventory = useQuery({
    gcTime: 0,
    queryKey: inventoryQueryKey,
    queryFn: async ({ signal }) => {
      try {
        return await fetchInventoryPage<InventoryServer>(
          {
            ...inventorySearchParams,
            page,
            page_size: pageSize,
          },
          signal
        )
      } catch (error) {
        if (signal.aborted) throw error
        const response = (
          error as {
            response?: {
              data?: { detail?: unknown; error?: { message?: string } }
            }
          }
        ).response?.data
        const message =
          typeof response?.detail === 'string'
            ? response.detail
            : response?.error?.message ||
              (error instanceof Error ? error.message : 'Search failed')
        toast.error(String(message))
        throw error
      }
    },
  })
  const passwordProfiles = useQuery({
    queryKey: ['password-profiles'],
    enabled: passwordRows.length > 0,
    queryFn: async ({ signal }) =>
      (await apiClient.get<PasswordProfile[]>('/password-profiles', { signal })).data,
  })
  const projectColumns = useMemo<ColumnDef<ProjectOption>[]>(
    () => [
      {
        id: 'row_number',
        header: '#',
        cell: ({ row, table }) => table.getSortedRowModel().rows.findIndex(item => item.id === row.id) + 1,
        enableSorting: false,
        enableHiding: false,
        meta: { className: 'w-8 max-w-8 px-1 text-center text-xs tabular-nums' },
      },
      {
        accessorKey: 'id',
        header: ({ column }) => <SortableHeader column={column} title='Project ID' />,
        cell: ({ row }) => <span className='block w-40 truncate font-mono text-xs' title={row.original.id}>{row.original.id}</span>,
        meta: { className: 'w-44 min-w-44 max-w-44 pr-6 border-r' },
      },
      {
        accessorKey: 'display_name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Project' />
        ),
        cell: ({ row }) => (
          <div>
            <p className='font-medium'>{row.original.display_name}</p>
            <p className='text-xs text-muted-foreground'>{row.original.name}</p>
          </div>
        ),
      },
      {
        accessorKey: 'is_synced',
        header: ({ column }) => <SortableHeader column={column} title='DB sync status' />,
        cell: ({ row }) => (
          <Badge variant='outline' className={row.original.is_synced
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'}>
            {row.original.is_synced ? 'Synced' : 'Not synced'}
          </Badge>
        ),
      },
      {
        accessorKey: 'last_synced_at',
        header: ({ column }) => <SortableHeader column={column} title='Last sync (GMT+7)' />,
        cell: ({ row }) => <span className='whitespace-nowrap text-xs tabular-nums'>{syncTimeText(row.original.last_synced_at)}</span>,
      },
      {
        id: 'days_since_sync',
        header: ({ column }) => <SortableHeader column={column} title='Days since sync' />,
        accessorFn: (project) => inventorySyncAge(project.last_synced_at)?.days ?? null,
        cell: ({ row }) => {
          const age = inventorySyncAge(row.original.last_synced_at)
          if (!age) return <span className='text-muted-foreground'>&mdash;</span>
          return <Badge variant='outline' className={age.tone === 'stale'
            ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400'
            : age.tone === 'old'
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'}>
            {age.days}
          </Badge>
        },
      },
      {
        accessorKey: 'organization',
        header: ({ column }) => (
          <SortableHeader column={column} title='Organization / access' />
        ),
      },
    ],
    []
  )
  const syncResultColumns = useMemo<ColumnDef<ProjectSyncResult>[]>(() => [
    ...(projectColumns as ColumnDef<ProjectSyncResult>[]),
    { accessorKey: 'servers', header: 'Servers' },
    { accessorKey: 'status', header: 'Status' },
    { accessorKey: 'error', header: 'Detail' },
  ], [projectColumns])
  const syncProjects = (selected: ProjectOption[]) => {
    syncJob.setVisible(true)
    setSelectedIds(new Set())
    void syncJob.start(selected, concurrency)
  }
  const toggleSort = (column: string) => {
    if (sortBy === column) setSortDesc((value) => !value)
    else {
      setSortBy(column)
      setSortDesc(false)
    }
    setPage(1)
  }
  const goToPage = () => {
    const target = Number(pageInput)
    if (!Number.isInteger(target) || target < 1 || target > pages) {
      toast.error(`Enter a page number from 1 to ${pages}.`)
      return
    }
    setPage(target)
    setPageInput('')
  }
  const runSearch = () => {
    // Stop the previous read immediately; searching never waits for the table.
    void queryClient.cancelQueries({ queryKey: inventoryQueryKey, exact: true })
    setQ(query)
    setApiFilters(filters)
    setAppliedAdvanced(
      advancedOpen
        ? {
            batchFields: advancedTab === 'batch' ? batchFields : '',
            batchValues: advancedTab === 'batch' ? batchValues : '',
            ipMatch: advancedTab === 'batch' ? ipMatch : 'contains',
            sqlQuery: advancedTab === 'sql' ? sqlQuery : '',
          }
        : {
            batchFields: '',
            batchValues: '',
            ipMatch: 'contains',
            sqlQuery: '',
          }
    )
    setPage(1)
    setSearchNonce((value) => value + 1)
  }
  const rows = inventory.data?.items ?? [],
    total = inventory.data?.total ?? 0,
    pages = Math.max(1, Math.ceil(total / pageSize))
  const selectedRows = rows.filter((row) => selectedIds.has(row.id))
  const toggleRow = (id: string, checked: boolean) =>
    setSelectedIds((current) => {
      const next = new Set(current)
      checked ? next.add(id) : next.delete(id)
      return next
    })
  const refreshServers = async (targets: InventoryServer[]) => {
    if (!targets.length) return
    setRefreshingRows(true)
    try {
      await apiClient.post(
        '/cloud/all-server-inventory/refresh-servers',
        {
          items: targets.map((row) => ({
            project_id: row.project_id,
            server_id: row.server_id,
          })),
        },
        { timeout: 180_000 }
      )
      setSelectedIds(new Set())
      await queryClient.invalidateQueries({
        queryKey: ['cloud', 'all-server-inventory'],
      })
    } finally {
      setRefreshingRows(false)
    }
  }
  const refreshProjects = (targets: InventoryServer[]) => {
    const projectsToSync = Array.from(
      new Map(
        targets.map((row) => [
          row.project_id,
          {
            id: row.project_id,
            name: row.project_name,
            display_name: row.project_display_name || row.project_name,
            organization: '',
          },
        ])
      ).values()
    )
    if (!projectsToSync.length) return
    setProjectsToConfirmSync(projectsToSync)
  }
  const openConsole = async (row: InventoryServer) => {
    try {
      const { data } = await apiClient.post<{ url: string }>(
        `/cloud/all-server-inventory/servers/${row.project_id}/${row.server_id}/console`
      )
      window.open(data.url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      toast.error(apiErrorMessage(error))
    }
  }
  const openPasswordDialog = (rows: InventoryServer[]) => {
    if (!rows.length) return
    setPasswordRows(rows)
    setPasswordMode('profile')
    setProfileId('')
    setManualPassword('')
    setRandomPasswords({})
    setShowPassword(false)
    setPasswordResults([])
  }
  const changePassword = async () => {
    const targets = [...passwordRows]
    if (!targets.length) return
    setChangingPassword(true)
    const results = new Map<string, PasswordResult>()
    const updateResult = (row: InventoryServer, result: PasswordResult) => {
      results.set(row.id, result)
      setPasswordResults(
        targets.map(
          (target) =>
            results.get(target.id) ?? {
              server_id: target.server_id,
              name: target.server_name,
              status: 'queued',
            }
        )
      )
    }
    targets.forEach((row) =>
      results.set(row.id, {
        server_id: row.server_id,
        name: row.server_name,
        status: 'queued',
      })
    )
    setPasswordResults(targets.map((row) => results.get(row.id)!))
    let nextTarget = 0
    const worker = async () => {
      while (nextTarget < targets.length) {
        const row = targets[nextTarget++]
        const password =
          passwordMode === 'random' ? randomPasswords[row.id] : manualPassword
        updateResult(row, {
          server_id: row.server_id,
          name: row.server_name,
          status: 'processing',
          ...(passwordMode === 'random' ? { password } : {}),
        })
        try {
          const { data } = await apiClient.post<{
            items?: Array<{ status?: string; error?: string }>
          }>(
            `/cloud/all-server-inventory/servers/${row.project_id}/${row.server_id}/change-password`,
            {
              server_ids: [row.server_id],
              ...(passwordMode === 'profile' ? { profile_id: profileId } : { password }),
            },
            { timeout: 45_000 }
          )
          const outcome = data.items?.[0]
          updateResult(row, {
            server_id: row.server_id,
            name: row.server_name,
            status: outcome?.status ?? 'completed',
            error: outcome?.error,
            ...(passwordMode === 'random' ? { password } : {}),
          })
        } catch (error) {
          updateResult(row, {
            server_id: row.server_id,
            name: row.server_name,
            status: 'failed',
            error: apiErrorMessage(error),
            ...(passwordMode === 'random' ? { password } : {}),
          })
        }
      }
    }
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(PASSWORD_CHANGE_CONCURRENCY, targets.length) },
          () => worker()
        )
      )
      const failed = Array.from(results.values()).filter(
        (result) => result.status === 'failed'
      ).length
      toast[failed ? 'warning' : 'success'](
        failed
          ? `Password changes finished: ${targets.length - failed} succeeded, ${failed} failed.`
          : `Password changes submitted for ${targets.length} server(s).`
      )
    } finally {
      setChangingPassword(false)
    }
  }
  const passwordReady =
    passwordMode === 'profile'
      ? Boolean(profileId)
      : passwordMode === 'manual'
        ? validServerPassword(manualPassword)
        : passwordRows.length > 0 &&
          passwordRows.every((row) => validServerPassword(randomPasswords[row.id] ?? ''))
  const metrics = [
    ['Projects synced', '—', Building2],
    ['Servers', total || '—', Server],
    ['Running', '—', Server],
    ['Last loaded', '—', RefreshCw],
  ]
  return (
    <CloudPageShell
      title='All servers'
      description='Organization-wide virtual machine inventory across every cloud project you can access.'
      actions={
        <>
          <Button
            size='icon'
            variant='outline'
            title={exportProgress || 'Export all matching servers from DB'}
            aria-label='Export all matching servers'
            disabled={
              exporting || inventory.isFetching || !inventory.data?.total
            }
            onClick={() => void exportAllMatches()}
          >
            {exporting ? <Loader2 className='animate-spin' /> : <Download />}
          </Button>
          <Button
            size='icon'
            variant='outline'
            title='Refresh projects in search results'
            aria-label='Refresh projects in search results'
            disabled={loadingSearchProjects || syncing || inventory.isFetching || !inventory.data?.total}
            onClick={() => void openSearchProjectRefresh()}
          >
            {loadingSearchProjects ? <Loader2 className='animate-spin' /> : <Building2 />}
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={loadingSearchProjects}
            onClick={() => {
              if (!syncing) {
                clearSyncResults()
              }
              syncJob.setVisible(true)
              setSyncOpen(true)
            }}
          >
            <RefreshCw /> Refresh inventory
          </Button>
        </>
      }
      tableHelp
      help={
        <p className='text-muted-foreground'>
          Select accessible projects, synchronize server lists, then use
          API-side search and sorting against stored inventory.
        </p>
      }
    >
      <div className='flex flex-wrap items-center gap-2'>
        {metrics.map(([label, value, Icon]) => {
          const MetricIcon = Icon as typeof Server
          return (
            <div
              key={label as string}
              className='flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5'
            >
              <MetricIcon className='size-3.5 text-muted-foreground' />
              <span className='text-xs text-muted-foreground'>
                {label as string}
              </span>
              <span className='text-sm font-semibold'>
                {value as string | number}
              </span>
            </div>
          )
        })}
      </div>
      <Card className='mt-3 min-h-0 flex-1'>
        <CardContent className='flex min-h-0 flex-1 flex-col p-4'>
          {advancedOpen ? (
            <div className='mb-3 max-h-[62vh] min-h-52 resize-y overflow-auto rounded-md border bg-muted/20 p-3'>
              <Tabs
                value={advancedTab}
                onValueChange={(value) =>
                  setAdvancedTab(value as 'batch' | 'sql')
                }
              >
                <div className='flex items-center justify-between gap-2'>
                  <TabsList className='h-8 w-fit'>
                    <TabsTrigger className='px-3' value='batch'>
                      Batch columns
                    </TabsTrigger>
                    <TabsTrigger className='px-3' value='sql'>
                      Safe SQL
                    </TabsTrigger>
                  </TabsList>
                  <div className='flex items-center gap-1'>
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={() => setAdvancedOpen(false)}
                    >
                      <X />
                      Close
                    </Button>
                    <Button
                      size='sm'
                      onClick={runSearch}
                    >
                      <Search />
                      Run search
                    </Button>
                  </div>
                </div>
                <TabsContent value='batch' className='space-y-3'>
                  <div className='flex flex-col gap-2 sm:flex-row'>
                    <select
                      className='h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm'
                      value={batchFields}
                      onChange={(event) => setBatchFields(event.target.value)}
                    >
                      <option value='server_name'>Server name</option>
                      <option value='server_id'>Server ID</option>
                      <option value='project_name'>Project name</option>
                      <option value='zone_name'>Zone name</option>
                      <option value='power_state'>Power state</option>
                      <option value='private_ip'>Private IP</option>
                      <option value='vip_ip'>VIP IP</option>
                      <option value='elastic_ip'>Elastic IP</option>
                      <option value='elastic_vip_ip'>Elastic VIP IP</option>
                    </select>
                    {['private_ip', 'vip_ip', 'elastic_ip', 'elastic_vip_ip'].includes(
                      batchFields
                    ) && (
                      <select
                        className='h-9 shrink-0 rounded-md border bg-background px-3 text-sm'
                        value={ipMatch}
                        onChange={(event) =>
                          setIpMatch(event.target.value as 'contains' | 'exact')
                        }
                        aria-label='IP batch search mode'
                      >
                        <option value='contains'>IP contains</option>
                        <option value='exact'>IP exact</option>
                      </select>
                    )}
                  </div>
                  <Textarea
                    className='min-h-52 resize-y bg-background font-mono text-xs'
                    value={batchValues}
                    onChange={(event) => setBatchValues(event.target.value)}
                    placeholder={'One value per line\napp-01\napp-02'}
                  />
                </TabsContent>
                <TabsContent value='sql' className='space-y-3'>
                  <div className='rounded-md border bg-background p-3 text-xs text-muted-foreground'>
                    <p>
                      Only <code>SELECT *</code> from{' '}
                      <code>all_server_inventory_snapshots</code> is accepted.
                      Other statements, tables, JOIN, subquery and multiple
                      statements are blocked.
                    </p>
                    <p className='mt-2'>
                      Search/order columns: server_id, server_name, project_id,
                      project_name, project_display_name, zone, zone_name,
                      region, power_state, status, server_type, bandwidth,
                      flavor_name, image_name, enable_ipv4, enable_elastic_ip,
                      cloud_created_at, cloud_updated_at, elastic_vip_ip, refreshed_at,
                      inventory_status.
                    </p>
                  </div>
                  <Textarea
                    className='min-h-52 resize-y bg-background font-mono text-xs'
                    value={sqlQuery}
                    onChange={(event) => setSqlQuery(event.target.value)}
                  />
                </TabsContent>
              </Tabs>
            </div>
          ) : (
            <div className='mb-3 grid gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-[minmax(130px,1fr)_minmax(160px,1.3fr)_repeat(4,minmax(0,0.7fr))_64px_88px_auto]'>
              <SearchableSelectV2
                multiple
                values={selectedProjectIds}
                onValuesChange={setSelectedProjectIds}
                ariaLabel='Filter projects'
                contentClassName='w-[480px] max-w-[calc(100vw_-_2rem)]'
                listClassName='max-h-[min(440px,60vh,calc(var(--radix-popover-content-available-height)_-_7rem))]'
                allItemsLabel='All projects'
                placeholder='All projects'
                searchPlaceholder='Search project name, display name or ID...'
                items={(projectOptions.data?.items ?? []).map((project) => ({
                  value: project.id,
                  label: project.display_name || project.name || project.id,
                  description: project.display_name && project.name !== project.display_name
                    ? project.name
                    : undefined,
                  keywords: [project.name, project.display_name, project.id],
                }))}
                isPending={projectOptions.isFetching && !projectOptions.data}
                emptyMessage={projectOptions.isError ? 'Unable to load projects. Reopen to retry.' : 'No matching project.'}
                onOpenChange={(open) => {
                  setProjectPickerOpen(open)
                  if (!open) {
                    const selected = [...selectedProjectIds].sort()
                    if (selected.join(',') !== appliedProjectIds.join(',')) {
                      setAppliedProjectIds(selected)
                      setPage(1)
                      setPageInput('')
                      setSelectedIds(new Set())
                    }
                  }
                }}
              />
              <div className='relative'>
                <Search className='absolute top-2.5 left-2.5 size-4 text-primary' />
                <Input
                  className='border-primary/50 bg-primary/5 pl-8 font-medium'
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') runSearch()
                  }}
                  placeholder='Search all columns'
                />
              </div>
              {(
                [
                  ['project_name', 'Project name'],
                  ['server_name', 'Server name'],
                  ['private_ip', 'Private IP'],
                  ['elastic_ip', 'Elastic IP'],
                  ['zone', 'Zone'],
                  ['power_state', 'Power state'],
                ] as const
              ).map(([key, label]) => (
                <Input
                  key={key}
                  className={`h-9 min-w-0 px-2 text-xs ${key === 'zone' ? 'max-w-16' : key === 'power_state' ? 'max-w-22' : ''}`}
                  title={label}
                  value={filters[key]}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') runSearch()
                  }}
                  placeholder={label}
                />
              ))}
              <div className='flex gap-2'>
                <Button
                  size='icon'
                  variant='outline'
                  title='Advanced search'
                  aria-label='Advanced search'
                  onClick={() => setAdvancedOpen(true)}
                >
                  <SlidersHorizontal />
                </Button>
                <Button
                  size='icon'
                  title='Run search'
                  aria-label='Run search'
                  onClick={runSearch}
                >
                  <Search />
                </Button>
              </div>
            </div>
          )}
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
                  onClick={() => setSelectedIds(new Set())}
                  aria-label='Clear selection'
                >
                  <X />
                </Button>
                <Separator orientation='vertical' className='h-5' />
                <Badge className='min-w-8 rounded-lg'>
                  {selectedRows.length}
                </Badge>
                <Separator orientation='vertical' className='h-5' />
                <Button
                  size='sm'
                  variant='outline'
                  disabled={refreshingRows || syncing}
                  onClick={() => openPasswordDialog(selectedRows)}
                >
                  <KeyRound />
                  Change password
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={refreshingRows}
                  onClick={() => void refreshServers(selectedRows)}
                >
                  {refreshingRows ? (
                    <Loader2 className='animate-spin' />
                  ) : (
                    <RefreshCw />
                  )}
                  Refresh VM
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={refreshingRows || syncing}
                  onClick={() => void refreshProjects(selectedRows)}
                >
                  <RefreshCw />
                  Refresh project
                  {new Set(selectedRows.map((row) => row.project_id)).size > 1
                    ? 's'
                    : ''}
                </Button>
              </div>
            </div>
          )}
          <div aria-busy={inventory.isFetching} className='min-h-0 flex-1 overflow-hidden rounded-md border [&>[data-slot=table-container]]:h-full [&>[data-slot=table-container]]:max-h-none'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className='w-9 px-1'>
                    <Checkbox
                      checked={
                        rows.length > 0 &&
                        rows.every((row) => selectedIds.has(row.id))
                      }
                      onCheckedChange={(checked) =>
                        setSelectedIds(
                          checked === true
                            ? new Set(rows.map((row) => row.id))
                            : new Set()
                        )
                      }
                    />
                  </TableHead>
                  <TableHead className='w-6 px-0 text-center'>#</TableHead>
                  {[['server_name', 'Server']].map(([key, label]) => (
                    <TableHead key={key}>
                      <Button
                        variant='ghost'
                        className='h-7 px-1 text-xs'
                        onClick={() => toggleSort(key)}
                      >
                        {label}
                        {sortBy === key ? (sortDesc ? ' ↓' : ' ↑') : ''}
                      </Button>
                    </TableHead>
                  ))}
                  <TableHead>Private IPs</TableHead>
                  <TableHead>VIP IPs</TableHead>
                  <TableHead>Elastic IPs</TableHead>
                  <TableHead>Elastic VIP IPs</TableHead>
                  {[
                    ['project_name', 'Project'],
                    ['zone', 'Zone'],
                    ['power_state', 'Power state'],
                    ['refreshed_at', 'Last sync'],
                  ].map(([key, label]) => (
                    <TableHead key={key}>
                      <Button
                        variant='ghost'
                        className='h-7 px-1 text-xs'
                        onClick={() => toggleSort(key)}
                      >
                        {label}
                        {sortBy === key ? (sortDesc ? ' ↓' : ' ↑') : ''}
                      </Button>
                    </TableHead>
                  ))}
                  <TableHead className='w-16 max-w-16 px-2 text-center text-xs'>Days</TableHead>
                  <TableHead className='w-10' />
                </TableRow>
              </TableHeader>
              <TableBody>
                {inventory.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={13} className='h-32 text-center'>
                      <Loader2 className='mr-2 inline animate-spin' />
                      Loading inventory…
                    </TableCell>
                  </TableRow>
                ) : rows.length ? (
                  rows.map((row, index) => (
                    <TableRow
                      key={row.id}
                      data-state={
                        selectedIds.has(row.id) ? 'selected' : undefined
                      }
                    >
                      <TableCell className='px-1'>
                        <Checkbox
                          checked={selectedIds.has(row.id)}
                          onCheckedChange={(checked) =>
                            toggleRow(row.id, checked === true)
                          }
                        />
                      </TableCell>
                      <TableCell className='w-6 px-0 text-center font-mono text-xs text-muted-foreground'>
                        {(page - 1) * pageSize + index + 1}
                      </TableCell>
                      <TableCell>
                        <p className='font-medium'>{row.server_name}</p>
                        <p className='font-mono text-xs text-muted-foreground'>
                          {row.server_id}
                        </p>
                      </TableCell>
                      <TableCell className='font-mono text-xs'>
                        {row.private_ip?.length
                          ? row.private_ip.map((ip, index) => (
                              <div key={index}>{ip}</div>
                            ))
                          : '—'}
                      </TableCell>
                      <TableCell className='font-mono text-xs'>
                        {row.vip_ip?.length
                          ? row.vip_ip.map((vip, index) => (
                              <div key={index}>{vip}</div>
                            ))
                          : '—'}
                      </TableCell>
                      <TableCell className='font-mono text-xs'>
                        {row.elastic_ip?.length
                          ? row.elastic_ip.map((ip, index) => (
                              <div key={index}>{ip}</div>
                            ))
                          : '—'}
                      </TableCell>
                      <TableCell className='font-mono text-xs'>
                        {row.elastic_vip_ip?.length
                          ? row.elastic_vip_ip.map(ip => <div key={ip}>{ip}</div>)
                          : <span className='text-muted-foreground'>&mdash;</span>}
                      </TableCell>
                      <TableCell>
                        <p>
                          {row.project_display_name || row.project_name || '—'}
                        </p>
                        <p className='text-xs text-muted-foreground'>
                          {row.project_name || '—'}
                        </p>
                      </TableCell>
                      <TableCell>{row.zone || '—'}</TableCell>
                      <TableCell
                        className={
                          row.power_state?.toLowerCase() === 'running'
                            ? 'font-medium text-emerald-600 dark:text-emerald-400'
                            : ''
                        }
                      >
                        {row.power_state || row.status || '—'}
                      </TableCell>
                      <TableCell>
                        {row.refreshed_at
                          ? new Date(row.refreshed_at).toLocaleString()
                          : '—'}
                      </TableCell>
                      <TableCell className='w-16 max-w-16 px-2 text-center text-xs tabular-nums'>
                        {(() => {
                          const days = inventorySyncElapsedDays(row.refreshed_at)
                          const age = inventorySyncAge(row.refreshed_at)
                          if (days == null || !age) return <span className='text-muted-foreground'>&mdash;</span>
                          return <span className={age.tone === 'stale'
                            ? 'font-medium text-red-600 dark:text-red-400'
                            : age.tone === 'old'
                              ? 'font-medium text-amber-600 dark:text-amber-400'
                              : 'text-muted-foreground'}>{syncElapsedDaysFormat.format(days)}</span>
                        })()}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size='icon' variant='ghost'>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align='end'>
                            <DropdownMenuItem
                              onClick={() => setDetailRow(row)}
                            >
                              <Eye />
                              View details
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setSecurityGroupsRow(row)}
                            >
                              <ShieldCheck /> View security groups
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => void refreshServers([row])}
                            >
                              <RefreshCw />
                              Refresh VM
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => void refreshProjects([row])}
                            >
                              <Building2 />
                              Refresh project
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => setSwitchProjectRow(row)}
                              disabled={!row.project_id}
                            >
                              <ArrowRightLeft /> Switch to VM project
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => openPasswordDialog([row])}
                            >
                              <KeyRound />
                              Change password
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => void openConsole(row)}
                            >
                              <ExternalLink />
                              Open console
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setTeleportProjectId(row.project_id)
                                setTeleportServer({
                                  id: row.server_id,
                                  name: row.server_name,
                                  server_type: 'vm',
                                  private_ip: (row.private_ip ?? []).map(ip => ({ id: ip, ip_address: ip })),
                                  elastic_ip: (row.elastic_ip ?? []).map(ip => ({ id: ip, ip_address: ip })),
                                })
                              }}
                            >
                              <Terminal /> Open in Teleport
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={13}
                      className='h-32 text-center text-muted-foreground'
                    >
                      No inventory data yet. Use Refresh inventory to select
                      projects and sync servers.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className='mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground'>
            <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums sm:text-sm'>
              <label className='flex items-center gap-2'>
                <span>Rows per page</span>
                <select
                  aria-label='Rows per page'
                  className='h-8 rounded-sm border bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
                  value={pageSize}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value) as typeof pageSize)
                    setPage(1)
                    setPageInput('')
                  }}
                >
                  {INVENTORY_PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
              </label>
              <span className='hidden h-4 w-px bg-border sm:block' />
              Showing{' '}
              <span className='font-medium text-foreground'>
                {total ? ((page - 1) * pageSize + 1).toLocaleString() : 0}–
                {Math.min(page * pageSize, total).toLocaleString()}
              </span>{' '}
              of <span className='font-medium text-foreground'>{total.toLocaleString()}</span> servers
            </div>
            <div className='flex items-center gap-1.5 text-xs tabular-nums'>
              <Button
                size='icon'
                variant='ghost'
                className='size-8'
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeft />
              </Button>
              <span>Page</span>
              <Input
                className='h-8 w-12 rounded-sm px-1 text-center text-xs'
                type='number'
                min={1}
                max={pages}
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') goToPage()
                }}
                onBlur={() => pageInput && goToPage()}
                placeholder={String(page)}
                aria-label={`Go to page, from 1 to ${pages}`}
              />
              <span>of {pages}</span>
              <Button
                size='icon'
                variant='ghost'
                className='size-8'
                disabled={page >= pages}
                onClick={() => setPage((value) => value + 1)}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <Dialog
        open={syncOpen}
        onOpenChange={(next) => {
          if (!next) setConfirmSyncClose(true)
          else { syncJob.setVisible(true); setSyncOpen(true) }
        }}
      >
        <DialogContent showCloseButton={false} className='flex h-[86svh] !w-[92vw] !max-w-[92vw] flex-col'>
          <div className='flex shrink-0 flex-wrap items-start justify-between gap-4 border-b pb-4'>
            <DialogHeader className='min-w-0 flex-1 basis-64 text-left'>
              <DialogTitle>Refresh organization inventory</DialogTitle>
              <DialogDescription>
                {hasSyncResults
                  ? `${syncProjectCount} selected project(s). Sync refreshes the full VM inventory of each project.`
                  : 'Direct and organization projects are de-duplicated by project ID. Unsynced projects appear first. Select projects to synchronize their VM list.'}
              </DialogDescription>
            </DialogHeader>
            <div className='ml-auto flex shrink-0 items-center gap-3'>
              <div className='flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2'>
                <label htmlFor='inventory-project-concurrency' className='max-w-32 text-xs font-medium text-muted-foreground'>Parallel project workflows</label>
                <Input id='inventory-project-concurrency' className='h-8 w-16' type='number' min={1} max={20}
                  disabled={syncing} value={concurrency}
                  onChange={(event) => setConcurrency(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} />
              </div>
              <div className='border-l pl-3'>
                <Button size='icon' variant='ghost' aria-label='Close inventory modal'
                  onClick={() => setConfirmSyncClose(true)}>
                  <X className='size-4' />
                </Button>
              </div>
            </div>
          </div>
          <div className='min-h-0 flex-1'>
            {hasSyncResults ? (
              <InventorySyncResultsTable results={syncResults} columns={syncResultColumns} />
            ) : (
              <CloudDataTable
                key={searchProjects ? 'search-projects' : 'all-projects'}
                data={searchProjects ?? projects.data?.items ?? []}
                initialSelectedRowIds={searchProjects?.map((project) => project.id)}
                columns={projectColumns}
                getRowId={(row) => row.id}
                loading={searchProjects === null && projects.isLoading}
                entityName='project'
                initialPageSize={50}
                pageSizeOptions={[20, 50, 100]}
                selectAllMatchingRows
                searchPlaceholder='Search accessible projects...'
                toolbar={(selected) => (
                  <Button
                    size='sm'
                    disabled={syncing || !selected.length}
                    onClick={() => setProjectsToConfirmSync([...selected])}
                  >
                    {syncing ? (
                      <Loader2 className='animate-spin' />
                    ) : (
                      <RefreshCw />
                    )}
                    Sync VM ({selected.length})
                  </Button>
                )}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={projectsToConfirmSync.length > 0}
        onOpenChange={(open) => { if (!open) setProjectsToConfirmSync([]) }}
        title='Synchronize selected projects?'
        desc='Review the projects below before refreshing their full VM inventory.'
        confirmText='Start sync'
        disabled={syncing || !projectsToConfirmSync.length}
        className='flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden p-4 sm:max-w-3xl sm:p-6'
        handleConfirm={() => {
          if (syncing || !projectsToConfirmSync.length) return
          const selected = projectsToConfirmSync
          setProjectsToConfirmSync([])
          setSearchProjects(null)
          setSyncOpen(true)
          syncProjects(selected)
        }}
      >
        <div className='flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground'>
          <Badge variant='secondary'>{projectsToConfirmSync.length} projects</Badge>
          <span>Up to {concurrency} projects at a time</span>
        </div>
        <div className='min-h-0 overflow-hidden rounded-md border'>
          <div className='hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 border-b bg-muted/50 px-4 py-2 text-xs font-medium text-muted-foreground sm:grid'>
            <span>Project</span>
            <span>Project ID</span>
          </div>
          <div className='max-h-[48dvh] overflow-y-auto overscroll-contain'>
            {projectsToConfirmSync.map((project) => (
              <div key={project.id} className='grid min-w-0 gap-1 border-b px-4 py-3 text-sm last:border-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center sm:gap-4'>
                <div className='min-w-0'>
                  <p className='truncate font-medium' title={project.display_name || project.name}>{project.display_name || project.name}</p>
                  {project.display_name && project.name !== project.display_name && (
                    <p className='truncate text-xs text-muted-foreground' title={project.name}>{project.name}</p>
                  )}
                </div>
                <p className='min-w-0 font-mono text-xs break-all text-muted-foreground select-text'>{project.id}</p>
              </div>
            ))}
          </div>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmSyncClose}
        onOpenChange={setConfirmSyncClose}
        title={syncing ? 'Close inventory while syncing?' : 'Close inventory modal?'}
        desc={syncing ? 'Synchronization will continue in the background. Reopen Refresh inventory to follow progress.' : 'Close this modal? Its selection and completed sync results will be cleared.'}
        cancelBtnText={syncing ? 'Keep watching' : 'Keep open'}
        confirmText='Close modal'
        handleConfirm={() => { setConfirmSyncClose(false); closeSyncModal() }}
      />
      {switchProjectRow && (
        <SwitchVmProjectDialog
          project={{
            id: switchProjectRow.project_id,
            name: switchProjectRow.project_name || switchProjectRow.project_id,
            display_name: switchProjectRow.project_display_name,
          }}
          serverName={switchProjectRow.server_name}
          onClose={() => setSwitchProjectRow(null)}
          onComplete={() => window.location.reload()}
        />
      )}
      {securityGroupsRow && (
        <InventoryServerSecurityGroupsDialog
          key={`${securityGroupsRow.project_id}:${securityGroupsRow.server_id}`}
          server={securityGroupsRow}
          onClose={() => setSecurityGroupsRow(null)}
        />
      )}
      <ServerDetailsDialog
        key={`${detailRow?.project_id ?? ''}-${detailRow?.server_id ?? ''}`}
        server={detailRow ? { id: detailRow.server_id, name: detailRow.server_name } : undefined}
        projectId={detailRow?.project_id ?? ''}
        crossProject
        onOpenChange={(open) => !open && setDetailRow(null)}
      />
      <TeleportSshDialog
        key={`${teleportProjectId}-${teleportServer?.id ?? ''}`}
        open={Boolean(teleportServer)}
        server={teleportServer}
        onOpenChange={(open) => !open && setTeleportServer(undefined)}
      />

      <Dialog
        open={passwordRows.length > 0}
        onOpenChange={(open) => {
          if (!open && !changingPassword) {
            setPasswordRows([])
            setPasswordResults([])
          }
        }}
      >
        <DialogContent className='sm:!max-w-3xl'>
          <DialogHeader>
            <DialogTitle>Change server passwords</DialogTitle>
            <DialogDescription>
              {passwordResults.length
                ? changingPassword
                  ? `Changing passwords independently (up to ${PASSWORD_CHANGE_CONCURRENCY} at a time).`
                  : 'The operation completed. Review the result returned for each server.'
                : `Choose how to set passwords for ${passwordRows.length} selected server(s). The existing passwords cannot be recovered from CloudTool.`}
            </DialogDescription>
          </DialogHeader>
          {passwordResults.length ? (
            <div className='max-h-80 overflow-auto rounded-md border'>
              <Table>
                <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Server ID</TableHead><TableHead>Status</TableHead><TableHead>Detail</TableHead>{passwordMode === 'random' && <TableHead>Generated password</TableHead>}</TableRow></TableHeader>
                <TableBody>{passwordResults.map((result) => <TableRow key={result.server_id}><TableCell className='font-medium'>{result.name}</TableCell><TableCell className='font-mono text-xs'>{result.server_id}</TableCell><TableCell>{result.status}</TableCell><TableCell className='max-w-64 break-words text-xs text-destructive'>{passwordResultDetail(result.error)}</TableCell>{passwordMode === 'random' && <TableCell className='font-mono text-xs'>{showPassword ? result.password : '••••••••••••'}</TableCell>}</TableRow>)}</TableBody>
              </Table>
            </div>
          ) : <>
          <div className='flex rounded-md border p-1'>
            {([
              ['profile', 'Password profile'],
              ['manual', 'Enter password'],
              ['random', 'Random password'],
            ] as Array<[PasswordMode, string]>).map(([mode, label]) => (
              <Button
                key={mode}
                type='button'
                size='sm'
                variant={passwordMode === mode ? 'secondary' : 'ghost'}
                className='flex-1'
                onClick={() => {
                  setPasswordMode(mode)
                  if (mode === 'random')
                    setRandomPasswords((current) =>
                      Object.fromEntries(passwordRows.map((row) => [row.id, current[row.id] || randomServerPassword()]))
                    )
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          {passwordMode === 'profile' ? (
            <div className='space-y-2'>
              <label className='text-sm font-medium' htmlFor='all-server-password-profile'>Password profile</label>
              <select
                id='all-server-password-profile'
                className='h-9 w-full rounded-md border bg-background px-3 text-sm'
                value={profileId}
                onChange={(event) => setProfileId(event.target.value)}
              >
                <option value=''>Select password profile</option>
                {(passwordProfiles.data ?? []).map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}{profile.username ? ` (${profile.username})` : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className='space-y-2 rounded-lg border bg-muted/20 p-4'>
              <div className='flex items-center justify-between gap-2'>
                <label className='text-sm font-medium' htmlFor='all-server-password'>New password</label>
                <div className='flex gap-2'>
                  <Button type='button' variant='ghost' size='sm' onClick={() => setShowPassword((value) => !value)}>
                    {showPassword ? 'Hide' : 'Show'}
                  </Button>
                  {passwordMode === 'random' && (
                    <Button type='button' variant='outline' size='sm' onClick={() => setRandomPasswords(Object.fromEntries(passwordRows.map((row) => [row.id, randomServerPassword()])))}>
                      <RefreshCw /> Regenerate all
                    </Button>
                  )}
                </div>
              </div>
              {passwordMode === 'manual' && <Input
                id='all-server-password'
                type={showPassword ? 'text' : 'password'}
                className='font-mono'
                value={manualPassword}
                onChange={(event) => setManualPassword(event.target.value)}
                placeholder='Example: G5_&s84Xbi'
                autoComplete='new-password'
              />}
              <p className='text-xs text-muted-foreground'>At least 9 characters with uppercase, lowercase, number and special character.</p>
            </div>
          )}
          <div className='max-h-52 overflow-auto rounded-md border'>
            <Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Server ID</TableHead><TableHead>Project</TableHead>{passwordMode === 'random' && <TableHead>Generated password</TableHead>}</TableRow></TableHeader><TableBody>{passwordRows.map((row) => <TableRow key={row.id}><TableCell className='font-medium'>{row.server_name}</TableCell><TableCell className='font-mono text-xs'>{row.server_id}</TableCell><TableCell>{row.project_display_name || row.project_name}</TableCell>{passwordMode === 'random' && <TableCell className='font-mono text-xs'>{showPassword ? randomPasswords[row.id] : '••••••••••••'}</TableCell>}</TableRow>)}</TableBody></Table>
          </div>
          </>}
          <DialogFooter>
            {passwordResults.length ? <Button disabled={changingPassword} onClick={() => setPasswordRows([])}>Close</Button> : <><Button variant='outline' disabled={changingPassword} onClick={() => setPasswordRows([])}>Cancel</Button><Button disabled={!passwordReady || changingPassword} onClick={() => void changePassword()}>{changingPassword && <Loader2 className='animate-spin' />}<KeyRound /> Change passwords</Button></>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CloudPageShell>
  )
}
