import { useWindowPointerDrag } from '@/hooks/use-window-pointer-drag'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import {
  Copy,
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  FileCode2,
  FolderOpen,
  HelpCircle,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Square,
  Star,
  Trash2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { downloadXlsx } from '@/lib/xlsx-export'
import { parseXlsxRows, rowsFromHeader } from '@/lib/xlsx-import'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardTitle,
} from '@/components/ui/card'
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { CloudDataTable } from '@/components/cloud-data-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  SearchableSelect,
  type SearchableOption,
} from '@/components/searchable-select'
import { SortableHeader } from '@/components/sortable-header'
import { CloudPageShell } from '@/features/cloud/page-shell'
import { creationErrorText, creationResponseText } from './creation-error'
import { elasticIpVariables } from './elastic-ip-variables'
import {
  applyManualIps,
  needsManualIps,
  type ManualIpResult,
} from './manual-ip-allocations'
import { ManualIpDialog } from './manual-ip-dialog'
import {
  emptyTerraformServer,
  terraformServerFromTemplate,
  terraformServerTemplateRow,
  terraformTemplateHeaders,
  validateTerraformServer,
  type TerraformTemplateLookups,
  type TemplateLookupItem,
} from './server-draft'
import type {
  ServerVolumeDraft,
  TerraformServerDraft,
  TerraformServerFieldErrors,
} from './types'

type Page<T> = { items: T[]; total: number; next?: string | null }
type CloudItem = Record<string, unknown> & {
  id: string
  name?: string
  display_name?: string
}
type QuotaItem = {
  service_name?: string
  name?: string
  limit?: number | null
  used?: number | null
}
type QuotaReviewItem = {
  label: string
  requested: number
  used: number
  limit: number | null
  available: number | null
  exceeded: boolean
}
type VpcInternetReviewItem = {
  vpcName: string
}
type SavedServerDraft = {
  servers: TerraformServerDraft[]
  updated_at?: string | null
}
type OrderedPrivateIpResult = {
  server_draft_id: string
  server_name: string
  subnet_id: string
  ip_address?: string
  ip_id?: string
  status: 'completed' | 'reused' | 'failed'
  error?: string
}
type DeploymentHistory = {
  id: string
  name: string
  status: string
  total_items: number
  succeeded_items: number
  failed_items: number
  created_at: string
  started_at?: string | null
  completed_at?: string | null
  error?: string | null
  server_names?: string[]
}
type DeploymentServerResult = {
  id: string
  server_name: string
  server_id?: string | null
  status: string
  error_code?: string | null
  error_message?: string | null
  request?: Record<string, unknown>
  result?: Record<string, unknown>
  created_at?: string
  started_at?: string
  completed_at?: string
}
type DeploymentDetail = DeploymentHistory & {
  execution_mode?: 'standard' | 'guarded_sequential'
  template?: { region?: string; servers?: Array<Record<string, unknown>> }
  servers: DeploymentServerResult[]
}
type CloudInitTemplate = {
  id: string
  name: string
  os_family: 'any' | 'ubuntu' | 'centos' | 'debian' | 'windows' | 'oracle'
  description: string
  content: string
  is_active: boolean
  is_starred: boolean
}

const labelOf = (item: CloudItem) => item.display_name || item.name || item.id
const optionsOf = (
  items?: CloudItem[],
  description?: (item: CloudItem) => string
) =>
  (items ?? []).map((item) => ({
    value: item.id,
    label: labelOf(item),
    description: description?.(item),
  }))
const diskKind = (name: string) =>
  /ssd/i.test(name) ? 'SSD' : /hdd/i.test(name) ? 'HDD' : 'Disk'
const quotaKey = (value: unknown) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
const quotaFor = (items: QuotaItem[], key: string) =>
  items.find((item) => quotaKey(item.name) === key)
const resourcePlanFor = (items: TerraformServerDraft[]) => {
  const volumes = items.flatMap((server) => server.volumes)
  return {
    servers: items.length,
    vcpus: items.reduce((sum, server) => sum + Number(server.vcpus || 0), 0),
    ram: items.reduce((sum, server) => sum + Number(server.ram || 0), 0),
    volumes: volumes.length,
    disk: volumes.reduce((sum, volume) => sum + Number(volume.size || 0), 0),
    hdd: volumes
      .filter((volume) => diskKind(volume.volume_type_name) === 'HDD')
      .reduce((sum, volume) => sum + Number(volume.size || 0), 0),
    ssd: volumes
      .filter((volume) => diskKind(volume.volume_type_name) === 'SSD')
      .reduce((sum, volume) => sum + Number(volume.size || 0), 0),
    elasticIps: items.filter((server) => server.elastic_ip_mode === 'auto')
      .length,
  }
}
const cidrFromText = (value: unknown) =>
  String(value ?? '').match(/(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}/)?.[0] || ''
const subnetCidrOf = (item?: CloudItem) => cidrFromText(item?.cidr)
const vpcCidrOf = (item?: CloudItem) => {
  const vpc = item?.vpc as Record<string, unknown> | undefined
  return (
    cidrFromText(vpc?.cidr) ||
    cidrFromText(vpc?.display_name) ||
    cidrFromText(item?.vpc_cidr) ||
    subnetCidrOf(item)
  )
}
const gatewayFromCidr = (cidr: string) => {
  const [address] = cidr.split('/')
  const octets = address.split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return ''
  let value =
    ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]
  value += 1
  return [
    Math.floor(value / 16777216) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 256) % 256,
    value % 256,
  ].join('.')
}
const jsonText = (value: unknown) =>
  value == null ? '—' : JSON.stringify(value, null, 2)
const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const isIpAddress = (value: string) =>
  /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(':')
const ipsFromValue = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(ipsFromValue)
  if (typeof value === 'string') return isIpAddress(value) ? [value] : []
  const item = recordValue(value)
  if (!item) return []
  return [
    item.ip_address,
    item.address,
    item.floating_ip_address,
    item.ip,
  ].flatMap((address) =>
    typeof address === 'string' && isIpAddress(address) ? [address] : []
  )
}
const uniqueIps = (...values: unknown[]) => [
  ...new Set(values.flatMap(ipsFromValue)),
]
const deploymentIps = (
  server: DeploymentServerResult,
  kind: 'private' | 'elastic'
) => {
  const result = recordValue(server.result)
  const cloudResponse = recordValue(result?.cloud_response)
  const request = server.request
  return kind === 'private'
    ? uniqueIps(
        result?.private_ips,
        cloudResponse?.private_ip,
        cloudResponse?.private_ips,
        request?.eni_address,
        request?.private_ip,
        request?.teleport_monitor_ip
      )
    : uniqueIps(
        result?.elastic_ips,
        cloudResponse?.elastic_ip,
        cloudResponse?.elastic_ips,
        request?.elastic_ip_address
      )
}
const elapsedTime = (
  startedAt?: string | null,
  completedAt?: string | null
) => {
  const started = startedAt ? new Date(startedAt).getTime() : Number.NaN
  const completed = completedAt ? new Date(completedAt).getTime() : Number.NaN
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    completed < started
  )
    return '—'
  const seconds = Math.round((completed - started) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours
    ? `${hours}h ${minutes}m ${seconds % 60}s`
    : minutes
      ? `${minutes}m ${seconds % 60}s`
      : `${seconds}s`
}
const dateTime = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : '—'
const securityGroupKey = (value: string) =>
  value.toLocaleLowerCase().replace(/[^a-z0-9]/g, '')
const securityGroupSuggestions = (groups: TemplateLookupItem[]) => {
  const seen = new Set<string>()
  const unique = groups.filter((group) => {
    const key = securityGroupKey(group.text)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
  const shared = unique.find(
    (group) => securityGroupKey(group.text) === 'sgall'
  )
  const others = unique.filter(
    (group) => securityGroupKey(group.text) !== 'sgall'
  )
  // Put ready-made common-SG pairs first and exclude SG_All, SG_All.
  return [
    ...(shared ? others.map((group) => `${shared.text}, ${group.text}`) : []),
    ...(shared ? [shared.text] : []),
    ...others.map((group) => group.text),
  ]
}
const isStable = (detail?: DeploymentDetail) =>
  Boolean(
    detail &&
    !['queued', 'running'].includes(detail.status) &&
    detail.servers.every(
      (server) => server.status === 'failed' || server.result?.stable === true
    )
  )
function renderPreview(
  content: string,
  server?: TerraformServerDraft,
  subnet?: CloudItem
) {
  if (!server) return content
  const dataVolumes = server.volumes.filter(
    (volume) => volume.mount_as === 'data'
  )
  const rootVolume = server.volumes.find((volume) => volume.mount_as === 'root')
  const subnetCidr = server.subnet_cidr || subnetCidrOf(subnet)
  const localGateway = gatewayFromCidr(subnetCidr)
  const values: Record<string, string> = {
    server_name: server.name || 'server-name',
    'server.name': server.name || 'server-name',
    hostnamectl: server.name || 'server-name',
    zone: server.zone_name,
    private_ip: server.eni_address,
    local_gateway: localGateway,
    private_gateway: localGateway,
    subnet_cidr: subnetCidr,
    vpc_cidr: server.vpc_cidr || vpcCidrOf(subnet) || subnetCidr,
    TELEPORT_ENABLE: String(server.teleport_enabled),
    TP_REGION: server.teleport_region,
    TP_SYSTEM: server.teleport_system || server.name,
    TP_HOSTNAME: server.teleport_hostname || server.name,
    TP_MONITOR_IP: server.teleport_monitor_ip,
    volume_count: String(server.volumes.length),
    data_volume_count: String(dataVolumes.length),
    has_data_volumes: String(dataVolumes.length > 0),
    has_other_volumes: String(dataVolumes.length > 0),
    root_volume: rootVolume
      ? `${rootVolume.mount_as},${rootVolume.volume_type_name},${rootVolume.size},${rootVolume.mount_point || '/'}`
      : '',
    data_volumes: dataVolumes
      .map(
        (volume) =>
          `${volume.mount_as},${volume.volume_type_name},${volume.size},${volume.mount_point || '/data'}`
      )
      .join('\n'),
    data_volume_types: dataVolumes
      .map((volume) => volume.volume_type_name)
      .join(','),
    data_volume_mounts: dataVolumes
      .map((volume) => volume.mount_point || '/data')
      .join('\n'),
    volume_mounts: server.volumes
      .map(
        (volume) =>
          `${volume.mount_as},${volume.mount_point || (volume.mount_as === 'root' ? '/' : '/data')}`
      )
      .join('\n'),
    ...server.cloud_init_variables,
    ...elasticIpVariables(server),
  }
  if (elasticIpVariables(server).elastic_ip_address === undefined)
    delete values.elastic_ip_address
  server.volumes.forEach((volume, index) => {
    values[`volume[${index + 1}].mount_path`] =
      volume.mount_point || (volume.mount_as === 'root' ? '/' : '/data')
    values[`volume[${index + 1}].type`] = volume.volume_type_name
    values[`volume[${index + 1}].size`] = String(volume.size)
    values[`volume_${index + 1}_mount_path`] =
      volume.mount_point || (volume.mount_as === 'root' ? '/' : '/data')
    values[`volume_${index + 1}_type`] = volume.volume_type_name
    values[`volume_${index + 1}_size`] = String(volume.size)
  })
  dataVolumes.forEach((volume, index) => {
    values[`data_volume[${index + 1}].mount_path`] =
      volume.mount_point || '/data'
    values[`data_volume[${index + 1}].type`] = volume.volume_type_name
    values[`data_volume[${index + 1}].size`] = String(volume.size)
    values[`data_volume_${index + 1}_mount_path`] =
      volume.mount_point || '/data'
    values[`data_volume_${index + 1}_type`] = volume.volume_type_name
    values[`data_volume_${index + 1}_size`] = String(volume.size)
  })
  return content.replace(
    /\{\{\s*([\w.\[\]]+)\s*\}\}/g,
    (token, key: string) => values[key] ?? token
  )
}

function RefSelect({
  label,
  value,
  options,
  onChange,
  loading,
  disabled,
  error,
  fieldKey,
  placeholder = 'Select...',
  clearable = true,
}: {
  label: string
  value: string
  options: SearchableOption[]
  onChange: (value: string) => void
  loading?: boolean
  disabled?: boolean
  error?: string
  fieldKey?: string
  placeholder?: string
  clearable?: boolean
}) {
  return (
    <div className='space-y-1.5' data-server-field={fieldKey}>
      <Label>{label}</Label>
      <div className='flex gap-1'>
        <SearchableSelect
          value={value}
          onValueChange={onChange}
          options={options}
          loading={loading}
          disabled={disabled}
          placeholder={placeholder}
          className='min-w-0'
        />
        {clearable && value && (
          <Button
            type='button'
            size='icon'
            variant='ghost'
            aria-label={`Clear ${label}`}
            onClick={() => onChange('')}
          >
            <Trash2 className='size-4' />
          </Button>
        )}
      </div>
      {error && <p className='text-xs text-destructive'>{error}</p>}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  values,
  onChange,
  className,
  wrap = false,
}: {
  value: T
  values: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  className?: string
  wrap?: boolean
}) {
  return (
    <div
      className={`flex rounded-md border p-0.5 ${wrap ? 'min-w-0 flex-wrap gap-0.5' : ''} ${className ?? ''}`}
    >
      {values.map((item) => (
        <Button
          key={item.value}
          type='button'
          size='sm'
          variant={value === item.value ? 'secondary' : 'ghost'}
          className={
            wrap
              ? 'h-auto min-h-7 max-w-full min-w-0 flex-[1_1_7.5rem] px-2 py-1 text-xs break-words whitespace-normal'
              : 'h-7 flex-1 px-2 text-xs'
          }
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  )
}

function ServerResultsTable({
  detail,
  compact = false,
  onViewDetail,
  onImportSelected,
}: {
  detail: DeploymentDetail
  compact?: boolean
  onViewDetail?: (server: DeploymentServerResult) => void
  onImportSelected?: (servers: DeploymentServerResult[]) => void
}) {
  const columns: ColumnDef<DeploymentServerResult>[] = [
    {
      id: 'sequence',
      header: 'No.',
      enableSorting: false,
      cell: ({ row }) => (
        <span className='text-xs text-muted-foreground tabular-nums'>
          {row.index + 1}
        </span>
      ),
    },
    {
      accessorKey: 'server_name',
      header: 'Server',
      cell: ({ row }) => (
        <div>
          <p className='font-medium'>{row.original.server_name}</p>
          <p className='font-mono text-xs text-muted-foreground'>
            {row.original.server_id || 'ID pending'}
          </p>
        </div>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Creation status',
      cell: ({ row }) => {
        const status = row.original.status
        const creating = [
          'pending',
          'creating',
          'queued',
          'waiting_for_running',
        ].includes(status)
        return (
          <div>
            <Badge
              variant={status === 'failed' ? 'destructive' : 'secondary'}
              className={
                status === 'succeeded'
                  ? 'border-emerald-300 bg-emerald-100 font-semibold text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                  : status === 'failed'
                    ? 'font-semibold shadow-sm'
                    : 'border-amber-300 bg-amber-100 font-semibold text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
              }
            >
              {creating && <Loader2 className='mr-1 size-3 animate-spin' />}
              {status}
            </Badge>
            <p className='mt-1 text-xs text-muted-foreground'>
              {row.original.status === 'succeeded'
                ? 'Created'
                : row.original.status === 'failed'
                  ? 'Not created'
                  : 'Creating…'}
            </p>
          </div>
        )
      },
    },
    {
      id: 'created_at',
      header: 'Created',
      accessorFn: (row) => row.completed_at || '',
      cell: ({ row }) =>
        row.original.status === 'succeeded' ? (
          <div className='text-xs leading-4'>
            <p className='font-medium tabular-nums'>
              {elapsedTime(row.original.started_at, row.original.completed_at)}
            </p>
            <p
              className='text-muted-foreground'
              title={dateTime(row.original.completed_at)}
            >
              {dateTime(row.original.completed_at)}
            </p>
          </div>
        ) : (
          <span className='text-muted-foreground'>—</span>
        ),
    },
    {
      id: 'power_state',
      header: 'Power state',
      accessorFn: (row) => String(row.result?.cloud_state || ''),
      cell: ({ row }) => {
        if (row.original.status !== 'succeeded') {
          return <span className='text-xs text-muted-foreground'>—</span>
        }
        const state = String(row.original.result?.cloud_state || 'checking')
        const running = state === 'running' || state === 'active'
        const checking = [
          'checking',
          'accepted',
          'queued',
          'pending',
          'creating',
          'building',
          'starting',
        ].includes(state)
        return (
          <div className='flex items-center gap-2'>
            {checking ? (
              <Loader2 className='size-3.5 animate-spin text-amber-600' />
            ) : (
              <span
                className={`size-2 rounded-full ${running ? 'bg-emerald-500' : state === 'error' || state === 'failed' ? 'bg-destructive' : 'bg-amber-500'}`}
              />
            )}
            <span className='capitalize'>{state}</span>
          </div>
        )
      },
    },
    {
      id: 'ips',
      header: 'IP addresses',
      accessorFn: (row) =>
        [
          ...deploymentIps(row, 'private'),
          ...deploymentIps(row, 'elastic'),
        ].join(', '),
      cell: ({ row }) => {
        const privateIps = deploymentIps(row.original, 'private')
        const elasticIps = deploymentIps(row.original, 'elastic')
        if (!privateIps.length && !elasticIps.length)
          return <span className='text-xs text-muted-foreground'>—</span>
        return (
          <div className='space-y-0.5 text-xs leading-4'>
            {privateIps.map((ip) => (
              <p key={`private-${ip}`}>
                <span className='text-muted-foreground'>Private </span>
                {ip}
              </p>
            ))}
            {elasticIps.map((ip) => (
              <p key={`elastic-${ip}`}>
                <span className='text-muted-foreground'>Elastic </span>
                {ip}
              </p>
            ))}
          </div>
        )
      },
    },
    {
      id: 'error',
      header: 'Error',
      meta: { className: 'max-w-72 !whitespace-normal align-top' },
      accessorFn: (row) => creationErrorText(row),
      cell: ({ row }) => {
        const error = creationErrorText(row.original)
        if (!error)
          return <span className='text-xs text-muted-foreground'>—</span>
        return (
          <div className='min-w-0 max-w-72 space-y-1 text-xs leading-4 text-destructive'>
            {row.original.error_code && (
              <Badge variant='destructive' className='h-5 px-1.5 text-[10px]'>
                {row.original.error_code}
              </Badge>
            )}
            <p className='whitespace-pre-wrap [overflow-wrap:anywhere]' title={error}>
              {error}
            </p>
          </div>
        )
      },
    },
    {
      id: 'request',
      header: 'Saved request',
      cell: ({ row }) => (
        <pre className='max-h-40 max-w-80 overflow-auto rounded bg-muted p-2 text-[10px] whitespace-pre-wrap'>
          {jsonText(row.original.request)}
        </pre>
      ),
    },
    {
      id: 'response',
      header: 'Cloud API response',
      cell: ({ row }) => (
        <pre className='max-h-40 max-w-96 overflow-auto rounded bg-muted p-2 text-[10px] whitespace-pre-wrap'>
          {creationResponseText(row.original)}
        </pre>
      ),
    },
  ]
  const visibleColumns = compact
    ? columns.filter((column) =>
        [
          'sequence',
          'server_name',
          'status',
          'created_at',
          'power_state',
          'ips',
          'error',
        ].includes(
          String(
            column.id || ('accessorKey' in column ? column.accessorKey : '')
          )
        )
      )
    : columns
  if (compact && onViewDetail)
    visibleColumns.push({
      id: 'detail',
      header: 'Action',
      enableHiding: false,
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant='ghost' size='icon' aria-label='Result actions'>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            <DropdownMenuItem onClick={() => onViewDetail(row.original)}>
              <Eye /> View detail
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    })
  return (
    <CloudDataTable
      data={detail.servers}
      columns={visibleColumns}
      getRowId={(row) => row.id}
      entityName='server result'
      enableSelection={Boolean(onImportSelected)}
      emptyText='Waiting for server results...'
      exportFileName={`deployment-${detail.id}`}
      toolbar={
        onImportSelected
          ? (selected) => (
              <Button
                type='button'
                size='sm'
                onClick={() => onImportSelected(selected)}
              >
                <Upload /> Import selected to list ({selected.length})
              </Button>
            )
          : undefined
      }
    />
  )
}

export function TerraformServersPage() {
  const queryClient = useQueryClient()
  const project = useCloudStore((state) => state.project)!
  const token = useCloudStore((state) => state.token)
  const currentUser = useAuthStore((state) => state.auth.user)
  const isAdmin =
    (typeof currentUser?.role === 'string'
      ? currentUser.role
      : currentUser?.role?.name) === 'admin'
  const fileRef = useRef<HTMLInputElement>(null)
  const [servers, setServers] = useState<TerraformServerDraft[]>([])
  const [draft, setDraft] = useState<TerraformServerDraft>()
  const [errors, setErrors] = useState<TerraformServerFieldErrors>({})
  const [deleteIds, setDeleteIds] = useState<string[]>([])
  const [selectedServers, setSelectedServers] = useState<
    TerraformServerDraft[]
  >([])
  const [reviewServers, setReviewServers] = useState<TerraformServerDraft[]>([])
  const [orderedIpServerTargets, setOrderedIpServerTargets] = useState<
    TerraformServerDraft[]
  >([])
  const [manualIpTargets, setManualIpTargets] = useState<
    TerraformServerDraft[]
  >([])
  const [manualIpProjectId, setManualIpProjectId] = useState(project.id)
  const [orderedIpOpen, setOrderedIpOpen] = useState(false)
  const [orderedIpCreating, setOrderedIpCreating] = useState(false)
  const [orderedIpResults, setOrderedIpResults] = useState<
    OrderedPrivateIpResult[]
  >([])
  const [orderedIpRetryLimit, setOrderedIpRetryLimit] = useState(0)
  const [reuseAvailableOrderedIp, setReuseAvailableOrderedIp] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<DeploymentHistory[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyDetail, setHistoryDetail] = useState<DeploymentDetail>()
  const [historyDeleteIds, setHistoryDeleteIds] = useState<string[]>([])
  const [historyDeleting, setHistoryDeleting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [deploymentName, setDeploymentName] = useState('Server deployment')
  const [importErrors, setImportErrors] = useState<Map<string, string>>(
    () => new Map()
  )
  const [delayBetweenCreateMs, setDelayBetweenCreateMs] = useState(3000)
  const [executionMode, setExecutionMode] = useState<
    'standard' | 'guarded_sequential'
  >('guarded_sequential')
  const [waitForRunningSeconds, setWaitForRunningSeconds] = useState(120)
  const [compensationLimit, setCompensationLimit] = useState(3)
  const [failureLimit, setFailureLimit] = useState(3)
  const [templateLoading, setTemplateLoading] = useState(false)
  const [tempSaving, setTempSaving] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [cloudInitManagerOpen, setCloudInitManagerOpen] = useState(false)
  const [cloudInitEditing, setCloudInitEditing] =
    useState<Partial<CloudInitTemplate>>()
  const [cloudInitPreview, setCloudInitPreview] = useState<CloudInitTemplate>()
  const [cloudInitSearch, setCloudInitSearch] = useState('')
  const [cloudInitDelete, setCloudInitDelete] = useState<CloudInitTemplate>()
  const [cloudInitStarChange, setCloudInitStarChange] =
    useState<CloudInitTemplate>()
  const [cloudInitStarSaving, setCloudInitStarSaving] = useState(false)
  const [executionDetail, setExecutionDetail] = useState<DeploymentDetail>()
  const [executionCloseConfirm, setExecutionCloseConfirm] = useState(false)
  const [resultServerDetail, setResultServerDetail] =
    useState<DeploymentServerResult>()
  const [resultRefreshMs, setResultRefreshMs] = useState(10_000)
  const [resultRefreshing, setResultRefreshing] = useState(false)
  const [executionControlLoading, setExecutionControlLoading] = useState(false)
  const executionSucceeded = executionDetail?.succeeded_items ?? 0
  const executionTotal = executionDetail?.total_items ?? 0
  const executionFailed = executionDetail?.failed_items ?? 0
  const executionProgress = executionTotal
    ? Math.min(100, Math.round((executionSucceeded / executionTotal) * 100))
    : 0

  const useCloudQuery = <T extends CloudItem>(
    key: string,
    path: string,
    params?: Record<string, unknown>,
    enabled = true
  ) =>
    useQuery({
      queryKey: ['server-create', project.id, key, params],
      enabled,
      queryFn: async ({ signal }) =>
        (await apiClient.get<Page<T>>(path, { params, signal })).data,
      staleTime: 30_000,
    })
  const zones = useCloudQuery<CloudItem>(
    'zones',
    '/cloud/zones',
    undefined,
    Boolean(draft)
  )
  const flavors = useCloudQuery<CloudItem>(
    'flavors',
    '/cloud/server-flavors',
    { zone: draft?.zone_id, family: draft?.instance_family, page_size: 200 },
    Boolean(draft?.zone_id && draft?.specs_kind === 'predefined')
  )
  const images = useCloudQuery<CloudItem>(
    'images',
    '/cloud/server-images',
    { page_size: 200 },
    Boolean(draft)
  )
  const keypairs = useCloudQuery<CloudItem>(
    'keypairs',
    '/cloud/server-keypairs',
    { page_size: 200 },
    Boolean(draft)
  )
  const subnets = useCloudQuery<CloudItem>(
    'subnets',
    '/cloud/subnets',
    { page_size: 200 },
    Boolean(draft?.private_network_mode === 'subnet')
  )
  const privateIps = useCloudQuery<CloudItem>(
    'private-ips',
    '/cloud/private-ips',
    { subnet_id: draft?.subnet_id, available: true, page_size: 200 },
    Boolean(draft?.subnet_id && draft?.private_ip_mode === 'existing')
  )
  const monitorPrivateIps = useQuery({
    queryKey: [
      'server-create',
      project.id,
      'teleport-monitor-ips',
      draft?.teleport_monitor_subnet_id,
    ],
    enabled: Boolean(
      draft?.teleport_monitor_subnet_id && draft?.teleport_enabled
    ),
    queryFn: async ({ signal }) => {
      const items = await fetchAll('/cloud/private-ips', {
        subnet_id: draft?.teleport_monitor_subnet_id,
        available: true,
      }, signal)
      return { items, total: items.length }
    },
    staleTime: 30_000,
  })
  const groups = useCloudQuery<CloudItem>(
    'groups',
    '/cloud/server-security-groups',
    { region_id: draft?.region_id, page_size: 200 },
    Boolean(draft?.region_id)
  )
  const volumeTypes = useCloudQuery<CloudItem>(
    'volumes',
    '/cloud/server-volume-types',
    { zone: draft?.zone_id, page_size: 200 },
    Boolean(draft?.zone_id)
  )
  const elasticIps = useCloudQuery<CloudItem>(
    'elastic',
    '/cloud/server-elastic-ips',
    { page_size: 200 },
    Boolean(draft?.elastic_ip_mode === 'existing')
  )
  const placementGroups = useCloudQuery<CloudItem>(
    'placement-groups',
    '/cloud/server-placement-groups',
    { region_id: draft?.region_id, page_size: 200 },
    Boolean(draft?.region_id)
  )
  const cloudInitTemplates = useQuery({
    queryKey: ['cloud-init-templates'],
    enabled: Boolean(draft || cloudInitManagerOpen || historyOpen),
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<{ items: CloudInitTemplate[] }>(
          '/cloud/cloud-init-templates', { signal }
        )
      ).data,
    staleTime: 10_000,
  })
  const savedServerDraft = useQuery({
    queryKey: ['server-create-temp-draft', project.id],
    enabled: false,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<SavedServerDraft>('/provisioning/server-draft', {
          headers: { 'X-Cloud-Token': token, 'X-Project-Id': project.id }, signal,
        })
      ).data,
    // Fetch the persisted list only when Load temp is clicked.
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
  const quotaQuery = useQuery({
    queryKey: ['server-create-quota-review', project.id],
    // Check only while the confirmation modal is open. This keeps ordinary
    // server-list work lightweight while still reviewing quota before create.
    enabled: reviewServers.length > 0,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<{ items: QuotaItem[]; total: number }>(
          '/cloud/quotas', { signal }
        )
      ).data,
    staleTime: 30_000,
  })
  const reviewSubnetsQuery = useQuery({
    queryKey: ['server-create-vpc-internet-subnets', project.id],
    // Load the subnet-to-VPC relationship once for the whole review. VPC
    // access is then evaluated locally, never once per private IP.
    enabled: reviewServers.length > 0,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Page<CloudItem>>('/cloud/subnets', {
          params: { page: 1, page_size: 200 }, signal,
        })
      ).data,
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  })
  const reviewVpcsQuery = useQuery({
    queryKey: ['server-create-vpc-internet-review', project.id],
    // One VPC-list request supplies every private-IP check in this modal.
    // It is deliberately re-requested only through the Refresh button below.
    enabled: reviewServers.length > 0,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Page<CloudItem>>('/cloud/network/vpcs', {
          params: { page: 1, page_size: 200 }, signal,
        })
      ).data,
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  })
  const serverPlan = useMemo(() => resourcePlanFor(servers), [servers])
  const selectedServerPlan = useMemo(
    () => resourcePlanFor(selectedServers),
    [selectedServers]
  )
  const displayedPlan = selectedServers.length ? selectedServerPlan : serverPlan
  const onSelectedServersChange = useCallback(
    (items: TerraformServerDraft[]) => setSelectedServers(items),
    []
  )
  const reviewPlan = useMemo(
    () => resourcePlanFor(reviewServers),
    [reviewServers]
  )
  const orderedIpTargets = useMemo(
    () =>
      orderedIpServerTargets.filter(
        (server) => server.private_ip_mode === 'ordered'
      ),
    [orderedIpServerTargets]
  )
  const quotaReview = useMemo((): QuotaReviewItem[] => {
    const quotas = quotaQuery.data?.items ?? []
    const requested = [
      { label: 'Servers', value: reviewPlan.servers, quota: 'servers' },
      { label: 'vCPU', value: reviewPlan.vcpus, quota: 'cpus' },
      { label: 'RAM', value: reviewPlan.ram, quota: 'ramgib' },
      { label: 'Volumes', value: reviewPlan.volumes, quota: 'volumes' },
      {
        label: 'HDD',
        value: reviewPlan.hdd,
        quota: 'persistentdiskstandardgib',
      },
      { label: 'SSD', value: reviewPlan.ssd, quota: 'persistentdiskssdgib' },
      {
        label: 'Elastic IPs',
        value: reviewPlan.elasticIps,
        quota: 'elasticips',
      },
    ]
    return requested
      .filter((item) => item.value > 0)
      .map((item) => {
        const quota = quotaFor(quotas, item.quota)
        const used = Number(quota?.used ?? 0)
        const rawLimit = quota?.limit
        const limit =
          rawLimit == null ||
          !Number.isFinite(Number(rawLimit)) ||
          Number(rawLimit) < 0
            ? null
            : Number(rawLimit)
        const available = limit == null ? null : Math.max(0, limit - used)
        return {
          label: item.label,
          requested: item.value,
          used,
          limit,
          available,
          exceeded: limit != null && used + item.value > limit,
        }
      })
  }, [quotaQuery.data?.items, reviewPlan])
  const vpcInternetWarnings = useMemo((): VpcInternetReviewItem[] => {
    const subnetVpcIds = new Map(
      (reviewSubnetsQuery.data?.items ?? []).map((subnet) => {
        const vpc = subnet.vpc
        const vpcId =
          typeof vpc === 'object' && vpc
            ? String((vpc as Record<string, unknown>).id ?? '')
            : String(vpc ?? '')
        return [subnet.id, vpcId]
      })
    )
    const vpcsById = new Map(
      (reviewVpcsQuery.data?.items ?? []).map((vpc) => [vpc.id, vpc])
    )
    const vmPrivateIpSubnets = reviewServers
      .filter(
        (server) =>
          server.enable_ipv4 &&
          server.private_network_mode === 'subnet' &&
          server.subnet_id
      )
      .map((server) => server.subnet_id)
    return vmPrivateIpSubnets.flatMap((subnetId) => {
      const vpc = vpcsById.get(subnetVpcIds.get(subnetId) ?? '')
      return vpc?.internet_access === false
        ? [
            {
              vpcName: labelOf(vpc),
            },
          ]
        : []
    })
  }, [
    reviewServers,
    reviewSubnetsQuery.data?.items,
    reviewVpcsQuery.data?.items,
  ])
  const vpcInternetWarningNames = useMemo(
    () => [...new Set(vpcInternetWarnings.map((item) => item.vpcName))],
    [vpcInternetWarnings]
  )

  const loadTemporaryList = async () => {
    if (!token || !project.id || tempSaving || savedServerDraft.isFetching)
      return
    const result = await savedServerDraft.refetch()
    if (result.isError) {
      toast.error('Could not load temporary list.')
      return
    }
    const restored = Array.isArray(result.data?.servers)
      ? result.data.servers
      : []
    setServers(restored)
    setImportErrors(new Map())
    toast.success(`Temporary list loaded (${restored.length} server(s)).`)
  }

  const saveTemporaryList = async () => {
    if (!isAdmin) return toast.error('Administrator permission is required.')
    if (tempSaving) return
    setTempSaving(true)
    try {
      const { data } = await apiClient.put<SavedServerDraft>(
        '/provisioning/server-draft',
        { servers },
        { headers: { 'X-Cloud-Token': token, 'X-Project-Id': project.id } }
      )
      queryClient.setQueryData(['server-create-temp-draft', project.id], data)
      toast.success(`Temporary list saved (${servers.length} server(s)).`)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `Could not save temporary list: ${error.message}`
          : 'Could not save temporary list.'
      )
    } finally {
      setTempSaving(false)
    }
  }

  async function saveCloudInitTemplate() {
    if (!isAdmin) return toast.error('Administrator permission is required.')
    if (!cloudInitEditing?.name?.trim() || !cloudInitEditing.content?.trim())
      return toast.error('Template name and YAML content are required.')
    const payload = {
      name: cloudInitEditing.name.trim(),
      os_family: cloudInitEditing.os_family || 'any',
      description: cloudInitEditing.description || '',
      content: cloudInitEditing.content,
      is_active: cloudInitEditing.is_active !== false,
      is_starred: cloudInitEditing.is_starred === true,
    }
    if (cloudInitEditing.id)
      await apiClient.patch(
        `/cloud/cloud-init-templates/${cloudInitEditing.id}`,
        payload
      )
    else await apiClient.post('/cloud/cloud-init-templates', payload)
    await cloudInitTemplates.refetch()
    setCloudInitEditing(undefined)
    toast.success('Cloud-init template saved.')
  }
  async function toggleCloudInitTemplateStar(item: CloudInitTemplate) {
    if (!isAdmin) return toast.error('Administrator permission is required.')
    setCloudInitStarSaving(true)
    try {
      await apiClient.patch(`/cloud/cloud-init-templates/${item.id}`, {
        is_starred: !item.is_starred,
      })
      await cloudInitTemplates.refetch()
      setCloudInitPreview({ ...item, is_starred: !item.is_starred })
      setCloudInitStarChange(undefined)
    } finally {
      setCloudInitStarSaving(false)
    }
  }
  function copyCloudInitTemplate(item: CloudInitTemplate) {
    if (!isAdmin) return toast.error('Administrator permission is required.')
    setCloudInitPreview(undefined)
    setCloudInitEditing({
      name: `${item.name} copy`,
      os_family: item.os_family,
      description: item.description,
      content: item.content,
      is_active: item.is_active,
      is_starred: false,
    })
  }
  function deleteCloudInitTemplate(item: CloudInitTemplate) {
    if (!isAdmin) return toast.error('Administrator permission is required.')
    setCloudInitDelete(item)
  }
  async function confirmCloudInitDelete() {
    if (!isAdmin) return toast.error('Administrator permission is required.')
    if (!cloudInitDelete) return
    await apiClient.delete(`/cloud/cloud-init-templates/${cloudInitDelete.id}`)
    await cloudInitTemplates.refetch()
    setCloudInitDelete(undefined)
    setCloudInitEditing(undefined)
    toast.success('Cloud-init template deleted.')
  }

  const validation = useMemo(
    () =>
      new Map(
        servers.map((server) => [
          server.id,
          {
            ...validateTerraformServer(server, servers),
            ...(importErrors.get(server.id)
              ? { name: importErrors.get(server.id) }
              : {}),
          },
        ])
      ),
    [importErrors, servers]
  )

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const { data } = await apiClient.get<{ items: DeploymentHistory[] }>(
        '/provisioning/deployments',
        {
          params: { project_id: project.id, limit: 100 },
          headers: { 'X-Cloud-Token': token, 'X-Project-Id': project.id },
        }
      )
      setHistory(data.items)
    } finally {
      setHistoryLoading(false)
    }
  }, [project.id, token])
  const deleteHistory = async () => {
    if (!isAdmin) return toast.error('Administrator permission is required.')
    if (!historyDeleteIds.length || historyDeleting) return
    setHistoryDeleting(true)
    try {
      for (const deploymentId of historyDeleteIds) {
        await apiClient.delete(`/provisioning/deployments/${deploymentId}`, {
          headers: { 'X-Cloud-Token': token, 'X-Project-Id': project.id },
        })
      }
      const deleted = new Set(historyDeleteIds)
      setHistory((current) => current.filter((item) => !deleted.has(item.id)))
      if (historyDetail && deleted.has(historyDetail.id))
        setHistoryDetail(undefined)
      toast.success(`Deleted ${historyDeleteIds.length} deployment log(s).`)
      setHistoryDeleteIds([])
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `Could not delete deployment logs: ${error.message}`
          : 'Could not delete deployment logs.'
      )
      await loadHistory()
    } finally {
      setHistoryDeleting(false)
    }
  }
  useEffect(() => {
    if (!historyOpen) return
    const timer = window.setTimeout(() => {
      void loadHistory().catch(() =>
        toast.error('Could not load server creation history.')
      )
    }, 0)
    return () => window.clearTimeout(timer)
  }, [historyOpen, loadHistory])
  const refreshExecutionDetail = useCallback(async () => {
    if (!executionDetail?.id || resultRefreshing) return
    setResultRefreshing(true)
    try {
      const { data } = await apiClient.get<DeploymentDetail>(
        `/provisioning/deployments/${executionDetail.id}`,
        {
          // Guarded sequential mode already polls only the current server in
          // the backend. Avoid a second full-project inventory scan every 10s.
          params: {
            refresh_cloud:
              executionDetail.execution_mode !== 'guarded_sequential',
          },
          headers: { 'X-Cloud-Token': token, 'X-Project-Id': project.id },
        }
      )
      setExecutionDetail(data)
    } catch {
      /* retain the last result and retry */
    } finally {
      setResultRefreshing(false)
    }
  }, [executionDetail?.id, project.id, resultRefreshing, token])
  const controlSequentialDeployment = async (
    action: 'pause' | 'resume' | 'stop'
  ) => {
    if (!executionDetail?.id || executionControlLoading) return
    setExecutionControlLoading(true)
    try {
      const { data } = await apiClient.post<DeploymentDetail>(
        `/provisioning/deployments/${executionDetail.id}/control`,
        { action },
        { headers: { 'X-Cloud-Token': token, 'X-Project-Id': project.id } }
      )
      setExecutionDetail(data)
      toast.success(
        action === 'stop'
          ? 'Sequential creation will stop after the current check.'
          : `Deployment ${action}d.`
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `Could not ${action} deployment: ${error.message}`
          : `Could not ${action} deployment.`
      )
    } finally {
      setExecutionControlLoading(false)
    }
  }
  useEffect(() => {
    if (
      !executionDetail ||
      !['queued', 'running'].includes(executionDetail.status) ||
      isStable(executionDetail)
    )
      return
    const timer = window.setInterval(
      () => void refreshExecutionDetail(),
      resultRefreshMs
    )
    return () => window.clearInterval(timer)
  }, [executionDetail, refreshExecutionDetail, resultRefreshMs])

  function saveDraft() {
    if (!draft) return
    // GPU instances may be created without a block volume. Remove only the
    // untouched empty placeholder before saving; configured volumes remain.
    const volumeNormalizedDraft =
      draft.instance_family === 'gpu'
        ? {
            ...draft,
            volumes: draft.volumes.filter((volume) => volume.volume_type),
          }
        : draft
    const normalizedDraft = volumeNormalizedDraft.teleport_enabled
      ? volumeNormalizedDraft
      : {
          ...volumeNormalizedDraft,
          teleport_system: '',
          teleport_hostname: '',
          teleport_monitor_subnet_id: '',
          teleport_monitor_subnet_name: '',
          teleport_monitor_ip: '',
          cloud_init_variables: Object.fromEntries(
            Object.entries(draft.cloud_init_variables).filter(
              ([key]) => !key.startsWith('TP_') && key !== 'TELEPORT_ENABLE'
            )
          ),
        }
    const next = servers.some((item) => item.id === draft.id)
      ? servers.map((item) => (item.id === draft.id ? normalizedDraft : item))
      : [...servers, normalizedDraft]
    const nextErrors = validateTerraformServer(normalizedDraft, next)
    setErrors(nextErrors)
    const firstError = Object.keys(nextErrors)[0]
    if (firstError) {
      window.requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>(
          `[data-server-field="${firstError}"]`
        )
        target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        const control = target?.querySelector<HTMLElement>(
          'input, textarea, button, [role="combobox"]'
        )
        control?.focus()
      })
      return
    }
    setServers(next)
    setImportErrors((current) => {
      const nextMap = new Map(current)
      nextMap.delete(normalizedDraft.id)
      return nextMap
    })
    setDraft(undefined)
  }

  function copyServers(items: TerraformServerDraft[]) {
    const copies = items.map((server) => ({
      ...server,
      id: crypto.randomUUID(),
      name: `${server.name}-copy`,
      volumes: server.volumes.map((volume) => ({
        ...volume,
        id: crypto.randomUUID(),
      })),
    }))
    setServers((current) => [...current, ...copies])
    toast.success(
      copies.length === 1
        ? 'Server row copied.'
        : `${copies.length} server rows copied.`
    )
  }

  function copyServer(server: TerraformServerDraft) {
    copyServers([server])
  }

  async function fetchAll(path: string, params: Record<string, unknown> = {}, signal?: AbortSignal) {
    const first = (
      await apiClient.get<Page<CloudItem>>(path, {
        params: { ...params, page: 1, page_size: 200 },
        signal,
      })
    ).data
    const pages = Math.ceil(first.total / 200)
    if (pages <= 1) return first.items
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, index) =>
        apiClient.get<Page<CloudItem>>(path, {
          params: { ...params, page: index + 2, page_size: 200 },
          signal,
        })
      )
    )
    return [first.items, ...rest.map((response) => response.data.items)].flat()
  }

  const resourceText = (item: CloudItem, preferred?: string) =>
    String(
      (preferred && item[preferred]) ||
        item.name ||
        item.display_name ||
        item.id
    )
  const relationId = (value: unknown) =>
    typeof value === 'object' && value
      ? String(
          (value as Record<string, unknown>).id ||
            (value as Record<string, unknown>).region ||
            ''
        )
      : String(value || '')

  async function loadTemplateLookups(): Promise<TerraformTemplateLookups> {
    const zoneRows = await fetchAll('/cloud/zones')
    const [imageRows, keypairRows, subnetRows, elasticRows, cloudInitRows] =
      await Promise.all([
        fetchAll('/cloud/server-images'),
        fetchAll('/cloud/server-keypairs'),
        fetchAll('/cloud/subnets'),
        fetchAll('/cloud/server-elastic-ips'),
        fetchAll('/cloud/cloud-init-templates'),
      ])
    const zonesList: TemplateLookupItem[] = zoneRows.map((item) => ({
      id: item.id,
      text: labelOf(item),
      name: item.name,
      region_id: relationId(item.region),
    }))
    const regionIds = [
      ...new Set(zonesList.map((item) => item.region_id).filter(Boolean)),
    ]
    const [flavorSets, volumeSets, groupSets, placementSets, privateSets] =
      await Promise.all([
        Promise.all(
          zonesList.flatMap((zone) =>
            ['basic', 'gpu'].map(async (family) =>
              (
                await fetchAll('/cloud/server-flavors', {
                  zone: zone.id,
                  family,
                })
              ).map((item) => ({
                id: item.id,
                text: resourceText(item),
                name: item.name,
                zone_id: zone.id,
                family,
              }))
            )
          )
        ),
        Promise.all(
          zonesList.map(async (zone) =>
            (
              await fetchAll('/cloud/server-volume-types', { zone: zone.id })
            ).map((item) => ({
              id: item.id,
              text: labelOf(item),
              name: item.name,
              zone_id: zone.id,
            }))
          )
        ),
        Promise.all(
          regionIds.map(async (regionId) =>
            (
              await fetchAll('/cloud/server-security-groups', {
                region_id: regionId,
              })
            ).map((item) => ({
              id: item.id,
              text: labelOf(item),
              name: item.name,
              region_id: regionId,
            }))
          )
        ),
        Promise.all(
          regionIds.map(async (regionId) =>
            (
              await fetchAll('/cloud/server-placement-groups', {
                region_id: regionId,
              })
            ).map((item) => ({
              id: item.id,
              text: labelOf(item),
              name: item.name,
              region_id: regionId,
            }))
          )
        ),
        Promise.all(
          subnetRows.map(async (subnet) =>
            (
              await fetchAll('/cloud/private-ips', {
                subnet_id: subnet.id,
                available: true,
              })
            ).map((item) => ({
              id: item.id,
              text: resourceText(item, 'ip_address'),
              name: resourceText(item, 'ip_address'),
              subnet_id: subnet.id,
            }))
          )
        ),
      ])
    return {
      zones: zonesList,
      flavors: flavorSets.flat(),
      images: imageRows.map((item) => ({
        id: item.id,
        text: resourceText(item),
        name: item.name,
      })),
      keypairs: keypairRows.map((item) => ({
        id: item.id,
        text: labelOf(item),
        name: item.name,
      })),
      elasticIps: elasticRows
        .filter((item) => item.server == null)
        .map((item) => ({
          id: item.id,
          text: resourceText(item, 'ip_address'),
          name: resourceText(item, 'ip_address'),
        })),
      subnets: subnetRows.map((item) => ({
        id: item.id,
        text: labelOf(item),
        name: item.name,
        cidr: subnetCidrOf(item),
        vpc_cidr: vpcCidrOf(item),
      })),
      privateIps: privateSets.flat(),
      groups: groupSets.flat(),
      placementGroups: placementSets.flat(),
      volumeTypes: volumeSets.flat(),
      cloudInitTemplates: cloudInitRows
        .filter((item) => item.is_active !== false)
        .map((item) => ({
          id: item.id,
          text: labelOf(item),
          name: item.name,
          extra: String(item.content || ''),
        })),
    }
  }

  async function downloadTemplate(items = servers, suffix = 'template') {
    setTemplateLoading(true)
    try {
      const lookups = await loadTemplateLookups()
      const securityGroups = securityGroupSuggestions(lookups.groups)
      let templateItems = items.map((item) => ({
        ...item,
        teleport_monitor_subnet_name:
          item.teleport_monitor_subnet_name ||
          lookups.subnets.find(
            (subnet) => subnet.id === item.teleport_monitor_subnet_id
          )?.text ||
          '',
      }))
      let templateRows = templateItems.map(terraformServerTemplateRow)
      if (!templateItems.length) {
        const zone =
          lookups.zones.find(
            (item) =>
              lookups.flavors.some(
                (x) => x.zone_id === item.id && x.family === 'basic'
              ) && lookups.volumeTypes.some((x) => x.zone_id === item.id)
          ) || lookups.zones[0]
        const flavor = lookups.flavors.find(
          (item) => item.zone_id === zone?.id && item.family === 'basic'
        )
        const volume = lookups.volumeTypes.find(
          (item) => item.zone_id === zone?.id
        )
        const row = Object.fromEntries(
          terraformTemplateHeaders.map((header) => [header, ''])
        )
        Object.assign(row, {
          'SERVER NAME': 'app-01',
          'SERVER TYPE': 'basic',
          ZONE: zone?.text || '',
          'SPECS MODE': 'predefined',
          FLAVOR: flavor?.text || '',
          'RAM GB': '4',
          VCPUS: '2',
          BANDWIDTH: '300',
          'PUBLIC IMAGE': lookups.images[0]?.text || '',
          'KEY PAIR': lookups.keypairs[0]?.text || '',
          'ELASTIC IP ENABLED': 'no',
          'ELASTIC IP MODE': 'Auto Allocate',
          'ELASTIC IP': '',
          'ENABLE IPV4': 'yes',
          'PRIVATE IP MODE': 'Auto Allocate',
          SUBNET: lookups.subnets[0]?.text || '',
          'SECURITY GROUPS':
            lookups.groups.find((x) => x.region_id === zone?.region_id)?.text ||
            lookups.groups[0]?.text ||
            '',
          'PLACEMENT GROUP':
            lookups.placementGroups.find((x) => x.region_id === zone?.region_id)
              ?.text || '',
          'ROOT VOLUME': `root,${volume?.text || ''},50,/`,
          'OTHER VOLUMES': '',
          'CLOUD INIT ENABLED': 'no',
          TELEPORT_ENABLE: 'no',
          TP_REGION: 'public',
          TP_SYSTEM: 'teleport_system',
          TP_HOSTNAME: 'teleport_hostname',
          TP_SUBNET: lookups.subnets[0]?.text || '',
        })
        // A blank project may not have any Security Group yet.  This row is
        // only an Excel example, so it must not go through the strict import
        // validator (which correctly requires a group for actual creation).
        // Keep the cell blank in that case and let the user choose/type one.
        templateRows = [
          terraformTemplateHeaders.map((header) => row[header] || ''),
        ]
      }
      const validations = [
        { header: 'SERVER TYPE', values: ['basic', 'gpu'], allowBlank: false },
        {
          header: 'ZONE',
          values: lookups.zones.map((x) => x.text),
          allowBlank: false,
        },
        {
          header: 'SPECS MODE',
          values: ['predefined', 'custom'],
          allowBlank: false,
        },
        { header: 'FLAVOR', values: lookups.flavors.map((x) => x.text) },
        {
          header: 'PUBLIC IMAGE',
          values: lookups.images.map((x) => x.text),
          allowBlank: false,
        },
        {
          header: 'KEY PAIR',
          values: lookups.keypairs.map((x) => x.text),
          allowBlank: false,
        },
        {
          header: 'BANDWIDTH',
          values: [],
          type: 'whole' as const,
          min: 1,
          max: 10000,
          allowBlank: false,
        },
        {
          header: 'ELASTIC IP ENABLED',
          values: ['yes', 'no'],
          allowBlank: false,
        },
        {
          header: 'ELASTIC IP MODE',
          values: ['Auto Allocate', 'Select Existing', 'Manual create'],
        },
        { header: 'ELASTIC IP', values: lookups.elasticIps.map((x) => x.text) },
        { header: 'ENABLE IPV4', values: ['yes', 'no'], allowBlank: false },
        {
          header: 'PRIVATE IP MODE',
          values: [
            'Auto Allocate',
            'Select Existing',
            'Create ordered',
            'Manual create',
          ],
          allowBlank: false,
        },
        {
          header: 'SUBNET',
          values: lookups.subnets.map((x) => x.text),
          allowBlank: false,
        },
        {
          header: 'PRIVATE IP',
          values: lookups.privateIps.map((x) => x.text),
          enforce: false,
        },
        {
          header: 'SECURITY GROUPS',
          values: securityGroups,
          allowBlank: false,
          enforce: false,
        },
        {
          header: 'PLACEMENT GROUP',
          values: lookups.placementGroups.map((x) => x.text),
        },
        {
          header: 'ROOT VOLUME',
          values: lookups.volumeTypes.map((x) => `root,${x.text},50,/`),
          allowBlank: false,
          enforce: false,
        },
        {
          header: 'OTHER VOLUMES',
          values: lookups.volumeTypes.map((x) => `data,${x.text},50,/data`),
          enforce: false,
        },
        {
          header: 'CLOUD INIT ENABLED',
          values: ['yes', 'no'],
          allowBlank: false,
        },
        {
          header: 'CLOUD INIT TEMPLATE',
          values: lookups.cloudInitTemplates.map((x) => x.text),
        },
        { header: 'TELEPORT_ENABLE', values: ['yes', 'no'], allowBlank: false },
        { header: 'TP_REGION', values: ['public', 'vpublic'] },
        { header: 'TP_SUBNET', values: lookups.subnets.map((x) => x.text) },
        {
          header: 'TP_MONITOR_IP',
          values: lookups.privateIps.map((x) => x.text),
          enforce: false,
        },
      ]
      downloadXlsx(
        [...terraformTemplateHeaders],
        templateRows,
        `server-creation-${suffix}.xlsx`,
        {
          title: 'SERVER CREATION TEMPLATE',
          metadata: [
            { label: 'Project', value: project.name || project.id },
            {
              label: 'Instructions',
              value:
                'Use dropdown values. Separate multiple Security Groups with commas. If SG All exists, it is listed first and paired suggestions such as SG All, SG App are available. ROOT VOLUME and OTHER VOLUMES use mount_as,type,size,mount_point (examples: root,HDD,50,/ and data,SSD,100,/u01); put one other volume per line. TELEPORT_ENABLE requires CLOUD INIT ENABLED; TP_SUBNET selects the monitor-IP subnet.',
            },
          ],
          sheetName: 'Servers',
          validations,
        }
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `Template could not be prepared: ${error.message}`
          : 'Template could not be prepared.'
      )
    } finally {
      setTemplateLoading(false)
    }
  }

  async function importFile(file?: File) {
    if (!file) return
    setImportLoading(true)
    try {
      const rows = rowsFromHeader(parseXlsxRows(await file.arrayBuffer()), [
        ...terraformTemplateHeaders.filter(
          (header) => header !== 'ELASTIC IP MODE'
        ),
      ])
      const lookups = await loadTemplateLookups()
      const rowErrors = new Map<string, string>()
      const imported = rows.map((row, index) => {
        // Keep the valid part of a row usable even when one lookup value is
        // stale (for example an IP that became unavailable after the template
        // was exported).  The old behaviour replaced the entire row with an
        // empty draft, making every selector appear blank and hiding the
        // actual problem from the user.
        let candidate = { ...row }
        let lastError: unknown
        const invalidFields = new Set<string>()
        try {
          return terraformServerFromTemplate(candidate, lookups, index + 1)
        } catch (error) {
          lastError = error
        }

        // Retry after removing only the invalid field. This is deliberately
        // bounded and only used for import; normal Add/Edit validation remains
        // strict. Dependent values are cleared together where necessary.
        for (let attempt = 0; attempt < 64; attempt += 1) {
          const message =
            lastError instanceof Error
              ? lastError.message
              : 'Invalid imported row.'
          const field = message.match(/Row \d+, ([^:]+):/)?.[1]?.trim()
          if (!field) break
          invalidFields.add(field)
          const clear = (name: string) => {
            candidate[name] = ''
          }
          if (field === 'TP_MONITOR_IP' || field === 'TP_SUBNET') {
            // Choose an actual matching subnet/IP pair; using unrelated first
            // items made validation loop and eventually emptied the row.
            const fallbackIp = lookups.privateIps[0]
            const fallbackSubnet = lookups.subnets.find(
              (item) => item.id === fallbackIp?.subnet_id
            )
            candidate.TP_SUBNET = fallbackSubnet?.text || ''
            candidate.TP_MONITOR_IP = fallbackIp?.text || ''
            candidate.TELEPORT_ENABLE = 'yes'
          } else if (field === 'PRIVATE IP') {
            clear('PRIVATE IP')
            candidate['PRIVATE IP MODE'] = 'Auto Allocate'
          } else if (field === 'ELASTIC IP') {
            clear('ELASTIC IP')
            // Preserve the user's enabled switch; only the invalid address is
            // cleared for review.
          } else if (field === 'TELEPORT_ENABLE') {
            candidate.TELEPORT_ENABLE = 'no'
          } else if (
            field === 'CLOUD INIT TEMPLATE' ||
            field === 'CLOUD INIT'
          ) {
            if (field === 'CLOUD INIT TEMPLATE') {
              // Keep the user's enable switch. Use a valid template only as a
              // parsing placeholder, then clear the template/content on the
              // resulting draft so the row remains visibly enabled and is
              // flagged for correction.
              candidate['CLOUD INIT TEMPLATE'] =
                lookups.cloudInitTemplates[0]?.text || ''
              candidate['CLOUD INIT ENABLED'] = 'yes'
            } else {
              clear('CLOUD INIT TEMPLATE')
              candidate['CLOUD INIT ENABLED'] = 'no'
            }
          } else if (field.startsWith('OTHER VOLUMES')) {
            clear('OTHER VOLUMES')
          } else if (field.startsWith('SECURITY GROUPS')) {
            // The draft validator requires at least one group. Use a
            // temporary valid value to finish parsing, then clear it from the
            // resulting draft so only this column is marked for review.
            candidate['SECURITY GROUPS'] = lookups.groups[0]?.text || ''
          } else if (field === 'ZONE') {
            candidate.ZONE = lookups.zones[0]?.text || ''
          } else if (field === 'SERVER TYPE') {
            candidate['SERVER TYPE'] = 'basic'
          } else if (field === 'SPECS MODE') {
            candidate['SPECS MODE'] = 'custom'
          } else if (field === 'BANDWIDTH') {
            candidate.BANDWIDTH = '300'
          } else if (field === 'RAM GB/VCPUS') {
            candidate['RAM GB'] = '4'
            candidate.VCPUS = '2'
          } else if (field === 'FLAVOR') {
            candidate.FLAVOR = lookups.flavors[0]?.text || ''
          } else if (field === 'PUBLIC IMAGE') {
            candidate['PUBLIC IMAGE'] = lookups.images[0]?.text || ''
          } else if (field === 'KEY PAIR') {
            candidate['KEY PAIR'] = lookups.keypairs[0]?.text || ''
          } else if (field === 'SUBNET' || field === 'TP_SUBNET') {
            candidate[field] = lookups.subnets[0]?.text || ''
            if (field === 'TP_SUBNET') candidate.TELEPORT_ENABLE = 'no'
          } else if (field.startsWith('ROOT VOLUME')) {
            const volume =
              lookups.volumeTypes.find(
                (item) => item.zone_id === lookups.zones[0]?.id
              ) || lookups.volumeTypes[0]
            candidate['ROOT VOLUME'] = volume ? `root,${volume.text},50,/` : ''
          } else if (field.startsWith('OTHER VOLUMES')) {
            clear('OTHER VOLUMES')
          } else {
            clear(field)
          }
          try {
            const partial = terraformServerFromTemplate(
              candidate,
              lookups,
              index + 1
            )
            // Restore the UX contract: invalid spreadsheet columns are empty
            // in the editor, while the rest of the row remains populated.
            for (const invalid of invalidFields) {
              if (invalid === 'ZONE') {
                partial.zone_id = ''
                partial.zone_name = ''
              } else if (invalid === 'FLAVOR') partial.flavor_name = ''
              else if (invalid === 'PUBLIC IMAGE') {
                partial.image_id = ''
                partial.image_name = ''
                partial.image_display_name = ''
              } else if (invalid === 'KEY PAIR') {
                partial.key_pair_id = ''
                partial.key_pair_name = ''
              } else if (invalid === 'SUBNET') {
                partial.subnet_id = ''
                partial.subnet_display_name = ''
              } else if (invalid === 'SECURITY GROUPS') {
                partial.security_group_ids = []
                partial.security_group_names = []
              } else if (invalid.startsWith('ROOT VOLUME')) partial.volumes = []
              else if (invalid.startsWith('OTHER VOLUMES'))
                partial.volumes = partial.volumes.filter(
                  (v) => v.mount_as === 'root'
                )
              else if (invalid === 'TP_SUBNET') {
                partial.teleport_monitor_subnet_id = ''
                partial.teleport_monitor_subnet_name = row['TP_SUBNET'] || ''
                partial.teleport_monitor_ip = row['TP_MONITOR_IP'] || ''
                partial.teleport_enabled = true
              } else if (invalid === 'TP_MONITOR_IP') {
                partial.teleport_monitor_ip = row['TP_MONITOR_IP'] || ''
                partial.teleport_enabled = true
              } else if (invalid === 'TELEPORT_ENABLE') {
                partial.teleport_enabled = ['yes', 'true', '1', 'y'].includes(
                  String(row.TELEPORT_ENABLE || '')
                    .trim()
                    .toLowerCase()
                )
              } else if (invalid === 'ELASTIC IP') {
                partial.elastic_ip_id = ''
                partial.elastic_ip_address = row['ELASTIC IP'] || ''
                partial.elastic_ip_mode = 'existing'
              } else if (
                invalid === 'CLOUD INIT TEMPLATE' ||
                invalid === 'CLOUD INIT'
              ) {
                partial.cloud_init_enabled = invalid === 'CLOUD INIT TEMPLATE'
                partial.cloud_init_template_id = ''
                partial.cloud_init_template_name = ''
                partial.cloud_init_content = ''
              }
            }
            const id = partial.id
            rowErrors.set(id, message)
            return partial
          } catch (retryError) {
            lastError = retryError
          }
        }

        // Never replace a failed row with an empty draft. If several columns
        // are invalid, build a populated reviewable draft from the first
        // project resources and keep the original server name/toggles. This
        // prevents one bad lookup from erasing all other imported columns.
        const safeRow = { ...candidate }
        safeRow['SERVER TYPE'] = 'basic'
        safeRow.ZONE = lookups.zones[0]?.text || safeRow.ZONE || ''
        safeRow['SPECS MODE'] = 'predefined'
        safeRow.FLAVOR = lookups.flavors[0]?.text || ''
        safeRow['PUBLIC IMAGE'] = lookups.images[0]?.text || ''
        safeRow['KEY PAIR'] = lookups.keypairs[0]?.text || ''
        safeRow.SUBNET = lookups.subnets[0]?.text || ''
        safeRow['SECURITY GROUPS'] = lookups.groups[0]?.text || ''
        const safeVolume = lookups.volumeTypes[0]
        safeRow['ROOT VOLUME'] = safeVolume
          ? `root,${safeVolume.text},50,/`
          : 'root,HDD,50,/'
        safeRow['OTHER VOLUMES'] = ''
        const originalCloudInit = row['CLOUD INIT ENABLED']
        const originalTeleport = row.TELEPORT_ENABLE
        safeRow['CLOUD INIT ENABLED'] = originalCloudInit || 'no'
        safeRow['CLOUD INIT TEMPLATE'] =
          lookups.cloudInitTemplates[0]?.text || ''
        safeRow.TELEPORT_ENABLE = originalTeleport || 'no'
        const safeTeleportIp = lookups.privateIps[0]
        const safeTeleportSubnet = lookups.subnets.find(
          (item) => item.id === safeTeleportIp?.subnet_id
        )
        safeRow.TP_SUBNET = safeTeleportSubnet?.text || ''
        safeRow.TP_MONITOR_IP = safeTeleportIp?.text || ''
        let fallback: TerraformServerDraft
        try {
          fallback = terraformServerFromTemplate(safeRow, lookups, index + 1)
        } catch {
          fallback = emptyTerraformServer()
        }
        fallback.name = String(
          row['SERVER NAME'] || `Imported row ${index + 1}`
        )
        rowErrors.set(
          fallback.id,
          lastError instanceof Error
            ? lastError.message
            : 'Invalid imported row.'
        )
        return fallback
      })
      const all = [...servers, ...imported]
      setImportErrors((current) => new Map([...current, ...rowErrors]))
      setServers(all)
      toast.success(
        rowErrors.size
          ? `${rows.length} server(s) imported. ${rowErrors.size} row(s) need review.`
          : `${rows.length} server(s) imported.`
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import failed.')
    } finally {
      setImportLoading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function fromHistory(
    server: Record<string, unknown>,
    cloudInitTemplateItems = cloudInitTemplates.data?.items ?? []
  ): TerraformServerDraft {
    const base = emptyTerraformServer()
    const templateId = String(server.cloud_init_template_id ?? '')
    const currentTemplate = cloudInitTemplateItems.find(
      (template) => template.id === templateId
    )
    return {
      ...base,
      ...(server as unknown as TerraformServerDraft),
      // Reuse the currently selected template, rather than the historical
      // rendered cloud-init content or its deployment-specific variables.
      cloud_init_content: currentTemplate?.content ?? '',
      cloud_init_variables: {},
      bandwidth: Number(server.bandwidth) || 300,
      id: crypto.randomUUID(),
      volumes: Array.isArray(server.volumes)
        ? (server.volumes as ServerVolumeDraft[]).map((v) => ({
            ...v,
            id: crypto.randomUUID(),
          }))
        : base.volumes,
    }
  }

  async function fetchHistoryDetail(id: string) {
    const { data } = await apiClient.get<DeploymentDetail>(
      `/provisioning/deployments/${id}`,
      { headers: { 'X-Cloud-Token': token, 'X-Project-Id': project.id } }
    )
    return data
  }

  async function getHistoryDetail(id: string) {
    const data = await fetchHistoryDetail(id)
    setHistoryDetail(data)
    return data
  }

  async function importHistory(item: DeploymentHistory) {
    try {
      const [detail, templateResult] = await Promise.all([
        fetchHistoryDetail(item.id),
        cloudInitTemplates.refetch(),
      ])
      const imported = (detail.template?.servers ?? []).map((server) =>
        fromHistory(server, templateResult.data?.items ?? [])
      )
      setServers((current) => [...current, ...imported])
      setHistoryOpen(false)
      toast.success(`${imported.length} server(s) added to the creation table.`)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `Could not import this deployment: ${error.message}`
          : 'Could not import this deployment.'
      )
    }
  }

  async function importSelectedHistoryServers(
    detail: DeploymentDetail,
    selected: DeploymentServerResult[]
  ) {
    const selectedIds = new Set(selected.map((server) => server.id))
    const templateServers = detail.template?.servers ?? []
    const templateResult = await cloudInitTemplates.refetch()
    const imported = templateServers
      .filter((_, index) => selectedIds.has(detail.servers[index]?.id))
      .map((server) => fromHistory(server, templateResult.data?.items ?? []))

    if (!imported.length) {
      toast.error(
        'The selected server configurations are no longer available in this deployment template.'
      )
      return
    }

    setServers((current) => [...current, ...imported])
    setHistoryDetail(undefined)
    setHistoryOpen(false)
    const skipped = selected.length - imported.length
    toast.success(
      skipped
        ? `${imported.length} selected server(s) added. ${skipped} could not be matched to the saved template.`
        : `${imported.length} selected server(s) added to the creation table.`
    )
  }

  async function importFailedHistory(item: DeploymentHistory) {
    try {
      const [detail, templateResult] = await Promise.all([
        fetchHistoryDetail(item.id),
        cloudInitTemplates.refetch(),
      ])
      const imported = (detail.template?.servers ?? [])
        .filter((_, index) => detail.servers[index]?.status !== 'succeeded')
        .map((server) => fromHistory(server, templateResult.data?.items ?? []))
      if (!imported.length) {
        toast.info('Every server in this deployment was created successfully.')
        return
      }
      setServers((current) => [...current, ...imported])
      setHistoryOpen(false)
      toast.success(
        `${imported.length} unsuccessful server(s) added to the creation table.`
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `Could not import unsuccessful servers: ${error.message}`
          : 'Could not import unsuccessful servers.'
      )
    }
  }

  async function downloadHistory(item: DeploymentHistory) {
    try {
      const detail = await fetchHistoryDetail(item.id)
      downloadTemplate(
        (detail.template?.servers ?? []).map((server) => fromHistory(server)),
        item.id
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `Could not download this deployment: ${error.message}`
          : 'Could not download this deployment.'
      )
    }
  }

  async function deploy() {
    if (reviewServers.some(needsManualIps)) {
      toast.error('Create the manual IPs before deploying these VMs.')
      return
    }
    setSubmitting(true)
    try {
      const region =
        reviewServers[0]?.zone_name.replace(/[a-z]$/, '') || 'vn-central-1'
      const { data } = await apiClient.post<DeploymentDetail>(
        '/provisioning/deployments',
        {
          name: deploymentName.trim(),
          region,
          teleport_enabled: false,
          delay_between_create_ms: delayBetweenCreateMs,
          execution_mode: executionMode,
          wait_for_running_seconds: waitForRunningSeconds,
          compensation_limit: compensationLimit,
          failure_limit: failureLimit,
          servers: reviewServers.map((server) => ({
            ...server,
            zone: server.zone_name,
            security_groups: server.security_group_names,
            keypair: server.key_pair_name,
            subnet_name: server.subnet_display_name,
            // Provisioning uses monitor_ip for the cloud-side private-IP
            // attachment; keep the selected monitor subnet/id alongside it.
            monitor_ip: server.teleport_enabled
              ? server.teleport_monitor_ip
              : null,
            teleport_monitor_ip: server.teleport_enabled
              ? server.teleport_monitor_ip
              : null,
            teleport_monitor_subnet_id: server.teleport_enabled
              ? server.teleport_monitor_subnet_id
              : null,
            assign_public_ip: server.elastic_ip_mode !== 'none',
            boot_disk_gb:
              server.volumes.find((v) => v.mount_as === 'root')?.size ?? 50,
            disk_type: server.volumes[0]?.volume_type_name ?? '',
            data_disks: [],
          })),
        },
        { headers: { 'X-Cloud-Token': token, 'X-Project-Id': project.id } }
      )
      setExecutionDetail(data)
      setServers((current) =>
        current.filter(
          (item) => !reviewServers.some((selected) => selected.id === item.id)
        )
      )
      setReviewServers([])
      toast.success('Deployment queued.')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not create servers.'
      )
    } finally {
      setSubmitting(false)
    }
  }

  const createOrderedPrivateIps = async () => {
    if (!orderedIpTargets.length || orderedIpCreating) return
    setOrderedIpCreating(true)
    try {
      const { data } = await apiClient.post<{
        items: OrderedPrivateIpResult[]
      }>(
        '/cloud/private-ips/create-ordered',
        {
          items: orderedIpTargets.map((server) => ({
            server_draft_id: server.id,
            server_name: server.name,
            subnet_id: server.subnet_id,
          })),
          max_retries: orderedIpRetryLimit,
          reuse_available: reuseAvailableOrderedIp,
        },
        {
          headers: { 'X-Cloud-Token': token, 'X-Project-Id': project.id },
          // Ordered batches are sequential to preserve deterministic IPs.
          timeout: 300_000,
        }
      )
      setOrderedIpResults(data.items)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `Could not create ordered private IPs: ${error.message}`
          : 'Could not create ordered private IPs.'
      )
    } finally {
      setOrderedIpCreating(false)
    }
  }

  const applyManualIpResults = (results: ManualIpResult[]) => {
    const allocations = new Map(
      results.map((item) => [item.server_draft_id, item])
    )
    const originals = new Map(manualIpTargets.map((item) => [item.id, item]))
    const apply = (server: TerraformServerDraft) => {
      const result = allocations.get(server.id)
      const original = originals.get(server.id)
      return result && original
        ? applyManualIps(server, result, original)
        : server
    }
    setServers((current) => current.map(apply))
    setReviewServers((current) => current.map(apply))
    void queryClient.invalidateQueries({
      queryKey: ['server-create', project.id],
    })
    void queryClient.invalidateQueries({ queryKey: ['cloud', project.id] })
  }

  const applyOrderedPrivateIps = () => {
    const allocated = new Map(
      orderedIpResults
        .filter(
          (item) =>
            (item.status === 'completed' || item.status === 'reused') &&
            item.ip_id &&
            item.ip_address
        )
        .map((item) => [item.server_draft_id, item])
    )
    const apply = (server: TerraformServerDraft) => {
      const item = allocated.get(server.id)
      return item
        ? {
            ...server,
            private_ip_mode: 'existing' as const,
            eni_id: item.ip_id!,
            eni_address: item.ip_address!,
          }
        : server
    }
    setServers((current) => current.map(apply))
    setReviewServers((current) => current.map(apply))
    setOrderedIpServerTargets([])
    setOrderedIpOpen(false)
    setOrderedIpResults([])
    toast.success(`${allocated.size} private IP(s) linked to server drafts.`)
  }

  const columns = useMemo<ColumnDef<TerraformServerDraft>[]>(
    () => [
      {
        id: 'row_number',
        header: () => <span className='block w-6 text-center'>#</span>,
        cell: ({ row }) => (
          <span className='block w-6 text-center text-xs text-muted-foreground'>
            {row.index + 1}
          </span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server' />
        ),
        cell: ({ row }) => (
          <div>
            <p className='font-medium'>{row.original.name}</p>
            <p className='text-xs text-muted-foreground'>
              {row.original.image_display_name || row.original.image_name}
            </p>
          </div>
        ),
      },
      {
        id: 'zone_specs',
        header: 'Zone / Specs',
        accessorFn: (row) =>
          `${row.zone_name} ${row.specs_kind === 'custom' ? `${row.vcpus} vCPU ${row.ram} GB` : row.flavor_name}`,
        cell: ({ row }) => (
          <div className='max-w-44 space-y-0.5 text-xs leading-4'>
            <p className='truncate' title={row.original.zone_name}>
              <span className='text-muted-foreground'>Zone:</span>{' '}
              {row.original.zone_name || '—'}
            </p>
            <p className='truncate' title={row.original.flavor_name}>
              <span className='text-muted-foreground'>Specs:</span>{' '}
              {row.original.specs_kind === 'custom'
                ? `${row.original.vcpus} vCPU / ${row.original.ram} GB`
                : row.original.flavor_name || '—'}
            </p>
          </div>
        ),
      },
      {
        id: 'network',
        header: 'Network / IP',
        accessorFn: (row) =>
          `${row.subnet_display_name}${row.private_ip_mode === 'existing' ? ` · ${row.eni_address}` : row.private_ip_mode === 'ordered' ? ' · Create ordered' : row.private_ip_mode === 'manual' ? ' · Manual create' : ' · Auto'}${row.elastic_ip_mode === 'manual' ? ' · Elastic Manual create' : ''}`,
        cell: ({ row }) => (
          <div className='max-w-56 space-y-0.5 text-xs leading-4'>
            {row.original.enable_ipv4 && (
              <p className='truncate'>
                <span className='text-muted-foreground'>Private:</span>{' '}
                {row.original.private_ip_mode === 'existing'
                  ? row.original.eni_address || '—'
                  : row.original.private_ip_mode === 'manual'
                    ? `Manual create · ${(row.original.subnet_display_name || '—').split(' - ')[0]}`
                    : row.original.private_ip_mode === 'ordered'
                      ? `Create ordered · ${(row.original.subnet_display_name || '—').split(' - ')[0]}`
                      : (row.original.subnet_display_name || '—').split(
                          ' - '
                        )[0]}
              </p>
            )}
            <p className='hidden'>
              <span className='text-muted-foreground'>Private:</span>{' '}
              {(row.original.subnet_display_name || '—').split(' - ')[0]}
            </p>
            <p className='hidden'>
              <span className='text-muted-foreground'>Private:</span>{' '}
              {row.original.subnet_display_name || '—'}
            </p>
            <p className='hidden'>
              {row.original.private_ip_mode === 'existing'
                ? `Selected ${row.original.eni_address || '—'}`
                : `Auto · ${row.original.subnet_display_name || 'subnet not selected'}`}
            </p>
            {row.original.elastic_ip_mode !== 'none' && (
              <p className='truncate'>
                <span className='text-muted-foreground'>Elastic:</span>{' '}
                {row.original.elastic_ip_mode === 'manual'
                  ? 'Manual create'
                  : row.original.elastic_ip_address || 'Auto / None'}
              </p>
            )}
          </div>
        ),
      },
      {
        id: 'teleport_monitor_ip',
        header: 'Teleport',
        accessorFn: (row) =>
          row.teleport_enabled
            ? `${row.teleport_monitor_ip} ${row.teleport_region} ${row.teleport_system} ${row.teleport_hostname}`
            : 'Disabled',
        cell: ({ row }) => (
          <div className='max-w-56 space-y-0.5 text-xs leading-4'>
            {false && row.original.teleport_enabled && (
              <>
                <p className='truncate'>
                  IP: {row.original.teleport_monitor_ip || '—'}
                </p>
                <p className='truncate'>
                  Region: {row.original.teleport_region || 'public'}
                </p>
                <p className='truncate'>
                  <span className='text-muted-foreground'>System:</span>{' '}
                  {row.original.teleport_system || '—'}
                </p>
                <p className='truncate'>
                  <span className='text-muted-foreground'>Host:</span>{' '}
                  {row.original.teleport_hostname || '—'}
                </p>
              </>
            )}
            {false && row.original.teleport_enabled && (
              <>
                <p className='truncate'>
                  {row.original.teleport_region === 'vpublic' ? 'vpub' : 'pub'}{' '}
                  · {row.original.teleport_monitor_ip || '—'}
                </p>
                <p className='truncate'>
                  <span className='text-muted-foreground'>System:</span>{' '}
                  {row.original.teleport_system || '—'}
                </p>
                <p className='truncate'>
                  <span className='text-muted-foreground'>Host:</span>{' '}
                  {row.original.teleport_hostname || '—'}
                </p>
              </>
            )}
            {false && row.original.teleport_enabled && (
              <>
                <p
                  className='truncate'
                  title={row.original.teleport_monitor_ip}
                >
                  <span className='text-muted-foreground'>Region:</span>{' '}
                  {row.original.teleport_region === 'vpublic' ? 'vpub' : 'pub'}{' '}
                  · <span className='text-muted-foreground'>IP:</span>{' '}
                  {row.original.teleport_monitor_ip || '—'}
                </p>
                <p className='truncate' title={row.original.teleport_system}>
                  <span className='text-muted-foreground'>System:</span>{' '}
                  {row.original.teleport_system || '—'}
                </p>
                <p className='truncate' title={row.original.teleport_hostname}>
                  <span className='text-muted-foreground'>Host:</span>{' '}
                  {row.original.teleport_hostname || '—'}
                </p>
              </>
            )}
            {false && row.original.teleport_enabled && (
              <>
                <p className='truncate'>
                  <span className='text-muted-foreground'>
                    {row.original.teleport_region === 'vpublic'
                      ? 'vpub'
                      : 'pub'}
                    :
                  </span>{' '}
                  {row.original.teleport_monitor_ip || '—'}
                </p>
                <p className='truncate'>
                  System: {row.original.teleport_system || '—'}
                </p>
                <p className='truncate'>
                  Host: {row.original.teleport_hostname || '—'}
                </p>
              </>
            )}
            {row.original.teleport_enabled && (
              <>
                <p className='truncate'>
                  <span className='text-muted-foreground'>
                    {row.original.teleport_region === 'vpublic'
                      ? 'vpub'
                      : 'pub'}
                    :
                  </span>{' '}
                  {row.original.teleport_monitor_ip || '—'}
                </p>
                <p className='truncate'>
                  <span className='text-muted-foreground'>System:</span>{' '}
                  {row.original.teleport_system || '—'}
                </p>
                <p className='truncate'>
                  <span className='text-muted-foreground'>Host:</span>{' '}
                  {row.original.teleport_hostname || '—'}
                </p>
              </>
            )}
            {false && row.original.teleport_monitor_ip}
          </div>
        ),
      },
      {
        id: 'security_groups',
        header: 'Security Groups',
        accessorFn: (row) => row.security_group_names.join(', '),
        cell: ({ row }) => (
          <div className='max-w-52 space-y-0.5 text-xs leading-4'>
            {row.original.security_group_names.length ? (
              row.original.security_group_names.map((name) => (
                <p key={name} className='truncate' title={name}>
                  {name}
                </p>
              ))
            ) : (
              <span className='text-muted-foreground'>None</span>
            )}
          </div>
        ),
      },
      {
        id: 'volumes',
        header: 'Volumes',
        accessorFn: (row) =>
          row.volumes
            .map(
              (v) => `${diskKind(v.volume_type_name)} ${v.size}GB ${v.mount_as}`
            )
            .join(', '),
        cell: ({ row }) => (
          <div className='space-y-0.5'>
            {row.original.volumes.map((volume) => (
              <p key={`summary-${volume.id}`} className='hidden'>
                <strong>
                  {diskKind(volume.volume_type_name)} · {volume.size}GB ·{' '}
                  {volume.mount_as} · ({volume.mount_point || '/'})
                </strong>
              </p>
            ))}
            {row.original.volumes.map((volume) => (
              <p
                key={`display-${volume.id}`}
                className='truncate text-xs whitespace-nowrap'
              >
                <strong>
                  {diskKind(volume.volume_type_name)} · {volume.size}GB
                </strong>{' '}
                · {volume.mount_as} · ({volume.mount_point || '/'})
              </p>
            ))}
            {row.original.volumes.map((volume) => (
              <p key={volume.id} className='hidden'>
                <span className='font-medium'>
                  {diskKind(volume.volume_type_name)}
                </span>{' '}
                <span className='text-muted-foreground'>
                  ({volume.mount_point || '/'})
                </span>{' '}
                · {volume.size}GB · {volume.mount_as}
              </p>
            ))}
          </div>
        ),
      },
      {
        id: 'cloud_init',
        header: 'Cloud-init',
        accessorFn: (row) => (row.cloud_init_enabled ? 'Enabled' : 'Disabled'),
        cell: ({ row }) => (
          <div className='max-w-44 space-y-0.5 text-xs leading-4'>
            <Badge
              variant={
                row.original.cloud_init_enabled ? 'secondary' : 'outline'
              }
            >
              {row.original.cloud_init_enabled
                ? false
                  ? 'On · Teleport'
                  : 'On'
                : 'Off'}
            </Badge>
            {row.original.cloud_init_enabled && (
              <p
                className='hidden'
                title={
                  row.original.cloud_init_template_name || 'Inline cloud-init'
                }
              >
                {row.original.cloud_init_template_name || 'Inline cloud-init'}
                {row.original.teleport_enabled ? ' · Teleport' : ''}
              </p>
            )}
            {row.original.cloud_init_enabled && (
              <p
                className='truncate'
                title={
                  row.original.cloud_init_template_name || 'Inline cloud-init'
                }
              >
                {row.original.cloud_init_template_name || 'Inline cloud-init'}
              </p>
            )}
          </div>
        ),
      },
      {
        id: 'details',
        header: 'Details',
        accessorFn: (row) =>
          `${row.key_pair_name} ${row.placement_group_name} ${row.bandwidth}`,
        cell: ({ row }) => (
          <div className='max-w-48 space-y-0.5 text-xs leading-4'>
            <p className='truncate' title={row.original.key_pair_name}>
              <span className='text-muted-foreground'>Key:</span>{' '}
              {row.original.key_pair_name || '—'}
            </p>
            <p className='truncate' title={row.original.placement_group_name}>
              <span className='text-muted-foreground'>Placement:</span>{' '}
              {row.original.placement_group_name || '—'}
            </p>
            {false && (
              <p>
                <span className='text-muted-foreground'>IPv4:</span>{' '}
                {row.original.enable_ipv4 ? 'On' : 'Off'} ·{' '}
                {row.original.bandwidth} Mbps
              </p>
            )}
          </div>
        ),
      },
      {
        id: 'bandwidth',
        header: 'Bandwidth',
        accessorFn: (row) => row.bandwidth,
        size: 80,
        cell: ({ row }) => (
          <span className='text-xs whitespace-nowrap'>
            {row.original.bandwidth} Mbps
          </span>
        ),
      },
      {
        id: 'validation',
        header: 'Status',
        accessorFn: (row) => Object.keys(validation.get(row.id) ?? {}).length,
        cell: ({ row }) =>
          Object.keys(validation.get(row.original.id) ?? {}).length ? (
            <Badge variant='destructive'>Needs review</Badge>
          ) : (
            <Badge variant='secondary'>Ready</Badge>
          ),
      },
      {
        id: 'actions',
        enableHiding: false,
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant='ghost' size='icon' aria-label='Server actions'>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
              <DropdownMenuItem onClick={() => copyServer(row.original)}>
                <Copy /> Copy row
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setErrors({})
                  setDraft(structuredClone(row.original))
                }}
              >
                <Pencil /> Edit server
              </DropdownMenuItem>
              <DropdownMenuItem
                variant='destructive'
                onClick={() => setDeleteIds([row.original.id])}
              >
                <Trash2 /> Delete server
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [validation]
  )

  const historyColumns: ColumnDef<DeploymentHistory>[] = [
    {
      id: 'index',
      header: '#',
      cell: ({ row }) => (
        <span className='text-muted-foreground'>{row.index + 1}</span>
      ),
      enableSorting: false,
    },
    {
      accessorKey: 'name',
      header: 'Deployment',
      cell: ({ row }) => (
        <div>
          <p className='font-medium'>{row.original.name}</p>
          <p className='text-xs text-muted-foreground'>
            {new Date(row.original.created_at).toLocaleString()}
          </p>
        </div>
      ),
    },
    {
      id: 'server_names',
      header: 'Servers',
      accessorFn: (row) => (row.server_names ?? []).join(', '),
      cell: ({ row }) => {
        const names = row.original.server_names ?? []
        const remaining = Math.max(0, row.original.total_items - names.length)
        return (
          <div className='max-w-72 text-xs'>
            <span className='line-clamp-2'>{names.join(', ') || '—'}</span>
            {remaining > 0 && (
              <span className='text-muted-foreground'>+{remaining} more</span>
            )}
          </div>
        )
      },
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <Badge
          variant={
            row.original.status === 'failed' ? 'destructive' : 'secondary'
          }
        >
          {row.original.status}
        </Badge>
      ),
    },
    {
      id: 'completed_at',
      header: 'Completed',
      accessorFn: (row) => row.completed_at || '',
      cell: ({ row }) =>
        row.original.completed_at ? (
          <div className='text-xs leading-4'>
            <p className='font-medium text-foreground tabular-nums'>
              {elapsedTime(row.original.started_at, row.original.completed_at)}
            </p>
            <p className='text-muted-foreground'>
              {dateTime(row.original.completed_at)}
            </p>
          </div>
        ) : (
          <span className='text-xs text-muted-foreground'>In progress</span>
        ),
    },
    {
      id: 'result',
      header: 'Result',
      accessorFn: (row) => `${row.succeeded_items}/${row.total_items}`,
      cell: ({ row }) => {
        const total = row.original.total_items
        const succeeded = row.original.succeeded_items
        const failed = row.original.failed_items
        const percent = total
          ? Math.min(100, Math.round((succeeded / total) * 100))
          : 0
        return (
          <div className='min-w-28 space-y-1.5 text-xs'>
            <div className='flex items-center justify-between gap-2 tabular-nums'>
              <span className='font-medium'>
                {succeeded}/{total}
              </span>
              <span className='text-muted-foreground'>{percent}%</span>
            </div>
            <div
              className='h-1.5 overflow-hidden rounded-full bg-muted'
              role='progressbar'
              aria-label='Successful server creation result'
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div
                className='h-full rounded-full bg-emerald-500 transition-[width] duration-300'
                style={{ width: `${percent}%` }}
              />
            </div>
            {failed > 0 && <p className='text-destructive'>{failed} failed</p>}
          </div>
        )
      },
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant='ghost' size='icon' aria-label='History actions'>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            <DropdownMenuItem
              onClick={() => void downloadHistory(row.original)}
            >
              <Download /> Download template
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void importHistory(row.original)}>
              <Upload /> Import to list
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void importFailedHistory(row.original)}
            >
              <Upload /> Import failed to list
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void getHistoryDetail(row.original.id)}
            >
              <Eye /> View details
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ]

  return (
    <CloudPageShell
      title='Create servers'
      description={`Prepare servers for ${project.name || project.id}.`}
      actions={
        <div className='flex gap-2'>
          <Button
            variant='outline'
            onClick={() => setCloudInitManagerOpen(true)}
          >
            <FileCode2 /> Cloud-init templates
          </Button>
          <Button
            variant='outline'
            onClick={() => {
              setHistoryLoading(true)
              setHistoryOpen(true)
            }}
          >
            <History /> History
          </Button>
          <Button
            onClick={() => {
              setErrors({})
              setDraft(emptyTerraformServer())
            }}
          >
            <Plus /> Add server
          </Button>
        </div>
      }
    >
      <Card className='overflow-hidden'>
        <div className='flex flex-wrap items-center justify-between gap-2 border-b px-4 py-1.5'>
          <div className='flex items-center gap-2'>
            <CardTitle className='text-sm'>Servers to create</CardTitle>
            <CardDescription>
              {selectedServers.length
                ? `Selected ${displayedPlan.servers}/${serverPlan.servers}`
                : `${displayedPlan.servers} servers`}{' '}
              · {displayedPlan.vcpus} vCPU · {displayedPlan.ram} GB RAM ·{' '}
              {displayedPlan.volumes} volumes / {displayedPlan.disk} GiB
              {displayedPlan.elasticIps
                ? ` · ${displayedPlan.elasticIps} new Elastic IP`
                : ''}
            </CardDescription>
          </div>
          <div className='flex gap-2'>
            <Button
              size='sm'
              variant='outline'
              disabled={
                !isAdmin ||
                !token ||
                !project.id ||
                tempSaving ||
                savedServerDraft.isFetching
              }
              onClick={() => void saveTemporaryList()}
              title='Replace the saved temporary list for this project'
            >
              {tempSaving ? (
                <Loader2 className='animate-spin' />
              ) : (
                <FileCode2 />
              )}
              Save temp
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={
                !token ||
                !project.id ||
                tempSaving ||
                savedServerDraft.isFetching
              }
              onClick={() => void loadTemporaryList()}
              title='Load the saved temporary list for this project'
            >
              {savedServerDraft.isFetching ? (
                <Loader2 className='animate-spin' />
              ) : (
                <FolderOpen />
              )}
              Load temp
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={templateLoading}
              onClick={() => void downloadTemplate()}
            >
              <Download />{' '}
              {templateLoading ? 'Loading project data...' : 'Template'}
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={importLoading}
              onClick={() => fileRef.current?.click()}
            >
              {importLoading ? (
                <Loader2 className='animate-spin' />
              ) : (
                <Upload />
              )}{' '}
              {importLoading ? 'Importing...' : 'Import'}
            </Button>
            <input
              ref={fileRef}
              type='file'
              accept='.xlsx'
              className='hidden'
              onChange={(event) => void importFile(event.target.files?.[0])}
            />
          </div>
        </div>
        <CardContent className='px-4 pt-1'>
          <CloudDataTable
            data={servers}
            columns={columns}
            getRowId={(row) => row.id}
            onSelectedRowsChange={onSelectedServersChange}
            entityName='server'
            emptyText='No servers prepared.'
            exportFileName='servers-to-create'
            toolbar={(selected) => (
              <div className='flex shrink-0 flex-nowrap items-center gap-2 whitespace-nowrap'>
                <Button
                  size='sm'
                  className='shrink-0'
                  disabled={
                    !selected.length ||
                    selected.some(
                      (item) =>
                        item.private_ip_mode === 'ordered' ||
                        needsManualIps(item)
                    ) ||
                    selected.some(
                      (item) =>
                        Object.keys(validation.get(item.id) ?? {}).length
                    )
                  }
                  onClick={() => {
                    setExecutionMode('guarded_sequential')
                    setReviewServers(selected)
                  }}
                >
                  Review & Create ({selected.length})
                </Button>
                <Button
                  size='sm'
                  className='shrink-0'
                  disabled={!selected.some(needsManualIps)}
                  onClick={() => {
                    setManualIpProjectId(project.id)
                    setManualIpTargets(selected.filter(needsManualIps))
                  }}
                >
                  Create random IPs ({selected.filter(needsManualIps).length})
                </Button>
                <Button
                  size='sm'
                  className='shrink-0'
                  disabled={
                    !selected.length ||
                    !selected.some((item) => item.private_ip_mode === 'ordered')
                  }
                  onClick={() => {
                    const targets = selected.filter(
                      (item) => item.private_ip_mode === 'ordered'
                    )
                    setOrderedIpServerTargets(targets)
                    setOrderedIpRetryLimit(
                      Math.max(1, Math.ceil(targets.length / 3))
                    )
                    setReuseAvailableOrderedIp(true)
                    setOrderedIpResults([])
                    setOrderedIpOpen(true)
                  }}
                >
                  Create private IPs (
                  {
                    selected.filter(
                      (item) => item.private_ip_mode === 'ordered'
                    ).length
                  }
                  )
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  className='shrink-0'
                  disabled={!selected.length || templateLoading}
                  onClick={() =>
                    void downloadTemplate(selected, 'selected-servers')
                  }
                >
                  <Download /> Export Template ({selected.length})
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  className='shrink-0'
                  disabled={!selected.length}
                  onClick={() => copyServers(selected)}
                >
                  <Copy /> Copy selected ({selected.length})
                </Button>
                <Button
                  size='sm'
                  variant='destructive'
                  className='shrink-0'
                  disabled={!selected.length}
                  onClick={() => setDeleteIds(selected.map((item) => item.id))}
                >
                  <Trash2 /> Delete selected ({selected.length})
                </Button>
              </div>
            )}
          />
        </CardContent>
      </Card>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Server Creation History</DialogTitle>
            <DialogDescription>
              Reuse a previous deployment or open its complete execution
              details.
            </DialogDescription>
          </DialogHeader>
          {historyLoading && history.length > 0 && (
            <p
              role='status'
              className='flex items-center gap-2 text-sm text-muted-foreground'
            >
              <Loader2 className='size-4 animate-spin' /> Loading data...
            </p>
          )}
          <CloudDataTable
            data={history}
            loading={historyLoading}
            columns={historyColumns}
            getRowId={(row) => row.id}
            entityName='deployment'
            enableSelection={isAdmin}
            isRowSelectable={(row) =>
              !['queued', 'running', 'paused', 'stopping'].includes(row.status)
            }
            toolbar={
              isAdmin
                ? (selected, clearSelection) => (
                    <Button
                      type='button'
                      variant='destructive'
                      size='sm'
                      disabled={!selected.length}
                      onClick={() => {
                        setHistoryDeleteIds(selected.map((item) => item.id))
                        clearSelection()
                      }}
                    >
                      <Trash2 /> Delete logs ({selected.length})
                    </Button>
                  )
                : undefined
            }
            emptyText='No deployment history.'
            exportFileName='server-creation-history'
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(historyDetail)}
        onOpenChange={(open) => !open && setHistoryDetail(undefined)}
      >
        <DialogContent className='max-h-[92vh] overflow-y-auto sm:max-w-7xl'>
          <DialogHeader>
            <DialogTitle>{historyDetail?.name}</DialogTitle>
            <DialogDescription>
              {historyDetail &&
                `${historyDetail.status} · ${historyDetail.succeeded_items} succeeded · ${historyDetail.failed_items} failed · ${new Date(historyDetail.created_at).toLocaleString()}`}
            </DialogDescription>
          </DialogHeader>
          {historyDetail && (
            <ServerResultsTable
              detail={historyDetail}
              compact
              onViewDetail={setResultServerDetail}
              onImportSelected={(selected) =>
                importSelectedHistoryServers(historyDetail, selected)
              }
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(executionDetail)}
        onOpenChange={(open) => !open && setExecutionCloseConfirm(true)}
      >
        <DialogContent className='max-h-[92vh] overflow-y-auto sm:max-w-7xl'>
          <DialogHeader>
            <div className='flex flex-wrap items-center justify-between gap-3 pe-8'>
              <DialogTitle>Server creation results</DialogTitle>
              <div className='flex flex-wrap items-center justify-end gap-2'>
                {executionDetail?.execution_mode === 'guarded_sequential' &&
                  ['queued', 'running', 'paused'].includes(
                    executionDetail.status
                  ) && (
                    <div className='flex items-center gap-1 rounded-md border bg-muted/30 p-1'>
                      <Button
                        type='button'
                        variant='outline'
                        size='icon'
                        className='size-7'
                        title={
                          executionDetail.status === 'paused'
                            ? 'Resume creation'
                            : 'Pause creation'
                        }
                        aria-label={
                          executionDetail.status === 'paused'
                            ? 'Resume creation'
                            : 'Pause creation'
                        }
                        disabled={executionControlLoading}
                        onClick={() =>
                          void controlSequentialDeployment(
                            executionDetail.status === 'paused'
                              ? 'resume'
                              : 'pause'
                          )
                        }
                      >
                        {executionDetail.status === 'paused' ? (
                          <Play className='size-3.5' />
                        ) : (
                          <Pause className='size-3.5' />
                        )}
                      </Button>
                      <Button
                        type='button'
                        variant='destructive'
                        size='icon'
                        className='size-7'
                        title='Stop sequential creation'
                        aria-label='Stop sequential creation'
                        disabled={executionControlLoading}
                        onClick={() => void controlSequentialDeployment('stop')}
                      >
                        <Square className='size-3.5 fill-current' />
                      </Button>
                    </div>
                  )}
                <div className='flex items-center gap-1 rounded-md border bg-background/80 p-1'>
                  <label className='flex items-center gap-1.5 px-1 text-xs text-muted-foreground'>
                    <span className='sr-only'>Refresh interval</span>
                    <select
                      aria-label='Result refresh interval'
                      value={resultRefreshMs}
                      onChange={(event) =>
                        setResultRefreshMs(Number(event.target.value))
                      }
                      className='h-7 rounded-md border bg-background px-2 text-xs text-foreground'
                    >
                      <option value={10_000}>10 seconds</option>
                      <option value={20_000}>20 seconds</option>
                      <option value={30_000}>30 seconds</option>
                      <option value={60_000}>1 minute</option>
                    </select>
                  </label>
                  <Button
                    type='button'
                    variant='outline'
                    size='icon'
                    className='size-7'
                    title='Refresh now'
                    aria-label='Refresh now'
                    onClick={() => void refreshExecutionDetail()}
                    disabled={resultRefreshing}
                  >
                    <RefreshCw
                      className={resultRefreshing ? 'animate-spin' : undefined}
                    />
                  </Button>
                </div>
              </div>
            </div>
            <DialogDescription>
              {executionDetail &&
                (executionDetail.status === 'paused'
                  ? 'Sequential creation is paused. Resume to continue with the current server.'
                  : executionDetail.status === 'stopped'
                    ? `Stopped: ${executionDetail.succeeded_items} succeeded, ${executionDetail.failed_items} failed.`
                    : isStable(executionDetail)
                      ? `Completed: ${executionDetail.succeeded_items} succeeded, ${executionDetail.failed_items} failed.`
                      : `Creating servers and refreshing cloud status every ${resultRefreshMs / 1000} seconds…`)}
            </DialogDescription>
            {executionDetail && (
              <div className='mt-3 rounded-md border bg-muted/30 px-3 py-2.5'>
                <div className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs'>
                  <span className='font-medium text-foreground'>
                    {executionSucceeded}/{executionTotal} servers created
                    successfully
                  </span>
                  <span className='text-muted-foreground tabular-nums'>
                    {executionProgress}%
                    {executionFailed ? ` · ${executionFailed} failed` : ''}
                  </span>
                </div>
                <div
                  className='mt-2 h-2 overflow-hidden rounded-full bg-muted'
                  role='progressbar'
                  aria-label='Successful server creation progress'
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={executionProgress}
                >
                  <div
                    className='h-full rounded-full bg-emerald-500 transition-[width] duration-500'
                    style={{ width: `${executionProgress}%` }}
                  />
                </div>
              </div>
            )}
          </DialogHeader>
          {executionDetail && (
            <ServerResultsTable
              detail={executionDetail}
              compact
              onViewDetail={setResultServerDetail}
            />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={executionCloseConfirm}
        onOpenChange={setExecutionCloseConfirm}
        title='Close server creation results?'
        desc={
          <p>
            {executionDetail && !isStable(executionDetail)
              ? 'Server creation is still running. Closing this window does not stop it; you can open the results again from Server Creation History.'
              : 'This will close the current deployment result view.'}
          </p>
        }
        cancelBtnText='Keep watching'
        confirmText='Close results'
        handleConfirm={() => {
          setExecutionCloseConfirm(false)
          setExecutionDetail(undefined)
        }}
      />
      <Dialog
        open={Boolean(resultServerDetail)}
        onOpenChange={(open) => !open && setResultServerDetail(undefined)}
      >
        <DialogContent className='max-h-[90vh] min-w-0 overflow-hidden p-0 sm:max-w-4xl'>
          <DialogHeader className='border-b px-5 py-4'>
            <DialogTitle>
              Server detail: {resultServerDetail?.server_name}
            </DialogTitle>
            <DialogDescription>
              Creation result, Cloud API power state, request and response.
            </DialogDescription>
          </DialogHeader>
          {resultServerDetail && (
            <div className='min-w-0 space-y-3 overflow-y-auto px-5 py-4 text-sm'>
              <div className='grid gap-2 sm:grid-cols-3'>
                <div>
                  <span className='text-muted-foreground'>Creation</span>
                  <p className='font-medium'>{resultServerDetail.status}</p>
                </div>
                <div>
                  <span className='text-muted-foreground'>Server ID</span>
                  <p className='font-mono text-xs break-all'>
                    {resultServerDetail.server_id || '—'}
                  </p>
                </div>
                <div>
                  <span className='text-muted-foreground'>Power state</span>
                  <p className='font-medium'>
                    {String(
                      resultServerDetail.result?.cloud_state || 'pending'
                    )}
                  </p>
                </div>
              </div>
              {creationErrorText(resultServerDetail) && (
                <Alert variant='destructive'>
                  <AlertTitle>
                    {resultServerDetail.error_code || 'Creation error'}
                  </AlertTitle>
                  <AlertDescription className='whitespace-pre-wrap'>
                    <span className='break-words'>
                      {creationErrorText(resultServerDetail)}
                    </span>
                  </AlertDescription>
                </Alert>
              )}
              <div>
                <Label>Cloud API response</Label>
                <pre className='max-h-72 max-w-full overflow-auto rounded bg-muted p-3 text-xs break-words whitespace-pre-wrap'>
                  {creationResponseText(resultServerDetail)}
                </pre>
              </div>
              <div>
                <Label>Request</Label>
                <pre className='max-h-72 max-w-full overflow-auto rounded bg-muted p-3 text-xs break-words whitespace-pre-wrap'>
                  {jsonText(resultServerDetail.request)}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <SectionedEditServerDialog
        draft={draft}
        setDraft={setDraft}
        errors={errors}
        setErrors={setErrors}
        save={saveDraft}
        zones={zones}
        flavors={flavors}
        images={images}
        keypairs={keypairs}
        subnets={subnets}
        privateIps={privateIps}
        monitorPrivateIps={monitorPrivateIps}
        groups={groups}
        placementGroups={placementGroups}
        volumeTypes={volumeTypes}
        elasticIps={elasticIps}
        cloudInitTemplates={cloudInitTemplates.data?.items ?? []}
      />

      <Dialog
        open={cloudInitManagerOpen}
        onOpenChange={setCloudInitManagerOpen}
      >
        <DialogContent className='sm:max-w-6xl'>
          <DialogHeader>
            <DialogTitle>Cloud-init templates</DialogTitle>
            <DialogDescription>
              Store reusable YAML as plain text. Nothing is sent unless a server
              explicitly selects a template.
            </DialogDescription>
          </DialogHeader>
          <div className='grid max-h-[65vh] min-h-0 gap-4 overflow-hidden md:grid-cols-[1fr_1.3fr]'>
            <div className='flex min-h-0 flex-col gap-2 rounded-lg bg-muted/20 p-2'>
              <p className='text-xs font-medium text-muted-foreground'>
                {cloudInitTemplates.data?.items.length ?? 0} templates
              </p>
              <div className='flex items-center gap-2'>
                <Input
                  className='min-w-0 flex-1'
                  value={cloudInitSearch}
                  onChange={(event) => setCloudInitSearch(event.target.value)}
                  placeholder='Search templates...'
                />
                {isAdmin && (
                  <Button
                    size='sm'
                    className='shrink-0'
                    onClick={() =>
                      setCloudInitEditing({
                        name: '',
                        os_family: 'any',
                        description: '',
                        content: '#cloud-config\n',
                        is_active: true,
                        is_starred: false,
                      })
                    }
                  >
                    <Plus /> Add
                  </Button>
                )}
              </div>
              <div className='min-h-0 flex-1 space-y-2 overflow-y-auto pr-1'>
                {(cloudInitTemplates.data?.items ?? [])
                  .filter((item) => {
                    const q = cloudInitSearch.trim().toLowerCase()
                    return (
                      !q ||
                      item.name.toLowerCase().includes(q) ||
                      item.description.toLowerCase().includes(q) ||
                      item.os_family.toLowerCase().includes(q)
                    )
                  })
                  .sort(
                    (left, right) =>
                      Number(right.is_starred) - Number(left.is_starred) ||
                      left.name.localeCompare(right.name)
                  )
                  .map((item) => (
                    <div
                      key={item.id}
                      onClick={() => {
                        setCloudInitPreview(item)
                        setCloudInitEditing(undefined)
                      }}
                      className={`group flex cursor-pointer items-start justify-between gap-2 rounded-md border bg-background p-3 transition-colors ${cloudInitPreview?.id === item.id ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'hover:border-primary/40'}`}
                    >
                      <div>
                        <div className='flex items-center gap-2'>
                          <p className='font-medium'>{item.name}</p>
                          {item.is_starred && (
                            <Star className='size-3.5 fill-amber-400 text-amber-500' />
                          )}
                        </div>
                        <p className='text-xs text-muted-foreground'>
                          <span className='font-semibold text-primary uppercase'>
                            {item.os_family}
                          </span>{' '}
                          · {item.description || 'No description'}
                        </p>
                      </div>
                      {isAdmin && (
                        <div className='flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100'>
                          <Button
                            size='icon'
                            variant='ghost'
                            title={
                              item.is_starred
                                ? 'Remove priority'
                                : 'Mark as priority'
                            }
                            aria-label={
                              item.is_starred
                                ? 'Remove priority'
                                : 'Mark as priority'
                            }
                            onClick={(event) => {
                              event.stopPropagation()
                              setCloudInitStarChange(item)
                            }}
                          >
                            <Star
                              className={
                                item.is_starred
                                  ? 'fill-amber-400 text-amber-500'
                                  : ''
                              }
                            />
                          </Button>
                          <Button
                            size='icon'
                            variant='ghost'
                            title='Copy as new template'
                            aria-label='Copy as new template'
                            onClick={(event) => {
                              event.stopPropagation()
                              copyCloudInitTemplate(item)
                            }}
                          >
                            <Copy />
                          </Button>
                          <Button
                            size='icon'
                            variant='ghost'
                            onClick={(event) => {
                              event.stopPropagation()
                              setCloudInitEditing({ ...item })
                              setCloudInitPreview(item)
                            }}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            size='icon'
                            variant='ghost'
                            onClick={(event) => {
                              event.stopPropagation()
                              void deleteCloudInitTemplate(item)
                            }}
                          >
                            <Trash2 className='text-destructive' />
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </div>
            <div className='min-h-0 space-y-3 overflow-y-auto pr-1'>
              {cloudInitEditing ? (
                <>
                  <div className='grid gap-3 sm:grid-cols-2'>
                    <div className='space-y-1'>
                      <Label>Name</Label>
                      <Input
                        value={cloudInitEditing.name || ''}
                        onChange={(event) =>
                          setCloudInitEditing({
                            ...cloudInitEditing,
                            name: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div className='space-y-1'>
                      <Label>OS family</Label>
                      <Segmented
                        value={cloudInitEditing.os_family || 'any'}
                        values={[
                          { value: 'any', label: 'Any' },
                          { value: 'ubuntu', label: 'Ubuntu' },
                          { value: 'centos', label: 'CentOS' },
                          { value: 'debian', label: 'Debian' },
                          { value: 'windows', label: 'Windows' },
                          { value: 'oracle', label: 'Oracle' },
                        ]}
                        onChange={(os_family) =>
                          setCloudInitEditing({
                            ...cloudInitEditing,
                            os_family,
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className='space-y-1'>
                    <Label>Description</Label>
                    <Input
                      value={cloudInitEditing.description || ''}
                      onChange={(event) =>
                        setCloudInitEditing({
                          ...cloudInitEditing,
                          description: event.target.value,
                        })
                      }
                    />
                  </div>
                  <label className='flex items-center gap-2 rounded-md border px-3 py-2 text-sm'>
                    <Checkbox
                      checked={cloudInitEditing.is_active !== false}
                      onCheckedChange={(value) =>
                        setCloudInitEditing({
                          ...cloudInitEditing,
                          is_active: value === true,
                        })
                      }
                    />
                    Available for server creation
                  </label>
                  <div className='space-y-1'>
                    <div className='flex items-center justify-between'>
                      <Label>Cloud-init YAML</Label>
                      <span className='text-xs text-muted-foreground'>
                        Supports {'{{server_name}}'} and TP_* variables
                      </span>
                    </div>
                    <Textarea
                      className='h-[28rem] max-h-[70vh] min-h-64 resize-y overflow-auto font-mono text-xs'
                      value={cloudInitEditing.content || ''}
                      onChange={(event) =>
                        setCloudInitEditing({
                          ...cloudInitEditing,
                          content: event.target.value,
                        })
                      }
                    />
                  </div>
                </>
              ) : cloudInitPreview ? (
                <div className='min-h-0 space-y-3 rounded-lg border bg-muted/10 p-4'>
                  <div className='flex items-start justify-between gap-3'>
                    <div className='min-w-0'>
                      <h3 className='truncate font-semibold'>
                        {cloudInitPreview.name}
                      </h3>
                      <p className='text-sm text-muted-foreground'>
                        {cloudInitPreview.description || 'No description'}
                      </p>
                    </div>
                    <span className='shrink-0 text-xs font-semibold text-primary uppercase'>
                      {cloudInitPreview.os_family}
                    </span>
                  </div>
                  <pre className='max-h-[55vh] overflow-auto rounded-md bg-muted p-3 text-xs break-words whitespace-pre-wrap'>
                    {cloudInitPreview.content}
                  </pre>
                </div>
              ) : (
                <div className='flex min-h-72 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground'>
                  Select a template or create a new one.
                </div>
              )}
            </div>
          </div>
          {isAdmin && (
            <DialogFooter className='sticky bottom-0 border-t bg-background pt-3'>
              <Button
                variant='outline'
                onClick={() => setCloudInitEditing(undefined)}
                disabled={!cloudInitEditing}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void saveCloudInitTemplate()}
                disabled={!cloudInitEditing}
              >
                Save template
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={reviewServers.length > 0}
        onOpenChange={(open) => !open && setReviewServers([])}
      >
        <DialogContent className='sm:max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Review & Create</DialogTitle>
            <DialogDescription>
              {reviewServers.length} selected server(s) are ready to create.
            </DialogDescription>
          </DialogHeader>
          <Segmented
            value={executionMode}
            onChange={setExecutionMode}
            values={[
              { value: 'guarded_sequential', label: 'Sequential guarded' },
              { value: 'standard', label: 'Standard' },
            ]}
          />
          <div className='grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.55fr)]'>
            <div className='rounded-lg border bg-muted/20 px-3 py-2.5'>
              <div className='flex items-center justify-between gap-3'>
                <div>
                  <p className='text-sm font-medium'>Quota review</p>
                  <p className='text-xs text-muted-foreground'>
                    Planned capacity is compared with the active project quota.
                    Warnings do not block creation.
                  </p>
                </div>
                <Button
                  size='icon'
                  variant='ghost'
                  className='size-8 shrink-0'
                  onClick={() => void quotaQuery.refetch()}
                  disabled={quotaQuery.isFetching}
                  title='Refresh quota'
                >
                  <RefreshCw
                    className={quotaQuery.isFetching ? 'animate-spin' : ''}
                  />
                </Button>
              </div>
              {quotaQuery.isLoading ? (
                <div className='mt-2 flex items-center gap-2 text-xs text-muted-foreground'>
                  <Loader2 className='size-3.5 animate-spin' /> Checking project
                  quota…
                </div>
              ) : quotaQuery.isError ? (
                <p className='mt-2 text-xs text-amber-700 dark:text-amber-400'>
                  Quota could not be checked. You can still continue creating
                  servers.
                </p>
              ) : (
                <>
                  <div className='mt-2 flex flex-wrap gap-1.5'>
                    {quotaReview.map((item) => (
                      <span
                        key={item.label}
                        className={`rounded border px-2 py-1 text-xs tabular-nums ${
                          item.exceeded
                            ? 'border-destructive/35 bg-destructive/10 text-destructive'
                            : 'border-border bg-background text-muted-foreground'
                        }`}
                      >
                        <span className='font-medium text-foreground'>
                          {item.label}
                        </span>{' '}
                        +{item.requested} ·{' '}
                        {item.limit == null
                          ? 'quota unavailable'
                          : `${item.available} free / ${item.limit}`}
                      </span>
                    ))}
                  </div>
                  {quotaReview.some((item) => item.exceeded) && (
                    <p className='mt-2 text-xs font-medium text-destructive'>
                      Warning: one or more requested resources exceed the
                      remaining quota. Creation remains available and may be
                      rejected by Cloud API.
                    </p>
                  )}
                </>
              )}
            </div>
            <div
              className={`rounded-lg border px-3 py-2.5 ${
                vpcInternetWarnings.length
                  ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100'
                  : 'bg-muted/20 text-foreground'
              }`}
            >
              <div className='flex items-center justify-between gap-3'>
                <div>
                  <p className='text-sm font-medium'>VPC internet access</p>
                  <p className='text-xs text-muted-foreground'>
                    Private-IP VPC status
                  </p>
                </div>
                <Button
                  size='icon'
                  variant='ghost'
                  className='size-8 shrink-0'
                  onClick={() => void reviewVpcsQuery.refetch()}
                  disabled={reviewVpcsQuery.isFetching}
                  title='Refresh VPCs'
                >
                  <RefreshCw
                    className={reviewVpcsQuery.isFetching ? 'animate-spin' : ''}
                  />
                </Button>
              </div>
              {reviewVpcsQuery.isLoading || reviewSubnetsQuery.isLoading ? (
                <div className='mt-2 flex items-center gap-2 text-xs text-muted-foreground'>
                  <Loader2 className='size-3.5 animate-spin' /> Checking VPC
                  internet access…
                </div>
              ) : reviewVpcsQuery.isError || reviewSubnetsQuery.isError ? (
                <p className='mt-2 text-xs text-muted-foreground'>
                  VPC status unavailable.
                </p>
              ) : vpcInternetWarnings.length ? (
                <p className='mt-2 text-xs font-medium'>
                  Internet disabled: {vpcInternetWarningNames.join(', ')}
                </p>
              ) : (
                <p className='mt-2 text-xs text-muted-foreground'>
                  Internet access enabled.
                </p>
              )}
            </div>
          </div>
          <div className='grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]'>
            <div className='space-y-1.5'>
              <Label htmlFor='deployment-name'>Create name</Label>
              <Input
                id='deployment-name'
                value={deploymentName}
                onChange={(event) => setDeploymentName(event.target.value)}
                placeholder='e.g. Production app servers'
                maxLength={160}
              />
              <p className='text-xs text-muted-foreground'>
                Name this deployment for history.
              </p>
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='delay-between-create'>
                Delay between creates
              </Label>
              <div className='flex items-center gap-2'>
                <Input
                  id='delay-between-create'
                  type='number'
                  min={0}
                  max={60000}
                  step={50}
                  value={delayBetweenCreateMs}
                  onChange={(event) =>
                    setDelayBetweenCreateMs(
                      Math.max(
                        0,
                        Math.min(60000, Number(event.target.value) || 0)
                      )
                    )
                  }
                />
                <span className='text-sm text-muted-foreground'>ms</span>
              </div>
              <p className='text-xs text-muted-foreground'>
                {executionMode === 'guarded_sequential'
                  ? 'Applied after a server is confirmed running.'
                  : 'Delay between Cloud API create calls.'}
              </p>
            </div>
          </div>
          {executionMode === 'guarded_sequential' && (
            <div className='grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-3'>
              <div className='space-y-1.5'>
                <Label htmlFor='running-timeout'>Running timeout</Label>
                <div className='flex items-center gap-2'>
                  <Input
                    id='running-timeout'
                    type='number'
                    min={10}
                    max={3600}
                    value={waitForRunningSeconds}
                    onChange={(event) =>
                      setWaitForRunningSeconds(
                        Math.max(
                          10,
                          Math.min(3600, Number(event.target.value) || 120)
                        )
                      )
                    }
                  />
                  <span className='text-xs text-muted-foreground'>sec</span>
                </div>
                <p className='text-xs text-muted-foreground'>
                  Wait for running before the next server.
                </p>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='compensation-limit'>Max replacements</Label>
                <Input
                  id='compensation-limit'
                  type='number'
                  min={0}
                  max={100}
                  value={compensationLimit}
                  onChange={(event) =>
                    setCompensationLimit(
                      Math.max(
                        0,
                        Math.min(100, Number(event.target.value) || 0)
                      )
                    )
                  }
                />
                <p className='text-xs text-muted-foreground'>
                  Create a “-recovery-N” replacement when a server is not
                  running.
                </p>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='failure-limit'>Max failed attempts</Label>
                <Input
                  id='failure-limit'
                  type='number'
                  min={0}
                  max={100}
                  value={failureLimit}
                  onChange={(event) =>
                    setFailureLimit(
                      Math.max(
                        0,
                        Math.min(100, Number(event.target.value) || 0)
                      )
                    )
                  }
                />
                <p className='text-xs text-muted-foreground'>
                  Stop once failures exceed this limit.
                </p>
              </div>
            </div>
          )}
          <div className='max-h-[55vh] overflow-auto rounded-md border'>
            <table className='w-full text-left text-sm'>
              <thead className='sticky top-0 bg-muted/95 text-xs'>
                <tr>
                  <th className='w-12 px-3 py-2 font-medium'>#</th>
                  <th className='px-3 py-2 font-medium'>Server</th>
                  <th className='px-3 py-2 font-medium'>Zone</th>
                  <th className='px-3 py-2 font-medium'>Specs</th>
                  <th className='px-3 py-2 font-medium'>Network / IP</th>
                  <th className='px-3 py-2 font-medium'>Security Groups</th>
                  <th className='px-3 py-2 font-medium'>Volumes</th>
                </tr>
              </thead>
              <tbody>
                {reviewServers.map((server, index) => (
                  <tr key={server.id} className='border-t align-top'>
                    <td className='px-3 py-2 text-xs text-muted-foreground tabular-nums'>
                      {index + 1}
                    </td>
                    <td className='px-3 py-2 font-medium'>{server.name}</td>
                    <td className='px-3 py-2'>{server.zone_name}</td>
                    <td className='px-3 py-2'>
                      {server.specs_kind === 'custom'
                        ? `${server.vcpus}C / ${server.ram}GB`
                        : server.flavor_name}
                    </td>
                    <td className='px-3 py-2'>
                      <div>{server.subnet_display_name}</div>
                      <div className='text-xs text-muted-foreground'>
                        {server.private_ip_mode === 'existing'
                          ? server.eni_address
                          : server.private_ip_mode === 'manual'
                            ? 'Manual create'
                            : server.private_ip_mode === 'ordered'
                              ? 'Create ordered'
                              : 'Auto IP'}
                      </div>
                    </td>
                    <td className='max-w-52 px-3 py-2'>
                      {server.security_group_names.join(', ')}
                    </td>
                    <td className='px-3 py-2 whitespace-nowrap'>
                      {server.volumes
                        .map((volume) => `${volume.mount_as}: ${volume.size}GB`)
                        .join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DialogFooter className='sticky bottom-0 border-t bg-background pt-3'>
            <Button variant='outline' onClick={() => setReviewServers([])}>
              Cancel
            </Button>
            <Button
              disabled={
                submitting ||
                !deploymentName.trim() ||
                orderedIpTargets.length > 0 ||
                reviewServers.some(needsManualIps)
              }
              onClick={() => void deploy()}
            >
              {submitting ? 'Creating...' : 'Confirm Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {manualIpTargets.length > 0 && (
        <ManualIpDialog
          servers={manualIpTargets}
          projectId={manualIpProjectId}
          onApply={applyManualIpResults}
          onClose={() => setManualIpTargets([])}
        />
      )}
      <Dialog
        open={orderedIpOpen}
        onOpenChange={(open) => !orderedIpCreating && setOrderedIpOpen(open)}
      >
        <DialogContent className='sm:max-w-3xl'>
          <DialogHeader>
            <DialogTitle>Create ordered private IPs</DialogTitle>
            <DialogDescription>
              Addresses are allocated sequentially from the beginning of each
              selected subnet, then linked only after you confirm.
            </DialogDescription>
          </DialogHeader>
          {!orderedIpResults.length && (
            <div className='flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2'>
              <label className='flex items-center gap-2 text-xs font-medium'>
                <Checkbox
                  checked={reuseAvailableOrderedIp}
                  onCheckedChange={(value) =>
                    setReuseAvailableOrderedIp(value === true)
                  }
                />
                Use matching available IP first
              </label>
              <div className='flex items-center gap-2'>
                <Label htmlFor='ordered-ip-retries' className='text-xs'>
                  Max new-IP retries
                </Label>
                <Input
                  id='ordered-ip-retries'
                  className='h-8 w-20'
                  type='number'
                  min={0}
                  max={200}
                  value={orderedIpRetryLimit}
                  onChange={(event) =>
                    setOrderedIpRetryLimit(
                      Math.max(
                        0,
                        Math.min(200, Number(event.target.value) || 0)
                      )
                    )
                  }
                />
              </div>
              <p className='basis-full text-xs text-muted-foreground'>
                Reuse only the next sequential available address; otherwise
                create it. Failed creates retry once before moving to the next
                IP.
              </p>
            </div>
          )}
          <div className='max-h-[48vh] overflow-auto rounded-md border'>
            <table className='w-full text-left text-sm'>
              <thead className='sticky top-0 bg-muted text-xs'>
                <tr>
                  <th className='w-12 px-3 py-2'>#</th>
                  <th className='px-3 py-2'>Server</th>
                  <th className='px-3 py-2'>Subnet</th>
                  <th className='px-3 py-2'>Private IP</th>
                  <th className='px-3 py-2'>Result</th>
                </tr>
              </thead>
              <tbody>
                {(orderedIpResults.length
                  ? orderedIpResults
                  : orderedIpTargets
                ).map((item, index) => {
                  if ('server_draft_id' in item) {
                    return (
                      <tr key={item.server_draft_id} className='border-t'>
                        <td className='px-3 py-2 text-muted-foreground'>
                          {index + 1}
                        </td>
                        <td className='px-3 py-2 font-medium'>
                          {item.server_name}
                        </td>
                        <td className='px-3 py-2'>{item.subnet_id}</td>
                        <td className='px-3 py-2 font-mono'>
                          {item.ip_address || '—'}
                        </td>
                        <td
                          className={
                            item.status === 'failed'
                              ? 'px-3 py-2 text-destructive'
                              : 'px-3 py-2 text-emerald-600'
                          }
                        >
                          {item.status === 'completed'
                            ? 'Created'
                            : item.status === 'reused'
                              ? 'Used available'
                              : item.error || 'Failed'}
                        </td>
                      </tr>
                    )
                  }
                  return (
                    <tr key={item.id} className='border-t'>
                      <td className='px-3 py-2 text-muted-foreground'>
                        {index + 1}
                      </td>
                      <td className='px-3 py-2 font-medium'>{item.name}</td>
                      <td className='px-3 py-2'>{item.subnet_display_name}</td>
                      <td className='px-3 py-2 font-mono'>—</td>
                      <td className='px-3 py-2 text-muted-foreground'>Ready</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            {!orderedIpResults.length ? (
              <>
                <Button
                  variant='outline'
                  disabled={orderedIpCreating}
                  onClick={() => setOrderedIpOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={orderedIpCreating}
                  onClick={() => void createOrderedPrivateIps()}
                >
                  {orderedIpCreating && <Loader2 className='animate-spin' />}
                  Create IPs
                </Button>
              </>
            ) : (
              <Button onClick={applyOrderedPrivateIps}>
                OK · use successful IPs
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={historyDeleteIds.length > 0}
        onOpenChange={(open) => !open && setHistoryDeleteIds([])}
        title='Delete deployment logs?'
        desc={`Delete ${historyDeleteIds.length} completed deployment log(s)? Cloud servers are not affected.`}
        cancelBtnText='Keep logs'
        confirmText='Delete logs'
        destructive
        isLoading={historyDeleting}
        handleConfirm={() => void deleteHistory()}
      />
      <ConfirmDialog
        open={deleteIds.length > 0}
        onOpenChange={(open) => !open && setDeleteIds([])}
        title='Remove servers?'
        desc={`Remove ${deleteIds.length} server(s) from this list?`}
        destructive
        handleConfirm={() => {
          setServers((current) =>
            current.filter((item) => !deleteIds.includes(item.id))
          )
          setDeleteIds([])
        }}
      />
      <ConfirmDialog
        open={Boolean(cloudInitDelete)}
        onOpenChange={(open) => !open && setCloudInitDelete(undefined)}
        title='Delete cloud-init template?'
        desc={`Delete “${cloudInitDelete?.name || ''}”? Existing deployment history will remain unchanged.`}
        destructive
        handleConfirm={() => void confirmCloudInitDelete()}
      />
      <ConfirmDialog
        open={Boolean(cloudInitStarChange)}
        onOpenChange={(open) => !open && setCloudInitStarChange(undefined)}
        title={
          cloudInitStarChange?.is_starred
            ? 'Remove template priority?'
            : 'Prioritize template?'
        }
        desc={
          cloudInitStarChange?.is_starred
            ? `Remove the priority star from “${cloudInitStarChange.name}”?`
            : `Mark “${cloudInitStarChange?.name || ''}” as a priority template? It will appear first in this list.`
        }
        confirmText={
          cloudInitStarChange?.is_starred ? 'Remove priority' : 'Mark priority'
        }
        isLoading={cloudInitStarSaving}
        handleConfirm={() => {
          if (cloudInitStarChange)
            void toggleCloudInitTemplateStar(cloudInitStarChange)
        }}
      />
    </CloudPageShell>
  )
}

type QueryResult = { data?: Page<CloudItem>; isLoading: boolean }
function FormSection({
  number,
  title,
  description,
  children,
  enabled,
  onEnabledChange,
  action,
}: {
  number: number
  title: string
  description: string
  children: ReactNode
  enabled?: boolean
  onEnabledChange?: (enabled: boolean) => void
  action?: ReactNode
}) {
  return (
    <section className='overflow-hidden rounded-lg border bg-card'>
      <div className='flex items-start justify-between gap-3 border-b bg-muted/30 px-4 py-2.5'>
        <div className='flex items-start gap-3'>
          <span className='flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground'>
            {number}
          </span>
          <div className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
            <h3 className='text-sm font-semibold'>{title}</h3>
            <p className='text-xs text-muted-foreground'>{description}</p>
          </div>
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          {action}
          {onEnabledChange && (
            <label className='flex shrink-0 items-center gap-2 text-xs font-medium'>
              <Checkbox
                checked={enabled}
                onCheckedChange={(value) => onEnabledChange(value === true)}
              />
              Enable
            </label>
          )}
        </div>
      </div>
      <div className='grid gap-3 p-3 sm:grid-cols-2'>{children}</div>
    </section>
  )
}

function HighlightedCloudInitPreview({
  value,
  variables,
}: {
  value: string
  variables: Array<{ key: string; value: string }>
}) {
  const valueToKey = new Map<string, string>()
  variables.forEach(({ key, value: resolvedValue }) => {
    if (resolvedValue.trim().length >= 2 && !valueToKey.has(resolvedValue))
      valueToKey.set(resolvedValue, key)
  })
  const values = [...valueToKey.keys()].sort((a, b) => b.length - a.length)
  const matcher = values.length
    ? new RegExp(
        `(${values.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
        'g'
      )
    : undefined
  const parts = matcher ? value.split(matcher) : [value]

  return (
    <div
      role='textbox'
      aria-readonly='true'
      aria-label='Rendered Cloud-init preview'
      className='h-72 max-h-[60vh] min-h-40 resize-y overflow-auto rounded-md border bg-muted/25 p-3 font-mono text-xs leading-5 whitespace-pre-wrap'
    >
      {parts.map((part, index) => {
        const key = valueToKey.get(part)
        return key ? (
          <mark
            key={`${index}-${part}`}
            title={`Resolved from {{${key}}}`}
            className='rounded bg-amber-200/80 px-0.5 text-foreground ring-1 ring-amber-400/60 dark:bg-amber-500/30 dark:ring-amber-500/50'
          >
            {part}
          </mark>
        ) : (
          <span key={`${index}-${part}`}>{part}</span>
        )
      })}
    </div>
  )
}

function SectionedEditServerDialog({
  draft,
  setDraft,
  errors,
  setErrors,
  save,
  zones,
  flavors,
  images,
  keypairs,
  subnets,
  privateIps,
  monitorPrivateIps,
  groups,
  placementGroups,
  volumeTypes,
  elasticIps,
  cloudInitTemplates,
}: {
  draft?: TerraformServerDraft
  setDraft: (value?: TerraformServerDraft) => void
  errors: TerraformServerFieldErrors
  setErrors: (errors: TerraformServerFieldErrors) => void
  save: () => void
  zones: QueryResult
  flavors: QueryResult
  images: QueryResult
  keypairs: QueryResult
  subnets: QueryResult
  privateIps: QueryResult
  monitorPrivateIps: QueryResult
  groups: QueryResult
  placementGroups: QueryResult
  volumeTypes: QueryResult
  elasticIps: QueryResult
  cloudInitTemplates: CloudInitTemplate[]
}) {
  const [volumeHelpOpen, setVolumeHelpOpen] = useState(false)
  const [securityGroupPickerOpen, setSecurityGroupPickerOpen] = useState(false)
  const [cloudInitVariablesOpen, setCloudInitVariablesOpen] = useState(false)
  const [cloudInitPreviewSplit, setCloudInitPreviewSplit] = useState(50)
  const cloudInitEditorRef = useRef<HTMLTextAreaElement>(null)
  const cloudInitSplitRef = useRef<HTMLDivElement>(null)
  const startWindowPointerDrag = useWindowPointerDrag(Boolean(draft))
  if (!draft) return null
  const saveWithTeleportIpCheck = () => {
    if (!draft.teleport_enabled) {
      save()
      return
    }
    const monitorIp = draft.teleport_monitor_ip.trim()
    const exists = (monitorPrivateIps.data?.items ?? []).some((item) => {
      const value = String(item.ip_address || item.name || item.id)
      return value === monitorIp && item.server == null
    })
    if (!monitorIp || !exists) {
      setErrors({
        ...errors,
        teleport_monitor_ip:
          'TP_MONITOR_IP is no longer available in the selected TP_SUBNET. Select an available IP before saving.',
      })
      window.requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>(
          '[data-server-field="teleport_monitor_ip"]'
        )
        target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        target
          ?.querySelector<HTMLElement>('input, button, [role="combobox"]')
          ?.focus()
      })
      return
    }
    save()
  }
  const zoneOptions = optionsOf(zones.data?.items, (item) =>
    String((item.region as Record<string, unknown>)?.display_name ?? '')
  )
  const groupOptions = optionsOf(groups.data?.items)
  const placementOptions = optionsOf(placementGroups.data?.items, (item) =>
    String(item.policy ?? '')
  )
  const availablePrivateIps = privateIps.data?.items ?? []
  const availableElasticIps = (elasticIps.data?.items ?? []).filter(
    (item) => item.server == null
  )
  const selectedGroups = draft.security_group_ids.map((id, index) => ({
    id,
    name: draft.security_group_names[index] || id,
  }))
  const selectedSubnet = subnets.data?.items.find(
    (item) => item.id === draft.subnet_id
  )
  const subnetCidr = draft.subnet_cidr || subnetCidrOf(selectedSubnet)
  const dataVolumes = draft.volumes.filter(
    (volume) => volume.mount_as === 'data'
  )
  const variableValues: Record<string, string> = {
    server_name: draft.name,
    'server.name': draft.name,
    hostnamectl: draft.name,
    zone: draft.zone_name,
    private_ip: draft.eni_address,
    local_gateway: gatewayFromCidr(subnetCidr),
    private_gateway: gatewayFromCidr(subnetCidr),
    subnet_cidr: subnetCidr,
    vpc_cidr: draft.vpc_cidr || vpcCidrOf(selectedSubnet) || subnetCidr,
    TELEPORT_ENABLE: String(draft.teleport_enabled),
    TP_REGION: draft.teleport_region,
    TP_SYSTEM: draft.teleport_system || draft.name,
    TP_HOSTNAME: draft.teleport_hostname || draft.name,
    TP_MONITOR_IP: draft.teleport_monitor_ip,
    volume_count: String(draft.volumes.length),
    data_volume_count: String(dataVolumes.length),
    has_data_volumes: String(dataVolumes.length > 0),
    has_other_volumes: String(dataVolumes.length > 0),
    ...draft.cloud_init_variables,
    ...elasticIpVariables(draft),
  }
  if (elasticIpVariables(draft).elastic_ip_address === undefined)
    delete variableValues.elastic_ip_address
  const renderedCloudInit = renderPreview(
    draft.cloud_init_content,
    draft,
    selectedSubnet
  )
  const resolvedCloudInitVariables = [
    ...new Set(
      [...draft.cloud_init_content.matchAll(/\{\{\s*([\w.\[\]]+)\s*\}\}/g)]
        .map((match) => match[1])
        .filter((key) => variableValues[key] !== undefined)
    ),
  ]
  draft.volumes.forEach((volume, index) => {
    const prefix = `volume[${index + 1}]`
    variableValues[`${prefix}.mount_path`] =
      volume.mount_point || (volume.mount_as === 'root' ? '/' : '/data')
    variableValues[`${prefix}.type`] = volume.volume_type_name
    variableValues[`${prefix}.size`] = String(volume.size)
  })
  dataVolumes.forEach((volume, index) => {
    const prefix = `data_volume[${index + 1}]`
    variableValues[`${prefix}.mount_path`] = volume.mount_point || '/data'
    variableValues[`${prefix}.type`] = volume.volume_type_name
    variableValues[`${prefix}.size`] = String(volume.size)
  })
  const insertVariable = (key: string) => {
    const token = `{{${key}}}`
    const editor = cloudInitEditorRef.current
    const start = editor?.selectionStart ?? draft.cloud_init_content.length
    const end = editor?.selectionEnd ?? start
    setDraft({
      ...draft,
      cloud_init_content:
        draft.cloud_init_content.slice(0, start) +
        token +
        draft.cloud_init_content.slice(end),
    })
    window.requestAnimationFrame(() => {
      editor?.focus()
      editor?.setSelectionRange(start + token.length, start + token.length)
    })
  }
  const variableButton = (key: string, label = key) => {
    const rawValue = variableValues[key]
    const preview =
      key === 'elastic_ip_address' && !rawValue
        ? draft.elastic_ip_mode === 'none'
          ? 'Empty: Elastic IP is disabled.'
          : draft.elastic_ip_mode === 'manual'
            ? 'Create the manual Elastic IP from the VM table before deployment.'
            : draft.elastic_ip_mode === 'auto'
              ? 'Available after creation only. Select an existing Elastic IP to use this variable.'
              : 'Select an existing Elastic IP with a valid address.'
        : rawValue
          ? rawValue.replace(/\n/g, ' ↵ ').slice(0, 80)
          : 'Value will be resolved when the server is created.'
    return (
      <Button
        key={key}
        type='button'
        size='sm'
        variant='outline'
        className='h-7 shrink-0 px-2 font-mono text-[11px] whitespace-nowrap'
        title={`${key}: ${preview}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => insertVariable(key)}
      >
        <span className='text-muted-foreground'>{'{{'}</span>
        {label}
        <span className='text-muted-foreground'>{'}}'}</span>
      </Button>
    )
  }
  // Fully editable example: data_volumes is rendered as one CSV row per disk,
  // then the script assigns unmounted disks in attachment order.
  const customMountCloudInit = `#cloud-config
write_files:
  - path: /usr/local/sbin/mount-data-volumes.sh
    permissions: '0750'
    content: |
      #!/usr/bin/env bash
      set -Eeuo pipefail

      mapfile -t devices < <(lsblk -rpn -o NAME,TYPE,MOUNTPOINT | awk '$2=="disk" && $3=="" {print $1}')
      device_index=0

      volume_rows='{{data_volumes_shell}}'
      while IFS=, read -r mount_as disk_type size mount_path; do
        [ -z "$mount_path" ] && continue
        device="\${devices[$device_index]:-}"
        if [ -z "$device" ]; then
          echo "No unmounted disk available for $mount_path" >&2
          exit 1
        fi

        mkdir -p "$mount_path"
        # Volumes must already contain a filesystem. Do not format disks here.
        uuid=$(blkid -s UUID -o value "$device" 2>/dev/null || true)
        if [ -n "$uuid" ]; then
          grep -q "^UUID=$uuid[[:space:]]" /etc/fstab || \\
            echo "UUID=$uuid $mount_path auto defaults,nofail 0 2" >> /etc/fstab
          mount "$mount_path" || mount "$device" "$mount_path"
        else
          mount "$device" "$mount_path"
        fi

        echo "Mounted $device ($disk_type, $size GB) at $mount_path"
        device_index=$((device_index + 1))
      done < <(printf '%b\\n' "$volume_rows")

runcmd:
  - /usr/local/sbin/mount-data-volumes.sh`
  return (
    <>
      <Dialog open onOpenChange={(open) => !open && setDraft()}>
        <DialogContent className='!top-[1svh] !h-[98svh] !max-h-[98svh] !w-[calc(100vw-1rem)] !max-w-[calc(100vw-1rem)] overflow-y-auto p-0 sm:!w-[calc(100vw-1rem)] sm:!max-w-[calc(100vw-1rem)]'>
          <DialogHeader className='sticky top-0 z-10 border-b bg-background px-5 py-4'>
            <DialogTitle>
              {draft.name ? `Edit ${draft.name}` : 'Add Server'}
            </DialogTitle>
          </DialogHeader>
          <div className='space-y-3 px-5 py-4'>
            <div className='grid items-start gap-3 xl:grid-cols-[minmax(0,2.5fr)_minmax(0,1fr)]'>
              <FormSection
                number={1}
                title='Server specs'
                description='Server identity, compute, zone and boot image.'
              >
                <div className='space-y-3 sm:col-span-2'>
                  <div className='space-y-1.5' data-server-field='name'>
                    <Label>Server name *</Label>
                    <Input
                      value={draft.name}
                      onChange={(e) =>
                        setDraft({ ...draft, name: e.target.value })
                      }
                    />
                    {errors.name && (
                      <p className='text-xs text-destructive'>{errors.name}</p>
                    )}
                  </div>
                  <div className='grid max-w-4xl gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]'>
                    <div className='space-y-1.5'>
                      <Label>Server type *</Label>
                      <Segmented
                        value={draft.instance_family}
                        values={[
                          { value: 'basic', label: 'Basic' },
                          { value: 'gpu', label: 'GPU' },
                        ]}
                        onChange={(instance_family) =>
                          setDraft({
                            ...draft,
                            instance_family,
                            flavor_name: '',
                          })
                        }
                      />
                    </div>
                    <RefSelect
                      label='Zone *'
                      fieldKey='zone_id'
                      value={draft.zone_id}
                      options={zoneOptions}
                      loading={zones.isLoading}
                      error={errors.zone_id}
                      clearable={false}
                      onChange={(id) => {
                        const item = zones.data?.items.find((x) => x.id === id)
                        const region = item?.region as
                          Record<string, string> | undefined
                        setDraft({
                          ...draft,
                          zone_id: id,
                          zone_name: item ? labelOf(item) : '',
                          region_id: region?.id || String(item?.region || ''),
                          flavor_name: '',
                          security_group_ids: [],
                          security_group_names: [],
                          placement_group_id: '',
                          placement_group_name: '',
                          volumes: draft.volumes.map((v) => ({
                            ...v,
                            volume_type: '',
                            volume_type_name: '',
                          })),
                        })
                      }}
                    />
                  </div>
                </div>
                <div className='grid max-w-4xl gap-3 sm:col-span-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]'>
                  <div className='space-y-1.5'>
                    <Label>Configuration mode</Label>
                    <Segmented
                      value={draft.specs_kind}
                      values={[
                        { value: 'predefined', label: 'Preset Flavor' },
                        { value: 'custom', label: 'Custom Specs' },
                      ]}
                      onChange={(specs_kind) =>
                        setDraft({ ...draft, specs_kind })
                      }
                    />
                  </div>
                  {draft.specs_kind === 'predefined' ? (
                    <RefSelect
                      label='Flavor *'
                      fieldKey='flavor_name'
                      value={draft.flavor_name}
                      options={(flavors.data?.items ?? []).map((x) => ({
                        value: x.name || x.id,
                        label: labelOf(x),
                        description: `${x.vcpus ?? '?'} vCPU · ${x.ram ?? '?'} GB RAM`,
                      }))}
                      loading={flavors.isLoading}
                      disabled={!draft.zone_id}
                      error={errors.flavor_name}
                      clearable={false}
                      onChange={(flavor_name) => {
                        const flavor = flavors.data?.items.find(
                          (item) => (item.name || item.id) === flavor_name
                        )
                        setDraft({
                          ...draft,
                          flavor_name,
                          ram: Number(flavor?.ram || draft.ram),
                          vcpus: Number(flavor?.vcpus || draft.vcpus),
                        })
                      }}
                    />
                  ) : (
                    <div className='grid gap-3 sm:grid-cols-2'>
                      <div className='space-y-1.5'>
                        <Label>vCPUs *</Label>
                        <Input
                          type='number'
                          min={1}
                          value={draft.vcpus}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              vcpus: Number(e.target.value),
                            })
                          }
                        />
                        {errors.vcpus && (
                          <p className='text-xs text-destructive'>
                            {errors.vcpus}
                          </p>
                        )}
                      </div>
                      <div className='space-y-1.5'>
                        <Label>RAM (GB) *</Label>
                        <Input
                          type='number'
                          min={1}
                          value={draft.ram}
                          onChange={(e) =>
                            setDraft({ ...draft, ram: Number(e.target.value) })
                          }
                        />
                        {errors.ram && (
                          <p className='text-xs text-destructive'>
                            {errors.ram}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className='grid max-w-4xl gap-3 sm:col-span-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]'>
                  <RefSelect
                    label='Boot source'
                    value={draft.boot_source}
                    options={[{ value: 'public_image', label: 'Public Image' }]}
                    clearable={false}
                    onChange={() =>
                      setDraft({ ...draft, boot_source: 'public_image' })
                    }
                  />
                  <RefSelect
                    label='Public image *'
                    fieldKey='image_name'
                    value={draft.image_id}
                    options={optionsOf(
                      images.data?.items,
                      (x) =>
                        `${x.os ?? ''} ${x.version ?? ''} · min ${x.min_volume_size ?? '?'} GB`
                    )}
                    loading={images.isLoading}
                    error={errors.image_name}
                    clearable={false}
                    onChange={(id) => {
                      const item = images.data?.items.find((x) => x.id === id)
                      setDraft({
                        ...draft,
                        image_id: id,
                        image_name: item?.name || '',
                        image_display_name: item ? labelOf(item) : '',
                      })
                    }}
                  />
                </div>
              </FormSection>
              <FormSection
                number={2}
                title='Other information'
                description='SSH key, placement policy and network bandwidth.'
              >
                <div className='grid gap-3 sm:col-span-2'>
                  <RefSelect
                    label='Key pair (optional)'
                    fieldKey='key_pair_id'
                    value={draft.key_pair_id}
                    options={optionsOf(keypairs.data?.items, (x) =>
                      String(x.fingerprint ?? '')
                    )}
                    loading={keypairs.isLoading}
                    error={errors.key_pair_id}
                    clearable={false}
                    onChange={(id) => {
                      const item = keypairs.data?.items.find((x) => x.id === id)
                      setDraft({
                        ...draft,
                        key_pair_id: id,
                        key_pair_name: item ? labelOf(item) : '',
                      })
                    }}
                  />
                  <div className='space-y-1.5'>
                    <Label>Placement group (optional)</Label>
                    <SearchableSelect
                      value={draft.placement_group_id}
                      options={placementOptions}
                      loading={placementGroups.isLoading}
                      disabled={!draft.region_id}
                      placeholder='Select placement group'
                      onValueChange={(id) => {
                        const option = placementOptions.find(
                          (item) => item.value === id
                        )
                        setDraft({
                          ...draft,
                          placement_group_id: id,
                          placement_group_name: option?.label || '',
                        })
                      }}
                    />
                  </div>
                  <div className='space-y-1.5'>
                    <Label>Bandwidth (Mbps)</Label>
                    <Input
                      type='number'
                      min={1}
                      max={10000}
                      step={1}
                      value={draft.bandwidth}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          bandwidth: Number(e.target.value),
                        })
                      }
                    />
                    {errors.bandwidth && (
                      <p className='text-xs text-destructive'>
                        {errors.bandwidth}
                      </p>
                    )}
                  </div>
                </div>
              </FormSection>
            </div>
            <FormSection
              number={3}
              title='Network'
              description='Configure Elastic IP and Private IP for this server.'
            >
              <div className='grid gap-0 sm:col-span-2 lg:grid-cols-2'>
                <div className='space-y-3 pr-0 lg:pr-4'>
                  <label className='flex items-center gap-2 text-sm font-medium'>
                    <Checkbox
                      checked={draft.elastic_ip_mode !== 'none'}
                      onCheckedChange={(value) =>
                        setDraft({
                          ...draft,
                          elastic_ip_mode: value === true ? 'auto' : 'none',
                          elastic_ip_id: '',
                          elastic_ip_address: '',
                        })
                      }
                    />
                    Enable Elastic IP
                  </label>
                  <div
                    className={
                      draft.elastic_ip_mode === 'none'
                        ? 'pointer-events-none space-y-3 opacity-40'
                        : 'space-y-3'
                    }
                  >
                    <div className='grid gap-3 sm:grid-cols-2'>
                      <div className='space-y-1.5'>
                        <Label>Elastic IP mode</Label>
                        <Segmented
                          value={
                            draft.elastic_ip_mode === 'none'
                              ? 'auto'
                              : draft.elastic_ip_mode
                          }
                          values={[
                            { value: 'auto', label: 'Auto allocate' },
                            { value: 'existing', label: 'Select existing' },
                            { value: 'manual', label: 'Manual create' },
                          ]}
                          onChange={(elastic_ip_mode) =>
                            setDraft({
                              ...draft,
                              elastic_ip_mode,
                              elastic_ip_id: '',
                              elastic_ip_address: '',
                            })
                          }
                        />
                      </div>
                      {draft.elastic_ip_mode === 'existing' && (
                        <div className='space-y-1.5'>
                          <RefSelect
                            label='Available Elastic IP *'
                            fieldKey='elastic_ip_id'
                            value={draft.elastic_ip_id}
                            options={optionsOf(availableElasticIps, (x) =>
                              String(x.ip_address ?? '')
                            )}
                            loading={elasticIps.isLoading}
                            error={errors.elastic_ip_id}
                            clearable={false}
                            onChange={(id) => {
                              const item = availableElasticIps.find(
                                (x) => x.id === id
                              )
                              setDraft({
                                ...draft,
                                elastic_ip_id: id,
                                elastic_ip_address: String(
                                  item?.ip_address ?? ''
                                ),
                              })
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className='mt-4 space-y-3 border-t pt-4 lg:mt-0 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4'>
                  <label className='flex items-center gap-2 text-sm font-medium'>
                    <Checkbox
                      checked={draft.enable_ipv4}
                      onCheckedChange={(value) =>
                        setDraft({ ...draft, enable_ipv4: value === true })
                      }
                    />
                    Enable Private IPv4
                  </label>
                  <div
                    className={
                      draft.enable_ipv4
                        ? 'grid gap-3 lg:grid-cols-3'
                        : 'pointer-events-none grid gap-3 opacity-40 lg:grid-cols-3'
                    }
                  >
                    <RefSelect
                      label='Subnet *'
                      fieldKey='subnet_id'
                      value={draft.subnet_id}
                      options={optionsOf(subnets.data?.items, (x) =>
                        String(x.cidr ?? '')
                      )}
                      loading={subnets.isLoading}
                      error={errors.subnet_id}
                      clearable={false}
                      onChange={(id) => {
                        const item = subnets.data?.items.find(
                          (x) => x.id === id
                        )
                        setDraft({
                          ...draft,
                          private_network_mode: 'subnet',
                          subnet_id: id,
                          subnet_display_name: item ? labelOf(item) : '',
                          subnet_cidr: subnetCidrOf(item),
                          vpc_cidr: vpcCidrOf(item),
                          private_ip_mode: 'auto',
                          eni_id: '',
                          eni_address: '',
                        })
                      }}
                    />
                    <div className='space-y-1.5'>
                      <Label>Private IP allocation</Label>
                      <Segmented
                        wrap
                        value={draft.private_ip_mode}
                        values={[
                          { value: 'auto', label: 'Auto allocate' },
                          { value: 'existing', label: 'Select existing' },
                          { value: 'ordered', label: 'Create ordered' },
                          { value: 'manual', label: 'Manual create' },
                        ]}
                        onChange={(private_ip_mode) =>
                          setDraft({
                            ...draft,
                            private_ip_mode,
                            eni_id: '',
                            eni_address: '',
                          })
                        }
                      />
                    </div>
                    {draft.private_ip_mode === 'existing' && (
                      <div className='space-y-1.5'>
                        <RefSelect
                          label='Available Private IP *'
                          fieldKey='eni_id'
                          value={draft.eni_id}
                          options={optionsOf(availablePrivateIps, (x) =>
                            String(x.ip_address ?? '')
                          )}
                          loading={privateIps.isLoading}
                          disabled={!draft.subnet_id}
                          error={errors.eni_id}
                          clearable={false}
                          placeholder={
                            draft.subnet_id
                              ? 'Select an unused private IP'
                              : 'Select subnet first'
                          }
                          onChange={(id) => {
                            const item = availablePrivateIps.find(
                              (x) => x.id === id
                            )
                            setDraft({
                              ...draft,
                              eni_id: id,
                              eni_address: String(item?.ip_address ?? ''),
                            })
                          }}
                        />
                      </div>
                    )}
                    {draft.private_ip_mode === 'manual' && (
                      <p className='text-xs text-muted-foreground'>
                        Select this VM in the table and use Create random IPs to
                        create a new unused address in this subnet before
                        deployment.
                      </p>
                    )}
                    {draft.private_ip_mode === 'ordered' && (
                      <p className='text-xs text-muted-foreground'>
                        Private IPs are created in subnet order from Review &
                        Create, then mapped to these servers before deployment.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </FormSection>
            <div className='grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]'>
              <FormSection
                number={4}
                title='Security groups'
                description='Attach one or more firewall policies from the selected region.'
              >
                <div className='space-y-2 sm:col-span-2'>
                  <div className='flex min-h-7 flex-wrap items-center gap-1'>
                    <Popover
                      open={securityGroupPickerOpen}
                      onOpenChange={setSecurityGroupPickerOpen}
                      modal
                    >
                      <PopoverTrigger asChild>
                        <Button
                          type='button'
                          variant='outline'
                          size='icon'
                          className='size-7'
                          disabled={!draft.region_id}
                          aria-label='Add security group'
                          title='Add security group'
                          aria-expanded={securityGroupPickerOpen}
                        >
                          <Plus />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        align='start'
                        className='w-80 max-w-[calc(100vw-2rem)] p-0'
                      >
                        <SearchableSelect
                          inline
                          className='max-h-[min(400px,60svh)] border-0'
                          value=''
                          options={groupOptions.filter(
                            (o) => !draft.security_group_ids.includes(o.value)
                          )}
                          loading={groups.isLoading}
                          disabled={!draft.region_id}
                          placeholder={
                            draft.region_id
                              ? 'Add security group...'
                              : 'Select zone first'
                          }
                          onValueChange={(id) => {
                            const option = groupOptions.find(
                              (o) => o.value === id
                            )
                            setSecurityGroupPickerOpen(false)
                            setDraft({
                              ...draft,
                              security_group_ids: [
                                ...draft.security_group_ids,
                                id,
                              ],
                              security_group_names: [
                                ...draft.security_group_names,
                                option?.label || id,
                              ],
                            })
                          }}
                        />
                      </PopoverContent>
                    </Popover>
                    {selectedGroups.map((group) => (
                      <Badge
                        key={group.id}
                        variant='secondary'
                        className='cursor-pointer'
                        onClick={() => {
                          const index = draft.security_group_ids.indexOf(
                            group.id
                          )
                          setDraft({
                            ...draft,
                            security_group_ids: draft.security_group_ids.filter(
                              (id) => id !== group.id
                            ),
                            security_group_names:
                              draft.security_group_names.filter(
                                (_, i) => i !== index
                              ),
                          })
                        }}
                      >
                        {group.name} ×
                      </Badge>
                    ))}
                  </div>
                  {errors.security_group_ids && (
                    <p className='text-xs text-destructive'>
                      {errors.security_group_ids}
                    </p>
                  )}
                </div>
              </FormSection>
              <FormSection
                number={5}
                title='Volumes'
                description={
                  draft.instance_family === 'gpu'
                    ? 'Optional for GPU servers. Add volumes only when required by the workload.'
                    : 'Exactly one root volume is required; additional volumes must be Data.'
                }
                action={
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    className='h-7 px-2 text-xs'
                    onClick={() =>
                      setDraft({
                        ...draft,
                        volumes: [
                          ...draft.volumes,
                          {
                            id: crypto.randomUUID(),
                            volume_type: '',
                            volume_type_name: '',
                            size: 50,
                            mount_as: 'data',
                            mount_point: '/data',
                          },
                        ],
                      })
                    }
                  >
                    <Plus /> Add data volume
                  </Button>
                }
              >
                <div className='space-y-2 sm:col-span-2'>
                  <div className='grid grid-cols-[28px_minmax(130px,.7fr)_90px_90px_minmax(220px,1.6fr)_36px] gap-2 px-1 text-xs text-muted-foreground'>
                    <span>No.</span>
                    <span>Volume type</span>
                    <span>Size (GiB)</span>
                    <span>Mount as</span>
                    <span>Mount path</span>
                    <span />
                  </div>
                  {draft.volumes.map((volume, index) => (
                    <div
                      key={volume.id}
                      className='grid grid-cols-[28px_minmax(130px,.7fr)_90px_90px_minmax(220px,1.6fr)_36px] items-center gap-2'
                    >
                      <span className='text-center text-sm'>{index + 1}</span>
                      <SearchableSelect
                        value={volume.volume_type}
                        options={optionsOf(
                          volumeTypes.data?.items,
                          (x) => `${x.disk_type ?? ''} · ${x.speed ?? ''}`
                        )}
                        loading={volumeTypes.isLoading}
                        disabled={!draft.zone_id}
                        placeholder='Volume type'
                        onValueChange={(id) => {
                          const item = volumeTypes.data?.items.find(
                            (x) => x.id === id
                          )
                          setDraft({
                            ...draft,
                            volumes: draft.volumes.map((v) =>
                              v.id === volume.id
                                ? {
                                    ...v,
                                    volume_type: id,
                                    volume_type_name: item ? labelOf(item) : '',
                                  }
                                : v
                            ),
                          })
                        }}
                      />
                      <Input
                        type='number'
                        min={1}
                        value={volume.size}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            volumes: draft.volumes.map((v) =>
                              v.id === volume.id
                                ? { ...v, size: Number(e.target.value) }
                                : v
                            ),
                          })
                        }
                      />
                      <Badge
                        variant={
                          volume.mount_as === 'root' ? 'default' : 'secondary'
                        }
                        className='justify-center py-1.5'
                      >
                        {volume.mount_as}
                      </Badge>
                      <Input
                        value={
                          volume.mount_as === 'root'
                            ? '/'
                            : (volume.mount_point ?? '/data')
                        }
                        placeholder={volume.mount_as === 'root' ? '/' : '/u01'}
                        disabled={
                          volume.mount_as === 'root' &&
                          draft.instance_family !== 'gpu'
                        }
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            volumes: draft.volumes.map((v) =>
                              v.id === volume.id
                                ? { ...v, mount_point: e.target.value }
                                : v
                            ),
                          })
                        }
                      />
                      <Button
                        type='button'
                        size='icon'
                        variant='ghost'
                        disabled={volume.mount_as === 'root'}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            volumes: draft.volumes.filter(
                              (v) => v.id !== volume.id
                            ),
                          })
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                  {errors.volumes && (
                    <p className='text-xs text-destructive'>{errors.volumes}</p>
                  )}
                </div>
              </FormSection>
            </div>
            <FormSection
              number={6}
              title='Cloud-init'
              description='Rendered independently for this server, then saved in deployment history.'
              enabled={draft.cloud_init_enabled}
              onEnabledChange={(cloud_init_enabled) =>
                setDraft({ ...draft, cloud_init_enabled })
              }
            >
              <div className={draft.cloud_init_enabled ? 'contents' : 'hidden'}>
                <div className='order-2 sm:col-span-2'>
                  <RefSelect
                    label='Managed template (optional)'
                    value={draft.cloud_init_template_id}
                    options={cloudInitTemplates
                      .filter((item) => item.is_active)
                      .map((item) => ({
                        value: item.id,
                        label: item.name,
                        description: `${item.os_family} · ${item.description}`,
                      }))}
                    placeholder='Use custom YAML'
                    onChange={(id) => {
                      const item = cloudInitTemplates.find(
                        (template) => template.id === id
                      )
                      setDraft({
                        ...draft,
                        cloud_init_template_id: id,
                        cloud_init_template_name: item?.name || '',
                        cloud_init_content: item?.content || '',
                      })
                    }}
                  />
                </div>
                {false && resolvedCloudInitVariables.length > 0 && (
                  <div className='order-2 sm:col-span-2'>
                    <div className='flex max-h-14 flex-wrap gap-1 overflow-y-auto rounded-md border bg-muted/40 p-1.5 text-[10px]'>
                      {resolvedCloudInitVariables.map((key) => (
                        <Badge
                          key={key}
                          variant='outline'
                          className='border-amber-300 bg-amber-50/70 font-mono text-[10px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-200'
                        >
                          {`{{${key}}}`} →{' '}
                          {(variableValues[key] || '')
                            .replace(/\n/g, ' ↵ ')
                            .slice(0, 48)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                <div className='order-3 space-y-1.5 sm:col-span-2'>
                  <div className='flex items-center justify-start gap-2'>
                    <Label>Variables</Label>
                    <div className='flex items-center gap-1'>
                      <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        className='h-8 gap-1.5 border px-2 text-xs font-medium'
                        title={
                          cloudInitVariablesOpen
                            ? 'Hide variables'
                            : 'Show variables'
                        }
                        aria-label={
                          cloudInitVariablesOpen
                            ? 'Hide variables'
                            : 'Show variables'
                        }
                        onClick={() =>
                          setCloudInitVariablesOpen((open) => !open)
                        }
                      >
                        {cloudInitVariablesOpen ? (
                          <ChevronUp />
                        ) : (
                          <ChevronDown />
                        )}
                        <span>Variables</span>
                      </Button>
                    </div>
                  </div>
                  {cloudInitVariablesOpen && (
                    <div className='space-y-2 rounded-md border bg-muted/20 p-2'>
                      <div className='flex justify-start'>
                        <Button
                          type='button'
                          size='sm'
                          variant='ghost'
                          className='h-7 px-2 text-xs'
                          onClick={() => setVolumeHelpOpen(true)}
                        >
                          <HelpCircle /> Variable help
                        </Button>
                      </div>
                      <div>
                        <p className='text-xs font-semibold tracking-wide text-muted-foreground uppercase'>
                          Basic information
                        </p>
                        <div className='mt-1 flex flex-wrap gap-1'>
                          {[
                            'server_name',
                            'hostnamectl',
                            'zone',
                            'private_ip',
                            'local_gateway',
                            'subnet_cidr',
                            'vpc_cidr',
                          ].map((key) => variableButton(key))}
                        </div>
                      </div>
                      <div>
                        <p className='text-xs font-semibold tracking-wide text-muted-foreground uppercase'>
                          Elastic IP
                        </p>
                        <div className='mt-1 flex flex-wrap gap-1'>
                          {['elastic_ip_enabled', 'elastic_ip_address'].map(
                            (key) => variableButton(key)
                          )}
                        </div>
                        <p className='mt-1 text-xs text-muted-foreground'>
                          elastic_ip_enabled is true/false. elastic_ip_address
                          uses the selected existing IP; it is empty when
                          disabled. Auto allocation has no address until the
                          server is created.
                        </p>
                      </div>
                      <div>
                        <p className='text-xs font-semibold tracking-wide text-muted-foreground uppercase'>
                          Volumes
                        </p>
                        <div className='mt-1 flex flex-wrap gap-1'>
                          {[
                            'has_other_volumes',
                            'data_volume_count',
                            'root_volume',
                            'data_volumes',
                            'data_volumes_shell',
                            'data_volume_types',
                            'data_volume_mounts',
                            'volume_mounts',
                          ].map((key) => variableButton(key))}
                        </div>
                        <div className='mt-2 space-y-1'>
                          {draft.volumes.map((volume, index) => (
                            <div
                              key={volume.id}
                              className='rounded border bg-background p-2'
                            >
                              <p className='mb-1 text-xs font-medium'>
                                {index + 1}. {volume.mount_as}{' '}
                                {volume.mount_point ||
                                  (volume.mount_as === 'root' ? '/' : '/data')}
                              </p>
                              <div className='flex flex-wrap gap-1'>
                                {[
                                  `volume[${index + 1}].mount_path`,
                                  `volume[${index + 1}].type`,
                                  `volume[${index + 1}].size`,
                                ].map((key) => variableButton(key))}
                              </div>
                              {volume.mount_as === 'data' && (
                                <div className='mt-1 flex flex-wrap gap-1'>
                                  {[
                                    `data_volume[${draft.volumes.filter((item) => item.mount_as === 'data').indexOf(volume) + 1}].mount_path`,
                                    `data_volume[${draft.volumes.filter((item) => item.mount_as === 'data').indexOf(volume) + 1}].type`,
                                    `data_volume[${draft.volumes.filter((item) => item.mount_as === 'data').indexOf(volume) + 1}].size`,
                                  ].map((key) => variableButton(key))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                      {draft.teleport_enabled && (
                        <div>
                          <p className='text-xs font-semibold tracking-wide text-muted-foreground uppercase'>
                            Teleport
                          </p>
                          <div className='mt-1 flex flex-wrap gap-1'>
                            {[
                              'TP_REGION',
                              'TP_SYSTEM',
                              'TP_HOSTNAME',
                              'TP_MONITOR_IP',
                            ].map((key) => variableButton(key))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {cloudInitVariablesOpen &&
                    Object.entries(draft.cloud_init_variables).map(
                      ([key, value]) => (
                        <div
                          key={key}
                          className='grid grid-cols-[1fr_1fr_32px] gap-2'
                        >
                          <Input
                            className='h-8'
                            value={key}
                            onChange={(event) => {
                              const next = { ...draft.cloud_init_variables }
                              delete next[key]
                              next[event.target.value] = value
                              setDraft({
                                ...draft,
                                cloud_init_variables: next,
                              })
                            }}
                          />
                          <Input
                            className='h-8'
                            value={value}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                cloud_init_variables: {
                                  ...draft.cloud_init_variables,
                                  [key]: event.target.value,
                                },
                              })
                            }
                          />
                          <Button
                            type='button'
                            size='icon'
                            variant='ghost'
                            className='size-8'
                            onClick={() => {
                              const next = { ...draft.cloud_init_variables }
                              delete next[key]
                              setDraft({
                                ...draft,
                                cloud_init_variables: next,
                              })
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      )
                    )}
                  {cloudInitVariablesOpen && (
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      onClick={() =>
                        setDraft({
                          ...draft,
                          cloud_init_variables: {
                            ...draft.cloud_init_variables,
                            [`variable_${Object.keys(draft.cloud_init_variables).length + 1}`]:
                              '',
                          },
                        })
                      }
                    >
                      <Plus /> Add variable
                    </Button>
                  )}
                  {cloudInitVariablesOpen &&
                    resolvedCloudInitVariables.length > 0 && (
                      <div className='mt-2 flex max-h-14 flex-wrap gap-1 overflow-y-auto rounded-md border bg-muted/40 p-1.5 text-[10px]'>
                        {resolvedCloudInitVariables.map((key) => (
                          <Badge
                            key={key}
                            variant='outline'
                            className='border-amber-300 bg-amber-50/70 font-mono text-[10px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-200'
                          >
                            {`{{${key}}}`} →{' '}
                            {(variableValues[key] || '')
                              .replace(/\n/g, ' ↵ ')
                              .slice(0, 48)}
                          </Badge>
                        ))}
                      </div>
                    )}
                </div>
                <div
                  ref={cloudInitSplitRef}
                  className='order-4 sm:col-span-2 lg:flex lg:items-stretch'
                >
                  <div
                    className='min-w-0 space-y-1.5 lg:pr-3'
                    style={{ flexBasis: `${cloudInitPreviewSplit}%` }}
                  >
                    <Label>Cloud-init YAML *</Label>
                    <Textarea
                      ref={cloudInitEditorRef}
                      className='h-72 max-h-[60vh] min-h-40 resize-y overflow-auto font-mono text-xs'
                      value={draft.cloud_init_content}
                      placeholder={'#cloud-config\nhostname: {{server_name}}'}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          cloud_init_template_id: '',
                          cloud_init_template_name: '',
                          cloud_init_content: e.target.value,
                        })
                      }
                    />
                    {errors.cloud_init_content && (
                      <p className='text-xs text-destructive'>
                        {errors.cloud_init_content}
                      </p>
                    )}
                  </div>
                  <div className='relative hidden w-3 shrink-0 cursor-col-resize lg:block'>
                    <button
                      type='button'
                      aria-label='Resize Cloud-init preview'
                      className='absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors hover:w-0.5 hover:bg-primary focus-visible:w-0.5 focus-visible:bg-primary focus-visible:outline-none'
                      onPointerDown={(event) => {
                        event.preventDefault()
                        const container = cloudInitSplitRef.current
                        if (!container) return
                        const bounds = container.getBoundingClientRect()
                        const resize = (moveEvent: PointerEvent) => {
                          const next = Math.round(
                            ((moveEvent.clientX - bounds.left) / bounds.width) *
                              100
                          )
                          setCloudInitPreviewSplit(
                            Math.min(70, Math.max(30, next))
                          )
                        }
                        startWindowPointerDrag(resize)
                      }}
                    />
                  </div>
                  <div
                    className='mt-4 min-w-0 space-y-1.5 border-t pt-4 lg:mt-0 lg:border-t-0 lg:pt-0 lg:pl-3'
                    style={{ flexBasis: `${100 - cloudInitPreviewSplit}%` }}
                  >
                    <div className='flex flex-wrap items-center justify-between gap-2'>
                      <Label>Rendered preview</Label>
                      {resolvedCloudInitVariables.length > 0 && (
                        <span className='text-xs text-muted-foreground'>
                          Resolved values are highlighted
                        </span>
                      )}
                    </div>
                    {resolvedCloudInitVariables.length > 0 && (
                      <div className='hidden max-h-14 flex-wrap gap-1 overflow-y-auto rounded-md border bg-muted/40 p-1.5 text-[10px]'>
                        {resolvedCloudInitVariables.map((key) => (
                          <Badge
                            key={key}
                            variant='outline'
                            className='hidden border-primary/30 bg-background font-mono text-[10px] text-foreground'
                          >
                            {`{{${key}}}`} →{' '}
                            {(variableValues[key] || '')
                              .replace(/\n/g, ' ↵ ')
                              .slice(0, 48)}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <HighlightedCloudInitPreview
                      value={renderedCloudInit}
                      variables={resolvedCloudInitVariables.map((key) => ({
                        key,
                        value: variableValues[key] || '',
                      }))}
                    />
                  </div>
                </div>
                <div className='order-1 min-w-0 space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3 sm:col-span-2'>
                  <label className='flex min-h-7 flex-wrap items-center gap-2 text-sm font-medium'>
                    <Checkbox
                      checked={draft.teleport_enabled}
                      onCheckedChange={(value) => {
                        const enabled = value === true
                        const variables = { ...draft.cloud_init_variables }
                        if (!enabled)
                          [
                            'TP_REGION',
                            'TP_SYSTEM',
                            'TP_HOSTNAME',
                            'TP_MONITOR_IP',
                            'TELEPORT_ENABLE',
                          ].forEach((key) => delete variables[key])
                        setDraft({
                          ...draft,
                          teleport_enabled: enabled,
                          cloud_init_variables: variables,
                          teleport_system: enabled ? draft.teleport_system : '',
                          teleport_hostname: enabled
                            ? draft.teleport_hostname
                            : '',
                          teleport_monitor_subnet_id: enabled
                            ? draft.teleport_monitor_subnet_id
                            : '',
                          teleport_monitor_subnet_name: enabled
                            ? draft.teleport_monitor_subnet_name
                            : '',
                          teleport_monitor_ip: enabled
                            ? draft.teleport_monitor_ip
                            : '',
                        })
                      }}
                    />
                    Install / register Teleport
                  </label>
                  {draft.teleport_enabled && (
                    <div className='grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,4.5fr)_minmax(0,4.5fr)] items-start gap-3'>
                      <div className='min-w-0 space-y-1.5'>
                        <Label>TP_REGION</Label>
                        <Segmented
                          className='w-full min-w-0'
                          value={draft.teleport_region}
                          values={[
                            { value: 'public', label: 'Public' },
                            { value: 'vpublic', label: 'VPublic' },
                          ]}
                          onChange={(teleport_region) =>
                            setDraft({ ...draft, teleport_region })
                          }
                        />
                      </div>
                      <div className='grid min-w-0 grid-cols-2 gap-3'>
                        <div className='space-y-1.5'>
                          <Label>TP_SYSTEM (teleport_system)</Label>
                          <Input
                            className='h-8'
                            value={draft.teleport_system}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                teleport_system: e.target.value,
                              })
                            }
                          />
                        </div>
                        <div className='space-y-1.5'>
                          <Label>TP_HOSTNAME (teleport_hostname)</Label>
                          <Input
                            className='h-8'
                            value={draft.teleport_hostname}
                            placeholder={draft.name}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                teleport_hostname: e.target.value,
                              })
                            }
                          />
                        </div>
                      </div>
                      <div className='grid min-w-0 grid-cols-2 gap-3'>
                        <div className='min-w-0'>
                          <RefSelect
                            label='TP_SUBNET'
                            fieldKey='teleport_monitor_subnet_id'
                            value={draft.teleport_monitor_subnet_id}
                            options={optionsOf(subnets.data?.items, (x) =>
                              String(x.cidr ?? '')
                            )}
                            loading={subnets.isLoading}
                            error={errors.teleport_monitor_subnet_id}
                            clearable={false}
                            onChange={(id) => {
                              const item = subnets.data?.items.find(
                                (x) => x.id === id
                              )
                              setDraft({
                                ...draft,
                                teleport_monitor_subnet_id: id,
                                teleport_monitor_subnet_name: item
                                  ? labelOf(item)
                                  : '',
                                teleport_monitor_ip: '',
                              })
                            }}
                          />
                        </div>
                        <div className='min-w-0'>
                          <div
                            className='space-y-1.5'
                            data-server-field='teleport_monitor_ip'
                          >
                            <Label>TP_MONITOR_IP</Label>
                            <SearchableSelect
                              value={draft.teleport_monitor_ip}
                              options={(monitorPrivateIps.data?.items ?? [])
                                .filter((item) => item.server == null)
                                .map((item) => ({
                                  value: String(
                                    item.ip_address || item.name || item.id
                                  ),
                                  label: String(
                                    item.ip_address || item.name || item.id
                                  ),
                                  description: String(item.description || ''),
                                }))}
                              loading={monitorPrivateIps.isLoading}
                              disabled={!draft.teleport_monitor_subnet_id}
                              placeholder={
                                draft.teleport_monitor_subnet_id
                                  ? 'Select available monitor IP'
                                  : 'Select TP_SUBNET first'
                              }
                              onValueChange={(ip) =>
                                setDraft({
                                  ...draft,
                                  teleport_monitor_ip: ip,
                                })
                              }
                            />
                            {errors.teleport_monitor_ip && (
                              <p className='text-xs text-destructive'>
                                {errors.teleport_monitor_ip}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </FormSection>
          </div>
          <DialogFooter className='sticky bottom-0 z-10 border-t bg-background px-5 py-3'>
            <Button variant='outline' onClick={() => setDraft()}>
              Cancel
            </Button>
            <Button onClick={saveWithTeleportIpCheck}>Save Server</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={volumeHelpOpen} onOpenChange={setVolumeHelpOpen}>
        <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>Cloud-init volume variables</DialogTitle>
            <DialogDescription>
              Variables are grouped by purpose. Volume buttons are generated
              from the current volume list; click one to insert it into YAML.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4 text-sm'>
            <div>
              <p className='font-medium'>Variable groups</p>
              <p className='text-muted-foreground'>
                Basic information inserts server identity and network values.
                Network values include the selected subnet CIDR, its local
                gateway, and the VPC CIDR returned by Cloud API. Volumes inserts
                the disk list and per-volume mount paths. Teleport appears only
                when Install / register Teleport is enabled.
              </p>
            </div>
            <div>
              <p className='font-medium'>Private network variables</p>
              <p className='text-muted-foreground'>
                <code>{'{{local_gateway}}'}</code> is calculated as the first
                usable address of the selected Private subnet (network + 1).
                <code>{'{{subnet_cidr}}'}</code> is the exact selected subnet
                CIDR. <code>{'{{vpc_cidr}}'}</code> uses the VPC CIDR from the
                subnet/VPC API response; if the Cloud API does not expose it, it
                safely falls back to the subnet CIDR.
              </p>
              <pre className='mt-2 rounded bg-muted p-3 text-xs'>{`gateway: {{local_gateway}}
subnet: {{subnet_cidr}}
vpc: {{vpc_cidr}}`}</pre>
            </div>
            <div>
              <p className='font-medium'>Elastic IP variables</p>
              <p className='text-muted-foreground'>
                <code>{'{{elastic_ip_enabled}}'}</code> is true when Elastic IP
                is enabled (auto or existing), otherwise false.
                <code>{'{{elastic_ip_address}}'}</code> is the exact selected
                existing address, or an empty string when disabled. For
                automatic allocation, use only the enabled flag: the address is
                assigned after cloud-init is submitted. Choose an existing
                Elastic IP when your cloud-init needs the exact address.
              </p>
              <pre className='mt-2 rounded bg-muted p-3 text-xs'>{`elastic_enabled: {{elastic_ip_enabled}}
elastic_address: "{{elastic_ip_address}}"`}</pre>
            </div>
            <div>
              <p className='font-medium'>Per-volume variables</p>
              <p className='text-muted-foreground'>
                The volume list shows each configured disk. The root disk uses
                <code>volume[index].field</code>; data disks use
                <code>data_volume[index].field</code> with a 1-based index.
              </p>
              <pre className='mt-2 rounded bg-muted p-3 text-xs'>{`{{volume[1].mount_path}}\n{{data_volume[1].mount_path}}\n{{data_volume[1].type}}\n{{data_volume[1].size}}`}</pre>
            </div>
            <div>
              <p className='font-medium'>Loop-friendly variables</p>
              <p className='text-muted-foreground'>
                Each data volume is one CSV line:
                <code>mount_as,type,size,mount_path</code>. Split the lines in a
                shell loop when generating mount commands. Use
                <code>data_volumes_shell</code> inside cloud-init so the
                multiline list remains valid YAML.
              </p>
              <pre className='mt-2 rounded bg-muted p-3 text-xs whitespace-pre-wrap'>{`# One rendered line = one data volume\nwhile IFS=, read -r mount_as disk_type size mount_path; do\n  [ -z "$disk_type" ] && continue\n  echo "Mount $disk_type ($size GB) at $mount_path"\ndone <<'VOLUMES'\n{{data_volumes}}\nVOLUMES`}</pre>
            </div>
            <div>
              <p className='font-medium'>Custom mount cloud-init sample</p>
              <p className='text-muted-foreground'>
                This is a fully editable starting point generated from this
                server&apos;s data volumes. No hidden mount-script variable is
                inserted by the backend. Change the device discovery, filesystem
                options, formatting and mount commands as required.
              </p>
              <pre className='mt-2 max-h-80 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap'>
                {customMountCloudInit}
              </pre>
              <p className='mt-2 text-xs text-muted-foreground'>
                The sample selects currently unmounted disks in attachment
                order. For production, verify the selected device with
                <code>lsblk -f</code> and add UUID-based mounting when the image
                provides stable filesystem UUIDs.
              </p>
            </div>
            <div>
              <p className='font-medium'>Useful checks</p>
              <ul className='list-disc space-y-1 pl-5 text-muted-foreground'>
                <li>
                  <code>{'{{has_other_volumes}}'}</code> is true/false.
                </li>
                <li>
                  <code>{'{{data_volume_count}}'}</code> gives the number of
                  non-root volumes.
                </li>
                <li>
                  <code>{'{{volume_mounts}}'}</code> lists every volume and
                  mount path.
                </li>
              </ul>
            </div>
            <Alert>
              <AlertTitle>Important</AlertTitle>
              <AlertDescription>
                These variables are rendered separately for each server. The
                backend only substitutes the variables you explicitly use. Put
                all mount logic in the editable cloud-init YAML and review it
                before deploying to production.
              </AlertDescription>
            </Alert>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function LegacyEditServerDialog({
  draft,
  setDraft,
  errors,
  save,
  zones,
  flavors,
  images,
  keypairs,
  subnets,
  enis,
  groups,
  volumeTypes,
  elasticIps,
}: {
  draft?: TerraformServerDraft
  setDraft: (value?: TerraformServerDraft) => void
  errors: TerraformServerFieldErrors
  save: () => void
  zones: QueryResult
  flavors: QueryResult
  images: QueryResult
  keypairs: QueryResult
  subnets: QueryResult
  enis: QueryResult
  groups: QueryResult
  volumeTypes: QueryResult
  elasticIps: QueryResult
}) {
  if (!draft) return null
  const zoneOptions = optionsOf(zones.data?.items, (item) =>
    String((item.region as Record<string, unknown>)?.display_name ?? '')
  )
  const groupOptions = optionsOf(groups.data?.items)
  const selectedGroups = draft.security_group_ids.map((id, index) => ({
    id,
    name: draft.security_group_names[index] || id,
  }))
  return (
    <Dialog open onOpenChange={(open) => !open && setDraft()}>
      <DialogContent className='max-h-[92vh] overflow-y-auto sm:max-w-4xl'>
        <DialogHeader>
          <DialogTitle>Edit Server</DialogTitle>
          <DialogDescription>
            Reference fields are loaded from Viettel Cloud. Select a zone first.
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-1.5'>
            <Label>Server name</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            {errors.name && (
              <p className='text-xs text-destructive'>{errors.name}</p>
            )}
          </div>
          <RefSelect
            label='Zone'
            value={draft.zone_id}
            options={zoneOptions}
            loading={zones.isLoading}
            error={errors.zone_id}
            onChange={(id) => {
              const item = zones.data?.items.find((x) => x.id === id)
              const region = item?.region as Record<string, string> | undefined
              setDraft({
                ...draft,
                zone_id: id,
                zone_name: item ? labelOf(item) : '',
                region_id: region?.id || '',
                flavor_name: '',
                volumes: draft.volumes.map((v) => ({
                  ...v,
                  volume_type: '',
                  volume_type_name: '',
                })),
              })
            }}
          />
          <div className='space-y-1.5'>
            <Label>Server Type</Label>
            <Segmented
              value={draft.instance_family}
              values={[
                { value: 'basic', label: 'Basic' },
                { value: 'gpu', label: 'GPU' },
              ]}
              onChange={(instance_family) =>
                setDraft({ ...draft, instance_family, flavor_name: '' })
              }
            />
          </div>
          <div className='space-y-1.5'>
            <Label>Specs mode</Label>
            <Segmented
              value={draft.specs_kind}
              values={[
                { value: 'predefined', label: 'Flavor' },
                { value: 'custom', label: 'Custom' },
              ]}
              onChange={(specs_kind) => setDraft({ ...draft, specs_kind })}
            />
          </div>
          {draft.specs_kind === 'predefined' ? (
            <RefSelect
              label='Flavor'
              value={draft.flavor_name}
              options={(flavors.data?.items ?? []).map((x) => ({
                value: x.name || x.id,
                label: labelOf(x),
              }))}
              loading={flavors.isLoading}
              disabled={!draft.zone_id}
              error={errors.flavor_name}
              onChange={(flavor_name) => setDraft({ ...draft, flavor_name })}
            />
          ) : (
            <>
              <div className='space-y-1.5'>
                <Label>RAM (GB)</Label>
                <Input
                  type='number'
                  min={1}
                  value={draft.ram}
                  onChange={(e) =>
                    setDraft({ ...draft, ram: Number(e.target.value) })
                  }
                />
              </div>
              <div className='space-y-1.5'>
                <Label>vCPUs</Label>
                <Input
                  type='number'
                  min={1}
                  value={draft.vcpus}
                  onChange={(e) =>
                    setDraft({ ...draft, vcpus: Number(e.target.value) })
                  }
                />
              </div>
            </>
          )}
          <RefSelect
            label='Boot Source'
            value={draft.boot_source}
            options={[{ value: 'public_image', label: 'Public Image' }]}
            onChange={() => setDraft({ ...draft, boot_source: 'public_image' })}
          />
          <RefSelect
            label='Public Image'
            value={draft.image_id}
            options={optionsOf(
              images.data?.items,
              (x) => `${x.os ?? ''} ${x.version ?? ''}`
            )}
            loading={images.isLoading}
            error={errors.image_name}
            onChange={(id) => {
              const item = images.data?.items.find((x) => x.id === id)
              setDraft({
                ...draft,
                image_id: id,
                image_name: item?.name || '',
                image_display_name: item ? labelOf(item) : '',
              })
            }}
          />
          <RefSelect
            label='Key Pair'
            value={draft.key_pair_id}
            options={optionsOf(keypairs.data?.items)}
            loading={keypairs.isLoading}
            error={errors.key_pair_id}
            onChange={(id) => {
              const item = keypairs.data?.items.find((x) => x.id === id)
              setDraft({
                ...draft,
                key_pair_id: id,
                key_pair_name: item ? labelOf(item) : '',
              })
            }}
          />
          <label className='flex items-center gap-3 rounded-md border p-3'>
            <Checkbox
              checked={draft.enable_ipv4}
              onCheckedChange={(v) =>
                setDraft({ ...draft, enable_ipv4: v === true })
              }
            />
            <span className='text-sm font-medium'>Enable IPv4</span>
          </label>
          <div className='space-y-1.5'>
            <Label>Elastic IP</Label>
            <Segmented
              value={draft.elastic_ip_mode}
              values={[
                { value: 'none', label: 'Off' },
                { value: 'auto', label: 'Auto' },
                { value: 'existing', label: 'Existing' },
                { value: 'manual', label: 'Manual create' },
              ]}
              onChange={(elastic_ip_mode) =>
                setDraft({
                  ...draft,
                  elastic_ip_mode,
                  elastic_ip_id: '',
                  elastic_ip_address: '',
                })
              }
            />
          </div>
          {draft.elastic_ip_mode === 'existing' && (
            <RefSelect
              label='Existing Elastic IP'
              value={draft.elastic_ip_id}
              options={optionsOf(elasticIps.data?.items, (x) =>
                String(x.ip_address ?? '')
              )}
              loading={elasticIps.isLoading}
              error={errors.elastic_ip_id}
              onChange={(id) => {
                const item = elasticIps.data?.items.find((x) => x.id === id)
                setDraft({
                  ...draft,
                  elastic_ip_id: id,
                  elastic_ip_address: String(
                    item?.ip_address ?? labelOf(item!)
                  ),
                })
              }}
            />
          )}
          <div className='space-y-1.5'>
            <Label>Private Network</Label>
            <Segmented
              value={draft.private_network_mode}
              values={[
                { value: 'subnet', label: 'Subnet' },
                { value: 'eni', label: 'ENI' },
              ]}
              onChange={(private_network_mode) =>
                setDraft({ ...draft, private_network_mode })
              }
            />
          </div>
          {draft.private_network_mode === 'subnet' ? (
            <RefSelect
              label='Subnet'
              value={draft.subnet_id}
              options={optionsOf(subnets.data?.items, (x) =>
                String(x.cidr ?? '')
              )}
              loading={subnets.isLoading}
              error={errors.subnet_id}
              onChange={(id) => {
                const item = subnets.data?.items.find((x) => x.id === id)
                setDraft({
                  ...draft,
                  subnet_id: id,
                  subnet_display_name: item ? labelOf(item) : '',
                  subnet_cidr: subnetCidrOf(item),
                  vpc_cidr: vpcCidrOf(item),
                })
              }}
            />
          ) : (
            <RefSelect
              label='ENI'
              value={draft.eni_id}
              options={optionsOf(enis.data?.items, (x) =>
                String(x.ip_address ?? '')
              )}
              loading={enis.isLoading}
              error={errors.eni_id}
              onChange={(id) => {
                const item = enis.data?.items.find((x) => x.id === id)
                setDraft({
                  ...draft,
                  eni_id: id,
                  eni_address: String(item?.ip_address ?? ''),
                })
              }}
            />
          )}
          <div className='space-y-2 sm:col-span-2'>
            <Label>Security Groups</Label>
            <SearchableSelect
              value=''
              options={groupOptions.filter(
                (o) => !draft.security_group_ids.includes(o.value)
              )}
              loading={groups.isLoading}
              disabled={!draft.region_id}
              placeholder='Add security group...'
              onValueChange={(id) => {
                const option = groupOptions.find((o) => o.value === id)
                setDraft({
                  ...draft,
                  security_group_ids: [...draft.security_group_ids, id],
                  security_group_names: [
                    ...draft.security_group_names,
                    option?.label || id,
                  ],
                })
              }}
            />
            <div className='flex flex-wrap gap-1'>
              {selectedGroups.map((group) => (
                <Badge
                  key={group.id}
                  variant='secondary'
                  className='cursor-pointer'
                  onClick={() => {
                    const index = draft.security_group_ids.indexOf(group.id)
                    setDraft({
                      ...draft,
                      security_group_ids: draft.security_group_ids.filter(
                        (id) => id !== group.id
                      ),
                      security_group_names: draft.security_group_names.filter(
                        (_, i) => i !== index
                      ),
                    })
                  }}
                >
                  {group.name} ×
                </Badge>
              ))}
            </div>
            {errors.security_group_ids && (
              <p className='text-xs text-destructive'>
                {errors.security_group_ids}
              </p>
            )}
          </div>
          <div className='space-y-2 sm:col-span-2'>
            <div className='flex items-center justify-between'>
              <div>
                <Label>Volumes</Label>
                <p className='text-xs text-muted-foreground'>
                  Exactly one root volume; add any number of data volumes.
                </p>
              </div>
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={() =>
                  setDraft({
                    ...draft,
                    volumes: [
                      ...draft.volumes,
                      {
                        id: crypto.randomUUID(),
                        volume_type: '',
                        volume_type_name: '',
                        size: 50,
                        mount_as: 'data',
                      },
                    ],
                  })
                }
              >
                <Plus /> Add volume
              </Button>
            </div>
            {draft.volumes.map((volume) => (
              <div
                key={volume.id}
                className='grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_110px_120px_auto]'
              >
                <SearchableSelect
                  value={volume.volume_type}
                  options={optionsOf(volumeTypes.data?.items, (x) =>
                    String(x.disk_type ?? '')
                  )}
                  loading={volumeTypes.isLoading}
                  disabled={!draft.zone_id}
                  placeholder='Volume type'
                  onValueChange={(id) => {
                    const item = volumeTypes.data?.items.find(
                      (x) => x.id === id
                    )
                    setDraft({
                      ...draft,
                      volumes: draft.volumes.map((v) =>
                        v.id === volume.id
                          ? {
                              ...v,
                              volume_type: id,
                              volume_type_name: item ? labelOf(item) : '',
                            }
                          : v
                      ),
                    })
                  }}
                />
                <Input
                  type='number'
                  min={1}
                  value={volume.size}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      volumes: draft.volumes.map((v) =>
                        v.id === volume.id
                          ? { ...v, size: Number(e.target.value) }
                          : v
                      ),
                    })
                  }
                />
                <Segmented
                  value={volume.mount_as}
                  values={[
                    { value: 'root', label: 'Root' },
                    { value: 'data', label: 'Data' },
                  ]}
                  onChange={(mount_as) =>
                    setDraft({
                      ...draft,
                      volumes: draft.volumes.map((v) =>
                        v.id === volume.id ? { ...v, mount_as } : v
                      ),
                    })
                  }
                />
                <Button
                  type='button'
                  size='icon'
                  variant='ghost'
                  onClick={() =>
                    setDraft({
                      ...draft,
                      volumes: draft.volumes.filter((v) => v.id !== volume.id),
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            {errors.volumes && (
              <p className='text-xs text-destructive'>{errors.volumes}</p>
            )}
          </div>
          <label className='flex items-center gap-3 rounded-md border p-3 sm:col-span-2'>
            <Checkbox
              checked={draft.cloud_init_enabled}
              onCheckedChange={(v) =>
                setDraft({ ...draft, cloud_init_enabled: v === true })
              }
            />
            <span>
              <span className='block text-sm font-medium'>
                Enable cloud-init
              </span>
              <span className='text-xs text-muted-foreground'>
                Leave custom content empty to use the default OS template.
              </span>
            </span>
          </label>
          {draft.cloud_init_enabled && (
            <div className='space-y-1.5 sm:col-span-2'>
              <Label>Custom cloud-init</Label>
              <Textarea
                className='min-h-32 font-mono text-xs'
                value={draft.cloud_init_content}
                onChange={(e) =>
                  setDraft({ ...draft, cloud_init_content: e.target.value })
                }
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={() => setDraft()}>
            Cancel
          </Button>
          <Button onClick={save}>Save Server</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
