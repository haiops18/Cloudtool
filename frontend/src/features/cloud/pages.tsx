import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AxiosError } from 'axios'
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import {
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileUp,
  GripVertical,
  HardDrive,
  KeyRound,
  Link2,
  Loader2,
  Maximize2,
  MoreHorizontal,
  MonitorPlay,
  Pencil,
  Plus,
  Pause,
  Play,
  RefreshCw,
  Share2,
  ShieldCheck,
  Trash2,
  Square,
  Terminal,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { readAttachMarkers, writeAttachMarkers } from '@/lib/attach-markers'
import { buildIpRange, isUsableIpInCidr, nextIpAddress } from '@/lib/ip-address'
import { downloadXlsx } from '@/lib/xlsx-export'
import { parseXlsxRows, rowsFromHeader } from '@/lib/xlsx-import'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { CloudDataTable } from '@/components/cloud-data-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SearchableSelect } from '@/components/searchable-select'
import { SegmentedTabs } from '@/components/segmented-tabs'
import { SortableHeader } from '@/components/sortable-header'
import { terraformTemplateHeaders } from '@/features/terraform/server-draft'
import { MultiConsoleDialog } from './multi-console-page'
import { CloudPageShell } from './page-shell'
import { resizeErrorMessage } from './resize-error-message'
import { runServerDeletions } from './server-delete-runner'
import { ServerDetailsDialog } from './server-details-dialog'
import { ServerPasswordResultsTable } from './server-password-results-table'
import { ServerResizeDialog } from './server-resize-dialog'
import { ServerSecurityGroupsBulkDialog } from './server-security-groups-bulk-dialog'
import { ServerSecurityGroupsContent } from './server-security-groups-dialog'
import { ServerSecurityRuleCreateDialog } from './server-security-rule-create-dialog'
import { TeleportSshDialog } from './teleport-ssh-dialog'
import type {
  LogRow,
  Page,
  PrivateIp,
  Profile,
  ServerRow,
  Subnet,
} from './types'

type Confirmation = {
  title: string
  desc: string
  path: string
  body?: unknown
}

function useCloudMutation() {
  const project = useCloudStore((state) => state.project)!
  const queryClient = useQueryClient()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const mutation = useMutation({
    mutationFn: async (request: Confirmation) =>
      (await apiClient.post(request.path, request.body)).data,
    onSuccess: async () => {
      toast.success('The operation was submitted successfully.')
      setConfirmation(undefined)
      await queryClient.invalidateQueries({ queryKey: ['cloud', project.id] })
    },
    onError: () =>
      toast.error('The operation failed. Review the audit log for details.'),
  })
  const dialog = (
    <ConfirmDialog
      open={Boolean(confirmation)}
      onOpenChange={(open) => !open && setConfirmation(undefined)}
      title={confirmation?.title ?? ''}
      desc={confirmation?.desc ?? ''}
      isLoading={mutation.isPending}
      handleConfirm={() =>
        confirmation && mutation.mutateAsync(confirmation).then(() => undefined)
      }
    />
  )
  return {
    ask: setConfirmation,
    execute: mutation.mutateAsync,
    isPending: mutation.isPending,
    dialog,
  }
}

function copyText(value: string, label = 'ID') {
  void navigator.clipboard.writeText(value)
  toast.success(`${label} copied.`)
}

function RowActions({
  id,
  label = 'ID',
  children,
}: {
  id: string
  label?: string
  children?: React.ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant='ghost' size='icon' className='size-8'>
          <span className='sr-only'>Open actions</span>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => copyText(id, label)}>
          <Copy />
          Copy {label}
        </DropdownMenuItem>
        {children && <DropdownMenuSeparator />}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function copySelected<T>(
  rows: T[],
  getId: (row: T) => string,
  clear: () => void
) {
  void navigator.clipboard.writeText(rows.map(getId).join('\n'))
  toast.success(`${rows.length} IDs copied.`)
  clear()
}

async function downloadCustomServerExport(
  fields: string[] | undefined,
  projectName: string,
  exportedBy: string,
  reverseOrder = false
) {
  const rows: Array<Record<string, unknown>> = []
  let page = 1
  let total: number
  do {
    const response = await apiClient.get<Page<Record<string, unknown>>>(
      '/cloud/servers',
      { params: { page, page_size: 200 } }
    )
    rows.push(...response.data.items)
    total = response.data.total
    page += 1
  } while (rows.length < total)
  const exportRows = reverseOrder ? [...rows].reverse() : rows

  const selectedFields =
    fields ??
    Array.from(
      new Set([
        ...defaultServerExportFields,
        ...exportRows.flatMap((row) => Object.keys(row)),
      ])
    ).sort()
  const ipFields = new Set(['elastic_ip', 'private_ip'])
  const ipCounts = Object.fromEntries(
    selectedFields
      .filter((field) => ipFields.has(field))
      .map((field) => [
        field,
        Math.max(
          1,
          ...exportRows.map((row) =>
            Array.isArray(row[field]) ? row[field].length : 0
          )
        ),
      ])
  )
  const dataHeaders = selectedFields.flatMap((field) =>
    field in ipCounts
      ? Array.from(
          { length: ipCounts[field] },
          (_, index) => `${field}_${index + 1}`
        )
      : [field]
  )
  const outputRows = exportRows.map((row, rowIndex) => [
    rowIndex + 1,
    ...selectedFields.flatMap((field) => {
      if (!(field in ipCounts)) {
        if (field === 'zone') return [row.zone_display_name ?? row.zone ?? '']
        return [row[field] ?? '']
      }
      const addresses = Array.isArray(row[field])
        ? (row[field] as Array<Record<string, unknown>>)
        : []
      // Preserve the upstream ordering for ordinary rows, but make the
      // CloudTool management network address the primary Private IP whenever
      // a VM has more than one address.
      const orderedAddresses =
        field === 'private_ip' && addresses.length > 1
          ? [...addresses].sort((left, right) => {
              const leftPreferred = String(left.ip_address ?? '').startsWith(
                '10.129.'
              )
              const rightPreferred = String(right.ip_address ?? '').startsWith(
                '10.129.'
              )
              return Number(rightPreferred) - Number(leftPreferred)
            })
          : addresses
      return Array.from({ length: ipCounts[field] }, (_, index) => {
        const address = orderedAddresses[index]
        if (!address) return ''
        return String(address.ip_address ?? '')
      })
    }),
  ])
  const headers = ['NO.', ...dataHeaders.map((header) => header.toUpperCase())]
  downloadXlsx(
    headers,
    outputRows,
    `servers-${
      projectName.trim().replace(/[\\/:*?"<>|]/g, '-') || 'project'
    }-${fields ? 'custom' : 'full'}.xlsx`,
    {
      title: 'SERVER REPORT',
      metadata: [
        {
          label: 'Exported at',
          value: new Intl.DateTimeFormat('en-GB', {
            dateStyle: 'medium',
            timeStyle: 'medium',
          }).format(new Date()),
        },
        { label: 'Exported by', value: exportedBy },
      ],
      sheetName: 'Servers',
    }
  )
}

type ServerCopyColumn =
  | 'id'
  | 'name'
  | 'ip_addresses'
  | 'server_type'
  | 'power_state'
  | 'zone_display_name'
  | 'bandwidth'

const serverCopyOptions: Array<{
  value: ServerCopyColumn
  label: string
}> = [
  { value: 'id', label: 'Server ID' },
  { value: 'name', label: 'Name' },
  { value: 'ip_addresses', label: 'IP addresses' },
  { value: 'server_type', label: 'Server type' },
  { value: 'power_state', label: 'Power state' },
  { value: 'zone_display_name', label: 'Zone' },
  { value: 'bandwidth', label: 'Bandwidth' },
]

const defaultServerExportFields = [
  'id',
  'name',
  'elastic_ip',
  'private_ip',
  'server_type',
  'zone',
  'bandwidth',
] as const

interface ServerOperationResult {
  server_id: string
  status: string
  name?: string
  error?: string
  password?: string
  error_detail?: unknown
}

interface ServerPowerResult extends ServerOperationResult {
  action: 'start' | 'stop'
  upstream_status?: number
}

type ServerDeleteResource = { id: string; label: string }
type ServerDeleteDraft = {
  server_id: string
  name: string
  volumes: ServerDeleteResource[]
  eips: ServerDeleteResource[]
  private_ips: ServerDeleteResource[]
  selected_volumes: string[]
  selected_eips: string[]
  selected_private_ips: string[]
}

type ServerPasswordMode = 'profile' | 'manual' | 'random'
type PrometheusLink = {
  id: string
  name: string
  url: string
  auth_type: string
}
type PrometheusIpResult = {
  ip: string
  found: boolean
  down: boolean
  labels: Record<string, string>
}
type PrometheusResult = {
  server_id: string
  found: boolean
  down: boolean
  labels: Record<string, string>
  ip_results: PrometheusIpResult[]
}
type PrometheusForm = {
  id: string
  name: string
  url: string
  auth_type: string
  bearer_token: string
  username: string
  password: string
  header_name: string
  header_value: string
}
const emptyPrometheusForm: PrometheusForm = {
  id: '',
  name: '',
  url: '',
  auth_type: 'none',
  bearer_token: '',
  username: '',
  password: '',
  header_name: '',
  header_value: '',
}
type TeleportLink = {
  id: string
  name: string
  url: string
  verify_tls: boolean
}
type TeleportResult = {
  server_id: string
  found: boolean
  checked_ip?: string
  teleport_name?: string
  teleport_labels?: string
  error?: string
}

type ResizeFlavor = {
  id: string
  name?: string
  display_name?: string
  ram?: number | string
  vcpus?: number | string
}

type QuotaItem = {
  name?: string
  used?: number | string
  limit?: number | string
}

type AttachmentVolume = {
  name: string
  volume_type: string
  volume_type_name?: string
  size: number
  description: string
}

type AttachmentPlan = {
  server_id: string
  name: string
  zone_id: string
  zone_name: string
  volumes: AttachmentVolume[]
  error?: string
}

type AttachmentResult = {
  server_id: string
  name: string
  status:
    | 'queued'
    | 'creating'
    | 'waiting'
    | 'attaching'
    | 'attached'
    | 'detaching'
    | 'detached'
    | 'failed'
    | 'stopped'
  detail?: string
  operations?: Array<{
    action: 'create' | 'status' | 'attach' | 'detach'
    request: unknown
    response?: unknown
    error?: unknown
  }>
  volumes: Array<{
    name?: string
    volume_id?: string
    status: string
    error?: string
    response?: unknown
  }>
}

function upstreamDetail(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') {
    try {
      return upstreamDetail(JSON.parse(value)) || value
    } catch {
      return value
    }
  }
  if (typeof value !== 'object') return String(value)
  const item = value as Record<string, unknown>
  if (item.upstream_detail != null) return upstreamDetail(item.upstream_detail)
  if (item.detail != null) return upstreamDetail(item.detail)
  if (item.message != null) return upstreamDetail(item.message)
  return JSON.stringify(value)
}

function volumeOperationOutcome(
  operation: NonNullable<AttachmentResult['operations']>[number]
) {
  if (operation.error != null)
    return { label: 'Failed', className: 'text-destructive' }
  const response = operation.response as
    { items?: Array<{ status?: unknown; error?: unknown }> } | undefined
  const items = Array.isArray(response?.items) ? response.items : []
  if (
    items.some(
      (item) =>
        ['failed', 'error'].includes(String(item.status).toLowerCase()) ||
        item.error
    )
  )
    return { label: 'Failed', className: 'text-destructive' }
  if (items.length) {
    const states = [
      ...new Set(items.map((item) => String(item.status || 'returned'))),
    ]
    return {
      label: states.join(', '),
      className: 'text-emerald-600 dark:text-emerald-400',
    }
  }
  return { label: 'Response received', className: 'text-muted-foreground' }
}

type DetachVolumeRow = {
  id: string
  server_id: string
  server_name: string
  volume_id: string
  volume_name: string
  mount_as?: string
  size?: string | number
  disk_type?: string
  speed?: string
  error?: string
}

type DetachServerGroup = {
  serverId: string
  name: string
  rows: DetachVolumeRow[]
}

const PASSWORD_CHANGE_CONCURRENCY = 3
const SERVER_INVENTORY_REFRESH_BATCH_SIZE = 10

function passwordChangeErrorMessage(error: unknown) {
  const detail =
    error instanceof AxiosError
      ? (error.response?.data ?? error.message)
      : error instanceof Error
        ? error.message
        : error
  return (
    resizeErrorMessage(detail) || 'Password request could not be completed.'
  )
}

function validServerPassword(value: string) {
  return (
    value.length > 8 &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9]/.test(value)
  )
}

function upstreamDetailOrFullError(errorDetail: unknown, fallback?: string) {
  if (
    errorDetail &&
    typeof errorDetail === 'object' &&
    !Array.isArray(errorDetail)
  ) {
    const upstreamDetail = (errorDetail as Record<string, unknown>)
      .upstream_detail
    if (typeof upstreamDetail === 'string' && upstreamDetail.trim())
      return upstreamDetail
  }
  return fallback || 'Deletion failed without an error message.'
}

function randomServerPassword(length = 12) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnopqrstuvwxyz'
  const digits = '23456789'
  const special = '_&!@#$%*-+='
  const all = `${upper}${lower}${digits}${special}`
  const pick = (source: string) =>
    source[crypto.getRandomValues(new Uint32Array(1))[0] % source.length]
  const characters = [pick(upper), pick(lower), pick(digits), pick(special)]
  while (characters.length < Math.max(9, length)) characters.push(pick(all))
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex =
      crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1)
    ;[characters[index], characters[swapIndex]] = [
      characters[swapIndex],
      characters[index],
    ]
  }
  return characters.join('')
}

function serverCopyValue(server: ServerRow, column: ServerCopyColumn) {
  if (column === 'ip_addresses')
    return [...(server.elastic_ip ?? []), ...(server.private_ip ?? [])]
      .map((ip) => ip.ip_address)
      .join(', ')
  return String(server[column] ?? '')
}

function IpAddressList({
  addresses,
}: {
  addresses?: Array<{ id: string; ip_address: string }>
}) {
  if (!addresses?.length)
    return <span className='text-muted-foreground'>—</span>
  return (
    <div className='space-y-1'>
      {addresses.map((address) => (
        <div key={address.id}>
          <p className='text-sm whitespace-nowrap'>{address.ip_address}</p>
        </div>
      ))}
    </div>
  )
}

function serverVipAddresses(server: ServerRow): string[] {
  return (server.private_ip ?? []).flatMap((privateIp) => {
    const { vips } = privateIp
    if (typeof vips === 'string')
      return vips
        .split(',')
        .map((vip) => vip.trim())
        .filter(Boolean)
    if (!Array.isArray(vips)) return []
    return vips
      .map((vip) =>
        typeof vip === 'string' ? vip : (vip.ip_address?.trim() ?? '')
      )
      .filter(Boolean)
  })
}

function ServerDetailValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '')
    return <span className='text-muted-foreground'>—</span>
  if (typeof value === 'object')
    return (
      <pre className='max-w-full font-mono text-xs break-all whitespace-pre-wrap'>
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  return <span className='text-sm break-all'>{String(value)}</span>
}

function normalizeServerIps(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is { id: string; ip_address: string } =>
    Boolean(
      item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).id === 'string' &&
      typeof (item as Record<string, unknown>).ip_address === 'string'
    )
  )
}

function attachedServerVolumes(
  server: ServerRow,
  detail: Record<string, unknown>
) {
  const source =
    detail.volume_details ?? detail.volumes ?? detail.attached_volumes ?? []
  const values = Array.isArray(source) ? source : []
  return values
    .map((item): DetachVolumeRow | undefined => {
      const outer =
        typeof item === 'object' && item
          ? (item as Record<string, unknown>)
          : {}
      const volume =
        typeof outer.volume === 'object' && outer.volume
          ? (outer.volume as Record<string, unknown>)
          : outer
      const volumeId = String(volume.id ?? outer.volume_id ?? '')
      if (!volumeId) return undefined
      const mountAs = String(outer.mount_as ?? volume.mount_as ?? '')
      if (mountAs.toLowerCase() === 'root') return undefined
      return {
        id: `${server.id}-${volumeId}`,
        server_id: server.id,
        server_name: server.name,
        volume_id: volumeId,
        volume_name: String(volume.display_name ?? volume.name ?? volumeId),
        mount_as: mountAs,
        size: volume.size as string | number | undefined,
        disk_type: volume.disk_type as string | undefined,
        speed: volume.speed as string | undefined,
      }
    })
    .filter((item): item is DetachVolumeRow => Boolean(item))
}

function serverDeleteResources(
  server: ServerRow,
  detail: Record<string, unknown>
): ServerDeleteDraft {
  const asResources = (
    value: unknown,
    labelKeys: string[]
  ): ServerDeleteResource[] => {
    const values = Array.isArray(value) ? value : value ? [value] : []
    return values.flatMap((item) => {
      const outer =
        item && typeof item === 'object'
          ? (item as Record<string, unknown>)
          : {}
      const resource =
        outer.volume && typeof outer.volume === 'object'
          ? (outer.volume as Record<string, unknown>)
          : outer
      const id = String(resource.id ?? outer.volume_id ?? '')
      if (!id) return []
      const label = labelKeys
        .map((key) => resource[key] ?? outer[key])
        .find((value) => typeof value === 'string' && value.trim())
      return [{ id, label: String(label ?? id) }]
    })
  }
  const eips = asResources(
    detail.elastic_ip ?? detail.elastic_ips ?? server.elastic_ip,
    ['ip_address', 'display_name', 'name']
  )
  const privateIps = asResources(
    detail.private_ip ?? detail.private_ips ?? server.private_ip,
    ['ip_address', 'display_name', 'name']
  )
  const volumes = asResources(
    detail.volume_details ?? detail.volumes ?? detail.attached_volumes,
    ['display_name', 'name', 'device', 'id']
  )
  return {
    server_id: server.id,
    name: String(detail.name ?? server.name),
    volumes,
    eips,
    private_ips: privateIps,
    selected_volumes: [],
    selected_eips: [],
    selected_private_ips: [],
  }
}

function ServerIpDetails({
  title,
  type,
  addresses,
}: {
  title: string
  type: 'Elastic' | 'Private'
  addresses: Array<{ id: string; ip_address: string }>
}) {
  return (
    <div className='space-y-2'>
      <div className='flex items-center justify-between'>
        <h3 className='text-sm font-semibold'>{title}</h3>
        <span className='text-xs text-muted-foreground'>
          {addresses.length} address(es)
        </span>
      </div>
      <div className='overflow-x-auto rounded-md border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>IP address</TableHead>
              <TableHead>IP ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {addresses.length ? (
              addresses.map((address) => (
                <TableRow key={address.id}>
                  <TableCell>{type}</TableCell>
                  <TableCell className='font-mono font-medium'>
                    {address.ip_address}
                  </TableCell>
                  <TableCell className='font-mono text-xs'>
                    {address.id}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className='h-20 text-center text-muted-foreground'
                >
                  No {type.toLowerCase()} IP addresses.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

interface ServerInventoryRow {
  id: string
  server_id: string
  server_name: string
  refreshed_at: string
  power_state?: string
  zone?: string
  private_ip?: unknown
  vip_ip?: unknown
  private_subnets?: unknown
  elastic_ip?: unknown
  inventory_status?: 'active' | 'deleted'
  snapshot: Record<string, unknown>
}

interface SecurityGroupOption {
  id: string
  name: string
  display_name?: string
  description?: string
}

interface ServerSecurityRule {
  id: string
  direction: 'ingress' | 'egress'
  protocol: string
  port_range_min?: number | null
  port_range_max?: number | null
  remote_ip_prefix?: string
  ethertype?: string
  description?: string
  security_group?:
    string | { id?: string; name?: string; display_name?: string }
}

function securityGroupId(value: unknown) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object')
    return String((value as Record<string, unknown>).id ?? '')
  return ''
}

function snapshotUnavailable(loading: boolean) {
  return (
    <span className='text-xs text-muted-foreground'>
      {loading ? 'Loading…' : 'No snapshot'}
    </span>
  )
}

function inventoryIpText(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === 'object' && item
          ? String((item as Record<string, unknown>).ip_address ?? '')
          : String(item ?? '')
      )
      .filter(Boolean)
      .join(', ')
  }
  if (typeof value === 'object' && value)
    return String((value as Record<string, unknown>).ip_address ?? '')
  return String(value ?? '')
}

function inventoryIpLines(value: unknown) {
  return inventoryIpText(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function inventoryVipLinesByPrivateIp(value: unknown): string[][] {
  const privateIps = Array.isArray(value) ? value : [value]
  return privateIps.map((privateIp) => {
    if (!privateIp || typeof privateIp !== 'object') return []
    const vips = (privateIp as Record<string, unknown>).vips
    return inventoryIpLines(vips)
  })
}

function inventoryLines(value: unknown) {
  if (Array.isArray(value)) return value.map(inventoryText)
  const text = inventoryText(value)
  return text ? [text] : []
}

function inventoryText(value: unknown): string {
  if (Array.isArray(value))
    return value.map(inventoryText).filter(Boolean).join(', ')
  if (typeof value === 'object' && value) {
    const item = value as Record<string, unknown>
    return String(
      item.display_name ??
        item.name ??
        item.ip_address ??
        item.flavor_name ??
        item.id ??
        ''
    )
  }
  return String(value ?? '')
}

function inventoryReference(snapshot: Record<string, unknown>, key: string) {
  const references = snapshot.mapped_references as
    Record<string, unknown> | undefined
  return inventoryText(references?.[key] ?? snapshot[key])
}

function inventorySpecs(snapshot: Record<string, unknown>) {
  const specs =
    (snapshot.specs as Record<string, unknown> | undefined) ??
    (snapshot.flavor as Record<string, unknown> | undefined) ??
    (snapshot.configuration as Record<string, unknown> | undefined)
  if (!specs) return '—'
  const flavor = inventoryText(
    specs.flavor_name ?? specs.name ?? snapshot.flavor_name
  )
  if (flavor) return flavor
  const cpu = inventoryText(specs.vcpus ?? specs.vcpu ?? snapshot.vcpus)
  const ram = inventoryText(specs.ram ?? snapshot.ram)
  return (
    [cpu && `${cpu} vCPU`, ram && `${ram} GB`].filter(Boolean).join(' · ') ||
    '—'
  )
}

function inventoryCpuRam(snapshot: Record<string, unknown>) {
  const specs =
    (snapshot.specs as Record<string, unknown> | undefined) ??
    (snapshot.flavor as Record<string, unknown> | undefined) ??
    (snapshot.configuration as Record<string, unknown> | undefined) ??
    {}
  const cpu = inventoryText(specs.vcpus ?? specs.vcpu ?? snapshot.vcpus)
  const ram = inventoryText(specs.ram ?? snapshot.ram)
  return (
    [cpu && `${cpu} vCPU`, ram && `${ram} GB`].filter(Boolean).join(' · ') ||
    '—'
  )
}

function inventoryBoot(snapshot: Record<string, unknown>) {
  const boot = snapshot.boot as Record<string, unknown> | undefined
  return inventoryText(
    snapshot.image_name ??
      boot?.image_name ??
      boot?.public_image_name ??
      boot?.image ??
      snapshot.image
  )
}

function inventoryFlavor(snapshot: Record<string, unknown>) {
  const specs =
    (snapshot.specs as Record<string, unknown> | undefined) ??
    (snapshot.flavor as Record<string, unknown> | undefined) ??
    (snapshot.configuration as Record<string, unknown> | undefined)
  return (
    inventoryText(specs?.flavor_name ?? specs?.name ?? snapshot.flavor_name) ||
    (specs ? 'Custom' : '—')
  )
}

function inventoryVolumes(snapshot: Record<string, unknown>) {
  const volumes = Array.isArray(snapshot.volume_details)
    ? snapshot.volume_details
    : Array.isArray(snapshot.volumes)
      ? snapshot.volumes
      : Array.isArray(snapshot.volume)
        ? snapshot.volume
        : Array.isArray(snapshot.attached_volumes)
          ? snapshot.attached_volumes
          : []
  return volumes
    .map((value) => {
      const volume = value as Record<string, unknown>
      const source =
        typeof volume.volume === 'object' && volume.volume
          ? (volume.volume as Record<string, unknown>)
          : volume
      const volumeType = source.volume_type
      const type = inventoryText(
        volumeType ?? source.disk_type ?? source.type ?? source.volume_type_name
      )
      const size = inventoryText(source.size)
      const mount = inventoryText(volume.mount_as)
      const details =
        typeof volumeType === 'object' && volumeType
          ? (volumeType as Record<string, unknown>)
          : source
      const speed = inventoryText(
        details.iops ??
          details.max_iops ??
          details.throughput ??
          details.speed ??
          details.performance
      )
      return [
        mount,
        type && type.toUpperCase(),
        size && `${size}GB`,
        speed && `(${speed})`,
      ]
        .filter(Boolean)
        .join(' · ')
    })
    .filter(Boolean)
    .join('\n')
}

function inventoryReferenceLines(
  snapshot: Record<string, unknown>,
  key: string
) {
  const references = snapshot.mapped_references as
    Record<string, unknown> | undefined
  const value = references?.[key] ?? snapshot[key]
  if (Array.isArray(value)) return value.map(inventoryText).filter(Boolean)
  const text = inventoryText(value)
  return text
    ? text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : []
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function terraformTemplateRowFromInventory(
  inventory: ServerInventoryRow,
  fallback: ServerRow
) {
  const snapshot = inventory.snapshot ?? {}
  const references = objectValue(snapshot.mapped_references)
  const specs = objectValue(snapshot.specs)
  const boot = objectValue(snapshot.boot)
  const reference = (key: string, fallbackValue?: unknown) =>
    inventoryText(references[key] ?? fallbackValue ?? snapshot[key])
  const referenceLines = (key: string, fallbackValue?: unknown) =>
    inventoryLines(references[key] ?? fallbackValue ?? snapshot[key])
  const family = String(
    specs.server_type ?? snapshot.instance_family ?? 'basic'
  )
    .toLowerCase()
    .includes('gpu')
    ? 'gpu'
    : 'basic'
  const specsMode =
    String(specs.kind ?? 'predefined').toLowerCase() === 'custom'
      ? 'custom'
      : 'predefined'
  const volumeDetails = Array.isArray(snapshot.volume_details)
    ? snapshot.volume_details.map(objectValue)
    : []
  const rootVolume =
    volumeDetails.find((item) => item.mount_as === 'root') ?? volumeDetails[0]
  const dataVolumes = volumeDetails.filter(
    (item) => item !== rootVolume && item.mount_as !== 'root'
  )
  const volumeLine = (
    item: Record<string, unknown>,
    mountAs: 'root' | 'data',
    index: number
  ) => {
    const type =
      inventoryText(item.type ?? item.volume_type ?? item.disk_type) || 'SSD'
    const size = Number(item.size ?? 50) || 50
    const mountPoint =
      inventoryText(item.mount_point ?? item.mount_path) ||
      (mountAs === 'root' ? '/' : index === 0 ? '/data' : `/data${index + 1}`)
    return `${mountAs},${type},${size},${mountPoint}`
  }
  const privateSubnet =
    inventoryLines(inventory.private_subnets)[0] || reference('subnet')
  const hasElasticIp = inventoryIpLines(inventory.elastic_ip).length > 0
  const imageName =
    inventoryText(snapshot.image_name) ||
    inventoryText(boot.public_image_name ?? boot.image)
  const root = rootVolume ? volumeLine(rootVolume, 'root', 0) : 'root,SSD,50,/'

  return [
    inventory.server_name || fallback.name,
    family,
    reference('zone', fallback.zone_display_name),
    specsMode,
    inventoryText(specs.flavor_name ?? snapshot.flavor_name),
    Number(specs.ram ?? snapshot.ram ?? 4) || 4,
    Number(specs.vcpus ?? specs.vcpu ?? snapshot.vcpus ?? 2) || 2,
    imageName,
    reference('key_pair', snapshot.key_pair ?? snapshot.keypair),
    Number(snapshot.bandwidth ?? fallback.bandwidth ?? 300) || 300,
    hasElasticIp ? 'yes' : 'no',
    '',
    snapshot.enable_ipv4 === false ? 'no' : 'yes',
    'Auto Allocate',
    privateSubnet,
    '',
    referenceLines('security_groups').join(', '),
    reference('placement_group', snapshot.placement_group),
    root,
    dataVolumes
      .map((item, index) => volumeLine(item, 'data', index))
      .join('\n'),
    'no',
    '',
    'no',
    'public',
    '',
    '',
    '',
    '',
  ]
}

function ServerInventoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const project = useCloudStore((state) => state.project)!
  const queryClient = useQueryClient()
  const [viewRow, setViewRow] = useState<ServerInventoryRow>()
  const [showDeleted, setShowDeleted] = useState(false)
  const [dolphinOpen, setDolphinOpen] = useState(false)
  const [dolphinSystemName, setDolphinSystemName] = useState('')
  const [dolphinOwnerUnit, setDolphinOwnerUnit] = useState('VHKT')
  const [dolphinProductOwner, setDolphinProductOwner] = useState('')
  const [dolphinDeploymentSite, setDolphinDeploymentSite] =
    useState('PUBLIC_CLOUD')
  const [dolphinDeploymentPosition, setDolphinDeploymentPosition] =
    useState('Public_cloud')
  const [dolphinPreviewRows, setDolphinPreviewRows] = useState<
    Array<Record<string, unknown>>
  >([])
  const [dolphinManageOpen, setDolphinManageOpen] = useState(false)
  const [dolphinManageRecords, setDolphinManageRecords] = useState<
    Array<Record<string, unknown>>
  >([])
  const [dolphinRetireConfirm, setDolphinRetireConfirm] = useState(false)
  const [dolphinRetireIds, setDolphinRetireIds] = useState<string[]>([])
  const [dolphinResults, setDolphinResults] = useState<
    Array<{
      server_id: string
      server_name?: string
      status: string
      action?: string
      error?: string
      vm_id?: string | number
      system_name?: string
      system_created?: boolean
    }>
  >([])
  const [refreshProgress, setRefreshProgress] = useState<{
    completed: number
    failed: number
    total: number
  }>()
  const inventory = useQuery({
    queryKey: ['cloud', project.id, 'server-inventory'],
    enabled: open,
    queryFn: async ({ signal }) =>
      (await apiClient.get<Page<ServerInventoryRow>>('/cloud/server-inventory', { signal }))
        .data,
  })
  const cloudIdentity = useQuery({
    queryKey: ['cloud', project.id, 'current-cloud-user'],
    enabled: open,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<{
          username?: string
          email?: string
          display_name?: string
        }>('/cloud/current-user', { signal })
      ).data,
  })
  useEffect(() => {
    if (!dolphinOpen || dolphinProductOwner) return
    const owner =
      cloudIdentity.data?.username ||
      cloudIdentity.data?.email ||
      cloudIdentity.data?.display_name ||
      ''
    if (!owner) return
    setDolphinProductOwner(owner)
    setDolphinPreviewRows((rows) =>
      rows.map((row) => ({ ...row, product_owner: owner }))
    )
  }, [cloudIdentity.data, dolphinOpen, dolphinProductOwner])
  const refresh = useMutation({
    mutationFn: async (serverIds?: string[]) => {
      const fullRefresh = !serverIds?.length
      let targetIds = serverIds ?? []

      if (fullRefresh) {
        targetIds = []
        let page = 1
        let hasMore = true
        while (hasMore) {
          const { data } = await apiClient.get<
            Page<{ server_id: string }> & { has_more?: boolean }
          >('/cloud/server-inventory/targets', {
            params: { page, page_size: 200 },
            timeout: 45_000,
          })
          targetIds.push(...data.items.map((item) => item.server_id))
          hasMore = Boolean(data.has_more)
          page += 1
        }
      }

      let completed = 0
      let failed = 0
      setRefreshProgress({ completed, failed, total: targetIds.length })

      for (
        let offset = 0;
        offset < targetIds.length;
        offset += SERVER_INVENTORY_REFRESH_BATCH_SIZE
      ) {
        const batch = targetIds.slice(
          offset,
          offset + SERVER_INVENTORY_REFRESH_BATCH_SIZE
        )
        try {
          const { data } = await apiClient.post<{
            items?: Array<{ status: string }>
          }>(
            '/cloud/server-inventory/refresh',
            { server_ids: batch },
            { timeout: 60_000 }
          )
          failed +=
            data.items?.filter((item) => item.status !== 'succeeded').length ??
            batch.length
        } catch {
          // This batch failed as a request, but later batches must continue.
          failed += batch.length
        }
        completed += batch.length
        setRefreshProgress({ completed, failed, total: targetIds.length })
      }

      let reconcileFailed = false
      if (fullRefresh) {
        try {
          await apiClient.post(
            '/cloud/server-inventory/reconcile',
            { server_ids: targetIds },
            { timeout: 45_000 }
          )
        } catch {
          reconcileFailed = true
        }
      }
      return { failed, reconcileFailed, total: targetIds.length }
    },
    onSuccess: async (result: {
      failed: number
      reconcileFailed: boolean
      total: number
    }) => {
      await queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'server-inventory'],
      })
      if (result.failed || result.reconcileFailed) {
        const detail = result.reconcileFailed
          ? ' Deleted-server reconciliation will retry on the next full refresh.'
          : ''
        toast.warning(
          `Refresh completed with ${result.failed} failed server(s) out of ${result.total}.${detail}`
        )
      } else
        toast.success(`Server inventory refreshed (${result.total} server(s)).`)
    },
    onError: () => toast.error('Server inventory refresh failed.'),
    onSettled: () => setRefreshProgress(undefined),
  })
  const dolphinPreview = useMutation({
    mutationFn: async (input: { serverIds: string[]; systemName: string }) =>
      (
        await apiClient.post<{ items: Array<Record<string, unknown>> }>(
          '/cloud/server-inventory/dolphin-preview',
          { server_ids: input.serverIds, system_name: input.systemName },
          { timeout: 60_000 }
        )
      ).data,
    onSuccess: (data) =>
      setDolphinPreviewRows(
        data.items.map((item) => ({
          ...item,
          owner_unit: dolphinOwnerUnit || 'VHKT',
          product_owner:
            dolphinProductOwner ||
            cloudIdentity.data?.username ||
            cloudIdentity.data?.email ||
            cloudIdentity.data?.display_name ||
            '',
          deployment_site: dolphinDeploymentSite || 'PUBLIC_CLOUD',
          deployment_position: dolphinDeploymentPosition || 'Public_cloud',
        }))
      ),
    onError: () => toast.error('Dolphin preview could not be prepared.'),
  })
  const dolphinSync = useMutation({
    mutationFn: async (rows: Array<Record<string, unknown>>) =>
      (
        await apiClient.post<{
          items: Array<{
            server_id: string
            server_name?: string
            status: string
            action?: string
            error?: string
            vm_id?: string | number
            system_name?: string
            system_created?: boolean
          }>
        }>(
          '/cloud/server-inventory/dolphin-sync',
          {
            items: rows,
            system_name: dolphinSystemName.trim(),
            action: 'allocate',
          },
          { timeout: 180_000 }
        )
      ).data,
    onSuccess: (data) => {
      setDolphinResults(data.items)
      const failed = data.items.filter(
        (item) => item.status.toLowerCase() === 'error'
      ).length
      toast[failed ? 'warning' : 'success'](
        failed
          ? `Dolphin sync finished with ${failed} failed server(s).`
          : `Dolphin sync completed for ${data.items.length} server(s).`
      )
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Dolphin sync failed.'
      ),
  })
  const dolphinRecordList = useMutation({
    mutationFn: async () =>
      (
        await apiClient.post<{ items: Array<Record<string, unknown>> }>(
          '/cloud/server-inventory/dolphin-records',
          {},
          { timeout: 180_000 }
        )
      ).data,
    onSuccess: (data) => setDolphinManageRecords(data.items),
    onError: () => toast.error('Dolphin VM information could not be loaded.'),
  })
  const dolphinManage = useMutation({
    mutationFn: async (input: { action: 'revoke'; serverIds: string[] }) =>
      (
        await apiClient.post<{ items: Array<Record<string, unknown>> }>(
          '/cloud/server-inventory/dolphin-sync',
          {
            server_ids: input.serverIds,
            system_name: dolphinSystemName.trim(),
            action: input.action,
          },
          { timeout: 180_000 }
        )
      ).data,
    onSuccess: (data) => {
      const failed = data.items.filter(
        (item) => String(item.status).toLowerCase() === 'error'
      ).length
      toast[failed ? 'warning' : 'success'](
        failed
          ? `Dolphin retire finished with ${failed} failed VM(s).`
          : `Retired ${data.items.length} Dolphin VM(s).`
      )
      dolphinRecordList.mutate()
    },
    onError: () => toast.error('Dolphin VM management request failed.'),
  })
  const openDolphinSync = (selected: ServerInventoryRow[]) => {
    if (!selected.length) return
    const systemName = project.display_name || project.name || project.id
    setDolphinSystemName(systemName)
    setDolphinOwnerUnit('VHKT')
    setDolphinProductOwner('')
    setDolphinDeploymentSite('PUBLIC_CLOUD')
    setDolphinDeploymentPosition('Public_cloud')
    setDolphinPreviewRows([])
    setDolphinResults([])
    setDolphinOpen(true)
    dolphinPreview.mutate({
      serverIds: selected.map((row) => row.server_id),
      systemName,
    })
  }
  const inventoryRows = useMemo(
    () =>
      (inventory.data?.items ?? []).filter(
        (row) => showDeleted || row.inventory_status !== 'deleted'
      ),
    [inventory.data, showDeleted]
  )
  const columns = useMemo<ColumnDef<ServerInventoryRow>[]>(
    () => [
      {
        accessorKey: 'server_id',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server ID' />
        ),
        cell: ({ row }) => (
          <span
            className='block max-w-28 truncate font-mono text-xs text-muted-foreground'
            title={row.original.server_id}
          >
            {row.original.server_id || '—'}
          </span>
        ),
      },
      {
        accessorKey: 'server_name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server' />
        ),
        cell: ({ row }) => (
          <div>
            <p className='font-medium'>{row.original.server_name || '—'}</p>
          </div>
        ),
      },
      {
        accessorKey: 'power_state',
        header: ({ column }) => (
          <SortableHeader column={column} title='State' />
        ),
        cell: ({ getValue, row }) => {
          const state = String(getValue() || 'unknown').toLowerCase()
          return (
            <div className='space-y-0.5 text-xs'>
              <p
                className={
                  state === 'running'
                    ? 'font-medium text-emerald-600 dark:text-emerald-400'
                    : ['error', 'deleted'].includes(state)
                      ? 'font-medium text-destructive'
                      : 'font-medium text-muted-foreground'
                }
              >
                {state}
              </p>
              <p className='text-muted-foreground'>
                {inventoryText(row.original.snapshot.server_type) || '—'}
              </p>
            </div>
          )
        },
      },
      {
        accessorKey: 'zone',
        header: ({ column }) => <SortableHeader column={column} title='Zone' />,
        cell: ({ getValue }) => (
          <span className='max-w-40 truncate text-xs'>
            {String(getValue() || '—')}
          </span>
        ),
      },
      {
        id: 'flavor',
        accessorFn: (row) =>
          `${inventoryFlavor(row.snapshot)} ${inventorySpecs(row.snapshot)}`,
        header: ({ column }) => (
          <SortableHeader column={column} title='Flavor / specs' />
        ),
        cell: ({ row }) => (
          <div className='max-w-52 space-y-0.5 text-xs'>
            <p className='truncate font-medium'>
              {inventoryFlavor(row.original.snapshot)}
            </p>
            <p className='truncate text-muted-foreground'>
              {inventoryCpuRam(row.original.snapshot)}
            </p>
          </div>
        ),
      },
      {
        id: 'image_name',
        accessorFn: (row) => inventoryBoot(row.snapshot),
        header: ({ column }) => (
          <SortableHeader column={column} title='Image name' />
        ),
        cell: ({ row }) => (
          <span className='block max-w-56 truncate text-xs'>
            {inventoryBoot(row.original.snapshot) || '—'}
          </span>
        ),
      },
      {
        id: 'elastic_ip',
        accessorFn: (row) => inventoryIpText(row.elastic_ip),
        header: ({ column }) => (
          <SortableHeader column={column} title='Elastic IP' />
        ),
        cell: ({ row }) => {
          const addresses = inventoryIpLines(row.original.elastic_ip)
          return addresses.length ? (
            <div className='font-mono text-xs leading-5'>
              {addresses.map((address) => (
                <p key={address}>{address}</p>
              ))}
            </div>
          ) : (
            <span className='text-xs text-muted-foreground'>—</span>
          )
        },
      },
      {
        id: 'private_ip',
        accessorFn: (row) => inventoryIpText(row.private_ip),
        header: ({ column }) => (
          <SortableHeader column={column} title='Private IP' />
        ),
        cell: ({ row }) => {
          const addresses = inventoryIpLines(row.original.private_ip)
          return addresses.length ? (
            <div className='font-mono text-xs leading-5'>
              {addresses.map((address) => (
                <p key={address}>{address}</p>
              ))}
            </div>
          ) : (
            <span className='text-xs text-muted-foreground'>—</span>
          )
        },
      },
      {
        id: 'vip_ip',
        accessorFn: (row) =>
          inventoryVipLinesByPrivateIp(row.private_ip).flat().join(' '),
        header: ({ column }) => (
          <SortableHeader column={column} title='VIP IP' />
        ),
        cell: ({ row }) => {
          const privateIps = inventoryIpLines(row.original.private_ip)
          const vipGroups = inventoryVipLinesByPrivateIp(
            row.original.private_ip
          )
          return privateIps.length ? (
            <div className='max-w-52 font-mono text-xs leading-5'>
              {privateIps.map((privateIp, index) => {
                const vips = vipGroups[index] ?? []
                return (
                  <p key={`${privateIp}-${index}`} className='truncate'>
                    {vips.length ? vips.join(', ') : '—'}
                  </p>
                )
              })}
            </div>
          ) : (
            <span className='text-xs text-muted-foreground'>—</span>
          )
        },
      },
      {
        id: 'private_subnet',
        accessorFn: (row) => inventoryLines(row.private_subnets).join(' '),
        header: ({ column }) => (
          <SortableHeader column={column} title='Subnet' />
        ),
        cell: ({ row }) => {
          const addresses = inventoryIpLines(row.original.private_ip)
          const subnets = inventoryLines(row.original.private_subnets)
          return addresses.length ? (
            <div className='max-w-48 text-xs leading-5'>
              {addresses.map((address, index) => (
                <p key={`${address}-${index}`} className='truncate'>
                  {subnets[index] || '—'}
                </p>
              ))}
            </div>
          ) : (
            <span className='text-xs text-muted-foreground'>—</span>
          )
        },
      },
      {
        id: 'security_groups',
        accessorFn: (row) =>
          inventoryReference(row.snapshot, 'security_groups'),
        header: ({ column }) => (
          <SortableHeader column={column} title='Security groups' />
        ),
        cell: ({ row }) => {
          const groups = inventoryReferenceLines(
            row.original.snapshot,
            'security_groups'
          )
          return groups.length ? (
            <div className='max-w-52 text-xs leading-5'>
              {groups.map((group) => (
                <p key={group} className='truncate'>
                  {group}
                </p>
              ))}
            </div>
          ) : (
            <span className='text-xs text-muted-foreground'>—</span>
          )
        },
      },
      {
        id: 'key_pair',
        accessorFn: (row) => inventoryReference(row.snapshot, 'key_pair'),
        header: ({ column }) => (
          <SortableHeader column={column} title='Key pair' />
        ),
        cell: ({ row }) => (
          <span className='block max-w-44 truncate text-xs'>
            {inventoryReference(row.original.snapshot, 'key_pair') || '—'}
          </span>
        ),
      },
      {
        id: 'placement_group',
        accessorFn: (row) =>
          inventoryReference(row.snapshot, 'placement_group'),
        header: ({ column }) => (
          <SortableHeader column={column} title='Placement group' />
        ),
        cell: ({ row }) => (
          <span className='block max-w-44 truncate text-xs'>
            {inventoryReference(row.original.snapshot, 'placement_group') ||
              '—'}
          </span>
        ),
      },
      {
        id: 'bandwidth',
        accessorFn: (row) => inventoryText(row.snapshot.bandwidth),
        header: ({ column }) => (
          <SortableHeader column={column} title='Bandwidth' />
        ),
        cell: ({ row }) => {
          const value = inventoryText(row.original.snapshot.bandwidth)
          return (
            <span className='text-xs'>{value ? `${value} Mbps` : '—'}</span>
          )
        },
      },
      {
        id: 'storage',
        accessorFn: (row) => inventoryVolumes(row.snapshot),
        header: ({ column }) => (
          <SortableHeader column={column} title='Volumes' />
        ),
        cell: ({ row }) => (
          <p className='max-w-56 text-xs leading-5 whitespace-pre-line'>
            {inventoryVolumes(row.original.snapshot) || '—'}
          </p>
        ),
      },
      {
        id: 'created_at',
        accessorFn: (row) => inventoryText(row.snapshot.created_at),
        header: ({ column }) => (
          <SortableHeader column={column} title='Created at' />
        ),
        cell: ({ row }) => {
          const value = inventoryText(row.original.snapshot.created_at)
          return (
            <span className='text-xs'>
              {value ? new Date(value).toLocaleString() : '—'}
            </span>
          )
        },
      },
      {
        accessorKey: 'refreshed_at',
        header: ({ column }) => (
          <SortableHeader column={column} title='Last refresh' />
        ),
        cell: ({ getValue }) => {
          const value = getValue() as string
          return value ? new Date(value).toLocaleString() : '—'
        },
      },
      {
        id: 'actions',
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions id={row.original.server_id} label='server ID'>
            <DropdownMenuItem onClick={() => setViewRow(row.original)}>
              <Eye />
              View collected details
            </DropdownMenuItem>
          </RowActions>
        ),
      },
    ],
    []
  )

  // The volume editor is rendered by the attachment workflow below. These
  // inert bindings keep this independent resize dialog isolated.
  const editingPlan: AttachmentPlan | undefined = undefined
  const setEditingPlanId = (_value: string | undefined) => undefined
  const volumeTypesByZone = new Map<string, ResizeFlavor[]>()
  const volumeTypeQueries: Array<{ isLoading?: boolean }> = []
  const uniqueZones: string[] = []
  const setPlanVolumes = (_serverId: string, _volumes: AttachmentVolume[]) =>
    undefined
  void [
    editingPlan,
    setEditingPlanId,
    volumeTypesByZone,
    volumeTypeQueries,
    uniqueZones,
    setPlanVolumes,
  ]

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && refresh.isPending) return
          onOpenChange(nextOpen)
        }}
      >
        <DialogContent className='!top-4 flex !h-[calc(100svh-2rem)] !max-h-[calc(100svh-2rem)] !w-[calc(100vw-2rem)] !max-w-[calc(100vw-2rem)] flex-col overflow-hidden sm:!w-[calc(100vw-2rem)] sm:!max-w-[calc(100vw-2rem)]'>
          <DialogHeader className='shrink-0'>
            <div className='flex items-start justify-between gap-4 pr-10'>
              <div>
                <DialogTitle>Server inventory</DialogTitle>
                <DialogDescription>
                  Saved server details for{' '}
                  {project.display_name || project.name}. Refresh collects the
                  current Cloud API details and updates this project-only
                  inventory.
                </DialogDescription>
                {refreshProgress && (
                  <p className='mt-1 text-xs text-muted-foreground'>
                    Refreshing {refreshProgress.completed}/
                    {refreshProgress.total}
                    {refreshProgress.failed
                      ? ` · ${refreshProgress.failed} failed`
                      : ''}
                  </p>
                )}
                <label className='mt-2 inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground'>
                  <Checkbox
                    checked={showDeleted}
                    onCheckedChange={(checked) =>
                      setShowDeleted(Boolean(checked))
                    }
                  />
                  Show deleted servers
                </label>
              </div>
              <div className='flex items-center gap-2'>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={refresh.isPending}
                  onClick={() => {
                    setDolphinManageRecords([])
                    setDolphinManageOpen(true)
                    dolphinRecordList.mutate()
                  }}
                >
                  <Share2 /> Manage Dolphin VMs
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size='icon'
                      aria-label='Refresh all server details'
                      onClick={() => refresh.mutate([])}
                      disabled={refresh.isPending}
                    >
                      <RefreshCw
                        className={
                          refresh.isPending ? 'animate-spin' : undefined
                        }
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Refresh all server details</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </DialogHeader>
          <div className='min-h-0 flex-1 overflow-auto [&_[data-slot=table-container]]:!max-h-[calc(100svh-15rem)]'>
            <CloudDataTable
              data={inventoryRows}
              columns={columns}
              getRowId={(row) => row.server_id}
              loading={inventory.isLoading}
              entityName='server snapshot'
              exportFileName={`server-inventory-${project.id}`}
              searchPlaceholder='Search collected server details...'
              toolbar={(selected) => (
                <div className='flex flex-wrap gap-2'>
                  <Button
                    variant='outline'
                    size='sm'
                    disabled={refresh.isPending || !selected.length}
                    onClick={() =>
                      refresh.mutate(selected.map((row) => row.server_id))
                    }
                  >
                    <RefreshCw
                      className={refresh.isPending ? 'animate-spin' : undefined}
                    />
                    Refresh selected ({selected.length})
                  </Button>
                  <Button
                    size='sm'
                    disabled={!selected.length || refresh.isPending}
                    onClick={() => openDolphinSync(selected)}
                  >
                    <Share2 /> Sync VM to Dolphin
                  </Button>
                  <Button
                    variant='outline'
                    size='sm'
                    disabled={!selected.length}
                    onClick={() => {
                      downloadXlsx(
                        [
                          'Server ID',
                          'Server',
                          'State',
                          'Zone',
                          'Flavor / specs',
                          'CPU (vCPU)',
                          'RAM (GB)',
                          'Image name',
                          'Elastic IP',
                          'Private IP',
                          'VIP IP',
                          'Subnet',
                          'Security groups',
                          'Key pair',
                          'Placement group',
                          'Bandwidth',
                          'Volumes',
                          'Created at',
                          'Last refresh',
                        ],
                        selected.map((row) => {
                          const flavor = row.snapshot.flavor as
                            Record<string, unknown> | undefined
                          const specs = (row.snapshot.specs ??
                            row.snapshot.configuration) as
                            Record<string, unknown> | undefined
                          const privateIps = inventoryIpLines(row.private_ip)
                          const vipGroups = inventoryVipLinesByPrivateIp(
                            row.private_ip
                          )
                          const subnets = inventoryLines(row.private_subnets)
                          const bandwidth = inventoryText(
                            row.snapshot.bandwidth
                          )
                          const created = inventoryText(row.snapshot.created_at)
                          return [
                            row.server_id,
                            row.server_name || '-',
                            `${String(row.power_state || 'unknown').toLowerCase()}\n${inventoryText(row.snapshot.server_type) || '-'}`,
                            row.zone || '-',
                            `${inventoryFlavor(row.snapshot)}\n${inventoryCpuRam(row.snapshot)}`,
                            flavor?.vcpus ??
                              flavor?.vcpu ??
                              specs?.vcpus ??
                              specs?.vcpu ??
                              row.snapshot.vcpus ??
                              '',
                            flavor?.ram ?? specs?.ram ?? row.snapshot.ram ?? '',
                            inventoryBoot(row.snapshot) || '-',
                            inventoryIpLines(row.elastic_ip).join('\n') || '-',
                            privateIps.join('\n') || '-',
                            privateIps
                              .map(
                                (_, index) =>
                                  vipGroups[index]?.join(', ') || '-'
                              )
                              .join('\n') || '-',
                            privateIps
                              .map((_, index) => subnets[index] || '-')
                              .join('\n') || '-',
                            inventoryReferenceLines(
                              row.snapshot,
                              'security_groups'
                            ).join('\n') || '-',
                            inventoryReference(row.snapshot, 'key_pair') || '-',
                            inventoryReference(
                              row.snapshot,
                              'placement_group'
                            ) || '-',
                            bandwidth ? `${bandwidth} Mbps` : '-',
                            inventoryVolumes(row.snapshot) || '-',
                            created ? new Date(created).toLocaleString() : '-',
                            row.refreshed_at
                              ? new Date(row.refreshed_at).toLocaleString()
                              : '-',
                          ]
                        }),
                        `server-inventory-selected-${(project.display_name || project.name || 'project').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim()}.xlsx`,
                        {
                          title: 'SELECTED SERVER INVENTORY',
                          sheetName: 'Servers',
                          metadata: [
                            {
                              label: 'Project',
                              value:
                                project.display_name ||
                                project.name ||
                                project.id,
                            },
                          ],
                        }
                      )
                    }}
                  >
                    <Download /> Export XLSX ({selected.length})
                  </Button>
                </div>
              )}
            />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(viewRow)}
        onOpenChange={(nextOpen) => !nextOpen && setViewRow(undefined)}
      >
        <DialogContent className='flex max-h-[90vh] flex-col overflow-hidden sm:!max-w-5xl'>
          <DialogHeader>
            <DialogTitle>
              {viewRow?.server_name || 'Server'} — collected details
            </DialogTitle>
            <DialogDescription>
              Snapshot collected{' '}
              {viewRow?.refreshed_at
                ? new Date(viewRow.refreshed_at).toLocaleString()
                : '—'}
              . User data is intentionally limited to its first 100 characters.
            </DialogDescription>
          </DialogHeader>
          <div className='min-h-0 flex-1 overflow-y-auto pr-1'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className='w-56'>Field</TableHead>
                  <TableHead>Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(viewRow?.snapshot ?? {}).map(([key, value]) => (
                  <TableRow key={key}>
                    <TableCell className='align-top font-mono text-xs font-medium'>
                      {key}
                    </TableCell>
                    <TableCell className='min-w-0'>
                      <ServerDetailValue value={value} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dolphinOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && dolphinSync.isPending) return
          setDolphinOpen(nextOpen)
        }}
      >
        <DialogContent className='flex max-h-[94vh] flex-col overflow-hidden sm:!max-w-[calc(100vw-3rem)]'>
          <DialogHeader className='shrink-0'>
            <DialogTitle>
              {dolphinResults.length
                ? 'Dolphin sync results'
                : 'Sync VM to Dolphin'}
            </DialogTitle>
            <DialogDescription>
              {dolphinResults.length
                ? `${dolphinResults.length} selected inventory record(s) were sent to Dolphin.`
                : 'Review and edit the saved inventory payload before sending it to Dolphin.'}
            </DialogDescription>
          </DialogHeader>
          {dolphinResults.length ? (
            <div className='min-h-0 flex-1 overflow-auto'>
              <CloudDataTable
                data={dolphinResults}
                columns={[
                  { accessorKey: 'server_name', header: 'Server' },
                  {
                    accessorKey: 'server_id',
                    header: 'Server ID',
                    cell: ({ getValue }) => (
                      <span className='font-mono text-xs'>
                        {getValue() as string}
                      </span>
                    ),
                  },
                  {
                    accessorKey: 'status',
                    header: 'Dolphin status',
                    cell: ({ getValue }) => {
                      const status = String(getValue()).toLowerCase()
                      return (
                        <span
                          className={
                            status === 'error'
                              ? 'font-medium text-destructive'
                              : 'font-medium text-emerald-600 dark:text-emerald-400'
                          }
                        >
                          {status}
                        </span>
                      )
                    },
                  },
                  { accessorKey: 'power_state', header: 'Power state' },
                  { accessorKey: 'inventory_status', header: 'Inventory' },
                  {
                    accessorKey: 'system_created',
                    header: 'New system',
                    cell: ({ getValue }) =>
                      getValue() ? (
                        <span className='font-medium text-amber-600 dark:text-amber-400'>
                          Created
                        </span>
                      ) : (
                        '—'
                      ),
                  },
                  {
                    accessorKey: 'error',
                    header: 'Error',
                    cell: ({ getValue }) => {
                      const error = getValue() as string | undefined
                      return error ? (
                        <p className='max-w-96 text-xs leading-5 break-words text-destructive'>
                          {error}
                        </p>
                      ) : (
                        '—'
                      )
                    },
                  },
                ]}
                getRowId={(row) => row.server_id}
                entityName='Dolphin result'
                exportFileName={`dolphin-sync-${project.id}`}
              />
            </div>
          ) : (
            <div className='space-y-5 py-1'>
              <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-5'>
                <div className='space-y-2'>
                  <Label htmlFor='dolphin-system-name'>System</Label>
                  <Input
                    id='dolphin-system-name'
                    value={dolphinSystemName}
                    onChange={(event) => {
                      const value = event.target.value
                      setDolphinSystemName(value)
                      setDolphinPreviewRows((rows) =>
                        rows.map((row) => ({ ...row, system_name: value }))
                      )
                    }}
                    disabled={dolphinSync.isPending}
                  />
                </div>
                <div className='space-y-2'>
                  <Label>Owner unit</Label>
                  <Input
                    value={dolphinOwnerUnit}
                    onChange={(event) => {
                      const value = event.target.value
                      setDolphinOwnerUnit(value)
                      setDolphinPreviewRows((rows) =>
                        rows.map((row) => ({ ...row, owner_unit: value }))
                      )
                    }}
                    disabled={dolphinSync.isPending}
                  />
                </div>
                <div className='space-y-2'>
                  <Label>Product owner</Label>
                  <Input
                    value={dolphinProductOwner}
                    onChange={(event) => {
                      const value = event.target.value
                      setDolphinProductOwner(value)
                      setDolphinPreviewRows((rows) =>
                        rows.map((row) => ({ ...row, product_owner: value }))
                      )
                    }}
                    placeholder='Cloud user'
                    disabled={dolphinSync.isPending}
                  />
                </div>
                <div className='space-y-2'>
                  <Label>Deployment site</Label>
                  <Input
                    value={dolphinDeploymentSite}
                    onChange={(event) => {
                      const value = event.target.value
                      setDolphinDeploymentSite(value)
                      setDolphinPreviewRows((rows) =>
                        rows.map((row) => ({ ...row, deployment_site: value }))
                      )
                    }}
                    disabled={dolphinSync.isPending}
                  />
                </div>
                <div className='space-y-2'>
                  <Label>Deployment position</Label>
                  <Input
                    value={dolphinDeploymentPosition}
                    onChange={(event) => {
                      const value = event.target.value
                      setDolphinDeploymentPosition(value)
                      setDolphinPreviewRows((rows) =>
                        rows.map((row) => ({
                          ...row,
                          deployment_position: value,
                        }))
                      )
                    }}
                    disabled={dolphinSync.isPending}
                  />
                </div>
              </div>
              {dolphinPreview.isPending ? (
                <div className='flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground'>
                  <Loader2 className='size-4 animate-spin' /> Preparing saved
                  inventory preview...
                </div>
              ) : (
                <CloudDataTable
                  data={dolphinPreviewRows}
                  columns={[
                    { accessorKey: 'server_name', header: 'Server' },
                    {
                      accessorKey: 'external_id',
                      header: 'Server ID',
                      cell: ({ getValue }) => (
                        <span className='font-mono text-xs'>
                          {String(getValue())}
                        </span>
                      ),
                    },
                    {
                      accessorKey: 'flavor_name',
                      header: 'Flavor',
                      cell: ({ getValue }) => (
                        <span className='text-sm whitespace-nowrap'>
                          {String(getValue() ?? '—')}
                        </span>
                      ),
                    },
                    {
                      accessorKey: 'vcpu',
                      header: 'vCPU',
                      cell: ({ row }) => (
                        <Input
                          className='h-8 min-w-16'
                          type='number'
                          value={String(row.original.vcpu ?? '')}
                          onChange={(event) =>
                            setDolphinPreviewRows((rows) =>
                              rows.map((item) =>
                                item.external_id === row.original.external_id
                                  ? { ...item, vcpu: event.target.value }
                                  : item
                              )
                            )
                          }
                        />
                      ),
                    },
                    {
                      accessorKey: 'ram_gb',
                      header: 'RAM (GB)',
                      cell: ({ row }) => (
                        <Input
                          className='h-8 min-w-20'
                          type='number'
                          value={String(row.original.ram_gb ?? '')}
                          onChange={(event) =>
                            setDolphinPreviewRows((rows) =>
                              rows.map((item) =>
                                item.external_id === row.original.external_id
                                  ? { ...item, ram_gb: event.target.value }
                                  : item
                              )
                            )
                          }
                        />
                      ),
                    },
                    {
                      accessorKey: 'storage_total_gb',
                      header: 'Storage (GB)',
                      cell: ({ row }) => (
                        <Input
                          className='h-8 min-w-24'
                          type='number'
                          value={String(row.original.storage_total_gb ?? '')}
                          onChange={(event) =>
                            setDolphinPreviewRows((rows) =>
                              rows.map((item) =>
                                item.external_id === row.original.external_id
                                  ? {
                                      ...item,
                                      storage_total_gb: event.target.value,
                                    }
                                  : item
                              )
                            )
                          }
                        />
                      ),
                    },
                    {
                      accessorKey: 'vip_ip',
                      header: 'VIP IP',
                      cell: ({ row }) => (
                        <Input
                          className='h-8 min-w-40 font-mono text-xs'
                          value={String(row.original.vip_ip ?? '')}
                          onChange={(event) =>
                            setDolphinPreviewRows((rows) =>
                              rows.map((item) =>
                                item.external_id === row.original.external_id
                                  ? { ...item, vip_ip: event.target.value }
                                  : item
                              )
                            )
                          }
                        />
                      ),
                    },
                    {
                      accessorKey: 'management_ip',
                      header: 'Management IP',
                      cell: ({ row }) => (
                        <SearchableSelect
                          value={String(row.original.management_ip ?? '')}
                          onValueChange={(value) =>
                            setDolphinPreviewRows((rows) =>
                              rows.map((item) =>
                                item.external_id === row.original.external_id
                                  ? { ...item, management_ip: value }
                                  : item
                              )
                            )
                          }
                          options={
                            Array.isArray(row.original.private_ip_options)
                              ? (
                                  row.original.private_ip_options as string[]
                                ).map((ip) => ({ value: ip, label: ip }))
                              : []
                          }
                          placeholder='Select private IP'
                          className='min-w-44'
                        />
                      ),
                    },
                    {
                      accessorKey: 'deployment_position',
                      header: 'Deployment position',
                      cell: ({ row }) => (
                        <Input
                          className='h-8 min-w-36'
                          value={String(row.original.deployment_position ?? '')}
                          onChange={(event) =>
                            setDolphinPreviewRows((rows) =>
                              rows.map((item) =>
                                item.external_id === row.original.external_id
                                  ? {
                                      ...item,
                                      deployment_position: event.target.value,
                                    }
                                  : item
                              )
                            )
                          }
                        />
                      ),
                    },
                    {
                      accessorKey: 'error',
                      header: 'Review',
                      cell: ({ getValue }) =>
                        getValue() ? (
                          <span className='text-destructive'>
                            {String(getValue())}
                          </span>
                        ) : (
                          <span className='text-emerald-600 dark:text-emerald-400'>
                            Ready
                          </span>
                        ),
                    },
                  ]}
                  getRowId={(row) => String(row.external_id)}
                  entityName='Dolphin VM preview'
                  exportFileName={`dolphin-preview-${project.id}`}
                  enableSelection
                  toolbar={(selected) => (
                    <Button
                      disabled={dolphinSync.isPending || !selected.length}
                      onClick={() => {
                        dolphinSync.mutate(selected)
                      }}
                    >
                      {dolphinSync.isPending ? (
                        <Loader2 className='animate-spin' />
                      ) : (
                        <Share2 />
                      )}
                      Sync {selected.length} VM(s) to Dolphin
                    </Button>
                  )}
                />
              )}
            </div>
          )}
          <DialogFooter className='shrink-0 border-t pt-4'>
            <Button
              variant='outline'
              disabled={dolphinSync.isPending}
              onClick={() => setDolphinOpen(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={dolphinManageOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && dolphinManage.isPending) return
          setDolphinManageOpen(nextOpen)
        }}
      >
        <DialogContent className='flex !h-[min(84vh,58rem)] !w-[min(96vw,86rem)] !max-w-[min(96vw,86rem)] flex-col overflow-hidden'>
          <DialogHeader className='shrink-0'>
            <DialogTitle>Manage Dolphin VMs</DialogTitle>
            <DialogDescription>
              Current Dolphin information and status for this project's saved
              server IDs. Select records to update or retire them.
            </DialogDescription>
          </DialogHeader>
          <div className='min-h-0 flex-1 overflow-auto'>
            {dolphinRecordList.isPending ? (
              <div className='flex h-full items-center justify-center gap-2 text-sm text-muted-foreground'>
                <Loader2 className='size-4 animate-spin' /> Loading Dolphin VM
                information...
              </div>
            ) : (
              <CloudDataTable
                data={dolphinManageRecords}
                columns={[
                  { accessorKey: 'server_name', header: 'Server' },
                  {
                    accessorKey: 'server_id',
                    header: 'Server ID',
                    cell: ({ getValue }) => (
                      <span className='font-mono text-xs'>
                        {String(getValue() ?? '')}
                      </span>
                    ),
                  },
                  { accessorKey: 'vm_id', header: 'Dolphin VM ID' },
                  { accessorKey: 'system_name', header: 'System' },
                  { accessorKey: 'management_ip', header: 'Management IP' },
                  { accessorKey: 'vcpu', header: 'vCPU' },
                  { accessorKey: 'ram_gb', header: 'RAM (GB)' },
                  { accessorKey: 'storage_total_gb', header: 'Storage (GB)' },
                  {
                    accessorKey: 'dolphin_status',
                    header: 'Dolphin status',
                    cell: ({ getValue }) => {
                      const status = String(getValue() ?? '')
                      return (
                        <span
                          className={
                            status === 'error'
                              ? 'text-destructive'
                              : status === 'not_found'
                                ? 'text-muted-foreground'
                                : 'text-emerald-600 dark:text-emerald-400'
                          }
                        >
                          {status || 'unknown'}
                        </span>
                      )
                    },
                  },
                  {
                    accessorKey: 'error',
                    header: 'Error',
                    cell: ({ getValue }) => (
                      <span className='max-w-80 break-words whitespace-normal text-destructive'>
                        {String(getValue() ?? '')}
                      </span>
                    ),
                  },
                  {
                    accessorKey: 'status',
                    header: 'Status',
                    cell: ({ getValue }) => {
                      const status = String(getValue() ?? '')
                      return (
                        <span
                          className={
                            status === 'error'
                              ? 'text-destructive'
                              : 'text-emerald-600 dark:text-emerald-400'
                          }
                        >
                          {status || '—'}
                        </span>
                      )
                    },
                  },
                ]}
                getRowId={(row) => String(row.server_id ?? row.external_id)}
                entityName='Dolphin VM'
                exportFileName={`dolphin-vm-management-${project.id}`}
                enableSelection
                toolbar={(selected) => (
                  <div className='flex flex-wrap gap-2'>
                    <Button
                      size='sm'
                      disabled={!selected.length || dolphinManage.isPending}
                      onClick={() => {
                        const ids = new Set(
                          selected.map((row) =>
                            String(row.server_id ?? row.external_id ?? '')
                          )
                        )
                        openDolphinSync(
                          inventoryRows.filter((row) => ids.has(row.server_id))
                        )
                      }}
                    >
                      <Share2 /> Update selected
                    </Button>
                    <Button
                      size='sm'
                      variant='destructive'
                      disabled={!selected.length || dolphinManage.isPending}
                      onClick={() => {
                        setDolphinRetireIds(
                          selected
                            .map((row) =>
                              String(row.server_id ?? row.external_id ?? '')
                            )
                            .filter(Boolean)
                        )
                        setDolphinRetireConfirm(true)
                      }}
                    >
                      Retire selected
                    </Button>
                  </div>
                )}
              />
            )}
          </div>
          <DialogFooter className='shrink-0 border-t pt-4'>
            <p className='mr-auto text-xs text-muted-foreground'>
              Updates use Dolphin's idempotent allocate action (upsert by source
              and server ID).
            </p>
            <Button
              variant='outline'
              disabled={dolphinManage.isPending}
              onClick={() => setDolphinManageOpen(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={dolphinRetireConfirm}
        onOpenChange={setDolphinRetireConfirm}
        title={`Retire ${dolphinRetireIds.length} Dolphin VM(s)?`}
        desc='Dolphin will retain these records as RETIRED for history. This does not delete or stop Cloud VMs.'
        destructive
        confirmText='Retire in Dolphin'
        isLoading={dolphinManage.isPending}
        handleConfirm={() => {
          setDolphinRetireConfirm(false)
          dolphinManage.mutate({
            action: 'revoke',
            serverIds: dolphinRetireIds,
          })
        }}
      />
    </>
  )
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

function resizeFlavorLabel(flavor: ResizeFlavor) {
  const name = flavor.name || flavor.display_name || flavor.id
  const capacity = [
    flavor.vcpus && `${flavor.vcpus} vCPU`,
    flavor.ram && `${flavor.ram} GB`,
  ]
    .filter(Boolean)
    .join(' · ')
  return capacity ? `${name} (${capacity})` : name
}

function defaultAttachmentVolumeName(
  serverName: string,
  serverId: string,
  volumeIndex: number
) {
  return `${serverName}-${serverId}-volume-${volumeIndex}`
}

function ServerVolumeAttachmentDialog({
  open,
  targets,
  onOpenChange,
}: {
  open: boolean
  targets: ServerRow[]
  onOpenChange: (open: boolean) => void
}) {
  const project = useCloudStore((state) => state.project)!
  const [mode, setMode] = useState<'attach' | 'detach'>('attach')
  const [plans, setPlans] = useState<AttachmentPlan[]>([])
  const [editingPlanId, setEditingPlanId] = useState<string>()
  const [concurrency, setConcurrency] = useState(3)
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [pendingPlans, setPendingPlans] = useState<AttachmentPlan[]>([])
  const [pendingDetachRows, setPendingDetachRows] = useState<DetachVolumeRow[]>(
    []
  )
  const [detachConfirmOpen, setDetachConfirmOpen] = useState(false)
  const [results, setResults] = useState<AttachmentResult[]>([])
  const [resultDetail, setResultDetail] = useState<AttachmentResult>()
  const [retryingServerId, setRetryingServerId] = useState<string>()
  const [autoRetrying, setAutoRetrying] = useState(false)
  const [runState, setRunState] = useState<
    'idle' | 'running' | 'paused' | 'stopped'
  >('idle')
  const controls = useRef({ paused: false, stopped: false })
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [closeConfirm, setCloseConfirm] = useState(false)
  const [reviewCloseConfirm, setReviewCloseConfirm] = useState(false)
  const [refreshingResults, setRefreshingResults] = useState(false)
  const [importing, setImporting] = useState(false)
  const [detachRows, setDetachRows] = useState<DetachVolumeRow[]>([])
  const [detachView, setDetachView] = useState<'table' | 'server'>('table')
  const [selectedDetachVolumeIds, setSelectedDetachVolumeIds] = useState<
    Set<string>
  >(() => new Set())
  const [loadingDetachRows, setLoadingDetachRows] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    controls.current = { paused: false, stopped: false }
    setRunState('idle')
    setResults([])
    setPendingPlans([])
    setImportWarnings([])
    setDetachView('table')
    setSelectedDetachVolumeIds(new Set())
    setMode('attach')
    setPlans(
      targets.map((server) => {
        const zone = serverResizeZone(server)
        return {
          server_id: server.id,
          name: server.name,
          zone_id: zone.id,
          zone_name: zone.name,
          volumes: [
            {
              name: defaultAttachmentVolumeName(server.name, server.id, 1),
              volume_type: '',
              size: 10,
              description: '',
            },
          ],
          error: zone.id ? undefined : 'Zone was not returned for this server.',
        }
      })
    )
  }, [open, targets])

  const loadDetachRows = useCallback(async () => {
    if (!open || !targets.length) return
    setLoadingDetachRows(true)
    try {
      const rows: DetachVolumeRow[] = []
      for (const server of targets) {
        const { data } = await apiClient.get<Record<string, unknown>>(
          `/cloud/servers/${server.id}`,
          { timeout: 45_000 }
        )
        rows.push(...attachedServerVolumes(server, data))
      }
      setDetachRows(rows)
      setSelectedDetachVolumeIds(new Set())
      return rows
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Attached volumes could not be loaded.'
      )
    } finally {
      setLoadingDetachRows(false)
    }
  }, [open, targets])

  const detachRowsByServer = useMemo(() => {
    const groups = new Map<string, { name: string; rows: DetachVolumeRow[] }>()
    for (const row of detachRows) {
      const group = groups.get(row.server_id) ?? {
        name: row.server_name,
        rows: [],
      }
      group.rows.push(row)
      groups.set(row.server_id, group)
    }
    return [...groups.entries()].map(([serverId, group]) => ({
      serverId,
      ...group,
    }))
  }, [detachRows])

  const toggleDetachVolumes = (rows: DetachVolumeRow[], checked: boolean) =>
    setSelectedDetachVolumeIds((current) => {
      const next = new Set(current)
      for (const row of rows) checked ? next.add(row.id) : next.delete(row.id)
      return next
    })

  useEffect(() => {
    if (mode === 'detach') void loadDetachRows()
  }, [mode, loadDetachRows])

  const zoneIdsKey = [
    ...new Set(plans.map((plan) => plan.zone_id).filter(Boolean)),
  ]
    .sort()
    .join(',')
  const uniqueZones = useMemo(
    () => (zoneIdsKey ? zoneIdsKey.split(',') : []),
    [zoneIdsKey]
  )
  const volumeTypeQueries = useQueries({
    queries: uniqueZones.map((zoneId) => ({
      queryKey: ['cloud', project.id, 'attachment-volume-types', zoneId],
      enabled: open,
      queryFn: async ({ signal }) =>
        (
          await apiClient.get<Page<ResizeFlavor>>(
            '/cloud/server-volume-types',
            {
              params: { zone: zoneId, page_size: 200 }, signal,
            }
          )
        ).data,
    })),
  })
  const volumeTypesByZone = useMemo(
    () =>
      new Map(
        uniqueZones.map((zoneId, index) => [
          zoneId,
          volumeTypeQueries[index]?.data?.items ?? [],
        ])
      ),
    [uniqueZones, volumeTypeQueries]
  )
  const volumeTypesByZoneRef = useRef(volumeTypesByZone)
  const volumeTypeLoadingByZoneRef = useRef(new Map<string, boolean>())
  volumeTypesByZoneRef.current = volumeTypesByZone
  volumeTypeLoadingByZoneRef.current = new Map(
    uniqueZones.map((zoneId, index) => [
      zoneId,
      Boolean(volumeTypeQueries[index]?.isLoading),
    ])
  )
  const attachmentQuotaQuery = useQuery({
    queryKey: ['cloud', project.id, 'volume-attachment-quota'],
    enabled: open && mode === 'attach',
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<{ items: QuotaItem[] }>('/cloud/quotas', { signal })).data,
  })
  const attachmentQuotaReview = useMemo(() => {
    const requested = { volumes: 0, hdd: 0, ssd: 0 }
    for (const plan of plans) {
      for (const volume of plan.volumes) {
        requested.volumes += 1
        const kind = String(
          volume.volume_type_name ?? volume.volume_type
        ).toLowerCase()
        if (kind.includes('ssd')) requested.ssd += volume.size
        else if (kind.includes('hdd')) requested.hdd += volume.size
      }
    }
    const normalize = (value: unknown) =>
      String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
    const quota = (key: string) =>
      attachmentQuotaQuery.data?.items.find(
        (item) => normalize(item.name) === key
      )
    return [
      ['Volumes', requested.volumes, 'volumes'],
      ['HDD', requested.hdd, 'persistentdiskstandardgib'],
      ['SSD', requested.ssd, 'persistentdiskssdgib'],
    ]
      .filter(([, value]) => Number(value) > 0)
      .map(([label, value, key]) => {
        const item = quota(String(key))
        const used = Number(item?.used ?? 0)
        const rawLimit = Number(item?.limit)
        const limit =
          Number.isFinite(rawLimit) && rawLimit >= 0 ? rawLimit : null
        return {
          label: String(label),
          requested: Number(value),
          available: limit == null ? null : Math.max(0, limit - used),
          limit,
          exceeded: limit != null && used + Number(value) > limit,
        }
      })
  }, [attachmentQuotaQuery.data?.items, plans])
  const displayPlans = plans
  const readyPlans = displayPlans.filter(
    (plan) =>
      plan.volumes.length &&
      plan.volumes.every((volume) => volume.volume_type && volume.size > 0) &&
      !plan.error
  )
  const editingPlan = plans.find((plan) => plan.server_id === editingPlanId)
  const setPlanVolumes = useCallback(
    (serverId: string, volumes: AttachmentVolume[]) =>
      setPlans((current) =>
        current.map((plan) =>
          plan.server_id === serverId
            ? { ...plan, volumes, error: plan.zone_id ? undefined : plan.error }
            : plan
        )
      ),
    []
  )

  const updateResult = (
    serverId: string,
    next: AttachmentResult | ((current: AttachmentResult) => AttachmentResult)
  ) =>
    setResults((current) =>
      current.map((item) =>
        item.server_id === serverId
          ? typeof next === 'function'
            ? next(item)
            : next
          : item
      )
    )
  const refreshResults = async () => {
    const volumeIds = [
      ...new Set(
        results.flatMap((result) =>
          result.volumes.flatMap((volume) =>
            volume.volume_id ? [volume.volume_id] : []
          )
        )
      ),
    ]
    if (!volumeIds.length) {
      toast.info('No created volume is available to refresh yet.')
      return
    }
    setRefreshingResults(true)
    try {
      const refreshed = [] as AttachmentResult['volumes']
      for (let index = 0; index < volumeIds.length; index += 20) {
        const { data } = await apiClient.post<{
          items: AttachmentResult['volumes']
        }>(
          '/cloud/servers/volume-attachments/status',
          { volume_ids: volumeIds.slice(index, index + 20) },
          { timeout: 45_000 }
        )
        refreshed.push(...(data.items ?? []))
      }
      const refreshedById = new Map(
        refreshed
          .filter((volume) => volume.volume_id)
          .map((volume) => [volume.volume_id!, volume])
      )
      setResults((current) =>
        current.map((result) => ({
          ...result,
          volumes: result.volumes.map((volume) =>
            volume.volume_id && refreshedById.has(volume.volume_id)
              ? { ...volume, ...refreshedById.get(volume.volume_id) }
              : volume
          ),
        }))
      )
      toast.success('Volume status refreshed.')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Volume status refresh failed.'
      )
    } finally {
      setRefreshingResults(false)
    }
  }
  const waitIfPaused = async () => {
    while (controls.current.paused && !controls.current.stopped)
      await new Promise((resolve) => window.setTimeout(resolve, 300))
    return !controls.current.stopped
  }
  const attachVolumesInParallel = async (
    serverId: string,
    volumeIds: string[]
  ) => {
    const results: AttachmentResult['volumes'] = []
    let cursor = 0
    const worker = async () => {
      while (true) {
        const volumeId = volumeIds[cursor++]
        if (!volumeId) return
        try {
          const { data } = await apiClient.post<{
            items: AttachmentResult['volumes']
          }>(
            '/cloud/servers/volume-attachments/attach',
            { server_id: serverId, volume_ids: [volumeId] },
            { timeout: 90_000 }
          )
          results.push(...(data.items ?? []))
        } catch (error) {
          results.push({
            volume_id: volumeId,
            status: 'failed',
            error:
              upstreamDetail(
                error instanceof AxiosError ? error.response?.data : error
              ) || 'Volume attach failed.',
            response:
              error instanceof AxiosError ? error.response?.data : undefined,
          })
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(10, volumeIds.length) }, () => worker())
    )
    const byId = new Map(
      results
        .filter((item) => item.volume_id)
        .map((item) => [item.volume_id!, item])
    )
    return volumeIds.map(
      (volumeId) =>
        byId.get(volumeId) ?? {
          volume_id: volumeId,
          status: 'failed',
          error: 'No attach response was returned.',
        }
    )
  }
  const runPlans = async (
    selected: AttachmentPlan[],
    preserveExistingResults = false
  ) => {
    controls.current = { paused: false, stopped: false }
    setRunState('running')
    const queued = selected.map(
      (plan) =>
        ({
          server_id: plan.server_id,
          name: plan.name,
          status: 'queued',
          volumes: [],
        }) as AttachmentResult
    )
    setResults((current) =>
      preserveExistingResults
        ? current.map((result) =>
            queued.some((item) => item.server_id === result.server_id)
              ? { ...result, status: 'queued', detail: undefined }
              : result
          )
        : queued
    )
    let cursor = 0
    const worker = async () => {
      while (!controls.current.stopped) {
        const plan = selected[cursor++]
        if (!plan) return
        if (!(await waitIfPaused())) return
        updateResult(plan.server_id, (current) => ({
          ...current,
          name: plan.name,
          status: 'creating',
          detail: undefined,
        }))
        try {
          const created = await apiClient.post<{
            items: AttachmentResult['volumes']
          }>(
            '/cloud/servers/volume-attachments/create',
            {
              server_id: plan.server_id,
              volumes: plan.volumes.map((volume) => ({
                name: volume.name,
                volume_type: volume.volume_type,
                size: volume.size,
                description: volume.description,
              })),
            },
            { timeout: 90_000 }
          )
          const volumeRows = created.data.items ?? []
          const createRequest = {
            server_id: plan.server_id,
            volumes: plan.volumes.map((volume) => ({
              name: volume.name,
              volume_type: volume.volume_type,
              size: volume.size,
              description: volume.description,
            })),
          }
          updateResult(plan.server_id, (current) => ({
            ...current,
            operations: [
              ...(current.operations ?? []),
              {
                action: 'create',
                request: createRequest,
                response: created.data,
              },
            ],
            volumes: volumeRows,
          }))
          const volumeIds = volumeRows
            .filter((item) => item.volume_id && item.status !== 'failed')
            .map((item) => item.volume_id!)
          if (volumeIds.length !== plan.volumes.length)
            throw new Error(
              volumeRows.find((item) => item.error)?.error ||
                'One or more volumes could not be created.'
            )
          let statuses = volumeRows
          while (true) {
            if (!(await waitIfPaused())) return
            updateResult(plan.server_id, (current) => ({
              ...current,
              name: plan.name,
              status: 'waiting',
              detail: 'Waiting for all volumes to become available.',
              volumes: statuses,
            }))
            await new Promise((resolve) => window.setTimeout(resolve, 10_000))
            if (!(await waitIfPaused())) return
            const statusResponse = await apiClient.post<{
              items: AttachmentResult['volumes']
            }>(
              '/cloud/servers/volume-attachments/status',
              { volume_ids: volumeIds },
              { timeout: 45_000 }
            )
            statuses = statusResponse.data.items ?? []
            if (
              statuses.some(
                (item) => item.status === 'failed' || item.status === 'error'
              )
            )
              throw new Error(
                statuses.find((item) => item.error)?.error ||
                  'A volume entered an error state.'
              )
            if (
              statuses.length === volumeIds.length &&
              statuses.every((item) => item.status === 'available')
            )
              break
          }
          if (!(await waitIfPaused())) return
          updateResult(plan.server_id, (current) => ({
            ...current,
            name: plan.name,
            status: 'attaching',
            volumes: statuses,
          }))
          const attachedRows = await attachVolumesInParallel(
            plan.server_id,
            volumeIds
          )
          const failed = attachedRows.find((item) => item.status === 'failed')
          updateResult(plan.server_id, (current) => ({
            ...current,
            name: plan.name,
            status: failed ? 'failed' : 'attached',
            detail: upstreamDetail(failed?.error),
            operations: [
              ...(current.operations ?? []),
              {
                action: 'attach',
                request: { server_id: plan.server_id, volume_ids: volumeIds },
                response: { items: attachedRows },
              },
            ],
            volumes: attachedRows,
          }))
        } catch (error) {
          updateResult(plan.server_id, (current) => ({
            ...current,
            name: plan.name,
            status: 'failed',
            detail:
              upstreamDetail(
                error instanceof AxiosError ? error.response?.data : error
              ) ||
              (error instanceof Error
                ? error.message
                : 'Volume attachment failed.'),
            operations: [
              ...(current.operations ?? []),
              {
                action: 'create',
                request: { server_id: plan.server_id, volumes: plan.volumes },
                error:
                  error instanceof AxiosError
                    ? error.response?.data
                    : String(error),
              },
            ],
          }))
        }
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(Math.max(1, concurrency), selected.length) },
        () => worker()
      )
    )
    if (controls.current.stopped)
      setResults((current) =>
        current.map((item) =>
          item.status === 'queued' ||
          item.status === 'creating' ||
          item.status === 'waiting'
            ? {
                ...item,
                status: 'stopped',
                detail: 'Stopped before attachment completed.',
              }
            : item
        )
      )
    setRunState(controls.current.stopped ? 'stopped' : 'idle')
  }

  const retryAttach = async (result: AttachmentResult) => {
    const volumeIds = result.volumes
      .filter((volume) => volume.volume_id && volume.status !== 'attached')
      .map((volume) => volume.volume_id!)
    if (!volumeIds.length) {
      toast.info('No created volume is available to attach again.')
      return
    }
    setRetryingServerId(result.server_id)
    try {
      const request = { server_id: result.server_id, volume_ids: volumeIds }
      const volumes = await attachVolumesInParallel(result.server_id, volumeIds)
      const failed = volumes.find((volume) => volume.status === 'failed')
      updateResult(result.server_id, {
        ...result,
        status: failed ? 'failed' : 'attached',
        detail: upstreamDetail(failed?.error),
        volumes,
        operations: [
          ...(result.operations ?? []),
          { action: 'attach', request, response: { items: volumes } },
        ],
      })
      toast.success(
        failed ? 'Attach retry completed with errors.' : 'Volumes attached.'
      )
    } catch (error) {
      const detail = upstreamDetail(
        error instanceof AxiosError ? error.response?.data : error
      )
      updateResult(result.server_id, {
        ...result,
        status: 'failed',
        detail: detail || 'Volume attach retry failed.',
        operations: [
          ...(result.operations ?? []),
          {
            action: 'attach',
            request: { server_id: result.server_id, volume_ids: volumeIds },
            error:
              error instanceof AxiosError
                ? error.response?.data
                : String(error),
          },
        ],
      })
      toast.error(detail || 'Volume attach retry failed.')
    } finally {
      setRetryingServerId(undefined)
    }
  }

  const retryCreateAndAttach = (result: AttachmentResult) => {
    const plan = plans.find((item) => item.server_id === result.server_id)
    if (!plan) {
      toast.error('The original volume plan is no longer available.')
      return
    }
    setRetryingServerId(result.server_id)
    void runPlans([plan], true).finally(() => setRetryingServerId(undefined))
  }

  const autoRetry = async (failedResults: AttachmentResult[]) => {
    const createPlans: AttachmentPlan[] = []
    const attachResults: AttachmentResult[] = []
    for (const result of failedResults) {
      const createFailed =
        result.volumes.length === 0 ||
        result.volumes.some((volume) => !volume.volume_id)
      const plan = plans.find((item) => item.server_id === result.server_id)
      if (createFailed && plan) createPlans.push(plan)
      else if (
        result.volumes.some(
          (volume) => volume.volume_id && volume.status !== 'attached'
        )
      )
        attachResults.push(result)
    }
    if (!createPlans.length && !attachResults.length) {
      toast.info('No retryable failed volume workflow was found.')
      return
    }
    setAutoRetrying(true)
    try {
      for (const result of attachResults) await retryAttach(result)
      if (createPlans.length) await runPlans(createPlans, true)
    } finally {
      setAutoRetrying(false)
    }
  }

  const runDetach = async (selected: DetachVolumeRow[]) => {
    const byServer = new Map<string, DetachVolumeRow[]>()
    for (const row of selected)
      byServer.set(row.server_id, [...(byServer.get(row.server_id) ?? []), row])
    const groups = [...byServer.values()]
    controls.current = { paused: false, stopped: false }
    setRunState('running')
    setResults(
      groups.map((rows) => ({
        server_id: rows[0].server_id,
        name: rows[0].server_name,
        status: 'queued',
        volumes: rows.map((row) => ({
          volume_id: row.volume_id,
          name: row.volume_name,
          status: 'queued',
        })),
      }))
    )
    let cursor = 0
    const worker = async () => {
      while (!controls.current.stopped) {
        const rows = groups[cursor++]
        if (!rows) return
        if (!(await waitIfPaused())) return
        let volumeResults: AttachmentResult['volumes'] = rows.map((row) => ({
          volume_id: row.volume_id,
          name: row.volume_name,
          status: 'queued',
        }))
        const operations: NonNullable<AttachmentResult['operations']> = []
        for (const row of rows) {
          if (!(await waitIfPaused())) return
          updateResult(rows[0].server_id, {
            server_id: rows[0].server_id,
            name: rows[0].server_name,
            status: 'detaching',
            volumes: volumeResults,
            operations,
          })
          try {
            const request = {
              server_id: row.server_id,
              volume_ids: [row.volume_id],
            }
            const { data } = await apiClient.post<{
              items: AttachmentResult['volumes']
            }>('/cloud/servers/volume-attachments/detach', request, {
              timeout: 90_000,
            })
            operations.push({ action: 'detach', request, response: data })
            const outcome = data.items?.[0] ?? {
              volume_id: row.volume_id,
              name: row.volume_name,
              status: 'detached',
            }
            volumeResults = volumeResults.map((item) =>
              item.volume_id === row.volume_id ? { ...item, ...outcome } : item
            )
          } catch (error) {
            operations.push({
              action: 'detach',
              request: {
                server_id: row.server_id,
                volume_ids: [row.volume_id],
              },
              error:
                error instanceof AxiosError
                  ? error.response?.data
                  : String(error),
            })
            volumeResults = volumeResults.map((item) =>
              item.volume_id === row.volume_id
                ? {
                    ...item,
                    status: 'failed',
                    error:
                      error instanceof Error
                        ? error.message
                        : 'Volume detach failed.',
                  }
                : item
            )
          }
        }
        const failed = volumeResults.some((item) => item.status === 'failed')
        updateResult(rows[0].server_id, {
          server_id: rows[0].server_id,
          name: rows[0].server_name,
          status: failed ? 'failed' : 'detached',
          volumes: volumeResults,
          operations,
        })
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(Math.max(1, concurrency), groups.length) },
        () => worker()
      )
    )
    setRunState(controls.current.stopped ? 'stopped' : 'idle')
  }

  const retryDetach = async (result: AttachmentResult) => {
    const failedVolumes = result.volumes.filter(
      (volume) => volume.volume_id && volume.status === 'failed'
    )
    if (!failedVolumes.length) {
      toast.info('No failed volume detach is available to retry.')
      return
    }
    setRetryingServerId(result.server_id)
    let volumes = result.volumes
    const operations = [...(result.operations ?? [])] as NonNullable<
      AttachmentResult['operations']
    >
    try {
      updateResult(result.server_id, {
        ...result,
        status: 'detaching',
        detail: undefined,
      })
      for (const volume of failedVolumes) {
        const request = {
          server_id: result.server_id,
          volume_ids: [volume.volume_id!],
        }
        try {
          const { data } = await apiClient.post<{
            items: AttachmentResult['volumes']
          }>('/cloud/servers/volume-attachments/detach', request, {
            timeout: 90_000,
          })
          const outcome = data.items?.[0] ?? { ...volume, status: 'detached' }
          operations.push({ action: 'detach', request, response: data })
          volumes = volumes.map((item) =>
            item.volume_id === volume.volume_id ? { ...item, ...outcome } : item
          )
        } catch (error) {
          const detail =
            upstreamDetail(
              error instanceof AxiosError ? error.response?.data : error
            ) || 'Volume detach retry failed.'
          operations.push({
            action: 'detach',
            request,
            error:
              error instanceof AxiosError
                ? error.response?.data
                : String(error),
          })
          volumes = volumes.map((item) =>
            item.volume_id === volume.volume_id
              ? { ...item, status: 'failed', error: detail }
              : item
          )
        }
      }
      const failed = volumes.some((volume) => volume.status === 'failed')
      updateResult(result.server_id, {
        ...result,
        status: failed ? 'failed' : 'detached',
        detail: failed
          ? upstreamDetail(
              volumes.find((volume) => volume.status === 'failed')?.error
            )
          : undefined,
        volumes,
        operations,
      })
    } finally {
      setRetryingServerId(undefined)
    }
  }

  const retryFailedDetaches = async (failedResults: AttachmentResult[]) => {
    setAutoRetrying(true)
    try {
      for (const result of failedResults) await retryDetach(result)
    } finally {
      setAutoRetrying(false)
    }
  }

  const importTemplate = async (file?: File) => {
    if (!file) return
    setImporting(true)
    try {
      const source = rowsFromHeader(parseXlsxRows(await file.arrayBuffer()), [
        'SERVER ID',
        'VOLUMES',
      ])
      // A template is intentionally scoped to the servers selected before
      // opening this modal. Never add an unrelated project server from XLSX.
      const servers = new Map(targets.map((server) => [server.id, server]))
      const grouped = new Map<string, AttachmentPlan>()
      const volumeTypeCache = new Map<string, ResizeFlavor[]>()
      const skippedServerIds: string[] = []
      for (const [index, row] of source.entries()) {
        const server = servers.get(row['SERVER ID'])
        if (!server) {
          skippedServerIds.push(row['SERVER ID'] || `row ${index + 2}`)
          continue
        }
        const zone = serverResizeZone(server)
        const current = grouped.get(server.id) || {
          server_id: server.id,
          name: server.name,
          zone_id: zone.id,
          zone_name: zone.name,
          volumes: [],
          error: zone.id ? undefined : 'Zone was not returned for this server.',
        }
        const volumeLines = (row.VOLUMES || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        if (!volumeLines.length) {
          current.error =
            current.error || `Row ${index + 1}: add at least one VOLUMES line.`
        } else if (!zone.id) {
          current.error =
            current.error || `Row ${index + 1}: Server zone is required.`
        } else {
          if (!volumeTypeCache.has(zone.id)) {
            const { data } = await apiClient.get<Page<ResizeFlavor>>(
              '/cloud/server-volume-types',
              { params: { zone: zone.id, page_size: 200 } }
            )
            volumeTypeCache.set(zone.id, data.items)
          }
          for (const [lineIndex, line] of volumeLines.entries()) {
            const [name, requestedType, sizeText, ...descriptionParts] = line
              .split(',')
              .map((value) => value.trim())
            const size = Number(sizeText)
            if (
              !name ||
              !requestedType ||
              !Number.isFinite(size) ||
              size <= 0
            ) {
              current.error =
                current.error ||
                `Row ${index + 1}, VOLUMES line ${lineIndex + 1}: use name,volume_type,size,description.`
              continue
            }
            const requested = requestedType.toLowerCase()
            const volumeType = volumeTypeCache
              .get(zone.id)
              ?.find((item) =>
                [item.id, item.name, item.display_name, resizeFlavorLabel(item)]
                  .filter(Boolean)
                  .some(
                    (value) => String(value).trim().toLowerCase() === requested
                  )
              )
            if (!volumeType) {
              current.error =
                current.error ||
                `Row ${index + 1}, VOLUMES line ${lineIndex + 1}: type '${requestedType}' is not available in ${zone.name}.`
              continue
            }
            current.volumes.push({
              name,
              volume_type: volumeType.id,
              volume_type_name: resizeFlavorLabel(volumeType),
              size,
              description: descriptionParts.join(', '),
            })
          }
        }
        grouped.set(server.id, current)
      }
      setPlans([...grouped.values()])
      const warnings = skippedServerIds.length
        ? [
            `${skippedServerIds.length} row(s) were skipped because SERVER ID is not in the selected server list: ${skippedServerIds.slice(0, 5).join(', ')}${skippedServerIds.length > 5 ? ', …' : ''}`,
          ]
        : []
      setImportWarnings(warnings)
      setMode('attach')
      setResults([])
      if (warnings.length) toast.warning(warnings[0])
      if (grouped.size)
        toast.success(`Imported ${grouped.size} server attachment plan(s).`)
      else toast.error('No template rows matched the selected server list.')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Volume template could not be imported.'
      )
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  const downloadTemplate = () => {
    if (!plans.length || volumeTypeQueries.some((query) => query.isLoading)) {
      toast.info(
        'Loading zone volume types. Please try the template again in a moment.'
      )
      return
    }
    const suggestedTypes = [
      ...new Set(
        [...volumeTypesByZone.values()]
          .flat()
          .map((item) => resizeFlavorLabel(item))
          .filter(Boolean)
      ),
    ].sort((left, right) => {
      const rank = (value: string) =>
        /ceph[_ -]?hdd/i.test(value) ? 0 : /ceph[_ -]?ssd/i.test(value) ? 1 : 2
      return rank(left) - rank(right) || left.localeCompare(right)
    })
    downloadXlsx(
      ['SERVER ID', 'SERVER NAME', 'ZONE', 'VOLUMES'],
      plans.map((plan) => [
        plan.server_id,
        plan.name,
        plan.zone_name,
        `${plan.name}-volume-1,${suggestedTypes[0] || 'VOLUME_TYPE'},10,description`,
      ]),
      `server-volume-attachment-template-${(project.name || project.id).replace(/[^a-zA-Z0-9._-]+/g, '-')}.xlsx`,
      {
        title: 'SERVER VOLUME ATTACHMENT TEMPLATE',
        metadata: [
          {
            label: 'Usage',
            value:
              'One row is one server. In VOLUMES, put one volume per line: name,volume_type,size_gb,description. Add lines to attach multiple volumes.',
          },
        ],
        sheetName: 'Attach volumes',
        columnWidthMultipliers: { VOLUMES: 1.5 },
        validations: [
          {
            header: 'SERVER ID',
            values: plans.map((plan) => plan.server_id),
            allowBlank: false,
            enforce: false,
          },
          ...plans.map((plan, index) => {
            const typesForServer = [
              ...new Set(
                (volumeTypesByZone.get(plan.zone_id) ?? [])
                  .map((item) => resizeFlavorLabel(item))
                  .filter(Boolean)
              ),
            ].sort((left, right) => {
              const rank = (value: string) =>
                /ceph[_ -]?hdd/i.test(value)
                  ? 0
                  : /ceph[_ -]?ssd/i.test(value)
                    ? 1
                    : 2
              return rank(left) - rank(right) || left.localeCompare(right)
            })
            return {
              header: 'VOLUMES',
              values: typesForServer.map(
                (type) => `${plan.name}-volume-1,${type},10,description`
              ),
              rowIndexes: [index + 1],
              allowBlank: false,
              enforce: false,
            }
          }),
        ],
      }
    )
  }
  const planColumns = useMemo<ColumnDef<AttachmentPlan>[]>(
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
        accessorKey: 'zone_name',
        header: ({ column }) => <SortableHeader column={column} title='Zone' />,
      },
      {
        id: 'volumes',
        accessorFn: (row) =>
          row.volumes
            .map((volume) => `${volume.volume_type} ${volume.size}`)
            .join(' '),
        header: ({ column }) => (
          <SortableHeader column={column} title='Volumes to create' />
        ),
        cell: ({ row }) => (
          <div className='relative min-w-[32rem] space-y-1.5 pl-8 text-xs'>
            <Button
              type='button'
              variant='ghost'
              size='icon'
              className='absolute top-1/2 left-0 size-7 -translate-y-1/2 text-foreground'
              onClick={() =>
                setPlanVolumes(row.original.server_id, [
                  ...row.original.volumes,
                  {
                    name: defaultAttachmentVolumeName(
                      row.original.name,
                      row.original.server_id,
                      row.original.volumes.length + 1
                    ),
                    volume_type: '',
                    size: 10,
                    description: '',
                  },
                ])
              }
              aria-label={`Add volume to ${row.original.name}`}
              title='Add volume'
            >
              <Plus className='size-3.5' />
            </Button>
            {(() => {
              const plan = row.original
              const options =
                volumeTypesByZoneRef.current.get(plan.zone_id) ?? []
              const loading =
                volumeTypeLoadingByZoneRef.current.get(plan.zone_id) ?? false
              return plan.volumes.map((volume, index) => {
                const change = (next: Partial<AttachmentVolume>) =>
                  setPlanVolumes(
                    plan.server_id,
                    plan.volumes.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, ...next } : item
                    )
                  )
                return (
                  <div
                    key={`${plan.server_id}-edit-${index}`}
                    className='grid grid-cols-[minmax(15rem,1fr)_minmax(7.25rem,0.6fr)_5rem_minmax(4.5rem,0.5fr)_1.75rem] items-center gap-1.5'
                  >
                    <Input
                      className='h-8 text-xs'
                      value={volume.name}
                      onChange={(event) => change({ name: event.target.value })}
                      placeholder='Volume name'
                    />
                    <SearchableSelect
                      value={volume.volume_type}
                      onValueChange={(value) => {
                        const selected = options.find(
                          (item) => item.id === value
                        )
                        change({
                          volume_type: value,
                          volume_type_name: selected
                            ? resizeFlavorLabel(selected)
                            : value,
                        })
                      }}
                      loading={loading}
                      placeholder='Volume type'
                      searchPlaceholder='Search volume types...'
                      options={options.map((item) => ({
                        value: item.id,
                        label: item.name || item.display_name || item.id,
                        description: item.id,
                      }))}
                    />
                    <Input
                      className='h-8 text-xs'
                      type='number'
                      min={1}
                      value={volume.size}
                      onChange={(event) =>
                        change({ size: Number(event.target.value) || 0 })
                      }
                      aria-label={`Volume ${index + 1} size in GB`}
                    />
                    <Input
                      className='h-8 text-xs'
                      value={volume.description}
                      onChange={(event) =>
                        change({ description: event.target.value })
                      }
                      placeholder='Description (optional)'
                    />
                    <Button
                      type='button'
                      variant='ghost'
                      size='icon'
                      className='size-7 text-muted-foreground hover:text-destructive'
                      disabled={plan.volumes.length === 1}
                      onClick={() =>
                        setPlanVolumes(
                          plan.server_id,
                          plan.volumes.filter(
                            (_, itemIndex) => itemIndex !== index
                          )
                        )
                      }
                      aria-label={`Remove volume ${index + 1}`}
                    >
                      <Trash2 className='size-3.5' />
                    </Button>
                  </div>
                )
              })
            })()}
            {row.original.volumes.map((volume) => (
              <p key={volume.name} className='hidden'>
                <b>{volume.volume_type_name || volume.volume_type}</b> ·{' '}
                {volume.size} GB · {volume.name}
              </p>
            ))}
          </div>
        ),
      },
      {
        accessorKey: 'error',
        header: ({ column }) => (
          <SortableHeader column={column} title='Review' />
        ),
        cell: ({ getValue }) => {
          const error = getValue() as string | undefined
          return error ? (
            <span className='text-destructive'>{error}</span>
          ) : (
            <span className='font-medium text-emerald-600 dark:text-emerald-400'>
              Ready
            </span>
          )
        },
      },
    ],
    [setPlanVolumes]
  )
  const detachColumns = useMemo<ColumnDef<DetachVolumeRow>[]>(
    () => [
      {
        accessorKey: 'server_name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server' />
        ),
        cell: ({ row }) => (
          <div>
            <p className='font-medium'>{row.original.server_name}</p>
            <p className='font-mono text-xs text-muted-foreground'>
              {row.original.server_id}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'volume_name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Volume' />
        ),
        cell: ({ row }) => (
          <div>
            <p className='font-medium'>{row.original.volume_name}</p>
            <p className='font-mono text-xs text-muted-foreground'>
              {row.original.volume_id}
            </p>
          </div>
        ),
      },
      {
        id: 'storage',
        accessorFn: (row) =>
          `${row.mount_as ?? ''} ${row.disk_type ?? ''} ${row.size ?? ''} ${row.speed ?? ''}`,
        header: ({ column }) => (
          <SortableHeader column={column} title='Storage' />
        ),
        cell: ({ row }) => (
          <span className='text-xs'>
            {row.original.mount_as || 'data'} ·{' '}
            {(row.original.disk_type || 'volume').toUpperCase()} ·{' '}
            <b>{row.original.size ? `${row.original.size} GB` : '—'}</b>
            {row.original.speed ? ` · ${row.original.speed}` : ''}
          </span>
        ),
      },
    ],
    []
  )
  const detachServerColumns = useMemo<ColumnDef<DetachServerGroup>[]>(
    () => [
      {
        accessorKey: 'name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server' />
        ),
        cell: ({ row }) => (
          <div>
            <p className='font-medium'>{row.original.name}</p>
            <p className='font-mono text-xs text-muted-foreground'>
              {row.original.serverId}
            </p>
          </div>
        ),
      },
      {
        id: 'volumes',
        accessorFn: (row) => row.rows.map((item) => item.volume_name).join(' '),
        header: 'Data volumes to detach',
        cell: ({ row }) => {
          const rows = row.original.rows
          const selected = rows.filter((item) =>
            selectedDetachVolumeIds.has(item.id)
          )
          return (
            <div className='space-y-2'>
              <div className='flex items-center gap-2 text-xs text-muted-foreground'>
                <span>
                  {selected.length}/{rows.length} selected
                </span>
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-7 px-2 text-xs'
                  onClick={() => toggleDetachVolumes(rows, true)}
                >
                  Select all
                </Button>
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-7 px-2 text-xs'
                  onClick={() => toggleDetachVolumes(rows, false)}
                >
                  Clear
                </Button>
              </div>
              <div className='grid gap-1 md:grid-cols-2'>
                {rows.map((item) => (
                  <label
                    key={item.id}
                    className='flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-xs hover:bg-muted/50'
                  >
                    <Checkbox
                      checked={selectedDetachVolumeIds.has(item.id)}
                      onCheckedChange={(checked) =>
                        toggleDetachVolumes([item], checked === true)
                      }
                    />
                    <span className='min-w-0'>
                      <b className='block truncate'>{item.volume_name}</b>
                      <span className='block truncate text-muted-foreground'>
                        {item.disk_type?.toUpperCase() || 'VOLUME'} ·{' '}
                        {item.size || '-'} GB · {item.mount_as || 'data'}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )
        },
      },
    ],
    [selectedDetachVolumeIds]
  )
  const resultColumns = useMemo<ColumnDef<AttachmentResult>[]>(
    () => [
      {
        accessorKey: 'name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server' />
        ),
        cell: ({ row }) => (
          <div>
            <p className='font-medium'>{row.original.name}</p>
            <p className='font-mono text-xs text-muted-foreground'>
              {row.original.server_id}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'status',
        header: ({ column }) => (
          <SortableHeader column={column} title='Status' />
        ),
        cell: ({ getValue }) => (
          <span
            className={
              ['failed', 'stopped'].includes(String(getValue()))
                ? 'font-medium text-destructive'
                : ['attached', 'detached'].includes(String(getValue()))
                  ? 'font-medium text-emerald-600 dark:text-emerald-400'
                  : 'font-medium text-amber-600 dark:text-amber-400'
            }
          >
            {String(getValue())}
          </span>
        ),
      },
      {
        id: 'volumes',
        accessorFn: (row) =>
          row.volumes
            .map((volume) => `${volume.name} ${volume.status}`)
            .join(' '),
        header: ({ column }) => (
          <SortableHeader column={column} title='Volumes' />
        ),
        cell: ({ row }) => (
          <div className='space-y-1 text-xs break-words'>
            {row.original.volumes.map((volume) => (
              <p
                key={volume.volume_id || volume.name}
                className={
                  ['failed', 'error'].includes(volume.status.toLowerCase())
                    ? 'text-destructive'
                    : ['attached', 'available', 'created', 'detached'].includes(
                          volume.status.toLowerCase()
                        )
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-amber-600 dark:text-amber-400'
                }
              >
                <b>{volume.name || volume.volume_id}</b> · {volume.status}
                {volume.error ? ` · ${volume.error}` : ''}
              </p>
            ))}
          </div>
        ),
      },
      {
        accessorKey: 'detail',
        header: ({ column }) => (
          <SortableHeader column={column} title='Detail' />
        ),
        cell: ({ getValue }) => (
          <span className='text-sm text-destructive'>
            {String(getValue() || '—')}
          </span>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        enableSorting: false,
        cell: ({ row }) => {
          const result = row.original
          const canAttach = result.volumes.some(
            (volume) => volume.volume_id && volume.status !== 'attached'
          )
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant='ghost' size='icon' className='size-8'>
                  <span className='sr-only'>Open result actions</span>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end'>
                <DropdownMenuLabel>Result actions</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setResultDetail(result)}>
                  <Eye />
                  View API detail
                </DropdownMenuItem>
                {result.status === 'failed' ? (
                  <>
                    <DropdownMenuSeparator />
                    {mode === 'detach' ? (
                      <DropdownMenuItem
                        disabled={Boolean(retryingServerId)}
                        onClick={() => void retryDetach(result)}
                      >
                        <RefreshCw
                          className={
                            retryingServerId === result.server_id
                              ? 'animate-spin'
                              : undefined
                          }
                        />
                        Retry detach
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem
                          disabled={Boolean(retryingServerId)}
                          onClick={() => retryCreateAndAttach(result)}
                        >
                          <RefreshCw
                            className={
                              retryingServerId === result.server_id
                                ? 'animate-spin'
                                : undefined
                            }
                          />
                          Retry create & attach
                        </DropdownMenuItem>
                        {canAttach ? (
                          <DropdownMenuItem
                            disabled={Boolean(retryingServerId)}
                            onClick={() => void retryAttach(result)}
                          >
                            <Link2 />
                            Retry attach only
                          </DropdownMenuItem>
                        ) : null}
                      </>
                    )}
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
      },
    ],
    [mode, plans, retryingServerId]
  )

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && ['running', 'paused'].includes(runState))
            setCloseConfirm(true)
          else if (!next && results.length) setReviewCloseConfirm(true)
          else onOpenChange(next)
        }}
      >
        <DialogContent className='!top-[1svh] flex !h-[98svh] !max-h-[98svh] w-[98vw] max-w-[98vw] flex-col overflow-hidden sm:!max-w-[98vw]'>
          <DialogHeader className='relative pr-28'>
            <DialogTitle>Manage server volumes</DialogTitle>
            <DialogDescription>
              {mode === 'attach'
                ? 'Create data volumes, wait for availability, then attach them to the selected servers.'
                : 'Review attached data volumes and detach only the volumes you select. Root volumes are excluded.'}
            </DialogDescription>
            <div className='absolute top-0 right-8 flex items-center gap-2 border-r pr-3'>
              {results.length ? (
                <Button
                  size='icon'
                  variant='outline'
                  disabled={refreshingResults}
                  onClick={() => void refreshResults()}
                  aria-label='Refresh volume results'
                >
                  <RefreshCw
                    className={refreshingResults ? 'animate-spin' : undefined}
                  />
                </Button>
              ) : null}
              {runState === 'running' || runState === 'paused' ? (
                <Button
                  size='icon'
                  variant='destructive'
                  onClick={() => {
                    controls.current.stopped = true
                    controls.current.paused = false
                  }}
                  aria-label='Stop attachment'
                >
                  <Square />
                </Button>
              ) : null}
            </div>
          </DialogHeader>
          {results.length ? (
            <div className='mt-2 min-h-0 flex-1'>
              <CloudDataTable
                data={results}
                columns={resultColumns}
                getRowId={(row) => row.server_id}
                entityName='attachment result'
                exportFileName='volume-attachment-results'
                searchPlaceholder='Search attachment results...'
                toolbar={(selected) => {
                  const failed = selected.filter(
                    (item) => item.status === 'failed'
                  )
                  const attachable = failed.filter((item) =>
                    item.volumes.some(
                      (volume) =>
                        volume.volume_id && volume.status !== 'attached'
                    )
                  )
                  return (
                    <div className='flex items-center gap-2'>
                      {mode === 'detach' ? (
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={
                            !failed.length ||
                            autoRetrying ||
                            Boolean(retryingServerId)
                          }
                          onClick={() => void retryFailedDetaches(failed)}
                        >
                          <RefreshCw
                            className={
                              autoRetrying ? 'animate-spin' : undefined
                            }
                          />
                          Retry detach ({failed.length})
                        </Button>
                      ) : (
                        <>
                          <Button
                            size='sm'
                            disabled={
                              !failed.length ||
                              autoRetrying ||
                              Boolean(retryingServerId)
                            }
                            onClick={() => void autoRetry(failed)}
                          >
                            <RefreshCw
                              className={
                                autoRetrying ? 'animate-spin' : undefined
                              }
                            />
                            Auto retry ({failed.length})
                          </Button>
                          <Button
                            size='sm'
                            variant='outline'
                            disabled={
                              !failed.length ||
                              autoRetrying ||
                              Boolean(retryingServerId)
                            }
                            onClick={() => {
                              const retryPlans = failed
                                .map((item) =>
                                  plans.find(
                                    (plan) => plan.server_id === item.server_id
                                  )
                                )
                                .filter((plan): plan is AttachmentPlan =>
                                  Boolean(plan)
                                )
                              if (retryPlans.length)
                                void runPlans(retryPlans, true)
                            }}
                          >
                            <RefreshCw
                              className={
                                retryingServerId ? 'animate-spin' : undefined
                              }
                            />
                            Retry create & attach ({failed.length})
                          </Button>
                          <Button
                            size='sm'
                            variant='outline'
                            disabled={
                              !attachable.length ||
                              autoRetrying ||
                              Boolean(retryingServerId)
                            }
                            onClick={() =>
                              void Promise.all(
                                attachable.map((item) => retryAttach(item))
                              )
                            }
                          >
                            <Link2 />
                            Retry attach ({attachable.length})
                          </Button>
                        </>
                      )}
                    </div>
                  )
                }}
              />
            </div>
          ) : (
            <>
              <SegmentedTabs
                value={mode}
                onValueChange={setMode}
                tabs={[
                  {
                    value: 'attach',
                    label: `Create & attach (${targets.length})`,
                  },
                  { value: 'detach', label: 'Detach attached volumes' },
                ]}
              />
              <div className='hidden shrink-0 items-center justify-between rounded-md border bg-muted/20 px-3 py-2'>
                <div>
                  <p className='text-sm font-medium'>
                    Parallel server workflows
                  </p>
                  <p className='text-xs text-muted-foreground'>
                    Each server processes its volumes in order; server workflows
                    run in parallel up to this limit.
                  </p>
                </div>
                <Input
                  className='w-20'
                  type='number'
                  min={1}
                  max={10}
                  value={concurrency}
                  onChange={(event) =>
                    setConcurrency(
                      Math.max(1, Math.min(10, Number(event.target.value) || 1))
                    )
                  }
                />
              </div>
              {mode === 'detach' ? (
                <div className='flex shrink-0 items-center justify-between rounded-md border bg-muted/20 p-3'>
                  <p className='text-sm text-muted-foreground'>
                    Live attached data volumes are loaded from the selected
                    servers. Root volumes are excluded.
                  </p>
                  <div className='flex items-center gap-2'>
                    <div className='flex rounded-md border p-0.5'>
                      <Button
                        size='sm'
                        variant={detachView === 'table' ? 'secondary' : 'ghost'}
                        className='h-7 px-2 text-xs'
                        onClick={() => setDetachView('table')}
                      >
                        Table
                      </Button>
                      <Button
                        size='sm'
                        variant={
                          detachView === 'server' ? 'secondary' : 'ghost'
                        }
                        className='h-7 px-2 text-xs'
                        onClick={() => setDetachView('server')}
                      >
                        By server
                      </Button>
                    </div>
                    {detachView === 'server' && selectedDetachVolumeIds.size ? (
                      <Button
                        size='sm'
                        variant='destructive'
                        onClick={() => {
                          setPendingDetachRows(
                            detachRows.filter((row) =>
                              selectedDetachVolumeIds.has(row.id)
                            )
                          )
                          setDetachConfirmOpen(true)
                        }}
                      >
                        <HardDrive />
                        Detach selected ({selectedDetachVolumeIds.size})
                      </Button>
                    ) : null}
                    <Button
                      size='icon'
                      variant='outline'
                      onClick={() => void loadDetachRows()}
                      title='Refresh attached volumes'
                    >
                      <RefreshCw
                        className={
                          loadingDetachRows ? 'animate-spin' : undefined
                        }
                      />
                    </Button>
                  </div>
                </div>
              ) : null}
              {mode === 'attach' ? (
                <div className='space-y-2 rounded-md border bg-muted/20 p-3'>
                  <div className='flex items-center justify-between gap-3'>
                    <div>
                      <p className='text-sm font-medium'>
                        Create & attach plan
                      </p>
                    </div>
                    <div className='flex items-center gap-3'>
                      <div className='flex items-center gap-2 border-r pr-3'>
                        <span className='text-xs text-muted-foreground'>
                          Parallel workflows
                        </span>
                        <Input
                          className='h-8 w-16'
                          type='number'
                          min={1}
                          max={10}
                          value={concurrency}
                          onChange={(event) =>
                            setConcurrency(
                              Math.max(
                                1,
                                Math.min(10, Number(event.target.value) || 1)
                              )
                            )
                          }
                        />
                      </div>
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
                          size='sm'
                          variant='outline'
                          onClick={downloadTemplate}
                        >
                          <Download />
                          Template
                        </Button>
                        <Button
                          size='sm'
                          disabled={importing}
                          onClick={() => fileRef.current?.click()}
                        >
                          {importing ? (
                            <Loader2 className='animate-spin' />
                          ) : (
                            <FileUp />
                          )}
                          Import Excel
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className='border-t pt-2'>
                    {attachmentQuotaQuery.isLoading ? (
                      <p className='mt-1 text-xs text-muted-foreground'>
                        Checking project quota...
                      </p>
                    ) : attachmentQuotaQuery.isError ? (
                      <p className='mt-1 text-xs text-amber-700 dark:text-amber-400'>
                        Quota could not be checked. You can still continue.
                      </p>
                    ) : (
                      <div className='mt-1 flex items-center gap-1.5'>
                        <div className='flex flex-1 flex-wrap gap-1.5'>
                          {attachmentQuotaReview.map((item) => (
                            <span
                              key={item.label}
                              className={
                                item.exceeded
                                  ? 'rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive'
                                  : 'rounded border px-2 py-1 text-xs'
                              }
                            >
                              <b>{item.label}</b> +{item.requested} ·{' '}
                              {item.limit == null
                                ? 'quota unavailable'
                                : `${item.available}${['HDD', 'SSD'].includes(item.label) ? ' GiB' : ''} free / ${item.limit}${['HDD', 'SSD'].includes(item.label) ? ' GiB' : ''}`}
                            </span>
                          ))}
                        </div>
                        <Button
                          size='icon'
                          variant='ghost'
                          className='size-7 shrink-0'
                          onClick={() => void attachmentQuotaQuery.refetch()}
                          disabled={attachmentQuotaQuery.isFetching}
                          title='Refresh quota'
                        >
                          <RefreshCw
                            className={
                              attachmentQuotaQuery.isFetching
                                ? 'size-3.5 animate-spin'
                                : 'size-3.5'
                            }
                          />
                        </Button>
                      </div>
                    )}
                    {attachmentQuotaReview.some((item) => item.exceeded) ? (
                      <p className='mt-1 text-xs font-medium text-destructive'>
                        Warning: requested volume capacity exceeds remaining
                        quota. Creation remains available.
                      </p>
                    ) : null}
                    {importWarnings.map((warning) => (
                      <p
                        key={warning}
                        className='mt-1 text-xs text-amber-700 dark:text-amber-400'
                      >
                        {warning}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
              {editingPlan && (
                <div className='shrink-0 space-y-3 rounded-md border bg-muted/20 p-3'>
                  <div className='flex items-center justify-between gap-3'>
                    <div>
                      <p className='text-sm font-medium'>
                        Configure volumes: {editingPlan.name}
                      </p>
                      <p className='text-xs text-muted-foreground'>
                        {editingPlan.zone_name} · Changes apply only to this
                        server.
                      </p>
                    </div>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => setEditingPlanId(undefined)}
                    >
                      Done
                    </Button>
                  </div>
                  {editingPlan.volumes.map((volume, index) => {
                    const options =
                      volumeTypesByZone.get(editingPlan.zone_id) ?? []
                    const change = (next: Partial<AttachmentVolume>) =>
                      setPlanVolumes(
                        editingPlan.server_id,
                        editingPlan.volumes.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, ...next } : item
                        )
                      )
                    return (
                      <div
                        key={`${volume.name}-${index}`}
                        className='grid gap-2 md:grid-cols-[minmax(9rem,1fr)_minmax(14rem,1.5fr)_6rem_minmax(10rem,1fr)_auto]'
                      >
                        <Input
                          value={volume.name}
                          onChange={(event) =>
                            change({ name: event.target.value })
                          }
                          placeholder='Volume name'
                        />
                        <SearchableSelect
                          value={volume.volume_type}
                          onValueChange={(value) => {
                            const selected = options.find(
                              (item) => item.id === value
                            )
                            change({
                              volume_type: value,
                              volume_type_name: selected
                                ? resizeFlavorLabel(selected)
                                : value,
                            })
                          }}
                          loading={
                            volumeTypeQueries[
                              uniqueZones.indexOf(editingPlan.zone_id)
                            ]?.isLoading
                          }
                          placeholder='Volume type'
                          searchPlaceholder='Search volume types...'
                          options={options.map((item) => ({
                            value: item.id,
                            label: item.name || item.display_name || item.id,
                            description: item.id,
                          }))}
                        />
                        <Input
                          type='number'
                          min={1}
                          value={volume.size}
                          onChange={(event) =>
                            change({ size: Number(event.target.value) || 0 })
                          }
                        />
                        <Input
                          value={volume.description}
                          onChange={(event) =>
                            change({ description: event.target.value })
                          }
                          placeholder='Description'
                        />
                        <Button
                          variant='ghost'
                          size='icon'
                          disabled={editingPlan.volumes.length === 1}
                          onClick={() =>
                            setPlanVolumes(
                              editingPlan.server_id,
                              editingPlan.volumes.filter(
                                (_, itemIndex) => itemIndex !== index
                              )
                            )
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    )
                  })}
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() =>
                      setPlanVolumes(editingPlan.server_id, [
                        ...editingPlan.volumes,
                        {
                          name: `data-${editingPlan.name}-${editingPlan.volumes.length + 1}`,
                          volume_type: '',
                          size: 10,
                          description: '',
                        },
                      ])
                    }
                  >
                    <Plus />
                    Add volume
                  </Button>
                </div>
              )}
              <div className='min-h-0 flex-1'>
                {mode === 'detach' ? (
                  loadingDetachRows ? (
                    <div className='flex h-full items-center justify-center text-sm text-muted-foreground'>
                      <Loader2 className='mr-2 animate-spin' />
                      Loading attached volumes from selected servers...
                    </div>
                  ) : detachView === 'table' ? (
                    <CloudDataTable
                      data={detachRows}
                      columns={detachColumns}
                      getRowId={(row) => row.id}
                      entityName='attached volume'
                      searchPlaceholder='Search server or attached volume...'
                      toolbar={(selected) => (
                        <Button
                          size='sm'
                          variant='destructive'
                          onClick={() => {
                            setPendingDetachRows(selected)
                            setDetachConfirmOpen(true)
                          }}
                        >
                          <HardDrive />
                          Detach volumes ({selected.length})
                        </Button>
                      )}
                    />
                  ) : (
                    <>
                      <CloudDataTable
                        data={detachRowsByServer}
                        columns={detachServerColumns}
                        getRowId={(row) => row.serverId}
                        entityName='server'
                        searchPlaceholder='Search server or data volume...'
                        isRowSelectable={() => false}
                        toolbar={() => null}
                      />
                      <div className='hidden space-y-2 overflow-auto pr-1'>
                        {detachRowsByServer.map(({ serverId, name, rows }) => {
                          const selectedCount = rows.filter((row) =>
                            selectedDetachVolumeIds.has(row.id)
                          ).length
                          return (
                            <div
                              key={serverId}
                              className='rounded-md border p-3'
                            >
                              <div className='mb-2 flex items-center justify-between gap-3'>
                                <div>
                                  <p className='font-medium'>{name}</p>
                                  <p className='font-mono text-xs text-muted-foreground'>
                                    {serverId}
                                  </p>
                                </div>
                                <div className='flex items-center gap-2'>
                                  <span className='text-xs text-muted-foreground'>
                                    {selectedCount}/{rows.length} selected
                                  </span>
                                  <Button
                                    size='sm'
                                    variant='ghost'
                                    className='h-7 px-2 text-xs'
                                    onClick={() =>
                                      toggleDetachVolumes(rows, true)
                                    }
                                  >
                                    Select all
                                  </Button>
                                  <Button
                                    size='sm'
                                    variant='ghost'
                                    className='h-7 px-2 text-xs'
                                    onClick={() =>
                                      toggleDetachVolumes(rows, false)
                                    }
                                  >
                                    Clear
                                  </Button>
                                </div>
                              </div>
                              <div className='grid gap-1 sm:grid-cols-2 xl:grid-cols-3'>
                                {rows.map((row) => (
                                  <label
                                    key={row.id}
                                    className='flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-sm hover:bg-muted/50'
                                  >
                                    <Checkbox
                                      checked={selectedDetachVolumeIds.has(
                                        row.id
                                      )}
                                      onCheckedChange={(checked) =>
                                        toggleDetachVolumes(
                                          [row],
                                          checked === true
                                        )
                                      }
                                    />
                                    <span className='min-w-0'>
                                      <span className='block truncate font-medium'>
                                        {row.volume_name}
                                      </span>
                                      <span className='block truncate text-xs text-muted-foreground'>
                                        {row.disk_type?.toUpperCase() ||
                                          'VOLUME'}{' '}
                                        · {row.size || '-'} GB ·{' '}
                                        {row.mount_as || 'data'}
                                      </span>
                                    </span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                        {!detachRowsByServer.length ? (
                          <div className='rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground'>
                            No detachable data volume was found.
                          </div>
                        ) : null}
                        {selectedDetachVolumeIds.size ? (
                          <div className='sticky bottom-0 flex justify-end border-t bg-background pt-2'>
                            <Button
                              size='sm'
                              variant='destructive'
                              onClick={() => {
                                setPendingDetachRows(
                                  detachRows.filter((row) =>
                                    selectedDetachVolumeIds.has(row.id)
                                  )
                                )
                                setDetachConfirmOpen(true)
                              }}
                            >
                              <HardDrive />
                              Detach selected volumes (
                              {selectedDetachVolumeIds.size})
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </>
                  )
                ) : (
                  <CloudDataTable
                    data={displayPlans}
                    columns={planColumns}
                    getRowId={(row) => row.server_id}
                    entityName='server'
                    searchPlaceholder='Search server, zone or volume...'
                    isRowSelectable={(row) =>
                      readyPlans.some(
                        (plan) => plan.server_id === row.server_id
                      )
                    }
                    toolbar={(selected) => (
                      <Button
                        size='sm'
                        onClick={() => {
                          setPendingPlans(selected)
                          setConfirmOpen(true)
                        }}
                      >
                        <HardDrive />
                        Attach volumes ({selected.length})
                      </Button>
                    )}
                  />
                )}
              </div>
            </>
          )}
          {runState === 'running' || runState === 'paused' ? (
            <DialogFooter className='shrink-0 border-t pt-4'>
              <Button
                size='icon'
                variant='outline'
                onClick={() => {
                  controls.current.paused = !controls.current.paused
                  setRunState(controls.current.paused ? 'paused' : 'running')
                }}
              >
                {runState === 'paused' ? <Play /> : <Pause />}
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(resultDetail)}
        onOpenChange={(next) => !next && setResultDetail(undefined)}
      >
        <DialogContent className='flex max-h-[90svh] max-w-5xl flex-col'>
          <DialogHeader>
            <DialogTitle>Volume API detail</DialogTitle>
            <DialogDescription>
              {resultDetail?.name} - {resultDetail?.server_id}
            </DialogDescription>
          </DialogHeader>
          <div className='min-h-0 space-y-4 overflow-y-auto pr-1'>
            <div className='rounded-md border'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Volume</TableHead>
                    <TableHead>ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {resultDetail?.volumes.length ? (
                    resultDetail.volumes.map((volume, index) => (
                      <TableRow
                        key={volume.volume_id || `${volume.name}-${index}`}
                      >
                        <TableCell className='font-medium'>
                          {volume.name || '-'}
                        </TableCell>
                        <TableCell className='font-mono text-xs'>
                          {volume.volume_id || '-'}
                        </TableCell>
                        <TableCell>{volume.status}</TableCell>
                        <TableCell className='max-w-md break-words whitespace-normal text-destructive'>
                          {upstreamDetail(volume.error) || '-'}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className='text-center text-muted-foreground'
                      >
                        No volume response was returned.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <div className='space-y-2'>
              <p className='text-sm font-medium'>API operations</p>
              {(resultDetail?.operations ?? []).length ? (
                resultDetail?.operations?.map((operation, index) => {
                  const outcome = volumeOperationOutcome(operation)
                  return (
                    <details
                      key={`${operation.action}-${index}`}
                      className='rounded-md border p-3'
                      open={index === 0}
                    >
                      <summary className='cursor-pointer text-sm font-medium capitalize'>
                        {operation.action} -{' '}
                        <span className={outcome.className}>
                          {outcome.label}
                        </span>
                      </summary>
                      <div className='mt-3 grid gap-3 lg:grid-cols-2'>
                        <div>
                          <Label>Request</Label>
                          <Textarea
                            readOnly
                            className='mt-1 h-40 resize-y font-mono text-xs'
                            value={JSON.stringify(operation.request, null, 2)}
                          />
                        </div>
                        <div>
                          <Label>
                            {operation.error ? 'Error response' : 'Response'}
                          </Label>
                          <Textarea
                            readOnly
                            className='mt-1 h-40 resize-y font-mono text-xs'
                            value={JSON.stringify(
                              operation.error ?? operation.response ?? {},
                              null,
                              2
                            )}
                          />
                        </div>
                      </div>
                    </details>
                  )
                })
              ) : (
                <p className='text-sm text-muted-foreground'>
                  No API operation log is available for this result.
                </p>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Attach volumes to ${pendingPlans.length} server(s)?`}
        desc={`Volumes will be created, checked every 10 seconds until available, then attached. Up to ${concurrency} server workflow(s) run in parallel.`}
        confirmText='Start attachment'
        handleConfirm={() => {
          setConfirmOpen(false)
          void runPlans(pendingPlans)
        }}
      />
      <ConfirmDialog
        open={closeConfirm}
        onOpenChange={setCloseConfirm}
        title='Stop attachment and close?'
        desc='Stopping prevents new create, status, and attach steps. A request already in progress cannot be cancelled at Viettel Cloud.'
        destructive
        confirmText='Stop and close'
        handleConfirm={() => {
          controls.current.stopped = true
          controls.current.paused = false
          setCloseConfirm(false)
          onOpenChange(false)
        }}
      />
      <ConfirmDialog
        open={detachConfirmOpen}
        onOpenChange={setDetachConfirmOpen}
        title={`Detach ${pendingDetachRows.length} volume(s)?`}
        desc='Selected volumes are detached sequentially for each server. The volume data itself is not deleted.'
        destructive
        confirmText='Detach volumes'
        handleConfirm={() => {
          setDetachConfirmOpen(false)
          void runDetach(pendingDetachRows)
        }}
      />
      <ConfirmDialog
        open={reviewCloseConfirm}
        onOpenChange={setReviewCloseConfirm}
        title='Close volume attachment results?'
        desc='The volume creation and attachment results are only shown in this modal. Close after you have reviewed the outcome.'
        confirmText='Close results'
        handleConfirm={() => {
          setReviewCloseConfirm(false)
          onOpenChange(false)
        }}
      />
    </>
  )
}

export function ServersPage() {
  const project = useCloudStore((state) => state.project)!
  const user = useAuthStore((state) => state.auth.user)
  const queryClient = useQueryClient()
  const [profileId, setProfileId] = useState('')
  const [passwordMode, setPasswordMode] =
    useState<ServerPasswordMode>('profile')
  const [manualPassword, setManualPassword] = useState('')
  const [showPasswords, setShowPasswords] = useState(false)
  const [randomPasswordLength, setRandomPasswordLength] = useState(12)
  const [randomPasswords, setRandomPasswords] = useState<
    Record<string, string>
  >({})
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [passwordResults, setPasswordResults] = useState<
    ServerOperationResult[]
  >([])
  const [changingPasswords, setChangingPasswords] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameResults, setRenameResults] = useState<ServerOperationResult[]>(
    []
  )
  const [powerOpen, setPowerOpen] = useState(false)
  const [powerAction, setPowerAction] = useState<'start' | 'stop'>('start')
  const [powerResults, setPowerResults] = useState<ServerPowerResult[]>([])
  const [powerConfirmationText, setPowerConfirmationText] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deletingServers, setDeletingServers] = useState(false)
  const deletingServersRef = useRef(false)
  const [deleteDrafts, setDeleteDrafts] = useState<ServerDeleteDraft[]>([])
  const [deleteResults, setDeleteResults] = useState<ServerOperationResult[]>(
    []
  )
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false)
  const [deleteConfirmationText, setDeleteConfirmationText] = useState('')
  const [copyOpen, setCopyOpen] = useState(false)
  const [multiConsoleOpen, setMultiConsoleOpen] = useState(false)
  const [prometheusOpen, setPrometheusOpen] = useState(false)
  const [prometheusLinksOpen, setPrometheusLinksOpen] = useState(false)
  const [prometheusTargets, setPrometheusTargets] = useState<ServerRow[]>([])
  const [prometheusLinkId, setPrometheusLinkId] = useState('')
  const [prometheusLabelSelector, setPrometheusLabelSelector] = useState('')
  const [prometheusResults, setPrometheusResults] = useState<
    PrometheusResult[]
  >([])
  const [prometheusChecking, setPrometheusChecking] = useState(false)
  const [prometheusJsonOpen, setPrometheusJsonOpen] = useState(false)
  const [prometheusJson, setPrometheusJson] = useState('')
  const [teleportOpen, setTeleportOpen] = useState(false)
  const [teleportSshServer, setTeleportSshServer] = useState<ServerRow>()
  const [teleportManageOpen, setTeleportManageOpen] = useState(false)
  const [teleportTargets, setTeleportTargets] = useState<ServerRow[]>([])
  const [teleportLinkId, setTeleportLinkId] = useState('')
  const [teleportCredentials, setTeleportCredentials] = useState({
    username: '',
    password: '',
    otp: '',
  })
  const [teleportResults, setTeleportResults] = useState<TeleportResult[]>([])
  const [teleportSelectedIps, setTeleportSelectedIps] = useState<
    Record<string, string>
  >({})
  const [teleportChecking, setTeleportChecking] = useState(false)
  const [teleportForm, setTeleportForm] = useState({
    name: '',
    url: '',
    verify_tls: true,
  })
  const [prometheusForm, setPrometheusForm] =
    useState<PrometheusForm>(emptyPrometheusForm)
  const [prometheusDeleteLink, setPrometheusDeleteLink] =
    useState<PrometheusLink>()
  const [prometheusStatusFilter, setPrometheusStatusFilter] = useState<
    'all' | 'up' | 'down' | 'not-found'
  >('all')
  const [attachPrivateIpsOpen, setAttachPrivateIpsOpen] = useState(false)
  const [elasticIpOpen, setElasticIpOpen] = useState(false)
  const [inventoryOpen, setInventoryOpen] = useState(false)
  const [showSnapshotDetails, setShowSnapshotDetails] = useState(false)
  const [resizeOpen, setResizeOpen] = useState(false)
  const [resizeTargets, setResizeTargets] = useState<ServerRow[]>([])
  const [volumeAttachmentOpen, setVolumeAttachmentOpen] = useState(false)
  const [volumeAttachmentTargets, setVolumeAttachmentTargets] = useState<
    ServerRow[]
  >([])
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [terraformExporting, setTerraformExporting] = useState(false)
  const [exportMode, setExportMode] = useState<'all' | 'custom'>('all')
  const [exportReverseOrder, setExportReverseOrder] = useState(false)
  const [exportFields, setExportFields] = useState<string[]>([
    ...defaultServerExportFields,
  ])
  const [warningAction, setWarningAction] = useState<
    'password' | 'rename' | 'start' | 'stop' | undefined
  >()
  const [renameLines, setRenameLines] = useState('')
  const [selectedServers, setSelectedServers] = useState<ServerRow[]>([])
  const [bulkSecurityGroups, setBulkSecurityGroups] = useState<{
    servers: ServerRow[]
    projectId: string
    projectName: string
  } | null>(null)
  const [singleRenameServer, setSingleRenameServer] = useState<ServerRow>()
  const [viewServer, setViewServer] = useState<ServerRow>()
  const [securityRulesServer, setSecurityRulesServer] = useState<ServerRow>()
  const [securityRuleGroupId, setSecurityRuleGroupId] = useState('__all__')
  const [securityRuleDirection, setSecurityRuleDirection] = useState<
    'all' | 'ingress' | 'egress'
  >('all')
  const [securityRuleCreateOpen, setSecurityRuleCreateOpen] = useState(false)
  const [securityRuleInitialGroupId, setSecurityRuleInitialGroupId] =
    useState('')
  const [securityRuleDeleteItems, setSecurityRuleDeleteItems] = useState<
    ServerSecurityRule[]
  >([])
  const [singleRenameName, setSingleRenameName] = useState('')
  const [copyColumns, setCopyColumns] = useState<ServerCopyColumn[]>(['id'])
  const [clearBulkSelection, setClearBulkSelection] = useState<() => void>(
    () => () => undefined
  )
  const { execute, isPending } = useCloudMutation()
  const isAdmin =
    (typeof user?.role === 'string' ? user.role : user?.role?.name) === 'admin'
  const canManageBulkServers = ['admin', 'operator'].includes(
    typeof user?.role === 'string' ? user.role : (user?.role?.name ?? '')
  )
  const canAttachPrivateIps = canManageBulkServers
  const prometheusLinks = useQuery({
    queryKey: ['prometheus-links'],
    queryFn: async ({ signal }) =>
      (await apiClient.get<PrometheusLink[]>('/prometheus-links', { signal })).data,
  })
  const teleportLinks = useQuery({
    queryKey: ['teleport-links'],
    queryFn: async ({ signal }) =>
      (await apiClient.get<TeleportLink[]>('/teleport-links', { signal })).data,
  })
  const teleportSession = useQuery({
    queryKey: ['teleport-links', teleportLinkId, 'session'],
    enabled: Boolean(teleportLinkId),
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<{ active: boolean }>(
          `/teleport-links/${teleportLinkId}/session`, { signal }
        )
      ).data,
  })
  const prometheusStatus = (result: PrometheusResult) =>
    result.down ? 'Down' : result.found ? 'Up' : 'Not found'
  const openPrometheusTargetJson = (results: PrometheusResult[]) => {
    setPrometheusJson(
      JSON.stringify(
        [
          {
            labels: { application: project.name },
            targets: results.flatMap((result) =>
              result.ip_results.map((item) => `${item.ip}:9100`)
            ),
          },
        ],
        null,
        2
      )
    )
    setPrometheusJsonOpen(true)
  }
  const filteredPrometheusResults = useMemo(
    () =>
      prometheusResults.filter(
        (result) =>
          prometheusStatusFilter === 'all' ||
          prometheusStatus(result).toLowerCase().replace(' ', '-') ===
            prometheusStatusFilter
      ),
    [prometheusResults, prometheusStatusFilter]
  )
  const prometheusLinkColumns = useMemo<ColumnDef<PrometheusLink>[]>(
    () => [
      { accessorKey: 'name', header: 'Name' },
      {
        accessorKey: 'url',
        header: 'URL',
        cell: ({ row }) => (
          <span className='max-w-72 truncate font-mono text-xs'>
            {row.original.url}
          </span>
        ),
      },
      {
        accessorKey: 'auth_type',
        header: 'Authentication',
        cell: ({ row }) => (
          <Badge variant='outline'>{row.original.auth_type}</Badge>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => (
          <div className='flex justify-end gap-1'>
            <Button
              variant='ghost'
              size='icon'
              aria-label={`Edit ${row.original.name}`}
              onClick={() =>
                setPrometheusForm({
                  ...emptyPrometheusForm,
                  id: row.original.id,
                  name: row.original.name,
                  url: row.original.url,
                  auth_type: row.original.auth_type,
                })
              }
            >
              <Pencil />
            </Button>
            <Button
              variant='ghost'
              size='icon'
              className='text-destructive'
              aria-label={`Delete ${row.original.name}`}
              onClick={() => setPrometheusDeleteLink(row.original)}
            >
              <Trash2 />
            </Button>
          </div>
        ),
      },
    ],
    []
  )
  const teleportCheckRows = useMemo(
    () =>
      teleportTargets.map((server) => {
        const ips = (server.private_ip ?? []).map((item) => item.ip_address)
        const selectedIp =
          teleportSelectedIps[server.id] ??
          ips.find((ip) => ip.startsWith('10.129.')) ??
          ips[0] ??
          ''
        return {
          server,
          ips,
          selectedIp,
          result: teleportResults.find((item) => item.server_id === server.id),
        }
      }),
    [teleportResults, teleportSelectedIps, teleportTargets]
  )
  const teleportResultColumns = useMemo<
    ColumnDef<(typeof teleportCheckRows)[number]>[]
  >(
    () => [
      {
        id: 'server',
        header: ({ column }) => (
          <SortableHeader column={column} title='VM server' />
        ),
        accessorFn: (row) => row.server.name,
        cell: ({ row }) => (
          <div>
            <div className='font-medium'>{row.original.server.name}</div>
            <div className='font-mono text-xs text-muted-foreground'>
              {row.original.server.id}
            </div>
          </div>
        ),
      },
      {
        id: 'private_ip',
        header: ({ column }) => (
          <SortableHeader column={column} title='Private IP to check' />
        ),
        accessorFn: (row) => row.selectedIp,
        cell: ({ row }) =>
          row.original.ips.length ? (
            <select
              aria-label={`Private IP for ${row.original.server.name}`}
              className='h-9 min-w-40 rounded-md border bg-background px-2 font-mono text-sm'
              onChange={(event) =>
                setTeleportSelectedIps((current) => ({
                  ...current,
                  [row.original.server.id]: event.target.value,
                }))
              }
              value={row.original.selectedIp}
            >
              {row.original.ips.map((ip) => (
                <option key={ip} value={ip}>
                  {ip}
                  {ip.startsWith('10.129.') ? ' (preferred)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className='text-muted-foreground'>No private IP</span>
          ),
      },
      {
        id: 'status',
        header: ({ column }) => (
          <SortableHeader column={column} title='Teleport status' />
        ),
        accessorFn: (row) =>
          row.result
            ? row.result.error
              ? 'Check failed'
              : row.result.found
                ? 'On Teleport'
                : 'Not found'
            : 'Not checked',
        cell: ({ row }) =>
          row.original.result ? (
            <Badge
              className={
                row.original.result.found
                  ? 'border-emerald-600 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                  : undefined
              }
              title={row.original.result.error}
              variant={row.original.result.found ? 'outline' : 'destructive'}
            >
              {row.original.result.error
                ? 'Check failed'
                : row.original.result.found
                  ? 'On Teleport'
                  : 'Not found'}
            </Badge>
          ) : (
            <span className='text-muted-foreground'>Not checked</span>
          ),
      },
      {
        id: 'teleport_name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Teleport node name' />
        ),
        accessorFn: (row) => row.result?.teleport_name ?? '',
        cell: ({ row }) => (
          <span className='font-mono text-xs'>
            {row.original.result?.teleport_name ?? '—'}
          </span>
        ),
      },
      {
        id: 'teleport_labels',
        header: ({ column }) => (
          <SortableHeader column={column} title='Teleport labels' />
        ),
        accessorFn: (row) => row.result?.teleport_labels ?? '',
        cell: ({ row }) => (
          <span className='block max-w-md truncate font-mono text-xs'>
            {row.original.result?.teleport_labels ?? '—'}
          </span>
        ),
      },
    ],
    []
  )
  const checkTeleportServers = async () => {
    if (!teleportLinkId || teleportChecking) return
    const serverIps = Object.fromEntries(
      teleportCheckRows
        .filter((row) => Boolean(row.selectedIp))
        .map((row) => [row.server.id, [row.selectedIp]])
    )
    if (!Object.keys(serverIps).length) {
      toast.error('None of the selected servers has a private IP to check.')
      return
    }
    setTeleportChecking(true)
    try {
      const { data } = await apiClient.post<TeleportResult[]>(
        `/teleport-links/${teleportLinkId}/check`,
        { server_ips: serverIps }
      )
      setTeleportResults(data)
      await teleportSession.refetch()
      toast.success(`Checked ${data.length} server(s).`)
    } catch (error) {
      const responseData =
        error instanceof AxiosError ? error.response?.data : undefined
      const detail =
        typeof responseData?.detail === 'string'
          ? responseData.detail
          : typeof responseData?.error?.message === 'string'
            ? responseData.error.message
            : 'Could not check Teleport. Sign in from the Teleport session page first.'
      toast.error(detail)
    } finally {
      setTeleportChecking(false)
    }
  }
  const prometheusResultColumns = useMemo<ColumnDef<PrometheusResult>[]>(
    () => [
      {
        accessorKey: 'server_id',
        header: 'Server ID',
        cell: ({ row }) => (
          <span
            className='block max-w-28 truncate font-mono text-xs'
            title={row.original.server_id}
          >
            {row.original.server_id}
          </span>
        ),
      },
      {
        id: 'server',
        header: 'Server',
        accessorFn: (row) =>
          prometheusTargets.find((server) => server.id === row.server_id)
            ?.name ?? row.server_id,
      },
      {
        id: 'private_ips',
        header: 'Private IPs',
        accessorFn: (row) => row.ip_results.map((item) => item.ip).join(', '),
        cell: ({ row }) => (
          <span className='max-w-md whitespace-normal'>
            {row.original.ip_results.map((item) => item.ip).join(', ') || '—'}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        accessorFn: prometheusStatus,
        cell: ({ row }) => (
          <Badge
            variant={row.original.down ? 'destructive' : 'outline'}
            className={
              row.original.found && !row.original.down
                ? 'border-emerald-600 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                : undefined
            }
          >
            {prometheusStatus(row.original)}
          </Badge>
        ),
      },
      {
        id: 'labels',
        header: 'Labels',
        accessorFn: (row) =>
          Object.entries(row.labels)
            .map(([key, value]) => `${key}=${value}`)
            .join(', '),
        cell: ({ row }) => (
          <span className='block max-w-sm truncate font-mono text-xs'>
            {Object.entries(row.original.labels)
              .map(([key, value]) => `${key}=${value}`)
              .join(', ') || '—'}
          </span>
        ),
      },
    ],
    [prometheusTargets]
  )
  const servers = useQuery({
    queryKey: ['cloud', project.id, 'servers'],
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Page<ServerRow>>('/cloud/servers', {
          params: { page_size: 200 }, signal,
        })
      ).data,
  })
  const serverInventory = useQuery({
    queryKey: ['cloud', project.id, 'server-inventory'],
    enabled: showSnapshotDetails,
    queryFn: async ({ signal }) =>
      (await apiClient.get<Page<ServerInventoryRow>>('/cloud/server-inventory', { signal }))
        .data,
  })
  const inventoryByServerId = useMemo(
    () =>
      new Map(
        (serverInventory.data?.items ?? []).map((item) => [
          item.server_id,
          item,
        ])
      ),
    [serverInventory.data]
  )
  const serverSecurityDetail = useQuery({
    queryKey: [
      'cloud',
      project.id,
      'server-security-groups',
      securityRulesServer?.id,
    ],
    enabled: Boolean(securityRulesServer),
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Record<string, unknown>>(
          `/cloud/servers/${securityRulesServer!.id}`, { signal }
        )
      ).data,
  })
  const securityGroups = useQuery({
    queryKey: ['cloud', project.id, 'security-groups'],
    enabled: Boolean(securityRulesServer),
    queryFn: async ({ signal }) =>
      (await apiClient.get<SecurityGroupOption[]>('/cloud/security-groups', { signal }))
        .data,
  })
  const attachedSecurityGroups = useMemo(() => {
    const attached = serverSecurityDetail.data?.security_groups
    const values = Array.isArray(attached)
      ? attached
      : attached
        ? [attached]
        : []
    const ids = new Set(values.map(securityGroupId).filter(Boolean))
    const names = new Set(
      values
        .filter((value): value is Record<string, unknown> =>
          Boolean(value && typeof value === 'object')
        )
        .map((value) => String(value.display_name ?? value.name ?? ''))
        .filter(Boolean)
    )
    return (securityGroups.data ?? []).filter(
      (group) =>
        ids.has(group.id) ||
        names.has(group.display_name ?? '') ||
        names.has(group.name)
    )
  }, [securityGroups.data, serverSecurityDetail.data])
  const securityRules = useQuery({
    queryKey: [
      'cloud',
      project.id,
      'server-security-group-rules',
      securityRulesServer?.id,
      securityRuleGroupId,
      securityRuleDirection,
    ],
    enabled:
      Boolean(securityRulesServer) &&
      attachedSecurityGroups.length > 0 &&
      Boolean(securityRuleGroupId) &&
      !serverSecurityDetail.isLoading,
    queryFn: async ({ signal }) => {
      const groupIds =
        securityRuleGroupId === '__all__'
          ? attachedSecurityGroups.map((group) => group.id)
          : [securityRuleGroupId]
      const responses = await Promise.all(
        groupIds.map(async (groupId) => {
          const { data } = await apiClient.get<ServerSecurityRule[]>(
            `/cloud/security-groups/${groupId}/rules`,
            { params: { direction: securityRuleDirection }, signal }
          )
          return data.map((rule) => ({
            ...rule,
            security_group: rule.security_group ?? groupId,
          }))
        })
      )
      return responses.flat()
    },
  })
  const refreshServerSecurityRules = async () => {
    await queryClient.invalidateQueries({
      queryKey: ['cloud', project.id, 'server-security-group-rules'],
    })
  }
  const deleteSecurityRules = useMutation({
    mutationFn: async (rules: ServerSecurityRule[]) => {
      await Promise.all(
        rules.map((rule) => {
          const groupId = securityGroupId(rule.security_group)
          if (!groupId) throw new Error('The rule security group is unknown.')
          return apiClient.delete(
            `/cloud/security-groups/${groupId}/rules/${rule.id}`
          )
        })
      )
    },
    onSuccess: async (_data, rules) => {
      setSecurityRuleDeleteItems([])
      await refreshServerSecurityRules()
      toast.success(`${rules.length} firewall rule(s) deleted.`)
    },
    onError: () => toast.error('Could not delete one or more firewall rules.'),
  })
  useEffect(() => {
    if (!attachedSecurityGroups.length) return
    if (
      !securityRuleGroupId ||
      (securityRuleGroupId !== '__all__' &&
        !attachedSecurityGroups.some(
          (group) => group.id === securityRuleGroupId
        ))
    )
      setSecurityRuleGroupId(attachedSecurityGroups[0].id)
  }, [attachedSecurityGroups, securityRuleGroupId])
  const profiles = useQuery({
    queryKey: ['password-profiles'],
    queryFn: async ({ signal }) =>
      (await apiClient.get<Profile[]>('/password-profiles', { signal })).data,
  })
  const exportTerraformTemplate = async (targets: ServerRow[]) => {
    if (!targets.length) return
    setTerraformExporting(true)
    try {
      const failures: string[] = []
      for (let start = 0; start < targets.length; start += 20) {
        const batch = targets.slice(start, start + 20)
        const { data } = await apiClient.post<{
          items?: Array<{ server_id: string; status: string; error?: string }>
        }>(
          '/cloud/server-inventory/refresh',
          { server_ids: batch.map((server) => server.id) },
          { timeout: 60_000 }
        )
        for (const item of data.items ?? []) {
          if (item.status !== 'succeeded') {
            failures.push(item.error || item.server_id)
          }
        }
      }
      if (failures.length) {
        throw new Error(
          `Could not refresh ${failures.length} selected server(s): ${failures.slice(0, 3).join('; ')}`
        )
      }
      const { data: inventory } = await apiClient.get<Page<ServerInventoryRow>>(
        '/cloud/server-inventory'
      )
      const inventoryByServerId = new Map(
        inventory.items.map((item) => [item.server_id, item])
      )
      const missing = targets.filter(
        (server) => !inventoryByServerId.has(server.id)
      )
      if (missing.length) {
        throw new Error(
          `No inventory detail was returned for: ${missing.map((item) => item.name).join(', ')}`
        )
      }
      const rows = targets.map((server) =>
        terraformTemplateRowFromInventory(
          inventoryByServerId.get(server.id)!,
          server
        )
      )
      const invalid = rows
        .map((row, index) => {
          const required = [
            ['ZONE', row[2]],
            ['PUBLIC IMAGE', row[7]],
            ['KEY PAIR', row[8]],
            ['SUBNET', row[14]],
            ['SECURITY GROUPS', row[16]],
          ].filter(([, value]) => !String(value ?? '').trim())
          return required.length
            ? `${targets[index].name}: ${required.map(([field]) => field).join(', ')}`
            : ''
        })
        .filter(Boolean)
      if (invalid.length) {
        throw new Error(
          `Terraform template is incomplete. Refresh/map these server(s) in Inventory first: ${invalid.join('; ')}`
        )
      }
      const projectLabel = (project.name || project.id).replace(
        /[^a-zA-Z0-9._-]+/g,
        '-'
      )
      downloadXlsx(
        [...terraformTemplateHeaders],
        rows,
        `terraform-server-template-${projectLabel}.xlsx`,
        {
          title: 'TERRAFORM SERVER CREATION TEMPLATE',
          metadata: [
            { label: 'Project', value: project.name || project.id },
            {
              label: 'Source',
              value: `${targets.length} selected server(s), refreshed from Cloud API before export. Existing private IPs are exported as Auto Allocate; existing Elastic IPs are exported as Auto Allocate.`,
            },
          ],
          sheetName: 'Servers',
        }
      )
      toast.success(
        `Terraform template exported for ${targets.length} server(s).`
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `Could not export Terraform template: ${error.message}`
          : 'Could not export Terraform template.'
      )
    } finally {
      setTerraformExporting(false)
    }
  }
  const renameItems = renameLines
    .split('\n')
    .map((line) => line.split(',').map((value) => value.trim()))
    .filter(
      (pair) =>
        pair.length >= 2 &&
        selectedServers.some((server) => server.id === pair[0])
    )
    .map(([server_id, new_name]) => ({ server_id, new_name }))
  const regenerateRandomPasswords = (
    targets = selectedServers,
    length = randomPasswordLength
  ) => {
    setRandomPasswords(
      Object.fromEntries(
        targets.map((server) => [server.id, randomServerPassword(length)])
      )
    )
  }
  const passwordReady =
    passwordMode === 'profile'
      ? Boolean(profileId)
      : passwordMode === 'manual'
        ? validServerPassword(manualPassword)
        : selectedServers.length > 0 &&
          selectedServers.every((server) =>
            validServerPassword(randomPasswords[server.id] ?? '')
          )

  const changePasswordsIndividually = async () => {
    const targets = [...selectedServers]
    if (!targets.length) return

    const results = new Map<string, ServerOperationResult>()
    const updateResult = (serverId: string, next: ServerOperationResult) => {
      results.set(serverId, next)
      setPasswordResults(
        targets.map(
          (server) =>
            results.get(server.id) ?? {
              server_id: server.id,
              name: server.name,
              status: 'queued',
            }
        )
      )
    }

    setChangingPasswords(true)
    targets.forEach((server) =>
      results.set(server.id, {
        server_id: server.id,
        name: server.name,
        status: 'queued',
      })
    )
    setPasswordResults(targets.map((server) => results.get(server.id)!))

    let nextTargetIndex = 0
    const runWorker = async () => {
      while (nextTargetIndex < targets.length) {
        const server = targets[nextTargetIndex++]
        updateResult(server.id, {
          server_id: server.id,
          name: server.name,
          status: 'processing',
          ...(passwordMode === 'random'
            ? { password: randomPasswords[server.id] }
            : {}),
        })
        try {
          const body =
            passwordMode === 'random'
              ? {
                  password_items: [
                    {
                      server_id: server.id,
                      password: randomPasswords[server.id],
                    },
                  ],
                }
              : {
                  server_ids: [server.id],
                  ...(passwordMode === 'profile'
                    ? { profile_id: profileId }
                    : { password: manualPassword }),
                }
          const { data } = await apiClient.post<{
            items?: ServerOperationResult[]
          }>('/cloud/servers/change-password', body, { timeout: 45_000 })
          const outcome = data.items?.[0]
          updateResult(server.id, {
            server_id: server.id,
            name: server.name,
            status: outcome?.status ?? 'unconfirmed',
            error:
              outcome?.error ??
              (!outcome
                ? 'The API returned no result for this VM.'
                : undefined),
            error_detail: outcome?.error_detail,
            ...(passwordMode === 'random'
              ? { password: randomPasswords[server.id] }
              : {}),
          })
        } catch (error) {
          updateResult(server.id, {
            server_id: server.id,
            name: server.name,
            status: 'failed',
            error: passwordChangeErrorMessage(error),
            error_detail:
              error instanceof AxiosError ? error.response?.data : undefined,
            ...(passwordMode === 'random'
              ? { password: randomPasswords[server.id] }
              : {}),
          })
        }
      }
    }

    try {
      await Promise.all(
        Array.from(
          { length: Math.min(PASSWORD_CHANGE_CONCURRENCY, targets.length) },
          () => runWorker()
        )
      )
      const failed = Array.from(results.values()).filter((result) =>
        ['failed', 'unconfirmed'].includes(result.status)
      ).length
      toast[failed ? 'warning' : 'success'](
        failed
          ? `Password changes finished: ${targets.length - failed} succeeded, ${failed} failed.`
          : `Password changes submitted for ${targets.length} server(s).`
      )
    } finally {
      setChangingPasswords(false)
    }
  }
  const availableExportFields = useMemo(
    () =>
      Array.from(
        new Set([
          ...defaultServerExportFields,
          ...(servers.data?.items.flatMap((server) => Object.keys(server)) ??
            []),
        ])
      ).sort(),
    [servers.data]
  )
  const resultColumns = useMemo<ColumnDef<ServerOperationResult>[]>(
    () => [
      {
        accessorKey: 'server_id',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server ID' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'status',
        header: ({ column }) => (
          <SortableHeader column={column} title='Status' />
        ),
      },
      {
        accessorKey: 'name',
        header: ({ column }) => <SortableHeader column={column} title='Name' />,
        cell: ({ getValue }) => {
          const error = getValue() as string | undefined
          return error ? (
            <p className='max-w-96 text-xs leading-5 break-words text-red-600 dark:text-red-400'>
              {error}
            </p>
          ) : (
            '—'
          )
        },
      },
      {
        accessorKey: 'password',
        header: ({ column }) => (
          <SortableHeader column={column} title='New password' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>
            {(getValue() as string | undefined) || '—'}
          </span>
        ),
      },
      {
        accessorKey: 'error',
        header: ({ column }) => (
          <SortableHeader column={column} title='Error' />
        ),
        cell: ({ getValue }) => (
          <span className='text-destructive'>
            {(getValue() as string | undefined) || '—'}
          </span>
        ),
      },
      {
        id: 'actions',
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions id={row.original.server_id} label='server ID' />
        ),
      },
    ],
    []
  )
  const powerResultColumns = useMemo<ColumnDef<ServerPowerResult>[]>(
    () => [
      {
        accessorKey: 'server_id',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server ID' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server' />
        ),
        cell: ({ getValue }) => (getValue() as string | undefined) || '—',
      },
      {
        accessorKey: 'status',
        header: ({ column }) => (
          <SortableHeader column={column} title='Result' />
        ),
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.status === 'failed' ? 'destructive' : 'secondary'
            }
          >
            {row.original.status === 'failed' ? 'Failed' : 'Success'}
          </Badge>
        ),
      },
      {
        accessorKey: 'error',
        header: ({ column }) => (
          <SortableHeader column={column} title='Detail' />
        ),
        cell: ({ row }) =>
          row.original.error ? (
            <p className='max-w-lg text-xs leading-5 break-words whitespace-pre-wrap text-destructive'>
              {upstreamDetailOrFullError(
                row.original.error_detail,
                row.original.error
              )}
            </p>
          ) : (
            <span className='text-xs text-muted-foreground'>
              Request accepted by Cloud API.
            </span>
          ),
      },
    ],
    []
  )
  const confirmWarningAction = async () => {
    try {
      if (warningAction === 'password') {
        setWarningAction(undefined)
        await changePasswordsIndividually()
        setProfileId('')
        setManualPassword('')
      }
      if (warningAction === 'rename') {
        const data = (await execute({
          title: 'Rename servers in bulk',
          desc: `${renameItems.length} valid name changes will be applied.`,
          path: '/cloud/servers/rename',
          body: { items: renameItems },
        })) as { items?: ServerOperationResult[] }
        setRenameResults(data.items ?? [])
        setRenameLines('')
      }
      if (warningAction === 'start' || warningAction === 'stop') {
        const action = warningAction
        const data = (await execute({
          title: `${action === 'start' ? 'Start' : 'Stop'} servers in bulk`,
          desc: `${selectedServers.length} selected server(s) will be processed independently.`,
          path: '/cloud/servers/power',
          body: {
            action,
            server_ids: selectedServers.map((server) => server.id),
          },
        })) as { items?: ServerPowerResult[] }
        const results = data.items ?? []
        setPowerAction(action)
        setPowerResults(results)
        setPowerOpen(true)
        const failed = results.filter((item) => item.status === 'failed').length
        if (failed)
          toast.warning(
            `${failed} server(s) failed. Review the detailed results.`
          )
      }
      setWarningAction(undefined)
      clearBulkSelection()
    } catch {
      // The mutation displays the API error and keeps the warning open.
    }
  }
  const openDeleteServers = async (targets: ServerRow[], clear: () => void) => {
    setSelectedServers(targets)
    setClearBulkSelection(() => clear)
    setDeleteResults([])
    setDeleteDrafts(targets.map((server) => serverDeleteResources(server, {})))
    setDeleteOpen(true)
    setDeleteLoading(true)
    try {
      const details: ServerDeleteDraft[] = []
      for (let index = 0; index < targets.length; index += 3) {
        const batch = await Promise.all(
          targets.slice(index, index + 3).map(async (server) => {
            try {
              const { data } = await apiClient.get<Record<string, unknown>>(
                `/cloud/servers/${server.id}`
              )
              return serverDeleteResources(server, data)
            } catch {
              return serverDeleteResources(server, {})
            }
          })
        )
        details.push(...batch)
      }
      setDeleteDrafts(details)
    } finally {
      setDeleteLoading(false)
    }
  }
  const updateDeleteDraft = (
    serverId: string,
    key: 'selected_volumes' | 'selected_eips' | 'selected_private_ips',
    id: string,
    checked: boolean
  ) => {
    setDeleteDrafts((current) =>
      current.map((draft) =>
        draft.server_id !== serverId
          ? draft
          : {
              ...draft,
              [key]: checked
                ? [...new Set([...draft[key], id])]
                : draft[key].filter((value) => value !== id),
            }
      )
    )
  }
  const setDeleteColumnSelection = (
    key: 'volumes' | 'eips' | 'private_ips',
    checked: boolean
  ) => {
    const selectedKey = `selected_${key}` as
      'selected_volumes' | 'selected_eips' | 'selected_private_ips'
    setDeleteDrafts((current) =>
      current.map((draft) => ({
        ...draft,
        [selectedKey]: checked ? draft[key].map((item) => item.id) : [],
      }))
    )
  }
  const setAllDeleteAttachments = (checked: boolean) => {
    setDeleteDrafts((current) =>
      current.map((draft) => ({
        ...draft,
        selected_volumes: checked ? draft.volumes.map((item) => item.id) : [],
        selected_eips: checked ? draft.eips.map((item) => item.id) : [],
        selected_private_ips: checked
          ? draft.private_ips.map((item) => item.id)
          : [],
      }))
    )
  }
  const deleteResultColumns = useMemo<ColumnDef<ServerOperationResult>[]>(
    () => [
      {
        accessorKey: 'server_id',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server ID' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server' />
        ),
        cell: ({ getValue }) => (getValue() as string | undefined) || '—',
      },
      {
        accessorKey: 'status',
        header: ({ column }) => (
          <SortableHeader column={column} title='Result' />
        ),
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.status === 'failed' ? 'destructive' : 'outline'
            }
            className={
              ['queued', 'processing', 'unconfirmed'].includes(
                row.original.status
              )
                ? 'border-amber-500 text-amber-700 dark:text-amber-400'
                : ['accepted', 'completed'].includes(row.original.status)
                  ? 'border-emerald-500 text-emerald-700 dark:text-emerald-400'
                  : ''
            }
          >
            {row.original.status === 'processing' && (
              <Loader2 className='size-3 animate-spin' />
            )}
            {(
              {
                queued: 'Queued',
                processing: 'Deleting...',
                accepted: 'Accepted',
                completed: 'Completed',
                failed: 'Failed',
                unconfirmed: 'Unconfirmed',
              } as Record<string, string>
            )[row.original.status] || row.original.status}
          </Badge>
        ),
      },
      {
        accessorKey: 'error',
        header: ({ column }) => (
          <SortableHeader column={column} title='Detail' />
        ),
        cell: ({ row }) =>
          row.original.error ? (
            <p className='max-w-lg text-xs leading-5 break-words whitespace-pre-wrap text-destructive'>
              {upstreamDetailOrFullError(
                row.original.error_detail,
                row.original.error
              )}
            </p>
          ) : (
            <span className='text-xs text-muted-foreground'>
              {row.original.status === 'queued'
                ? 'Waiting to submit.'
                : row.original.status === 'processing'
                  ? 'Waiting for Cloud API...'
                  : 'Deletion request accepted by Cloud API.'}
            </span>
          ),
      },
    ],
    []
  )
  const columns = useMemo<ColumnDef<ServerRow>[]>(() => {
    const snapshotColumns: ColumnDef<ServerRow>[] = showSnapshotDetails
      ? [
          {
            id: 'snapshot_os_image',
            accessorFn: (server) =>
              inventoryBoot(inventoryByServerId.get(server.id)?.snapshot ?? {}),
            header: ({ column }) => (
              <SortableHeader column={column} title='OS image' />
            ),
            cell: ({ row }) => {
              const inventory = inventoryByServerId.get(row.original.id)
              if (!inventory)
                return snapshotUnavailable(serverInventory.isLoading)
              const image = inventoryBoot(inventory.snapshot)
              return (
                <span className='block max-w-48 truncate text-xs' title={image}>
                  {image || '-'}
                </span>
              )
            },
          },
          {
            id: 'snapshot_security_groups',
            accessorFn: (server) =>
              inventoryReference(
                inventoryByServerId.get(server.id)?.snapshot ?? {},
                'security_groups'
              ),
            header: ({ column }) => (
              <SortableHeader column={column} title='Security groups' />
            ),
            cell: ({ row }) => {
              const inventory = inventoryByServerId.get(row.original.id)
              if (!inventory)
                return snapshotUnavailable(serverInventory.isLoading)
              const groups = inventoryReferenceLines(
                inventory.snapshot,
                'security_groups'
              )
              return groups.length ? (
                <div className='max-w-52 text-xs leading-5'>
                  {groups.map((group) => (
                    <p key={group} className='truncate' title={group}>
                      {group}
                    </p>
                  ))}
                </div>
              ) : (
                <span className='text-xs text-muted-foreground'>—</span>
              )
            },
          },
          {
            id: 'snapshot_private_subnet',
            accessorFn: (server) =>
              inventoryLines(
                inventoryByServerId.get(server.id)?.private_subnets
              ).join(' '),
            header: ({ column }) => (
              <SortableHeader column={column} title='Private subnet' />
            ),
            cell: ({ row }) => {
              const inventory = inventoryByServerId.get(row.original.id)
              if (!inventory)
                return snapshotUnavailable(serverInventory.isLoading)
              const subnets = inventoryLines(inventory.private_subnets)
              return subnets.length ? (
                <div className='max-w-48 text-xs leading-5'>
                  {subnets.map((subnet) => (
                    <p key={subnet} className='truncate' title={subnet}>
                      {subnet}
                    </p>
                  ))}
                </div>
              ) : (
                <span className='text-xs text-muted-foreground'>—</span>
              )
            },
          },
        ]
      : []

    return [
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
        accessorKey: 'id',
        meta: { className: 'w-12 max-w-12 px-1.5' },
        header: () => <span className='block w-9'>ID</span>,
        cell: ({ row }) => (
          <span
            className='block w-9 truncate font-mono text-xs text-muted-foreground'
            title={row.original.id}
          >
            {row.original.id}
          </span>
        ),
      },
      {
        accessorKey: 'name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server' />
        ),
        cell: ({ row }) => <p className='font-medium'>{row.original.name}</p>,
      },
      {
        id: 'elastic_ip',
        accessorFn: (row) =>
          (row.elastic_ip ?? []).map((ip) => ip.ip_address).join(', '),
        header: ({ column }) => (
          <SortableHeader column={column} title='Elastic IP' />
        ),
        cell: ({ row }) => (
          <IpAddressList addresses={row.original.elastic_ip} />
        ),
      },
      {
        id: 'private_ip',
        accessorFn: (row) =>
          (row.private_ip ?? []).map((ip) => ip.ip_address).join(', '),
        header: ({ column }) => (
          <SortableHeader column={column} title='Private IP' />
        ),
        cell: ({ row }) => (
          <IpAddressList addresses={row.original.private_ip} />
        ),
      },
      {
        id: 'vip_ip',
        accessorFn: (row) => serverVipAddresses(row).join(', '),
        header: ({ column }) => (
          <SortableHeader column={column} title='VIP IP' />
        ),
        cell: ({ row }) => {
          const addresses = serverVipAddresses(row.original)
          return addresses.length ? (
            <div className='space-y-1 font-mono text-sm'>
              {addresses.map((address, index) => (
                <p key={`${address}-${index}`} className='whitespace-nowrap'>
                  {address}
                </p>
              ))}
            </div>
          ) : (
            <span className='text-muted-foreground'>-</span>
          )
        },
      },
      {
        accessorKey: 'server_type',
        header: ({ column }) => <SortableHeader column={column} title='Type' />,
      },
      {
        accessorKey: 'zone_display_name',
        header: ({ column }) => <SortableHeader column={column} title='Zone' />,
      },
      {
        accessorKey: 'bandwidth',
        header: ({ column }) => (
          <SortableHeader column={column} title='Bandwidth' />
        ),
        cell: ({ getValue }) => (getValue() as number | undefined) ?? 'â€”',
      },
      {
        accessorKey: 'power_state',
        header: ({ column }) => (
          <SortableHeader column={column} title='Power state' />
        ),
        cell: ({ getValue }) => {
          const state = String(getValue() || 'unknown').toLowerCase()
          const tone =
            state === 'running'
              ? 'text-emerald-600 dark:text-emerald-400'
              : ['shutdown', 'shutoff', 'stopped', 'suspended'].includes(state)
                ? 'text-muted-foreground'
                : ['paused', 'shelved', 'rescue'].includes(state)
                  ? 'text-amber-600 dark:text-amber-400'
                  : ['error', 'failed'].includes(state)
                    ? 'text-destructive'
                    : 'text-sky-600 dark:text-sky-400'
          return (
            <span
              className={`rounded border border-current px-2 py-0.5 text-xs font-medium capitalize ${tone}`}
            >
              {state}
            </span>
          )
        },
      },
      ...snapshotColumns,
      {
        id: 'actions',
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions id={row.original.id} label='server ID'>
            <DropdownMenuItem onClick={() => setViewServer(row.original)}>
              <Eye />
              View details
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setSecurityRuleGroupId('')
                setSecurityRuleDirection('all')
                setSecurityRulesServer(row.original)
              }}
            >
              <ShieldCheck />
              View security groups
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem
                onClick={() => {
                  setSingleRenameServer(row.original)
                  setSingleRenameName(row.original.name)
                }}
              >
                <Pencil />
                Rename server
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={async () => {
                try {
                  const { data } = await apiClient.post<{ url: string }>(
                    `/cloud/servers/${row.original.id}/console`
                  )
                  window.open(data.url, '_blank', 'noopener,noreferrer')
                } catch {
                  toast.error('The server console could not be opened.')
                }
              }}
            >
              <ExternalLink />
              Open console
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                window.open(
                  `/console-mobile?server_id=${encodeURIComponent(row.original.id)}&project_id=${encodeURIComponent(project.id)}`,
                  '_blank',
                  'noopener,noreferrer'
                )
              }
            >
              <MonitorPlay />
              Open mobile console
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setTeleportSshServer(row.original)}
            >
              <Terminal />
              Open in Teleport
            </DropdownMenuItem>
          </RowActions>
        ),
      },
    ]
  }, [
    inventoryByServerId,
    isAdmin,
    serverInventory.isLoading,
    showSnapshotDetails,
  ])
  const exportedBy = user
    ? user.full_name
      ? `${user.full_name} (${user.email})`
      : user.email
    : 'Unknown user'

  return (
    <CloudPageShell
      title='Servers'
      description='Search, sort and manage every server in the selected project.'
      tableHelp
      help={
        <p className='text-muted-foreground'>
          Server operations are scoped to the active project. Select one or more
          rows to change passwords, rename servers, copy selected columns or
          export only the selected resources.
        </p>
      }
      actions={
        <>
          <Button variant='outline' onClick={() => setInventoryOpen(true)}>
            <RefreshCw />
            Inventory
          </Button>
          <Button variant='outline' onClick={() => setExportOpen(true)}>
            <Download />
            Full XLSX
          </Button>
          <Button
            variant={showSnapshotDetails ? 'secondary' : 'outline'}
            size='icon'
            aria-label='Toggle snapshot details'
            aria-pressed={showSnapshotDetails}
            onClick={() => setShowSnapshotDetails((current) => !current)}
            title={
              showSnapshotDetails
                ? 'Hide snapshot details'
                : 'Show snapshot details'
            }
          >
            {showSnapshotDetails ? <EyeOff /> : <Eye />}
          </Button>
        </>
      }
    >
      <Card>
        <CardContent>
          <CloudDataTable
            data={servers.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={servers.isLoading}
            entityName='server'
            exportFileName={`servers-${project.id}`}
            searchPlaceholder='Search by name, ID, IP, type or zone...'
            toolbar={(selected, clear) => {
              return (
                <>
                  {canManageBulkServers && (
                    <>
                      <Button
                        className='bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-700'
                        size='icon'
                        title='Start selected servers'
                        aria-label='Start selected servers'
                        disabled={!selected.length}
                        onClick={() => {
                          setSelectedServers(selected)
                          setClearBulkSelection(() => clear)
                          setPowerConfirmationText('')
                          setWarningAction('start')
                        }}
                      >
                        <Play />
                      </Button>
                      <Button
                        className='bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-500 dark:hover:bg-amber-600'
                        size='icon'
                        title='Stop selected servers'
                        aria-label='Stop selected servers'
                        disabled={!selected.length}
                        onClick={() => {
                          setSelectedServers(selected)
                          setClearBulkSelection(() => clear)
                          setPowerConfirmationText('')
                          setWarningAction('stop')
                        }}
                      >
                        <Square />
                      </Button>
                      <Button
                        variant='destructive'
                        size='icon'
                        title='Delete selected servers'
                        aria-label='Delete selected servers'
                        disabled={!selected.length}
                        onClick={() => void openDeleteServers(selected, clear)}
                      >
                        <Trash2 />
                      </Button>
                      <Button
                        variant='outline'
                        onClick={() => {
                          setSelectedServers(selected)
                          setMultiConsoleOpen(true)
                        }}
                      >
                        <MonitorPlay />
                        Console
                      </Button>
                      <Button
                        variant='outline'
                        onClick={() => {
                          setSelectedServers(selected)
                          setClearBulkSelection(() => clear)
                          setPasswordResults([])
                          setPasswordMode('profile')
                          setProfileId('')
                          setManualPassword('')
                          setRandomPasswords({})
                          setShowPasswords(false)
                          setPasswordOpen(true)
                        }}
                      >
                        <KeyRound />
                        Password
                      </Button>
                      <Button
                        variant='outline'
                        disabled={!selected.length}
                        onClick={() => {
                          setSelectedServers(selected)
                          setClearBulkSelection(() => clear)
                          setRenameResults([])
                          setRenameLines(
                            selected
                              .map((row) => `${row.id},${row.name}`)
                              .join('\n')
                          )
                          setRenameOpen(true)
                        }}
                      >
                        <Pencil />
                        Rename
                      </Button>
                      <Button
                        variant='outline'
                        disabled={!selected.length}
                        onClick={() =>
                          setBulkSecurityGroups({
                            servers: [...selected],
                            projectId: project.id,
                            projectName: project.name,
                          })
                        }
                      >
                        <ShieldCheck /> SG
                      </Button>
                      <Button
                        variant='outline'
                        disabled={!selected.length}
                        onClick={() => {
                          setVolumeAttachmentTargets(selected)
                          setVolumeAttachmentOpen(true)
                        }}
                      >
                        <HardDrive />
                        Volumes
                      </Button>
                      <Button
                        variant='outline'
                        disabled={!selected.length}
                        onClick={() => {
                          setResizeTargets(selected)
                          setResizeOpen(true)
                        }}
                      >
                        <Maximize2 />
                        Resize
                      </Button>
                    </>
                  )}
                  {!canManageBulkServers && (
                    <Button
                      variant='outline'
                      onClick={() => {
                        setSelectedServers(selected)
                        setMultiConsoleOpen(true)
                      }}
                    >
                      <MonitorPlay />
                      Console
                    </Button>
                  )}
                  <Button
                    variant='outline'
                    disabled={!selected.length || terraformExporting}
                    onClick={() => void exportTerraformTemplate(selected)}
                  >
                    {terraformExporting ? (
                      <Loader2 className='animate-spin' />
                    ) : (
                      <Download />
                    )}
                    Terraform
                  </Button>
                  {canAttachPrivateIps && (
                    <Button
                      variant='outline'
                      onClick={() => {
                        setSelectedServers(selected)
                        setAttachPrivateIpsOpen(true)
                      }}
                    >
                      <Link2 />
                      Private IPs
                    </Button>
                  )}
                  {canAttachPrivateIps && (
                    <Button
                      variant='outline'
                      onClick={() => {
                        setSelectedServers(selected)
                        setElasticIpOpen(true)
                      }}
                    >
                      <Link2 />
                      Elastic IPs
                    </Button>
                  )}
                  <Button
                    variant='outline'
                    onClick={() => {
                      setSelectedServers(selected)
                      setClearBulkSelection(() => clear)
                      setCopyOpen(true)
                    }}
                  >
                    <Copy />
                    Copy
                  </Button>
                  <Button
                    variant='outline'
                    disabled={!selected.length}
                    onClick={() => {
                      setPrometheusTargets(selected)
                      setPrometheusResults([])
                      setPrometheusOpen(true)
                    }}
                  >
                    <MonitorPlay />
                    Prometheus
                  </Button>
                  <Button
                    variant='outline'
                    disabled={!selected.length}
                    onClick={() => {
                      setTeleportTargets(selected)
                      setTeleportResults([])
                      setTeleportSelectedIps({})
                      setTeleportOpen(true)
                    }}
                  >
                    <MonitorPlay />
                    Teleport
                  </Button>
                </>
              )
            }}
          />
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(securityRulesServer)}
        onOpenChange={(open) => !open && setSecurityRulesServer(undefined)}
      >
        <ServerSecurityGroupsContent
          serverId={securityRulesServer?.id ?? ''}
          serverName={securityRulesServer?.name ?? ''}
          groups={attachedSecurityGroups}
          rules={securityRules.data ?? []}
          group={securityRuleGroupId}
          direction={securityRuleDirection}
          onGroupChange={setSecurityRuleGroupId}
          onDirectionChange={setSecurityRuleDirection}
          loading={serverSecurityDetail.isLoading || securityGroups.isLoading}
          rulesLoading={securityRules.isLoading}
          error={
            serverSecurityDetail.isError ||
            securityGroups.isError ||
            securityRules.isError
          }
          onRefresh={() => {
            void serverSecurityDetail.refetch()
            void securityGroups.refetch()
            void refreshServerSecurityRules()
          }}
          refreshing={
            serverSecurityDetail.isFetching ||
            securityGroups.isFetching ||
            securityRules.isFetching
          }
          actions={
            <Button
              size='sm'
              disabled={!attachedSecurityGroups.length}
              onClick={() => {
                setSecurityRuleInitialGroupId(
                  securityRuleGroupId === '__all__'
                    ? (attachedSecurityGroups[0]?.id ?? '')
                    : securityRuleGroupId ||
                        (attachedSecurityGroups[0]?.id ?? '')
                )
                setSecurityRuleCreateOpen(true)
              }}
            >
              <Plus /> Add rule
            </Button>
          }
          toolbar={(selected) => (
            <Button
              variant='destructive'
              size='sm'
              disabled={!selected.length}
              onClick={() => setSecurityRuleDeleteItems(selected)}
            >
              <Trash2 /> Delete {selected.length} rule(s)
            </Button>
          )}
        />
      </Dialog>

      {securityRuleCreateOpen && (
        <ServerSecurityRuleCreateDialog
          open
          onClose={() => setSecurityRuleCreateOpen(false)}
          projectId={project.id}
          projectName={project.name}
          serverName={securityRulesServer?.name ?? ''}
          groups={attachedSecurityGroups}
          initialGroupId={securityRuleInitialGroupId}
        />
      )}

      <AlertDialog
        open={Boolean(securityRuleDeleteItems.length)}
        onOpenChange={(open) =>
          !open &&
          !deleteSecurityRules.isPending &&
          setSecurityRuleDeleteItems([])
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete selected firewall rules?</AlertDialogTitle>
            <AlertDialogDescription>
              {securityRuleDeleteItems.length} selected rule(s) will be removed
              from their security group(s). This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteSecurityRules.isPending}>
              Cancel
            </AlertDialogCancel>
            <Button
              variant='destructive'
              disabled={deleteSecurityRules.isPending}
              onClick={() =>
                deleteSecurityRules.mutate(securityRuleDeleteItems)
              }
            >
              {deleteSecurityRules.isPending && (
                <Loader2 className='animate-spin' />
              )}
              Delete rules
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ServerInventoryDialog
        open={inventoryOpen}
        onOpenChange={setInventoryOpen}
      />
      <ServerResizeDialog
        open={resizeOpen}
        targets={resizeTargets}
        onOpenChange={setResizeOpen}
      />
      <ServerVolumeAttachmentDialog
        open={volumeAttachmentOpen}
        targets={volumeAttachmentTargets}
        onOpenChange={setVolumeAttachmentOpen}
      />

      <ServerDetailsDialog
        key={`${project.id}-${viewServer?.id ?? ''}`}
        server={viewServer}
        projectId={project.id}
        onOpenChange={(open) => !open && setViewServer(undefined)}
      />

      <Dialog
        open={Boolean(singleRenameServer)}
        onOpenChange={(open) => {
          if (!open) {
            setSingleRenameServer(undefined)
            setSingleRenameName('')
          }
        }}
      >
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>Rename server</DialogTitle>
            <DialogDescription>
              Enter a new name for {singleRenameServer?.name}. The server is
              identified by ID, so duplicate display names cannot target the
              wrong resource.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-2'>
            <Label htmlFor='single-server-name'>New server name</Label>
            <Input
              id='single-server-name'
              value={singleRenameName}
              onChange={(event) => setSingleRenameName(event.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setSingleRenameServer(undefined)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                isPending ||
                !singleRenameServer ||
                !singleRenameName.trim() ||
                singleRenameName.trim() === singleRenameServer.name
              }
              onClick={async () => {
                if (!singleRenameServer) return
                try {
                  await execute({
                    title: 'Rename server',
                    desc: `Rename ${singleRenameServer.name}.`,
                    path: '/cloud/servers/rename',
                    body: {
                      items: [
                        {
                          server_id: singleRenameServer.id,
                          new_name: singleRenameName.trim(),
                        },
                      ],
                    },
                  })
                  setSingleRenameServer(undefined)
                  setSingleRenameName('')
                } catch {
                  // The mutation displays the API error and keeps the modal open.
                }
              }}
            >
              {isPending ? 'Renaming...' : 'Rename server'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={teleportOpen} onOpenChange={setTeleportOpen}>
        <DialogContent className='!flex h-[92vh] !max-h-[92vh] !w-[96vw] !max-w-[96vw] !flex-col !overflow-hidden sm:!w-[94vw] sm:!max-w-[94vw]'>
          <DialogHeader>
            <DialogTitle>Teleport server check</DialogTitle>
            <DialogDescription>
              Select one private IP for each VM, then verify whether it exists
              in the active Teleport endpoint.
            </DialogDescription>
          </DialogHeader>
          <div className='hidden'>
            <section className='space-y-3 rounded-lg border p-4'>
              <div className='flex items-center justify-between'>
                <h3 className='font-semibold'>Teleport endpoints</h3>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={async () => {
                    if (!teleportForm.name.trim() || !teleportForm.url.trim())
                      return
                    try {
                      await apiClient.post('/teleport-links', teleportForm)
                      setTeleportForm({ name: '', url: '', verify_tls: true })
                      await teleportLinks.refetch()
                      toast.success('Teleport endpoint saved.')
                    } catch (error) {
                      toast.error(
                        error instanceof AxiosError &&
                          typeof error.response?.data?.detail === 'string'
                          ? error.response.data.detail
                          : 'Could not save Teleport endpoint.'
                      )
                    }
                  }}
                >
                  <Plus /> Add endpoint
                </Button>
              </div>
              <div className='grid gap-2 sm:grid-cols-2'>
                <Input
                  placeholder='Endpoint name'
                  value={teleportForm.name}
                  onChange={(event) =>
                    setTeleportForm((value) => ({
                      ...value,
                      name: event.target.value,
                    }))
                  }
                />
                <Input
                  placeholder='https://teleport.example'
                  value={teleportForm.url}
                  onChange={(event) =>
                    setTeleportForm((value) => ({
                      ...value,
                      url: event.target.value,
                    }))
                  }
                />
              </div>
              <label className='flex items-center gap-2 text-sm'>
                <Checkbox
                  checked={teleportForm.verify_tls}
                  onCheckedChange={(value) =>
                    setTeleportForm((current) => ({
                      ...current,
                      verify_tls: value === true,
                    }))
                  }
                />{' '}
                Verify TLS certificate{' '}
                <span className='text-xs text-muted-foreground'>
                  (turn off only for a test/self-signed endpoint)
                </span>
              </label>
              <div className='max-h-48 overflow-auto rounded-md border'>
                {(teleportLinks.data ?? []).map((link) => (
                  <div
                    key={link.id}
                    className='flex items-center justify-between gap-2 border-b px-3 py-2 text-sm'
                  >
                    <button
                      className='min-w-0 truncate text-left hover:underline'
                      onClick={() => setTeleportLinkId(link.id)}
                    >
                      {link.name}{' '}
                      <span className='text-xs text-muted-foreground'>
                        · {link.url}
                      </span>
                    </button>
                    <Button
                      variant='ghost'
                      size='icon'
                      className='size-7 text-destructive'
                      onClick={async () => {
                        await apiClient.delete(`/teleport-links/${link.id}`)
                        if (teleportLinkId === link.id) setTeleportLinkId('')
                        await teleportLinks.refetch()
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            </section>
            <section className='space-y-3 rounded-lg border p-4'>
              <h3 className='font-semibold'>Authenticate for this check</h3>
              <div className='space-y-2'>
                <Label>Endpoint</Label>
                <select
                  className='h-9 w-full rounded-md border bg-background px-2 text-sm'
                  value={teleportLinkId}
                  onChange={(event) => setTeleportLinkId(event.target.value)}
                >
                  <option value=''>Select endpoint</option>
                  {(teleportLinks.data ?? []).map((link) => (
                    <option key={link.id} value={link.id}>
                      {link.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className='space-y-2'>
                <Label>Username</Label>
                <Input
                  autoComplete='username'
                  value={teleportCredentials.username}
                  onChange={(event) =>
                    setTeleportCredentials((value) => ({
                      ...value,
                      username: event.target.value,
                    }))
                  }
                />
              </div>
              <div className='space-y-2'>
                <Label>Password</Label>
                <Input
                  type='password'
                  autoComplete='current-password'
                  value={teleportCredentials.password}
                  onChange={(event) =>
                    setTeleportCredentials((value) => ({
                      ...value,
                      password: event.target.value,
                    }))
                  }
                />
              </div>
              <div className='space-y-2'>
                <Label>Google Authenticator code</Label>
                <Input
                  inputMode='numeric'
                  maxLength={12}
                  value={teleportCredentials.otp}
                  onChange={(event) =>
                    setTeleportCredentials((value) => ({
                      ...value,
                      otp: event.target.value.replace(/\D/g, ''),
                    }))
                  }
                />
              </div>
              <Button
                className='w-full'
                disabled={
                  !teleportLinkId ||
                  !teleportCredentials.username ||
                  !teleportCredentials.password ||
                  teleportCredentials.otp.length < 6 ||
                  teleportChecking
                }
                onClick={async () => {
                  setTeleportChecking(true)
                  try {
                    const { data } = await apiClient.post<TeleportResult[]>(
                      `/teleport-links/${teleportLinkId}/check`,
                      {
                        ...teleportCredentials,
                        server_ips: Object.fromEntries(
                          teleportTargets.map((server) => [
                            server.id,
                            (server.private_ip ?? []).map(
                              (ip) => ip.ip_address
                            ),
                          ])
                        ),
                      }
                    )
                    setTeleportResults(data)
                    toast.success(`Checked ${data.length} server(s).`)
                  } catch (error) {
                    toast.error(
                      error instanceof AxiosError &&
                        typeof error.response?.data?.detail === 'string'
                        ? error.response.data.detail
                        : 'Could not check Teleport.'
                    )
                  } finally {
                    setTeleportChecking(false)
                  }
                }}
              >
                {teleportChecking && <Loader2 className='animate-spin' />} Check{' '}
                {teleportTargets.length} server(s)
              </Button>
            </section>
          </div>
          <section className='rounded-lg border p-4'>
            <div className='grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end'>
              <div className='space-y-1'>
                <Label>Teleport endpoint</Label>
                <select
                  className='h-9 w-full rounded-md border bg-background px-2 text-sm'
                  value={teleportLinkId}
                  onChange={(event) => setTeleportLinkId(event.target.value)}
                >
                  <option value=''>Select endpoint</option>
                  {(teleportLinks.data ?? []).map((link) => (
                    <option key={link.id} value={link.id}>
                      {link.name} — {link.url}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                disabled={
                  !teleportLinkId ||
                  teleportChecking ||
                  !teleportCheckRows.some((row) => row.selectedIp)
                }
                onClick={() => void checkTeleportServers()}
              >
                {teleportChecking && <Loader2 className='animate-spin' />} Check{' '}
                {teleportCheckRows.filter((row) => row.selectedIp).length}{' '}
                server(s)
              </Button>
            </div>
            <p className='mt-2 text-xs text-muted-foreground'>
              {teleportSession.data?.active
                ? 'Active Teleport session — credentials are not required.'
                : 'No active session. Sign in from the separate Teleport session page first.'}
            </p>
          </section>
          <CloudDataTable
            data={teleportCheckRows}
            columns={teleportResultColumns}
            getRowId={(row) => row.server.id}
            fillHeight
            initialPageSize={500}
            entityName='server result'
            exportFileName='teleport-server-check'
            searchPlaceholder='Search VM, private IP, node name or labels...'
            emptyText='No server was selected for this check.'
          />
          <DialogFooter>
            <Button variant='outline' onClick={() => setTeleportOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={teleportManageOpen} onOpenChange={setTeleportManageOpen}>
        <DialogContent className='sm:!max-w-3xl'>
          <DialogHeader>
            <DialogTitle>Manage Teleport endpoints</DialogTitle>
            <DialogDescription>
              Add endpoints and authenticate a session. Credentials and OTP are
              never saved.
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-4 md:grid-cols-2'>
            <section className='space-y-3 rounded-lg border p-4'>
              <h3 className='font-semibold'>Endpoints</h3>
              <Input
                placeholder='Endpoint name'
                value={teleportForm.name}
                onChange={(event) =>
                  setTeleportForm((value) => ({
                    ...value,
                    name: event.target.value,
                  }))
                }
              />
              <Input
                placeholder='https://teleport.example'
                value={teleportForm.url}
                onChange={(event) =>
                  setTeleportForm((value) => ({
                    ...value,
                    url: event.target.value,
                  }))
                }
              />
              <label className='flex items-center gap-2 text-sm'>
                <Checkbox
                  checked={teleportForm.verify_tls}
                  onCheckedChange={(value) =>
                    setTeleportForm((current) => ({
                      ...current,
                      verify_tls: value === true,
                    }))
                  }
                />{' '}
                Verify TLS certificate
              </label>
              <Button
                size='sm'
                onClick={async () => {
                  try {
                    await apiClient.post('/teleport-links', teleportForm)
                    setTeleportForm({ name: '', url: '', verify_tls: true })
                    await teleportLinks.refetch()
                  } catch {
                    toast.error('Could not save Teleport endpoint.')
                  }
                }}
              >
                <Plus /> Save endpoint
              </Button>
              <div className='max-h-44 overflow-auto rounded border'>
                {(teleportLinks.data ?? []).map((link) => (
                  <div
                    key={link.id}
                    className='flex items-center justify-between border-b px-2 py-1.5 text-sm'
                  >
                    <button
                      onClick={() => setTeleportLinkId(link.id)}
                      className='truncate text-left'
                    >
                      {link.name}
                    </button>
                    <Button
                      size='icon'
                      variant='ghost'
                      className='size-7 text-destructive'
                      onClick={async () => {
                        await apiClient.delete(`/teleport-links/${link.id}`)
                        await teleportLinks.refetch()
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            </section>
            <section className='space-y-3 rounded-lg border p-4'>
              <h3 className='font-semibold'>Sign in</h3>
              <select
                className='h-9 w-full rounded-md border bg-background px-2 text-sm'
                value={teleportLinkId}
                onChange={(event) => setTeleportLinkId(event.target.value)}
              >
                <option value=''>Select endpoint</option>
                {(teleportLinks.data ?? []).map((link) => (
                  <option key={link.id} value={link.id}>
                    {link.name}
                  </option>
                ))}
              </select>
              <Input
                placeholder='Username'
                value={teleportCredentials.username}
                onChange={(event) =>
                  setTeleportCredentials((value) => ({
                    ...value,
                    username: event.target.value,
                  }))
                }
              />
              <Input
                type='password'
                placeholder='Password'
                value={teleportCredentials.password}
                onChange={(event) =>
                  setTeleportCredentials((value) => ({
                    ...value,
                    password: event.target.value,
                  }))
                }
              />
              <Input
                inputMode='numeric'
                placeholder='Google Authenticator code'
                value={teleportCredentials.otp}
                onChange={(event) =>
                  setTeleportCredentials((value) => ({
                    ...value,
                    otp: event.target.value.replace(/\D/g, ''),
                  }))
                }
              />
              <Button
                disabled={
                  !teleportLinkId ||
                  !teleportCredentials.username ||
                  !teleportCredentials.password ||
                  teleportCredentials.otp.length < 6
                }
                onClick={async () => {
                  try {
                    await apiClient.post(
                      `/teleport-links/${teleportLinkId}/check`,
                      { ...teleportCredentials, server_ips: {} }
                    )
                    setTeleportCredentials({
                      username: '',
                      password: '',
                      otp: '',
                    })
                    await teleportSession.refetch()
                    toast.success('Teleport session is active.')
                  } catch {
                    toast.error('Could not authenticate with Teleport.')
                  }
                }}
              >
                Sign in
              </Button>
            </section>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setTeleportManageOpen(false)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={prometheusOpen} onOpenChange={setPrometheusOpen}>
        <DialogContent className='!flex h-[94vh] max-h-[94vh] !flex-col overflow-hidden sm:!max-h-[94vh] sm:!max-w-[95vw]'>
          <DialogHeader className='pr-12'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <div>
                <DialogTitle>Prometheus server check</DialogTitle>
                <DialogDescription>
                  Select a saved link and verify every private IP on the{' '}
                  {prometheusTargets.length} selected server(s).
                </DialogDescription>
              </div>
              <Button
                variant='outline'
                size='sm'
                onClick={() => {
                  setPrometheusForm(emptyPrometheusForm)
                  setPrometheusLinksOpen(true)
                }}
              >
                <Link2 /> Manage Prometheus links
              </Button>
            </div>
          </DialogHeader>
          <div className='flex min-h-0 flex-1 flex-col gap-4 [&>section]:flex [&>section]:min-h-0 [&>section]:flex-1 [&>section]:flex-col'>
            <section className='space-y-3 rounded-lg border p-4'>
              <div className='grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end'>
                <div className='space-y-1'>
                  <Label>Prometheus link</Label>
                  <select
                    className='h-9 w-full rounded-md border bg-background px-2 text-sm'
                    value={prometheusLinkId}
                    onChange={(e) => setPrometheusLinkId(e.target.value)}
                  >
                    <option value=''>Select link</option>
                    {prometheusLinks.data?.map((link) => (
                      <option key={link.id} value={link.id}>
                        {link.name} — {link.url}
                      </option>
                    ))}
                  </select>
                </div>
                <div className='space-y-1'>
                  <Label>Search labels</Label>
                  <Input
                    value={prometheusLabelSelector}
                    onChange={(e) => setPrometheusLabelSelector(e.target.value)}
                    placeholder='e.g. node_exporter or production'
                  />
                </div>
                <Button
                  disabled={!prometheusLinkId || prometheusChecking}
                  onClick={async () => {
                    setPrometheusChecking(true)
                    try {
                      const { data } = await apiClient.post<PrometheusResult[]>(
                        `/prometheus-links/${prometheusLinkId}/check`,
                        {
                          server_ips: Object.fromEntries(
                            prometheusTargets.map((server) => [
                              server.id,
                              (server.private_ip ?? []).map(
                                (ip) => ip.ip_address
                              ),
                            ])
                          ),
                          label_selector: prometheusLabelSelector,
                        }
                      )
                      setPrometheusResults(data)
                      setPrometheusStatusFilter('all')
                    } catch (error) {
                      const detail =
                        error instanceof AxiosError &&
                        typeof error.response?.data?.detail === 'string'
                          ? error.response.data.detail
                          : 'Could not check Prometheus.'
                      toast.error(detail)
                    } finally {
                      setPrometheusChecking(false)
                    }
                  }}
                >
                  {prometheusChecking ? (
                    <Loader2 className='animate-spin' />
                  ) : (
                    <MonitorPlay />
                  )}{' '}
                  Check {prometheusTargets.length} server(s)
                </Button>
              </div>
              {prometheusResults.length > 0 && (
                <>
                  <div className='flex flex-wrap gap-2'>
                    <span className='self-center text-sm text-muted-foreground'>
                      Quick filter:
                    </span>
                    {(['all', 'up', 'down', 'not-found'] as const).map(
                      (status) => (
                        <Button
                          key={status}
                          size='sm'
                          variant={
                            prometheusStatusFilter === status
                              ? 'default'
                              : 'outline'
                          }
                          onClick={() => setPrometheusStatusFilter(status)}
                        >
                          {status === 'all'
                            ? 'All'
                            : status === 'not-found'
                              ? 'Not found'
                              : status === 'up'
                                ? 'Up'
                                : 'Down'}
                        </Button>
                      )
                    )}
                  </div>
                  <CloudDataTable
                    data={filteredPrometheusResults}
                    columns={prometheusResultColumns}
                    getRowId={(row) => row.server_id}
                    fillHeight
                    initialPageSize={500}
                    entityName='server result'
                    exportFileName='prometheus-server-check'
                    searchPlaceholder='Search server, IP, status or labels...'
                    emptyText='No results match this filter.'
                    toolbar={(selected) => (
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => openPrometheusTargetJson(selected)}
                      >
                        Prometheus JSON
                      </Button>
                    )}
                  />
                </>
              )}
            </section>
          </div>
          <DialogFooter>
            {prometheusResults.length > 0 && (
              <Button
                variant='outline'
                onClick={() =>
                  downloadXlsx(
                    [
                      'Server ID',
                      'Server',
                      'Private IP mapping',
                      'Status',
                      'Labels',
                    ],
                    prometheusResults.map((result) => [
                      result.server_id,
                      prometheusTargets.find(
                        (server) => server.id === result.server_id
                      )?.name ?? '',
                      result.ip_results
                        .map(
                          (item) =>
                            `${item.ip}: ${item.down ? 'Down' : item.found ? 'Up' : 'Not found'}`
                        )
                        .join(', '),
                      prometheusStatus(result),
                      Object.entries(result.labels)
                        .map(([key, value]) => `${key}=${value}`)
                        .join(', '),
                    ]),
                    'prometheus-server-check.xlsx'
                  )
                }
              >
                <Download /> Export all results
              </Button>
            )}
            <Button variant='outline' onClick={() => setPrometheusOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={prometheusLinksOpen} onOpenChange={setPrometheusLinksOpen}>
        <DialogContent className='max-h-[92vh] overflow-y-auto sm:!max-w-6xl'>
          <DialogHeader>
            <DialogTitle>Manage Prometheus links</DialogTitle>
            <DialogDescription>
              Create, update, search and remove saved Prometheus endpoints.
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(340px,.9fr)]'>
            <section className='space-y-3 rounded-lg border p-4'>
              <div className='flex items-center justify-between'>
                <h3 className='font-semibold'>Saved links</h3>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => setPrometheusForm(emptyPrometheusForm)}
                >
                  <Plus /> New link
                </Button>
              </div>
              <CloudDataTable
                data={prometheusLinks.data ?? []}
                columns={prometheusLinkColumns}
                getRowId={(row) => row.id}
                loading={prometheusLinks.isLoading}
                enableSelection={false}
                initialPageSize={5}
                pageSizeOptions={[5, 10, 20]}
                entityName='Prometheus link'
                exportFileName='prometheus-links'
                searchPlaceholder='Search links by name, URL or auth...'
                emptyText='No Prometheus links saved.'
              />
            </section>
            <section className='space-y-3 rounded-lg border p-4'>
              <div>
                <h3 className='font-semibold'>
                  {prometheusForm.id ? 'Edit link' : 'Add link'}
                </h3>
                <p className='text-sm text-muted-foreground'>
                  Credentials are encrypted and not shown after saving.
                </p>
              </div>
              <div className='grid gap-3 sm:grid-cols-2'>
                <div className='space-y-1'>
                  <Label>Link name</Label>
                  <Input
                    placeholder='Production Prometheus'
                    value={prometheusForm.name}
                    onChange={(e) =>
                      setPrometheusForm((v) => ({ ...v, name: e.target.value }))
                    }
                  />
                </div>
                <div className='space-y-1'>
                  <Label>Prometheus URL</Label>
                  <Input
                    placeholder='https://prometheus.example'
                    value={prometheusForm.url}
                    onChange={(e) =>
                      setPrometheusForm((v) => ({ ...v, url: e.target.value }))
                    }
                  />
                </div>
              </div>
              <div className='space-y-1'>
                <Label>Authentication type</Label>
                <select
                  className='h-9 w-full rounded-md border bg-background px-2 text-sm'
                  value={prometheusForm.auth_type}
                  onChange={(e) =>
                    setPrometheusForm((v) => ({
                      ...v,
                      auth_type: e.target.value,
                    }))
                  }
                >
                  <option value='none'>No authentication</option>
                  <option value='bearer'>Bearer token</option>
                  <option value='basic'>Basic authentication</option>
                  <option value='header'>Custom header</option>
                </select>
              </div>
              {prometheusForm.auth_type === 'bearer' && (
                <div className='space-y-1'>
                  <Label>Bearer token</Label>
                  <Input
                    type='password'
                    placeholder='Token'
                    value={prometheusForm.bearer_token}
                    onChange={(e) =>
                      setPrometheusForm((v) => ({
                        ...v,
                        bearer_token: e.target.value,
                      }))
                    }
                  />
                </div>
              )}
              {prometheusForm.auth_type === 'basic' && (
                <div className='grid gap-3 sm:grid-cols-2'>
                  <div className='space-y-1'>
                    <Label>Username</Label>
                    <Input
                      value={prometheusForm.username}
                      onChange={(e) =>
                        setPrometheusForm((v) => ({
                          ...v,
                          username: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className='space-y-1'>
                    <Label>Password</Label>
                    <Input
                      type='password'
                      value={prometheusForm.password}
                      onChange={(e) =>
                        setPrometheusForm((v) => ({
                          ...v,
                          password: e.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
              )}
              {prometheusForm.auth_type === 'header' && (
                <div className='grid gap-3 sm:grid-cols-2'>
                  <div className='space-y-1'>
                    <Label>Header name</Label>
                    <Input
                      placeholder='X-API-Key'
                      value={prometheusForm.header_name}
                      onChange={(e) =>
                        setPrometheusForm((v) => ({
                          ...v,
                          header_name: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className='space-y-1'>
                    <Label>Header value</Label>
                    <Input
                      type='password'
                      value={prometheusForm.header_value}
                      onChange={(e) =>
                        setPrometheusForm((v) => ({
                          ...v,
                          header_value: e.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
              )}
              <div className='flex justify-end gap-2'>
                <Button
                  variant='outline'
                  onClick={() => setPrometheusForm(emptyPrometheusForm)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={
                    !prometheusForm.name.trim() || !prometheusForm.url.trim()
                  }
                  onClick={async () => {
                    try {
                      const method = prometheusForm.id ? 'patch' : 'post'
                      const path = prometheusForm.id
                        ? `/prometheus-links/${prometheusForm.id}`
                        : '/prometheus-links'
                      await apiClient[method](path, prometheusForm)
                      setPrometheusForm(emptyPrometheusForm)
                      await prometheusLinks.refetch()
                      toast.success('Prometheus link saved.')
                    } catch {
                      toast.error('Could not save Prometheus link.')
                    }
                  }}
                >
                  Save link
                </Button>
              </div>
            </section>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setPrometheusLinksOpen(false)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(prometheusDeleteLink)}
        onOpenChange={(open) => !open && setPrometheusDeleteLink(undefined)}
        title='Delete Prometheus link?'
        desc={`Delete ${prometheusDeleteLink?.name ?? 'this link'}? This cannot be undone.`}
        confirmText='Delete link'
        handleConfirm={async () => {
          if (!prometheusDeleteLink) return
          try {
            await apiClient.delete(
              `/prometheus-links/${prometheusDeleteLink.id}`
            )
            if (prometheusLinkId === prometheusDeleteLink.id)
              setPrometheusLinkId('')
            setPrometheusDeleteLink(undefined)
            await prometheusLinks.refetch()
            toast.success('Prometheus link deleted.')
          } catch {
            toast.error('Could not delete Prometheus link.')
          }
        }}
      />
      <Dialog open={prometheusJsonOpen} onOpenChange={setPrometheusJsonOpen}>
        <DialogContent className='sm:!max-w-3xl'>
          <DialogHeader>
            <DialogTitle>Prometheus target JSON</DialogTitle>
            <DialogDescription>
              Copy this file-based service-discovery JSON for the selected
              server results.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={prometheusJson}
            readOnly
            className='min-h-80 font-mono text-xs'
            aria-label='Prometheus target JSON'
          />
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => copyText(prometheusJson, 'Prometheus JSON')}
            >
              {' '}
              <Copy /> Copy JSON
            </Button>
            <Button onClick={() => setPrometheusJsonOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={passwordOpen}
        onOpenChange={(open) => {
          if (!open && changingPasswords) return
          setPasswordOpen(open)
          if (!open) setPasswordResults([])
        }}
      >
        <DialogContent className='sm:!max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Change server passwords</DialogTitle>
            <DialogDescription>
              {passwordResults.length
                ? changingPasswords
                  ? `Changing passwords independently (up to ${PASSWORD_CHANGE_CONCURRENCY} at a time). A failed server will not stop the remaining requests.`
                  : 'The operation completed. Review the result returned for each server.'
                : `Choose how to set passwords for ${selectedServers.length} selected server(s).`}
            </DialogDescription>
          </DialogHeader>
          {passwordResults.length ? (
            <ServerPasswordResultsTable rows={passwordResults} />
          ) : (
            <>
              <SegmentedTabs<ServerPasswordMode>
                value={passwordMode}
                onValueChange={(mode) => {
                  setPasswordMode(mode)
                  if (mode === 'random') regenerateRandomPasswords()
                }}
                tabs={[
                  { value: 'profile', label: 'Password profile' },
                  { value: 'manual', label: 'Enter password' },
                  { value: 'random', label: 'Random per server' },
                ]}
              />
              {passwordMode === 'profile' && (
                <div className='space-y-2'>
                  <Label>Password profile</Label>
                  <SearchableSelect
                    value={profileId}
                    onValueChange={setProfileId}
                    loading={profiles.isLoading}
                    placeholder='Select password profile'
                    searchPlaceholder='Search password profiles...'
                    options={profiles.data?.map((profile) => ({
                      value: profile.id,
                      label: profile.name,
                      description: profile.username,
                    }))}
                  />
                </div>
              )}
              {passwordMode === 'manual' && (
                <div className='space-y-2 rounded-lg border bg-muted/20 p-4'>
                  <div className='flex items-center justify-between'>
                    <Label htmlFor='manual-server-password'>
                      Password for all selected servers
                    </Label>
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      onClick={() => setShowPasswords((value) => !value)}
                    >
                      {showPasswords ? 'Hide' : 'Show'}
                    </Button>
                  </div>
                  <Input
                    id='manual-server-password'
                    type={showPasswords ? 'text' : 'password'}
                    className='font-mono'
                    value={manualPassword}
                    onChange={(event) => setManualPassword(event.target.value)}
                    placeholder='Example: G5_&s84Xbi'
                    autoComplete='new-password'
                  />
                  <p
                    className={`text-xs ${manualPassword && !validServerPassword(manualPassword) ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    At least 9 characters with uppercase, lowercase, number and
                    special character.
                  </p>
                </div>
              )}
              {passwordMode === 'random' && (
                <div className='flex flex-wrap items-end justify-between gap-3 rounded-lg border bg-muted/20 p-3'>
                  <div className='space-y-1.5'>
                    <Label htmlFor='random-password-length'>
                      Password length
                    </Label>
                    <Input
                      id='random-password-length'
                      type='number'
                      min={9}
                      max={64}
                      className='w-28'
                      value={randomPasswordLength}
                      onChange={(event) => {
                        const length = Math.max(
                          9,
                          Math.min(64, Number(event.target.value) || 9)
                        )
                        setRandomPasswordLength(length)
                        regenerateRandomPasswords(selectedServers, length)
                      }}
                    />
                  </div>
                  <div className='flex flex-wrap gap-2'>
                    <Button
                      type='button'
                      variant='outline'
                      onClick={() => setShowPasswords((value) => !value)}
                    >
                      {showPasswords ? 'Hide passwords' : 'Show passwords'}
                    </Button>
                    <Button
                      type='button'
                      variant='secondary'
                      onClick={() => regenerateRandomPasswords()}
                    >
                      <RefreshCw /> Regenerate all
                    </Button>
                    <Button
                      type='button'
                      variant='outline'
                      disabled={!passwordReady || changingPasswords}
                      onClick={() => {
                        downloadXlsx(
                          ['SERVER NAME', 'TYPE', 'ZONE', 'NEW PASSWORD'],
                          selectedServers.map((server) => [
                            server.name,
                            server.server_type,
                            server.zone_display_name || '',
                            randomPasswords[server.id] || '',
                          ]),
                          `server-random-passwords-${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`,
                          {
                            title: 'GENERATED SERVER PASSWORDS',
                            sheetName: 'Server passwords',
                            metadata: [
                              {
                                label: 'Project',
                                value: project.name || project.id,
                              },
                              {
                                label: 'Status',
                                value:
                                  'Generated passwords; not yet submitted.',
                              },
                            ],
                          }
                        )
                        toast.success('Server passwords exported.')
                      }}
                    >
                      <Download /> Export passwords
                    </Button>
                  </div>
                </div>
              )}
              <div className='max-h-72 overflow-auto rounded-md border'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Zone</TableHead>
                      {passwordMode === 'random' && (
                        <TableHead>Generated password</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedServers.map((server) => (
                      <TableRow key={server.id}>
                        <TableCell className='font-medium'>
                          {server.name}
                        </TableCell>
                        <TableCell>{server.server_type}</TableCell>
                        <TableCell>{server.zone_display_name || '—'}</TableCell>
                        {passwordMode === 'random' && (
                          <TableCell className='font-mono text-xs'>
                            {showPasswords
                              ? randomPasswords[server.id]
                              : '••••••••••••'}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
          <DialogFooter>
            {passwordResults.length ? (
              <Button
                disabled={changingPasswords}
                onClick={() => setPasswordOpen(false)}
              >
                Close
              </Button>
            ) : (
              <>
                <Button
                  variant='outline'
                  onClick={() => setPasswordOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={!passwordReady || !selectedServers.length}
                  onClick={() => setWarningAction('password')}
                >
                  <KeyRound />
                  Change passwords
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          setRenameOpen(open)
          if (!open) setRenameResults([])
        }}
      >
        <DialogContent className='sm:!max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Bulk rename servers</DialogTitle>
            <DialogDescription>
              {renameResults.length
                ? 'The operation completed. Review the result returned for each server.'
                : 'Keep one server_id,new_name pair per line. Only selected IDs are accepted.'}
            </DialogDescription>
          </DialogHeader>
          {renameResults.length ? (
            <CloudDataTable
              data={renameResults}
              columns={resultColumns}
              getRowId={(row) => row.server_id}
              entityName='result'
              exportFileName='bulk-rename-results'
              searchPlaceholder='Search result by server ID, name or status...'
            />
          ) : (
            <div className='grid gap-4 lg:grid-cols-2'>
              <div className='space-y-2'>
                <Label htmlFor='bulk-rename-values'>
                  Server ID and new name
                </Label>
                <Textarea
                  id='bulk-rename-values'
                  className='min-h-64 font-mono text-xs'
                  value={renameLines}
                  onChange={(event) => setRenameLines(event.target.value)}
                />
              </div>
              <div className='max-h-72 overflow-auto rounded-md border'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Current name</TableHead>
                      <TableHead>New name</TableHead>
                      <TableHead>Server ID</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {renameItems.map((item) => (
                      <TableRow key={item.server_id}>
                        <TableCell>
                          {selectedServers.find(
                            (server) => server.id === item.server_id
                          )?.name || '—'}
                        </TableCell>
                        <TableCell className='font-medium'>
                          {item.new_name}
                        </TableCell>
                        <TableCell className='font-mono text-xs'>
                          {item.server_id}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
          <DialogFooter>
            {renameResults.length ? (
              <Button onClick={() => setRenameOpen(false)}>Close</Button>
            ) : (
              <>
                <Button variant='outline' onClick={() => setRenameOpen(false)}>
                  Cancel
                </Button>
                <Button
                  disabled={!renameItems.length}
                  onClick={() => setWarningAction('rename')}
                >
                  Rename {renameItems.length} server(s)
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className='sm:!max-w-3xl'>
          <DialogHeader>
            <DialogTitle>Export servers to Excel</DialogTitle>
            <DialogDescription>
              Export every field returned by the Cloud API or choose the exact
              keys to include.
            </DialogDescription>
          </DialogHeader>
          <SegmentedTabs
            value={exportMode}
            onValueChange={setExportMode}
            tabs={[
              { value: 'all', label: 'Export all data' },
              { value: 'custom', label: 'Select keys' },
            ]}
          />
          <label className='flex cursor-pointer items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2.5 text-sm'>
            <span>
              <span className='block font-medium'>Reverse server order</span>
              <span className='block text-xs text-muted-foreground'>
                Export the current server list from last to first.
              </span>
            </span>
            <Checkbox
              checked={exportReverseOrder}
              onCheckedChange={(checked) =>
                setExportReverseOrder(Boolean(checked))
              }
            />
          </label>
          {exportMode === 'all' ? (
            <div className='rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground'>
              Every key returned by the API will be exported. Elastic and
              private IP arrays are expanded into numbered columns containing
              only the IP address, such as
              <code className='mx-1'>elastic_ip_1</code> and
              <code className='mx-1'>private_ip_1</code>.
            </div>
          ) : (
            <div className='space-y-3'>
              <div className='flex items-center justify-between gap-3'>
                <Label>Keys to export</Label>
                <div className='flex gap-2'>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() =>
                      setExportFields([...defaultServerExportFields])
                    }
                  >
                    Restore defaults
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setExportFields(availableExportFields)}
                  >
                    Select all
                  </Button>
                </div>
              </div>
              <div className='grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3'>
                {availableExportFields.map((field) => (
                  <label
                    key={field}
                    className='flex items-center gap-2 rounded-md border p-3 text-sm'
                  >
                    <Checkbox
                      checked={exportFields.includes(field)}
                      onCheckedChange={(checked) =>
                        setExportFields((current) =>
                          checked
                            ? [...current, field]
                            : current.filter((item) => item !== field)
                        )
                      }
                    />
                    <span className='truncate font-mono text-xs'>{field}</span>
                  </label>
                ))}
              </div>
              <p className='text-xs text-muted-foreground'>
                {exportFields.length} key(s) selected. IP objects export only
                <code className='mx-1'>ip_address</code>.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant='outline' onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                exporting || (exportMode === 'custom' && !exportFields.length)
              }
              onClick={async () => {
                setExporting(true)
                try {
                  if (exportMode === 'all')
                    await downloadCustomServerExport(
                      undefined,
                      project.display_name || project.name,
                      exportedBy,
                      exportReverseOrder
                    )
                  else
                    await downloadCustomServerExport(
                      exportFields,
                      project.display_name || project.name,
                      exportedBy,
                      exportReverseOrder
                    )
                  setExportOpen(false)
                  toast.success('The server Excel export is ready.')
                } catch {
                  toast.error('The Excel export could not be generated.')
                } finally {
                  setExporting(false)
                }
              }}
            >
              <Download />
              {exporting ? 'Exporting...' : 'Export XLSX'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>Copy selected server data</DialogTitle>
            <DialogDescription>
              Choose one or more columns. Data will be copied as tab-separated
              rows with a header, ready to paste into Excel or a text editor.
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-2 sm:grid-cols-2'>
            {serverCopyOptions.map((option) => (
              <label
                key={option.value}
                className='flex items-center gap-2 rounded-md border p-3 text-sm'
              >
                <Checkbox
                  checked={copyColumns.includes(option.value)}
                  onCheckedChange={(checked) =>
                    setCopyColumns((current) =>
                      checked
                        ? [...current, option.value]
                        : current.filter((column) => column !== option.value)
                    )
                  }
                />
                {option.label}
              </label>
            ))}
          </div>
          <p className='text-sm text-muted-foreground'>
            {copyColumns.length} column(s) × {selectedServers.length} row(s)
          </p>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() =>
                setCopyColumns(serverCopyOptions.map((option) => option.value))
              }
            >
              Select all columns
            </Button>
            <Button variant='outline' onClick={() => setCopyOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!copyColumns.length || !selectedServers.length}
              onClick={async () => {
                const labels = copyColumns.map(
                  (column) =>
                    serverCopyOptions.find((option) => option.value === column)
                      ?.label ?? column
                )
                const content = [
                  labels.join('\t'),
                  ...selectedServers.map((server) =>
                    copyColumns
                      .map((column) => serverCopyValue(server, column))
                      .join('\t')
                  ),
                ].join('\n')
                try {
                  await navigator.clipboard.writeText(content)
                  toast.success(
                    `${selectedServers.length} server row(s) copied.`
                  )
                  setCopyOpen(false)
                  clearBulkSelection()
                } catch {
                  toast.error('Clipboard access was denied by the browser.')
                }
              }}
            >
              <Copy />
              Copy to clipboard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (deleteLoading || deletingServers) return
          setDeleteOpen(open)
          if (!open) {
            setDeleteResults([])
            setDeleteConfirmationText('')
          }
        }}
      >
        <DialogContent className='flex h-[var(--interface-dialog-max-height,84svh)] flex-col overflow-hidden sm:!w-[86vw] sm:!max-w-[1300px]'>
          <DialogHeader className='shrink-0 pr-6'>
            <DialogTitle>Delete servers</DialogTitle>
            <DialogDescription>
              Select attachments to delete with each VM. Unticked Elastic IPs,
              private IPs and volumes are retained. Each VM is submitted
              independently.
            </DialogDescription>
          </DialogHeader>
          {deleteResults.length > 0 && (
            <div
              role='status'
              className='flex shrink-0 flex-wrap items-center gap-3 rounded-md border bg-muted/20 px-3 py-2 text-sm'
            >
              {deletingServers && <Loader2 className='size-4 animate-spin' />}
              <span>
                {
                  deleteResults.filter(
                    (row) => !['queued', 'processing'].includes(row.status)
                  ).length
                }
                /{deleteResults.length} processed
              </span>
              <span className='text-emerald-600 dark:text-emerald-400'>
                {
                  deleteResults.filter((row) =>
                    ['accepted', 'completed'].includes(row.status)
                  ).length
                }{' '}
                accepted
              </span>
              <span className='text-destructive'>
                {deleteResults.filter((row) => row.status === 'failed').length}{' '}
                failed
              </span>
              <span className='text-amber-600 dark:text-amber-400'>
                {
                  deleteResults.filter((row) => row.status === 'unconfirmed')
                    .length
                }{' '}
                unconfirmed
              </span>
            </div>
          )}
          {deleteResults.length ? (
            <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
              <CloudDataTable
                fillHeight
                enableSelection={false}
                data={deleteResults}
                columns={deleteResultColumns}
                getRowId={(row) => row.server_id}
                entityName='result'
                exportFileName='server-delete-results'
                searchPlaceholder='Search deletion results...'
              />
            </div>
          ) : (
            <div className='min-h-0 flex-1 overflow-auto rounded-md border'>
              <div className='flex flex-wrap items-center justify-end gap-2 border-b bg-muted/20 px-3 py-2'>
                <span className='mr-auto text-xs text-muted-foreground'>
                  Select attachments to delete
                </span>
                {(() => {
                  const total = deleteDrafts.reduce(
                    (sum, draft) =>
                      sum +
                      draft.eips.length +
                      draft.private_ips.length +
                      draft.volumes.length,
                    0
                  )
                  const selected = deleteDrafts.reduce(
                    (sum, draft) =>
                      sum +
                      draft.selected_eips.length +
                      draft.selected_private_ips.length +
                      draft.selected_volumes.length,
                    0
                  )
                  return (
                    <label className='flex items-center gap-1.5 text-xs font-medium'>
                      <Checkbox
                        checked={total > 0 && selected === total}
                        disabled={!total}
                        onCheckedChange={(checked) =>
                          setAllDeleteAttachments(checked === true)
                        }
                      />{' '}
                      Select all attachments
                    </label>
                  )
                })()}
                {(['eips', 'private_ips', 'volumes'] as const).map((key) => {
                  const total = deleteDrafts.reduce(
                    (sum, draft) => sum + draft[key].length,
                    0
                  )
                  const selectedKey = `selected_${key}` as
                    | 'selected_eips'
                    | 'selected_private_ips'
                    | 'selected_volumes'
                  const selected = deleteDrafts.reduce(
                    (sum, draft) => sum + draft[selectedKey].length,
                    0
                  )
                  const label =
                    key === 'eips'
                      ? 'Elastic IPs'
                      : key === 'private_ips'
                        ? 'Private IPs'
                        : 'Volumes'
                  return (
                    <label
                      className='flex items-center gap-1.5 text-xs'
                      key={key}
                    >
                      <Checkbox
                        checked={total > 0 && selected === total}
                        disabled={!total}
                        onCheckedChange={(checked) =>
                          setDeleteColumnSelection(key, checked === true)
                        }
                      />{' '}
                      {label}
                    </label>
                  )
                })}
              </div>
              <Table>
                <TableHeader className='sticky top-0 z-10 bg-background'>
                  <TableRow>
                    <TableHead className='w-12 text-center'>#</TableHead>
                    <TableHead className='min-w-48'>Server</TableHead>
                    <TableHead className='min-w-56'>Elastic IPs</TableHead>
                    <TableHead className='min-w-56'>Private IPs</TableHead>
                    <TableHead className='min-w-56'>Volumes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deleteDrafts.map((draft, index) => (
                    <TableRow key={draft.server_id}>
                      <TableCell className='text-center text-muted-foreground'>
                        {index + 1}
                      </TableCell>
                      <TableCell>
                        <p className='font-medium'>{draft.name}</p>
                        <code className='text-xs text-muted-foreground'>
                          {draft.server_id}
                        </code>
                      </TableCell>
                      {(
                        [
                          ['eips', 'selected_eips'],
                          ['private_ips', 'selected_private_ips'],
                          ['volumes', 'selected_volumes'],
                        ] as const
                      ).map(([resourceKey, selectedKey]) => (
                        <TableCell key={resourceKey}>
                          <div className='space-y-1.5'>
                            {draft[resourceKey].length ? (
                              draft[resourceKey].map((resource) => (
                                <label
                                  className='flex items-start gap-2 text-xs'
                                  key={resource.id}
                                >
                                  <Checkbox
                                    checked={draft[selectedKey].includes(
                                      resource.id
                                    )}
                                    onCheckedChange={(checked) =>
                                      updateDeleteDraft(
                                        draft.server_id,
                                        selectedKey,
                                        resource.id,
                                        checked === true
                                      )
                                    }
                                  />
                                  <span className='break-all'>
                                    {resource.label}
                                  </span>
                                </label>
                              ))
                            ) : (
                              <span className='text-xs text-muted-foreground'>
                                —
                              </span>
                            )}
                          </div>
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {deleteLoading && (
                <div className='flex items-center justify-center gap-2 border-t p-3 text-sm text-muted-foreground'>
                  <Loader2 className='size-4 animate-spin' /> Loading VM
                  attachments…
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            {deleteResults.length ? (
              <Button
                disabled={deletingServers}
                onClick={() => setDeleteOpen(false)}
              >
                Close
              </Button>
            ) : (
              <>
                <Button
                  disabled={deleteLoading}
                  onClick={() => setDeleteOpen(false)}
                  variant='outline'
                >
                  Cancel
                </Button>
                <Button
                  disabled={deleteLoading || !deleteDrafts.length}
                  onClick={() => {
                    setDeleteConfirmationText('')
                    setDeleteConfirmationOpen(true)
                  }}
                  variant='destructive'
                >
                  <Trash2 /> Delete {deleteDrafts.length} server(s)
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteConfirmationOpen}
        onOpenChange={setDeleteConfirmationOpen}
        title='Permanently delete selected servers?'
        desc={`This submits deletion for ${deleteDrafts.length} server(s). Type DELETE ALL to confirm.`}
        confirmText='Delete servers'
        destructive
        disabled={deleteConfirmationText.trim().toUpperCase() !== 'DELETE ALL'}
        isLoading={deletingServers}
        handleConfirm={async () => {
          if (deletingServersRef.current || deleteLoading) return
          deletingServersRef.current = true
          setDeletingServers(true)
          setDeleteConfirmationOpen(false)
          const projectId = project.id
          const targets = deleteDrafts.map((draft) => ({
            server_id: draft.server_id,
            name: draft.name,
            volumes: [...draft.selected_volumes],
            eips: [...draft.selected_eips],
            private_ips: [...draft.selected_private_ips],
          }))
          try {
            const outcomes = await runServerDeletions(
              targets,
              projectId,
              setDeleteResults
            )
            const uncertain = outcomes.filter((row) =>
              ['failed', 'unconfirmed'].includes(row.status)
            ).length
            toast[uncertain ? 'warning' : 'success'](
              `Deletion: ${outcomes.length - uncertain} accepted, ${uncertain} failed or unconfirmed.`
            )
            clearBulkSelection()
          } finally {
            deletingServersRef.current = false
            setDeletingServers(false)
            void queryClient.invalidateQueries({
              queryKey: ['cloud', projectId],
            })
          }
        }}
      >
        <div className='rounded-md border bg-muted/20 p-3'>
          <Label htmlFor='server-delete-confirmation'>
            Type <span className='font-mono font-semibold'>DELETE ALL</span> to
            confirm
          </Label>
          <Input
            autoComplete='off'
            className='mt-2 font-mono'
            id='server-delete-confirmation'
            onChange={(event) => setDeleteConfirmationText(event.target.value)}
            placeholder='DELETE ALL'
            value={deleteConfirmationText}
          />
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={warningAction === 'password' || warningAction === 'rename'}
        onOpenChange={(open) => !open && setWarningAction(undefined)}
        title={
          warningAction === 'password'
            ? 'Change passwords on selected servers?'
            : warningAction === 'rename'
              ? 'Rename selected servers?'
              : warningAction === 'start'
                ? 'Start selected servers?'
                : 'Stop selected servers?'
        }
        desc={
          warningAction === 'password'
            ? `This will submit a password change for ${selectedServers.length} server(s). The existing passwords cannot be recovered from CloudTool.`
            : warningAction === 'rename'
              ? `This will rename ${renameItems.length} server(s). Review every new name before continuing.`
              : `This will submit a ${warningAction} request for ${selectedServers.length} server(s). Each VM is processed independently; a failure will not stop the remaining requests.`
        }
        confirmText={
          warningAction === 'password'
            ? 'Change passwords'
            : warningAction === 'rename'
              ? 'Rename servers'
              : warningAction === 'start'
                ? 'Start servers'
                : 'Stop servers'
        }
        destructive
        isLoading={warningAction === 'password' ? changingPasswords : isPending}
        handleConfirm={confirmWarningAction}
      />
      <AlertDialog
        open={warningAction === 'start' || warningAction === 'stop'}
        onOpenChange={(open) => !open && setWarningAction(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {warningAction === 'start'
                ? 'Start selected servers?'
                : 'Stop selected servers?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will submit a {warningAction} request for{' '}
              {selectedServers.length} server(s). Each VM is processed
              independently; a failure will not stop the remaining requests.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className='rounded-md border bg-muted/20 p-3'>
            <Label htmlFor='server-power-confirmation'>
              Type{' '}
              <span className='font-mono font-semibold'>
                {warningAction?.toUpperCase()}
              </span>{' '}
              to confirm
            </Label>
            <Input
              autoComplete='off'
              className='mt-2 font-mono'
              id='server-power-confirmation'
              onChange={(event) => setPowerConfirmationText(event.target.value)}
              placeholder={warningAction?.toUpperCase()}
              value={powerConfirmationText}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button
              className={
                warningAction === 'start'
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'bg-amber-500 text-white hover:bg-amber-600'
              }
              disabled={
                isPending ||
                powerConfirmationText.trim().toUpperCase() !==
                  warningAction?.toUpperCase()
              }
              onClick={() => void confirmWarningAction()}
            >
              {warningAction === 'start' ? 'Start servers' : 'Stop servers'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={powerOpen}
        onOpenChange={(open) => {
          setPowerOpen(open)
          if (!open) setPowerResults([])
        }}
      >
        <DialogContent className='flex max-h-[85svh] w-[min(96vw,1100px)] max-w-[1100px] flex-col overflow-hidden sm:!max-w-[1100px]'>
          <DialogHeader>
            <DialogTitle>
              {powerAction === 'start' ? 'Start' : 'Stop'} server results
            </DialogTitle>
            <DialogDescription>
              Each VM was processed independently with at most three concurrent
              Cloud API operations. Review every status and error detail below.
            </DialogDescription>
          </DialogHeader>
          <div className='min-h-0 flex-1'>
            <CloudDataTable
              data={powerResults}
              columns={powerResultColumns}
              getRowId={(row) => row.server_id}
              entityName='result'
              exportFileName={`server-${powerAction}-results`}
              searchPlaceholder='Search result by server ID, name, status or error...'
            />
          </div>
          <DialogFooter>
            <Button onClick={() => setPowerOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {bulkSecurityGroups && (
        <ServerSecurityGroupsBulkDialog
          key={`${bulkSecurityGroups.projectId}:${bulkSecurityGroups.servers.map((server) => server.id).join('|')}`}
          {...bulkSecurityGroups}
          onClose={() => setBulkSecurityGroups(null)}
        />
      )}
      <MultiConsoleDialog
        key={selectedServers.map((server) => server.id).join('|')}
        open={multiConsoleOpen}
        onOpenChange={setMultiConsoleOpen}
        servers={selectedServers}
      />
      <TeleportSshDialog
        open={Boolean(teleportSshServer)}
        onOpenChange={(open) => !open && setTeleportSshServer(undefined)}
        server={teleportSshServer}
      />
      {attachPrivateIpsOpen && (
        <AttachPrivateIpsWorkspace
          key={`${project.id}:${selectedServers.map((server) => server.id).join('|')}`}
          embedded
          initialServers={selectedServers}
          onClose={() => setAttachPrivateIpsOpen(false)}
        />
      )}
      {elasticIpOpen && (
        <ElasticIpWorkspace
          key={`${project.id}:${selectedServers.map((server) => server.id).join('|')}`}
          initialServers={selectedServers}
          onClose={() => setElasticIpOpen(false)}
        />
      )}
    </CloudPageShell>
  )
}

interface IpPreviewRow {
  ip_address: string
  exists: boolean
  existing_id?: string
}

interface IpCreationResult {
  ip_address: string
  ip_id?: string
  status: 'completed' | 'failed'
  error?: string
  auto_added?: boolean
}

interface IpDeletionResult {
  ip_id: string
  ip_address?: string | null
  status: 'completed' | 'accepted' | 'failed' | 'skipped'
  http_status?: number
  error?: string
}
interface MultiPrivateIpRow {
  key: string
  row: number
  subnet_id: string
  subnet_name: string
  ip_address: string
  source: string
  validation: string
  ready: boolean
}
interface MultiPrivateIpResult extends MultiPrivateIpRow {
  status: 'completed' | 'failed'
  ip_id?: string
  error?: string
}

async function fetchAllPrivateIps(subnetId: string, includeAll = false, signal?: AbortSignal) {
  const items: PrivateIp[] = []
  let page = 1
  let total: number
  do {
    const response = await apiClient.get<Page<PrivateIp>>(
      '/cloud/private-ips',
      {
        params: {
          subnet_id: subnetId,
          ...(includeAll ? { include_all: true } : { available: true }),
          page,
          page_size: 200,
        },
        signal,
      }
    )
    items.push(...response.data.items)
    total = response.data.total
    page += 1
  } while (items.length < total)
  return items
}

function privateIpStatus(ip: PrivateIp) {
  if (ip.server) return `Attached to ${ip.server.name}`
  return ip.description
    ?.toLowerCase()
    .includes('port is created by cloud services')
    ? 'Reserved'
    : 'Available'
}

export function PrivateIpsPage() {
  const project = useCloudStore((state) => state.project)!
  const queryClient = useQueryClient()
  const multiFileRef = useRef<HTMLInputElement>(null)
  const [subnetId, setSubnetId] = useState('')
  const [ipScope, setIpScope] = useState<'available' | 'all'>('available')
  const [viewIp, setViewIp] = useState<PrivateIp>()
  const [createOpen, setCreateOpen] = useState(false)
  const [createMode, setCreateMode] = useState<'range' | 'count'>('range')
  const [startIp, setStartIp] = useState('')
  const [endIp, setEndIp] = useState('')
  const [count, setCount] = useState<number | ''>(1)
  const [autoFill, setAutoFill] = useState(true)
  const [maxAutoFill, setMaxAutoFill] = useState(1)
  const [previewRows, setPreviewRows] = useState<IpPreviewRow[]>([])
  const [previewing, setPreviewing] = useState(false)
  const [selectedPreview, setSelectedPreview] = useState<IpPreviewRow[]>([])
  const [confirmCreate, setConfirmCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [creationProgress, setCreationProgress] = useState({
    completed: 0,
    total: 0,
    currentIp: '',
    phase: 'Preparing creation requests…',
  })
  const [creationResults, setCreationResults] = useState<IpCreationResult[]>([])
  const [deleteTargets, setDeleteTargets] = useState<PrivateIp[]>([])
  const [deleting, setDeleting] = useState(false)
  const [deletionResults, setDeletionResults] = useState<IpDeletionResult[]>([])
  const [multiIpOpen, setMultiIpOpen] = useState(false)
  const [multiIpRows, setMultiIpRows] = useState<MultiPrivateIpRow[]>([])
  const [multiIpCreateItems, setMultiIpCreateItems] = useState<
    MultiPrivateIpRow[]
  >([])
  const [multiIpConfirm, setMultiIpConfirm] = useState(false)
  const [multiIpCreating, setMultiIpCreating] = useState(false)
  const [multiIpResults, setMultiIpResults] = useState<MultiPrivateIpResult[]>(
    []
  )
  const [multiTemplateDownloading, setMultiTemplateDownloading] =
    useState(false)
  const [multiTemplateImporting, setMultiTemplateImporting] = useState(false)
  const subnets = useQuery({
    queryKey: ['cloud', project.id, 'subnets'],
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Page<Subnet>>('/cloud/subnets', {
          params: { page_size: 200 }, signal,
        })
      ).data,
  })
  const selectedSubnet = subnets.data?.items.find(
    (subnet) => subnet.id === subnetId
  )
  useEffect(() => {
    const firstSubnet = subnets.data?.items[0]
    if (
      firstSubnet &&
      subnetId !== '__all_private_ips__' &&
      !subnets.data?.items.some((subnet) => subnet.id === subnetId)
    )
      setSubnetId(firstSubnet.id)
  }, [subnets.data?.items, subnetId])
  const ips = useQuery({
    queryKey: ['cloud', project.id, 'ips', subnetId, ipScope],
    enabled: Boolean(subnetId) && subnetId !== '__all_private_ips__',
    queryFn: ({ signal }) => fetchAllPrivateIps(subnetId, ipScope === 'all', signal),
  })
  const allIps = useQuery({
    queryKey: ['cloud', project.id, 'ips', 'all-subnets', ipScope],
    enabled: subnetId === '__all_private_ips__',
    queryFn: async ({ signal }) => {
      const rows: PrivateIp[] = []
      for (const subnet of subnets.data?.items ?? [])
        rows.push(...(await fetchAllPrivateIps(subnet.id, ipScope === 'all', signal)))
      return rows
    },
  })
  const displayedIps =
    subnetId === '__all_private_ips__' ? (allIps.data ?? []) : (ips.data ?? [])
  const columns = useMemo<ColumnDef<PrivateIp>[]>(
    () => [
      {
        accessorKey: 'ip_address',
        header: ({ column }) => (
          <SortableHeader column={column} title='IP address' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-sm'>{getValue() as string}</span>
        ),
      },
      {
        id: 'vips',
        accessorFn: (row) => inventoryIpLines(row.vips).join(' '),
        header: ({ column }) => (
          <SortableHeader column={column} title='VIP IP' />
        ),
        cell: ({ row }) => {
          const vips = inventoryIpLines(row.original.vips)
          return vips.length ? (
            <div className='font-mono text-xs leading-5'>
              {vips.map((vip) => (
                <p key={vip}>{vip}</p>
              ))}
            </div>
          ) : (
            <span className='text-xs text-muted-foreground'>—</span>
          )
        },
      },
      {
        accessorKey: 'id',
        header: ({ column }) => (
          <SortableHeader column={column} title='IP ID' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'region',
        header: ({ column }) => (
          <SortableHeader column={column} title='Region' />
        ),
        cell: ({ getValue }) => (getValue() as string | undefined) || '—',
      },
      {
        accessorKey: 'description',
        header: ({ column }) => (
          <SortableHeader column={column} title='Description' />
        ),
        cell: ({ getValue }) => (getValue() as string | undefined) || '—',
      },
      {
        id: 'server',
        accessorFn: (row) =>
          row.server ? `${row.server.name} ${row.server.id}` : '',
        header: ({ column }) => (
          <SortableHeader column={column} title='Attached server' />
        ),
        cell: ({ row }) =>
          row.original.server ? (
            <div>
              <p className='text-sm'>{row.original.server.name}</p>
              <p className='font-mono text-xs text-muted-foreground'>
                {row.original.server.id}
              </p>
            </div>
          ) : (
            '—'
          ),
      },
      {
        id: 'status',
        accessorFn: privateIpStatus,
        header: ({ column }) => (
          <SortableHeader column={column} title='Status' />
        ),
        cell: ({ row }) => {
          const status = privateIpStatus(row.original)
          return status === 'Available' ? (
            <span className='font-medium text-emerald-600 dark:text-emerald-400'>
              {status}
            </span>
          ) : (
            status
          )
        },
      },
      {
        id: 'actions',
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions id={row.original.id} label='IP ID'>
            <DropdownMenuItem onClick={() => setViewIp(row.original)}>
              <Eye />
              View details
            </DropdownMenuItem>
          </RowActions>
        ),
      },
    ],
    []
  )
  const previewColumns = useMemo<ColumnDef<IpPreviewRow>[]>(
    () => [
      {
        accessorKey: 'ip_address',
        header: ({ column }) => (
          <SortableHeader column={column} title='IP address' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-sm'>{getValue() as string}</span>
        ),
      },
      {
        id: 'availability',
        accessorFn: (row) =>
          row.exists ? 'Already exists' : 'Ready to create',
        header: ({ column }) => (
          <SortableHeader column={column} title='Availability' />
        ),
        cell: ({ row }) =>
          row.original.exists ? (
            <span className='text-muted-foreground'>Already exists</span>
          ) : (
            <span className='font-medium text-emerald-600 dark:text-emerald-400'>
              Ready to create
            </span>
          ),
      },
      {
        accessorKey: 'existing_id',
        header: ({ column }) => (
          <SortableHeader column={column} title='Existing IP ID' />
        ),
        cell: ({ getValue }) => (getValue() as string | undefined) || '—',
      },
    ],
    []
  )
  const resultColumns = useMemo<ColumnDef<IpCreationResult>[]>(
    () => [
      {
        accessorKey: 'ip_address',
        header: ({ column }) => (
          <SortableHeader column={column} title='IP address' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-sm'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'ip_id',
        header: ({ column }) => (
          <SortableHeader column={column} title='IP ID' />
        ),
        cell: ({ getValue }) => (getValue() as string | undefined) || '—',
      },
      {
        accessorKey: 'status',
        header: ({ column }) => (
          <SortableHeader column={column} title='Verified status' />
        ),
        cell: ({ getValue }) => {
          const status = getValue() as IpCreationResult['status']
          return status === 'completed' ? (
            <span className='font-medium text-emerald-600 dark:text-emerald-400'>
              Completed
            </span>
          ) : (
            <span className='font-medium text-destructive'>Failed</span>
          )
        },
      },
      {
        id: 'source',
        accessorFn: (row) =>
          row.auto_added ? 'Automatically added' : 'Selected',
        header: ({ column }) => (
          <SortableHeader column={column} title='Source' />
        ),
      },
      {
        accessorKey: 'error',
        header: ({ column }) => (
          <SortableHeader column={column} title='Error' />
        ),
        cell: ({ getValue }) => {
          const error = getValue() as string | undefined
          return error ? (
            <p className='max-w-96 text-xs leading-5 break-words text-destructive'>
              {error}
            </p>
          ) : (
            '—'
          )
        },
      },
    ],
    []
  )
  const deletionResultColumns = useMemo<ColumnDef<IpDeletionResult>[]>(
    () => [
      {
        accessorKey: 'ip_address',
        header: ({ column }) => (
          <SortableHeader column={column} title='IP address' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-sm'>
            {(getValue() as string | null) || '—'}
          </span>
        ),
      },
      {
        accessorKey: 'ip_id',
        header: ({ column }) => (
          <SortableHeader column={column} title='IP ID' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'status',
        header: ({ column }) => (
          <SortableHeader column={column} title='Result' />
        ),
        cell: ({ getValue }) => {
          const status = getValue() as IpDeletionResult['status']
          if (status === 'completed' || status === 'accepted')
            return (
              <span className='font-medium text-emerald-600 dark:text-emerald-400'>
                Deleted
              </span>
            )
          if (status === 'skipped')
            return (
              <span className='font-medium text-amber-600 dark:text-amber-400'>
                Skipped
              </span>
            )
          return <span className='font-medium text-destructive'>Failed</span>
        },
      },
      {
        accessorKey: 'http_status',
        header: ({ column }) => (
          <SortableHeader column={column} title='HTTP status' />
        ),
        cell: ({ getValue }) =>
          (getValue() as number | undefined)?.toString() || '—',
      },
      {
        accessorKey: 'error',
        header: ({ column }) => (
          <SortableHeader column={column} title='Message' />
        ),
        cell: ({ getValue }) => (getValue() as string | undefined) || '—',
      },
    ],
    []
  )

  async function deleteSelectedIps() {
    if (!subnetId || !deleteTargets.length) return
    setDeleting(true)
    try {
      const response = await apiClient.post<{ items: IpDeletionResult[] }>(
        '/cloud/private-ips/delete',
        { subnet_id: subnetId, ip_ids: deleteTargets.map((ip) => ip.id) }
      )
      const results = response.data.items
      setDeletionResults(results)
      setDeleteTargets([])
      await queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'ips', subnetId],
      })
      const completed = results.filter(
        (result) =>
          result.status === 'completed' || result.status === 'accepted'
      ).length
      if (completed === results.length)
        toast.success(`${completed} private IP(s) deleted.`)
      else
        toast.warning(
          `${completed}/${results.length} private IP(s) deleted. Review the results.`
        )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Private IP deletion failed.'
      )
    } finally {
      setDeleting(false)
    }
  }

  async function previewIps() {
    if (!subnetId) return
    setPreviewing(true)
    try {
      const addresses = buildIpRange(
        startIp,
        createMode === 'range' ? endIp : '',
        createMode === 'count' && count !== '' ? count : undefined
      )
      if (
        selectedSubnet &&
        addresses.some(
          (address) => !isUsableIpInCidr(address, selectedSubnet.cidr)
        )
      )
        throw new Error(
          `The requested range includes an address outside usable subnet ${selectedSubnet.cidr}.`
        )
      const currentIps = await fetchAllPrivateIps(subnetId)
      const existing = new Map(
        currentIps.map((ip) => [ip.ip_address, ip.id] as const)
      )
      setPreviewRows(
        addresses.map((ip_address) => ({
          ip_address,
          exists: existing.has(ip_address),
          existing_id: existing.get(ip_address),
        }))
      )
      setMaxAutoFill(Math.max(1, Math.ceil(addresses.length / 5)))
      setCreationResults([])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Invalid IP range.')
    } finally {
      setPreviewing(false)
    }
  }

  async function createOne(ipAddress: string) {
    try {
      const response = await apiClient.post<{
        items: Array<{
          ip_address: string
          ip_id?: string
          status: string
          error?: string
        }>
      }>('/cloud/private-ips/create-range', {
        subnet_id: subnetId,
        start_ip: ipAddress,
        count: 1,
        compensate: false,
      })
      const result = response.data.items[0]
      return result?.error
    } catch (error) {
      return error instanceof Error ? error.message : 'Creation request failed.'
    }
  }

  async function createSelectedIps() {
    if (!selectedPreview.length) return
    setCreating(true)
    setConfirmCreate(false)
    setCreationProgress({
      completed: 0,
      total: selectedPreview.length,
      currentIp: selectedPreview[0]?.ip_address ?? '',
      phase: 'Creating selected IP addresses…',
    })
    try {
      const attempted: Array<{
        ip_address: string
        error?: string
        auto_added?: boolean
      }> = []
      for (const [index, row] of selectedPreview.entries()) {
        setCreationProgress({
          completed: index,
          total: selectedPreview.length,
          currentIp: row.ip_address,
          phase: 'Creating selected IP addresses…',
        })
        attempted.push({
          ip_address: row.ip_address,
          error: await createOne(row.ip_address),
        })
        setCreationProgress((current) => ({
          ...current,
          completed: index + 1,
        }))
      }

      setCreationProgress((current) => ({
        ...current,
        currentIp: '',
        phase: 'Reloading and verifying subnet addresses…',
      }))
      let verified = await fetchAllPrivateIps(subnetId)
      let verifiedMap = new Map(
        verified.map((ip) => [ip.ip_address, ip] as const)
      )
      let completed = attempted.filter((item) =>
        verifiedMap.has(item.ip_address)
      ).length
      let candidate =
        previewRows[previewRows.length - 1]?.ip_address ??
        selectedPreview[selectedPreview.length - 1]?.ip_address ??
        ''
      let scanned = 0
      let autoAttempts = 0
      while (
        autoFill &&
        completed < selectedPreview.length &&
        autoAttempts < maxAutoFill &&
        scanned < 2000
      ) {
        scanned += 1
        const next = nextIpAddress(candidate)
        if (!next) break
        if (selectedSubnet && !isUsableIpInCidr(next, selectedSubnet.cidr))
          break
        candidate = next
        if (verifiedMap.has(next)) continue
        setCreationProgress((current) => ({
          ...current,
          currentIp: next,
          phase: 'Adding a replacement address and verifying it…',
        }))
        autoAttempts += 1
        const error = await createOne(next)
        attempted.push({ ip_address: next, error, auto_added: true })
        verified = await fetchAllPrivateIps(subnetId)
        verifiedMap = new Map(
          verified.map((ip) => [ip.ip_address, ip] as const)
        )
        completed = attempted.filter((item) =>
          verifiedMap.has(item.ip_address)
        ).length
      }

      // Always perform one final API read before presenting verified results.
      setCreationProgress((current) => ({
        ...current,
        currentIp: '',
        phase: 'Performing the final Cloud API verification…',
      }))
      verified = await fetchAllPrivateIps(subnetId)
      verifiedMap = new Map(verified.map((ip) => [ip.ip_address, ip] as const))
      const results: IpCreationResult[] = attempted.map((item) => {
        const created = verifiedMap.get(item.ip_address)
        return {
          ...item,
          ip_id: created?.id,
          status: created ? 'completed' : 'failed',
        }
      })
      setCreationResults(results)
      setPreviewRows([])
      setSelectedPreview([])
      await queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'ips', subnetId],
      })
      const successful = results.filter(
        (result) => result.status === 'completed'
      ).length
      if (successful < selectedPreview.length)
        toast.warning(
          `Created ${successful}/${selectedPreview.length} requested IPs. ${autoFill && autoAttempts >= maxAutoFill ? `The auto-fill limit (${maxAutoFill}) was reached.` : 'No more usable addresses could be added automatically.'}`
        )
      else toast.success(`${successful} private IP(s) created and verified.`)
    } catch {
      toast.error(
        'Private IP creation could not be verified. Reload the subnet before retrying.'
      )
    } finally {
      setCreating(false)
    }
  }

  function exportSuccessfulIps() {
    const successful = creationResults.filter(
      (result) => result.status === 'completed'
    )
    downloadXlsx(
      ['NO.', 'IP ADDRESS', 'IP ID', 'SOURCE'],
      successful.map((result, index) => [
        index + 1,
        result.ip_address,
        result.ip_id ?? '',
        result.auto_added ? 'Automatically added' : 'Selected',
      ]),
      `created-private-ips-${subnetId}.xlsx`,
      {
        title: 'CREATED PRIVATE IP REPORT',
        metadata: [
          { label: 'Subnet', value: selectedSubnet?.cidr ?? subnetId },
          {
            label: 'Exported at',
            value: new Date().toLocaleString(),
          },
        ],
      }
    )
  }

  const downloadMultiIpTemplate = () =>
    downloadXlsx(
      ['SUBNET', 'IP ADDRESSES', 'START IP', 'END IP', 'COUNT'],
      [
        [
          subnets.data?.items[0]?.display_name ||
            subnets.data?.items[0]?.name ||
            'Subnet_App',
          '10.20.1.10\n10.20.1.11',
          '',
          '',
          '',
        ],
        [
          subnets.data?.items[0]?.display_name ||
            subnets.data?.items[0]?.name ||
            'Subnet_App',
          '',
          '10.20.1.20',
          '',
          5,
        ],
        [
          subnets.data?.items[0]?.display_name ||
            subnets.data?.items[0]?.name ||
            'Subnet_App',
          '',
          '10.20.1.30',
          '10.20.1.35',
          '',
        ],
      ],
      `multi-private-ip-template-${project.name || project.id}`,
      {
        title: 'MULTI SUBNET PRIVATE IP TEMPLATE',
        metadata: [
          {
            label: 'SUBNET',
            value:
              'Required. Choose/type an exact subnet name. Every resulting IP is reviewed individually.',
          },
          {
            label: 'IP ADDRESSES',
            value:
              'Option A: list exact IPs, separated by commas or new lines. Leave the range columns blank.',
          },
          {
            label: 'START IP + COUNT',
            value:
              'Option B: enter a start IP and positive COUNT. END IP must be blank.',
          },
          {
            label: 'START IP + END IP',
            value:
              'Option C: enter inclusive start/end IP. COUNT must be blank. Use only one option per row.',
          },
        ],
        validations: [
          {
            header: 'SUBNET',
            values: (subnets.data?.items ?? [])
              .flatMap((subnet) => [subnet.name, subnet.display_name || ''])
              .filter(Boolean),
            allowBlank: false,
            enforce: false,
            prompt: 'Choose a subnet or type its exact name.',
          },
          {
            header: 'COUNT',
            type: 'whole',
            min: 1,
            max: 1000,
            allowBlank: true,
          },
        ],
        validationRowCount: 1000,
      }
    )
  const reviewMultiIpTemplate = async (file?: File) => {
    if (!file) return
    setMultiTemplateImporting(true)
    try {
      const records = rowsFromHeader(parseXlsxRows(await file.arrayBuffer()), [
        'SUBNET',
        'IP ADDRESSES',
      ])
      const rows = records.flatMap((record, index) => {
        const subnetName = (record.SUBNET || '').trim()
        const subnet = (subnets.data?.items ?? []).find(
          (item) =>
            item.id === subnetName ||
            item.name.toLowerCase() === subnetName.toLowerCase() ||
            item.display_name?.toLowerCase() === subnetName.toLowerCase()
        )
        const listed = (record['IP ADDRESSES'] || '')
          .split(/[\n,]+/)
          .map((value) => value.trim())
          .filter(Boolean)
        const hasRange = Boolean(
          (record['START IP'] || '').trim() ||
          (record['END IP'] || '').trim() ||
          record.COUNT
        )
        const modeConflict = listed.length > 0 && hasRange
        let rangeError = ''
        let addresses = listed
        const source = listed.length
          ? `List: ${listed.join(', ')}`
          : (record['END IP'] || '').trim()
            ? `Range: ${(record['START IP'] || '').trim()} – ${(record['END IP'] || '').trim()}`
            : `Start: ${(record['START IP'] || '').trim()} · Count: ${record.COUNT || '—'}`
        if (
          !modeConflict &&
          !addresses.length &&
          (record['START IP'] || '').trim()
        ) {
          try {
            addresses = buildIpRange(
              record['START IP'].trim(),
              (record['END IP'] || '').trim(),
              record.COUNT ? Number(record.COUNT) : undefined
            )
          } catch (error) {
            addresses = [record['START IP'].trim()]
            rangeError =
              error instanceof Error ? error.message : 'Invalid IP range'
          }
        }
        return (addresses.length ? addresses : ['']).map((ip, ipIndex) => ({
          key: `multi-ip-${index + 2}-${ipIndex + 1}`,
          row: index + 2,
          subnet_id: subnet?.id || '',
          subnet_name: subnet?.display_name || subnet?.name || subnetName,
          ip_address: ip,
          source,
          validation: modeConflict
            ? 'Use either IP ADDRESSES or START IP range fields, not both'
            : rangeError ||
              (!subnet
                ? `Subnet '${subnetName}' was not found`
                : !isUsableIpInCidr(ip, subnet.cidr)
                  ? `IP '${ip}' is outside subnet ${subnet.cidr}`
                  : 'Ready to create'),
          ready:
            !modeConflict &&
            !rangeError &&
            Boolean(subnet) &&
            isUsableIpInCidr(ip, subnet?.cidr || ''),
        }))
      })
      setMultiIpRows(rows)
      setMultiIpOpen(true)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Invalid private IP template.'
      )
    } finally {
      setMultiTemplateImporting(false)
      if (multiFileRef.current) multiFileRef.current.value = ''
    }
  }
  const startMultiTemplateDownload = () => {
    setMultiTemplateDownloading(true)
    window.setTimeout(() => {
      downloadMultiIpTemplate()
      setMultiTemplateDownloading(false)
    }, 0)
  }
  const createMultiIps = async () => {
    setMultiIpCreating(true)
    setMultiIpConfirm(false)
    const results: MultiPrivateIpResult[] = []
    for (const row of multiIpCreateItems) {
      try {
        const response = await apiClient.post<{
          items: Array<{ ip_id?: string; error?: string; status: string }>
        }>(
          '/cloud/private-ips/create-range',
          {
            subnet_id: row.subnet_id,
            start_ip: row.ip_address,
            count: 1,
            compensate: false,
          },
          { timeout: 0 }
        )
        const item = response.data.items[0]
        results.push({
          ...row,
          status: item?.status === 'completed' ? 'completed' : 'failed',
          ip_id: item?.ip_id,
          error: item?.error,
        })
      } catch (error) {
        results.push({
          ...row,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Creation failed.',
        })
      }
    }
    setMultiIpResults(results)
    setMultiIpCreating(false)
    setMultiIpOpen(false)
    await queryClient.invalidateQueries({
      queryKey: ['cloud', project.id, 'ips'],
    })
  }

  return (
    <CloudPageShell
      title='Private IPs'
      description='Inspect and create private addresses by subnet.'
      actions={
        <>
          <Button
            size='sm'
            variant='outline'
            disabled={multiTemplateDownloading}
            onClick={startMultiTemplateDownload}
          >
            {multiTemplateDownloading ? (
              <Loader2 className='animate-spin' />
            ) : (
              <Download />
            )}{' '}
            Template
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={multiTemplateImporting}
            onClick={() => multiFileRef.current?.click()}
          >
            {multiTemplateImporting ? (
              <Loader2 className='animate-spin' />
            ) : (
              <FileUp />
            )}{' '}
            Import
          </Button>
        </>
      }
      tableHelp
      help={
        <p className='text-muted-foreground'>
          Select a subnet to load all of its addresses. Create IP previews are
          checked against the latest API data; existing addresses are disabled.
          After creation, CloudTool reloads the subnet and can automatically add
          subsequent addresses until the requested quantity is satisfied.
        </p>
      }
    >
      <Card>
        <CardContent className='space-y-4'>
          <div className='grid gap-3 border-b pb-4 lg:grid-cols-[minmax(20rem,1fr)_auto] lg:items-end'>
            <div className='min-w-0 space-y-2'>
              <Label>Subnet</Label>
              <SearchableSelect
                value={subnetId}
                onValueChange={(value) => {
                  setSubnetId(value)
                  setCreationResults([])
                  setPreviewRows([])
                }}
                loading={subnets.isLoading}
                placeholder='Select subnet'
                searchPlaceholder='Search subnet, CIDR or region...'
                options={[
                  {
                    value: '__all_private_ips__',
                    label: '★ ALL PRIVATE IPs',
                    description: 'Project-wide private IP inventory',
                  },
                  ...(subnets.data?.items.map((subnet) => ({
                    value: subnet.id,
                    label: subnet.display_name || subnet.name,
                    description: `${subnet.cidr} · ${subnet.region}`,
                  })) ?? []),
                ]}
              />
            </div>
            <div className='flex flex-wrap items-center justify-end gap-2'>
              <div className='inline-flex h-8 shrink-0 items-center rounded-md border bg-muted/40 p-0.5'>
                {(
                  [
                    { value: 'available', label: 'Available' },
                    { value: 'all', label: 'All' },
                  ] as const
                ).map((tab) => (
                  <Button
                    key={tab.value}
                    type='button'
                    size='sm'
                    variant={ipScope === tab.value ? 'secondary' : 'ghost'}
                    className='h-7 px-3 text-xs'
                    onClick={() => setIpScope(tab.value)}
                  >
                    {tab.label}
                  </Button>
                ))}
              </div>
              <Button
                size='sm'
                className='max-w-64 gap-1.5'
                disabled={!subnetId || subnetId === '__all_private_ips__'}
                onClick={() => {
                  setCreateOpen(true)
                  setPreviewRows([])
                  setCreationResults([])
                }}
              >
                <Plus className='shrink-0' />
                <span className='shrink-0'>Create IP</span>
                <span
                  className='truncate'
                  title={
                    selectedSubnet?.display_name || selectedSubnet?.name || ''
                  }
                >
                  ·{' '}
                  {selectedSubnet?.display_name ||
                    selectedSubnet?.name ||
                    'selected subnet'}
                </span>
              </Button>
            </div>
          </div>
          {subnetId ? (
            <CloudDataTable
              data={displayedIps}
              columns={columns}
              getRowId={(row) => row.id}
              loading={
                subnetId === '__all_private_ips__'
                  ? allIps.isLoading
                  : ips.isLoading
              }
              entityName='private IP'
              exportFileName={`private-ips-${project.id}-${subnetId}`}
              searchPlaceholder='Search IP, ID, server, region or status...'
              isRowSelectable={(row) => privateIpStatus(row) === 'Available'}
              toolbar={(selected, clear) => (
                <div className='flex flex-wrap gap-2'>
                  <Button
                    variant='outline'
                    onClick={() =>
                      copySelected(selected, (row) => row.id, clear)
                    }
                  >
                    <Copy />
                    Copy selected IDs
                  </Button>
                  <Button
                    variant='destructive'
                    disabled={!selected.length}
                    onClick={() => setDeleteTargets(selected)}
                  >
                    <Trash2 />
                    Delete selected
                  </Button>
                </div>
              )}
            />
          ) : (
            <div className='py-16 text-center text-sm text-muted-foreground'>
              Select a subnet to display all of its private IP addresses.
            </div>
          )}
        </CardContent>
      </Card>

      <input
        ref={multiFileRef}
        type='file'
        accept='.xlsx'
        className='hidden'
        onChange={(event) =>
          void reviewMultiIpTemplate(event.target.files?.[0])
        }
      />
      <Dialog
        open={multiIpOpen}
        onOpenChange={(open) => !multiIpCreating && setMultiIpOpen(open)}
      >
        <DialogContent className='max-h-[90vh] sm:max-w-7xl'>
          <DialogHeader>
            <DialogTitle>Add private IPs to multiple subnets</DialogTitle>
            <DialogDescription>
              Template rows expand to individual IP operations and are reviewed
              before creation.
            </DialogDescription>
          </DialogHeader>
          {!multiIpRows.length ? (
            <div>
              <Button
                disabled={multiTemplateImporting}
                onClick={() => multiFileRef.current?.click()}
              >
                {multiTemplateImporting ? (
                  <Loader2 className='animate-spin' />
                ) : (
                  <FileUp />
                )}{' '}
                Import XLSX
              </Button>
            </div>
          ) : (
            <CloudDataTable
              data={multiIpRows}
              columns={[
                { accessorKey: 'row', header: '#' },
                { accessorKey: 'subnet_name', header: 'Subnet' },
                {
                  accessorKey: 'ip_address',
                  header: 'IP address',
                  cell: ({ row }) => (
                    <span className='font-mono'>
                      {row.original.ip_address || 'Invalid / missing IP'}
                    </span>
                  ),
                },
                {
                  accessorKey: 'source',
                  header: 'Template source',
                  cell: ({ row }) => (
                    <span
                      className='block max-w-72 truncate text-xs'
                      title={row.original.source}
                    >
                      {row.original.source}
                    </span>
                  ),
                },
                {
                  accessorKey: 'validation',
                  header: 'Review',
                  cell: ({ row }) => (
                    <span
                      className={
                        row.original.ready
                          ? 'text-emerald-600'
                          : 'text-destructive'
                      }
                    >
                      {row.original.validation}
                    </span>
                  ),
                },
              ]}
              getRowId={(row) => row.key}
              entityName='private IP'
              isRowSelectable={(row) => row.ready}
              initialPageSize={100}
              pageSizeOptions={[10, 25, 50, 100, 200, 500]}
              toolbar={(selected) => (
                <Button
                  onClick={() => {
                    setMultiIpCreateItems(selected)
                    setMultiIpConfirm(true)
                  }}
                >
                  Create selected ({selected.length})
                </Button>
              )}
            />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={multiIpConfirm}
        onOpenChange={(open) => !multiIpCreating && setMultiIpConfirm(open)}
        title={`Create ${multiIpCreateItems.length} private IP(s)?`}
        desc='IPs are created sequentially through the audited Cloud API gateway. A failed IP does not stop remaining items.'
        confirmText={
          <>
            {multiIpCreating && <Loader2 className='animate-spin' />} Create IPs
          </>
        }
        isLoading={multiIpCreating}
        handleConfirm={() => void createMultiIps()}
      />
      <Dialog
        open={Boolean(multiIpResults.length)}
        onOpenChange={(open) => !open && setMultiIpResults([])}
      >
        <DialogContent className='max-h-[90vh] sm:max-w-6xl'>
          <DialogHeader>
            <DialogTitle>Multi-subnet private IP results</DialogTitle>
            <DialogDescription>
              {
                multiIpResults.filter((row) => row.status === 'completed')
                  .length
              }{' '}
              of {multiIpResults.length} IP(s) created.
            </DialogDescription>
          </DialogHeader>
          <CloudDataTable
            data={multiIpResults}
            columns={[
              { accessorKey: 'subnet_name', header: 'Subnet' },
              { accessorKey: 'ip_address', header: 'IP address' },
              { accessorKey: 'ip_id', header: 'IP ID' },
              { accessorKey: 'status', header: 'Status' },
              { accessorKey: 'error', header: 'Detail' },
            ]}
            getRowId={(row) => row.key}
            entityName='private IP result'
            enableSelection={false}
            initialPageSize={100}
            pageSizeOptions={[10, 25, 50, 100, 200, 500]}
          />
          <DialogFooter>
            <Button onClick={() => setMultiIpResults([])}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(viewIp)}
        onOpenChange={(open) => !open && setViewIp(undefined)}
      >
        <DialogContent className='sm:!max-w-3xl'>
          <DialogHeader>
            <DialogTitle>Private IP details</DialogTitle>
            <DialogDescription>
              Complete information for {viewIp?.ip_address}.
            </DialogDescription>
          </DialogHeader>
          <div className='max-h-[65vh] overflow-auto rounded-md border'>
            <Table>
              <TableBody>
                {Object.entries(viewIp ?? {}).map(([key, value]) => (
                  <TableRow key={key}>
                    <TableCell className='w-52 align-top font-mono text-xs font-medium'>
                      {key}
                    </TableCell>
                    <TableCell>
                      <ServerDetailValue value={value} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button onClick={() => setViewIp(undefined)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!creating) setCreateOpen(open)
        }}
      >
        <DialogContent className='max-h-[92vh] gap-3 overflow-y-auto sm:!max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Create private IPs</DialogTitle>
            <DialogDescription>
              Enter addresses, preview availability, and create selected IPs.
            </DialogDescription>
          </DialogHeader>
          <div className='flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2 text-xs'>
            <div className='flex flex-wrap items-center gap-x-4 gap-y-1'>
              <span className='font-medium'>
                {selectedSubnet?.display_name || selectedSubnet?.name || '—'}
              </span>
              <span className='font-mono text-muted-foreground'>
                {selectedSubnet?.cidr || '—'}
              </span>
              <span className='text-muted-foreground'>
                {selectedSubnet?.region || '—'}
              </span>
            </div>
            {creationResults.length > 0 && (
              <Button
                size='sm'
                variant='outline'
                disabled={
                  !creationResults.some(
                    (result) => result.status === 'completed'
                  )
                }
                onClick={exportSuccessfulIps}
              >
                <Download /> Export successful IPs
              </Button>
            )}
          </div>
          {creationResults.length ? (
            <div className='min-w-0 space-y-4'>
              <div className='max-w-full overflow-x-auto'>
                <div className='min-w-[760px]'>
                  <CloudDataTable
                    data={creationResults}
                    columns={resultColumns}
                    getRowId={(row) =>
                      `${row.ip_address}-${row.auto_added ?? false}`
                    }
                    entityName='creation result'
                    exportFileName={`private-ip-results-${subnetId}`}
                    searchPlaceholder='Search result by IP, ID or status...'
                  />
                </div>
              </div>
              <div className='hidden'>
                <Button
                  variant='outline'
                  disabled={
                    !creationResults.some(
                      (result) => result.status === 'completed'
                    )
                  }
                  onClick={exportSuccessfulIps}
                >
                  <Download />
                  Export successful IPs
                </Button>
              </div>
            </div>
          ) : (
            <div className='space-y-4'>
              <div className='space-y-3'>
                <SegmentedTabs
                  value={createMode}
                  onValueChange={(value) => {
                    setCreateMode(value)
                    setPreviewRows([])
                  }}
                  tabs={[
                    { value: 'range', label: 'Start and end IP' },
                    { value: 'count', label: 'Start IP and quantity' },
                  ]}
                />
                <div className='grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto]'>
                  <div className='space-y-2'>
                    <Label htmlFor='create-start-ip'>Starting IP</Label>
                    <Input
                      id='create-start-ip'
                      value={startIp}
                      onChange={(event) => setStartIp(event.target.value)}
                      placeholder='10.0.0.10'
                    />
                  </div>
                  {createMode === 'range' ? (
                    <div className='space-y-2'>
                      <Label htmlFor='create-end-ip'>Ending IP</Label>
                      <Input
                        id='create-end-ip'
                        value={endIp}
                        onChange={(event) => setEndIp(event.target.value)}
                        placeholder='10.0.0.20'
                      />
                    </div>
                  ) : (
                    <div className='space-y-2'>
                      <Label htmlFor='create-ip-count'>Quantity</Label>
                      <Input
                        id='create-ip-count'
                        type='number'
                        inputMode='numeric'
                        min={1}
                        max={1000}
                        step={1}
                        value={count}
                        onWheel={(event) => event.currentTarget.blur()}
                        onChange={(event) => {
                          const value = event.target.value
                          if (value === '') {
                            setCount('')
                            return
                          }
                          const parsed = Number.parseInt(value, 10)
                          setCount(
                            Number.isNaN(parsed)
                              ? ''
                              : Math.min(1000, Math.max(1, parsed))
                          )
                        }}
                      />
                    </div>
                  )}
                  <Button
                    className='min-w-40 shadow-sm sm:col-span-2 lg:col-span-1'
                    disabled={
                      !startIp ||
                      (createMode === 'range'
                        ? !endIp
                        : count === '' || count < 1) ||
                      creating ||
                      previewing
                    }
                    onClick={previewIps}
                  >
                    {previewing ? (
                      <Loader2 className='animate-spin' />
                    ) : (
                      <Eye />
                    )}
                    {previewing ? 'Checking…' : 'Preview IPs'}
                  </Button>
                </div>
                <div className='flex flex-col gap-3 rounded-lg border bg-muted/30 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between'>
                  <label className='flex min-w-0 cursor-pointer items-start gap-2.5'>
                    <Checkbox
                      className='mt-0.5'
                      checked={autoFill}
                      onCheckedChange={(value) => setAutoFill(Boolean(value))}
                    />
                    <span className='min-w-0'>
                      <span className='block text-sm font-medium text-foreground'>
                        Auto-fill replacements
                      </span>
                      <span className='block text-xs text-muted-foreground'>
                        Try the next address only when verification returns
                        fewer IPs.
                      </span>
                    </span>
                  </label>
                  <div className='flex shrink-0 items-center gap-2 sm:border-l sm:pl-3'>
                    <Label
                      htmlFor='max-auto-fill'
                      className={`text-xs whitespace-nowrap ${autoFill ? '' : 'text-muted-foreground'}`}
                    >
                      Max attempts
                    </Label>
                    <Input
                      id='max-auto-fill'
                      className='h-8 w-16 text-center text-sm'
                      type='number'
                      min={0}
                      max={1000}
                      step={1}
                      disabled={!autoFill}
                      value={maxAutoFill}
                      onWheel={(event) => event.currentTarget.blur()}
                      onChange={(event) => {
                        const value = Number.parseInt(event.target.value, 10)
                        setMaxAutoFill(
                          Number.isNaN(value)
                            ? 0
                            : Math.min(1000, Math.max(0, value))
                        )
                      }}
                    />
                    <span className='text-[11px] text-muted-foreground'>
                      1/5 default
                    </span>
                  </div>
                </div>
              </div>
              {previewRows.length > 0 && (
                <div className='space-y-2 border-t pt-3'>
                  <p className='text-xs text-muted-foreground'>
                    Select available IPs below. Existing addresses are disabled.
                  </p>
                  <CloudDataTable
                    data={previewRows}
                    columns={previewColumns}
                    getRowId={(row) => row.ip_address}
                    entityName='IP preview'
                    exportFileName={`private-ip-preview-${subnetId}`}
                    searchPlaceholder='Search preview IP or availability...'
                    isRowSelectable={(row) => !row.exists}
                    toolbar={(selected) => (
                      <Button
                        disabled={!selected.length}
                        onClick={() => {
                          setSelectedPreview(selected)
                          setConfirmCreate(true)
                        }}
                      >
                        <Plus />
                        Create {selected.length} selected IP(s)
                      </Button>
                    )}
                  />
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant='outline'
              disabled={creating}
              onClick={() => setCreateOpen(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmCreate}
        onOpenChange={(open) => !creating && setConfirmCreate(open)}
        title='Create selected private IPs?'
        desc={`CloudTool will create ${selectedPreview.length} selected address(es), reload all IPs in the subnet, and ${autoFill ? 'automatically add subsequent addresses if the verified quantity is insufficient' : 'report any missing addresses without automatically replacing them'}.`}
        confirmText='Create and verify'
        isLoading={creating}
        handleConfirm={createSelectedIps}
      />

      <ConfirmDialog
        open={deleteTargets.length > 0}
        onOpenChange={(open) => !deleting && !open && setDeleteTargets([])}
        title={`Delete ${deleteTargets.length} available private IP(s)?`}
        desc='This permanently deletes the selected unreserved and unattached addresses from the current subnet. This action cannot be undone.'
        confirmText='Delete IPs'
        destructive
        isLoading={deleting}
        handleConfirm={deleteSelectedIps}
      />

      <Dialog
        open={deletionResults.length > 0}
        onOpenChange={(open) => !open && setDeletionResults([])}
      >
        <DialogContent className='max-h-[85vh] sm:!max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Private IP deletion results</DialogTitle>
            <DialogDescription>
              Result returned for every selected private IP.
            </DialogDescription>
          </DialogHeader>
          <div className='min-w-0 overflow-x-auto'>
            <div className='min-w-[760px]'>
              <CloudDataTable
                data={deletionResults}
                columns={deletionResultColumns}
                getRowId={(row) => row.ip_id}
                entityName='deletion result'
                exportFileName={`private-ip-deletion-results-${subnetId}`}
                searchPlaceholder='Search IP, ID, result or message...'
                enableSelection={false}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setDeletionResults([])}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={creating} onOpenChange={() => undefined}>
        <DialogContent
          showCloseButton={false}
          className='sm:!max-w-md'
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader className='items-center text-center sm:text-center'>
            <div className='mb-2 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary'>
              <Loader2 className='size-7 animate-spin' />
            </div>
            <DialogTitle>Creating private IPs</DialogTitle>
            <DialogDescription>
              Keep this page open while CloudTool creates and verifies every
              address against the Cloud API.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-3 rounded-lg border bg-muted/30 p-4'>
            <div className='flex items-center justify-between gap-3 text-sm'>
              <span className='font-medium'>{creationProgress.phase}</span>
              <span className='shrink-0 text-muted-foreground tabular-nums'>
                {creationProgress.completed}/{creationProgress.total}
              </span>
            </div>
            <div className='h-2 overflow-hidden rounded-full bg-muted'>
              <div
                className='h-full rounded-full bg-primary transition-[width] duration-300'
                style={{
                  width: `${creationProgress.total ? Math.min(100, (creationProgress.completed / creationProgress.total) * 100) : 0}%`,
                }}
              />
            </div>
            {creationProgress.currentIp && (
              <p className='truncate font-mono text-xs text-muted-foreground'>
                Processing {creationProgress.currentIp}
              </p>
            )}
          </div>
          <p className='text-center text-xs text-muted-foreground'>
            This may take several minutes when creating many addresses.
          </p>
        </DialogContent>
      </Dialog>
    </CloudPageShell>
  )
}

interface AttachPreviewRow {
  server_id: string
  server_name: string
  current_ip: string
  new_ip_address: string
  ip_id?: string
  validation: string
  ready: boolean
}

interface AttachResultRow extends AttachPreviewRow {
  api_status: string
  verified_status: 'verified' | 'failed'
  executed_at: string
  error?: string
  request?: unknown
  response?: unknown
}

interface DetachPrivateIpTarget {
  server_id: string
  server_name: string
  ip_id: string
  ip_address: string
}

async function fetchProjectPrivateIps(subnets: Subnet[]) {
  return (
    await Promise.all(subnets.map((subnet) => fetchAllPrivateIps(subnet.id)))
  ).flat()
}

async function fetchAllServers(signal?: AbortSignal) {
  const items: ServerRow[] = []
  let page = 1
  let total: number
  do {
    const response = await apiClient.get<Page<ServerRow>>('/cloud/servers', {
      params: { page, page_size: 200 },
      signal,
    })
    items.push(...response.data.items)
    total = response.data.total
    page += 1
  } while (items.length < total)
  return items
}

export function AttachPrivateIpsPage() {
  const projectId = useCloudStore((state) => state.project?.id)
  return <AttachPrivateIpsWorkspace key={projectId} />
}

function AttachPrivateIpsWorkspace({
  embedded = false,
  initialServers = [],
  onClose,
}: {
  embedded?: boolean
  initialServers?: ServerRow[]
  onClose?: () => void
} = {}) {
  const project = useCloudStore((state) => state.project)!
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [selectedServers, setSelectedServers] =
    useState<ServerRow[]>(initialServers)
  const [attachOpen, setAttachOpen] = useState(embedded)
  const [privateIpTab, setPrivateIpTab] = useState<'attach' | 'detach'>(
    'attach'
  )
  const [detachSelection, setDetachSelection] = useState<string[]>([])
  const [pendingDetachTargets, setPendingDetachTargets] = useState<
    DetachPrivateIpTarget[]
  >([])
  const [detachResults, setDetachResults] = useState<
    Array<
      DetachPrivateIpTarget & {
        status: string
        error?: string
        request?: unknown
        response?: unknown
      }
    >
  >([])
  const [ipOperationDetail, setIpOperationDetail] = useState<{
    title: string
    request?: unknown
    response?: unknown
    error?: string
  }>()
  const [mode, setMode] = useState<'available' | 'ordered' | 'custom'>(
    'available'
  )
  const [availableSubnetId, setAvailableSubnetId] = useState('')
  const [availableAssignmentIds, setAvailableAssignmentIds] = useState<
    string[]
  >([])
  const [availableMappingStarted, setAvailableMappingStarted] = useState(false)
  const [draggedAssignment, setDraggedAssignment] = useState<number>()
  const [ipText, setIpText] = useState('')
  const [customRecords, setCustomRecords] = useState<
    Array<Record<string, string>>
  >([])
  const [importName, setImportName] = useState('')
  const [previewRows, setPreviewRows] = useState<AttachPreviewRow[]>([])
  const [executionRows, setExecutionRows] = useState<AttachPreviewRow[]>([])
  const [results, setResults] = useState<AttachResultRow[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [previewingMappings, setPreviewingMappings] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [attachProgress, setAttachProgress] = useState({
    completed: 0,
    total: 0,
    current: '',
    phase: 'Submitting attachments to the Cloud API…',
  })
  const [attachMarks, setAttachMarks] = useState<Record<string, string>>(() =>
    readAttachMarkers(project.id)
  )
  const [viewServer, setViewServer] = useState<ServerRow>()
  const servers = useQuery({
    queryKey: ['cloud', project.id, 'servers', 'attach-private-ips'],
    queryFn: ({ signal }) => fetchAllServers(signal),
    enabled: !embedded,
  })
  const subnets = useQuery({
    queryKey: ['cloud', project.id, 'subnets', 'attach-private-ips'],
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Page<Subnet>>('/cloud/subnets', {
          params: { page_size: 1000 }, signal,
        })
      ).data,
  })
  const availableIps = useQuery({
    queryKey: [
      'cloud',
      project.id,
      'attach-private-ips',
      'available',
      availableSubnetId,
    ],
    enabled: attachOpen && mode === 'available' && Boolean(availableSubnetId),
    queryFn: ({ signal }) => fetchAllPrivateIps(availableSubnetId, false, signal),
  })
  const attachableIps = (availableIps.data ?? []).filter(
    (ip) => !ip.server && !ip.description
  )
  const detachCandidates = useMemo<DetachPrivateIpTarget[]>(
    () =>
      selectedServers.flatMap((server) =>
        (server.private_ip ?? []).map((ip) => ({
          server_id: server.id,
          server_name: server.name,
          ip_id: ip.id,
          ip_address: ip.ip_address,
        }))
      ),
    [selectedServers]
  )
  const availableIpById = new Map(
    attachableIps.map((ip) => [ip.id, ip] as const)
  )
  const effectiveAssignmentIds = availableAssignmentIds
  const serverDetail = useQuery({
    queryKey: [
      'cloud',
      project.id,
      'attach-private-ips-server-detail',
      viewServer?.id,
    ],
    enabled: Boolean(viewServer),
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Record<string, unknown>>(
          `/cloud/servers/${viewServer!.id}`, { signal }
        )
      ).data,
  })
  const columns = useMemo<ColumnDef<ServerRow>[]>(
    () => [
      {
        accessorKey: 'name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server' />
        ),
        cell: ({ row }) => <p className='font-medium'>{row.original.name}</p>,
      },
      {
        id: 'elastic_ip',
        accessorFn: (row) =>
          (row.elastic_ip ?? []).map((ip) => ip.ip_address).join(', '),
        header: ({ column }) => (
          <SortableHeader column={column} title='Elastic IP' />
        ),
        cell: ({ row }) => (
          <IpAddressList addresses={row.original.elastic_ip} />
        ),
      },
      {
        id: 'private_ip',
        accessorFn: (row) =>
          (row.private_ip ?? []).map((ip) => ip.ip_address).join(', '),
        header: ({ column }) => (
          <SortableHeader column={column} title='Private IP' />
        ),
        cell: ({ row }) => (
          <IpAddressList addresses={row.original.private_ip} />
        ),
      },
      {
        accessorKey: 'server_type',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server type' />
        ),
      },
      {
        accessorKey: 'zone_display_name',
        header: ({ column }) => <SortableHeader column={column} title='Zone' />,
      },
      {
        accessorKey: 'bandwidth',
        header: ({ column }) => (
          <SortableHeader column={column} title='Bandwidth' />
        ),
        cell: ({ getValue }) => (getValue() as number | undefined) ?? '—',
      },
      {
        id: 'last_attach_at',
        accessorFn: (row) => attachMarks[row.id] ?? '',
        header: ({ column }) => (
          <SortableHeader column={column} title='Last attached' />
        ),
        cell: ({ row }) =>
          attachMarks[row.original.id] ? (
            <span className='font-medium text-emerald-600'>
              {attachMarks[row.original.id]}
            </span>
          ) : (
            '—'
          ),
      },
      {
        id: 'actions',
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions id={row.original.id} label='server ID'>
            <DropdownMenuItem onClick={() => setViewServer(row.original)}>
              <Eye />
              View details
            </DropdownMenuItem>
          </RowActions>
        ),
      },
    ],
    [attachMarks]
  )
  const previewColumns = useMemo<ColumnDef<AttachPreviewRow>[]>(
    () => [
      {
        accessorKey: 'server_name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server' />
        ),
      },
      {
        accessorKey: 'server_id',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server ID' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'current_ip',
        header: ({ column }) => (
          <SortableHeader column={column} title='Current IP before attach' />
        ),
      },
      {
        accessorKey: 'new_ip_address',
        header: ({ column }) => (
          <SortableHeader column={column} title='New IP address' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-sm'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'ip_id',
        header: ({ column }) => (
          <SortableHeader column={column} title='Private IP ID' />
        ),
        cell: ({ getValue }) => (getValue() as string | undefined) || '—',
      },
      {
        accessorKey: 'validation',
        header: ({ column }) => (
          <SortableHeader column={column} title='Validation' />
        ),
      },
    ],
    []
  )
  const availableIpColumns = useMemo<ColumnDef<PrivateIp>[]>(
    () => [
      {
        accessorKey: 'ip_address',
        header: ({ column }) => (
          <SortableHeader column={column} title='IP address' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono font-medium'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'region',
        header: ({ column }) => (
          <SortableHeader column={column} title='Region' />
        ),
        cell: ({ getValue }) => (getValue() as string | undefined) || '—',
      },
      {
        accessorKey: 'created_at',
        header: ({ column }) => (
          <SortableHeader column={column} title='Created at' />
        ),
        cell: ({ getValue }) => (getValue() as string | undefined) || '—',
      },
      {
        id: 'availability',
        header: 'Status',
        cell: () => (
          <Badge
            variant='outline'
            className='border-emerald-500/40 text-emerald-600'
          >
            Available
          </Badge>
        ),
      },
    ],
    []
  )
  const resultColumns = useMemo<ColumnDef<AttachResultRow>[]>(
    () => [
      {
        accessorKey: 'server_name',
        header: ({ column }) => (
          <SortableHeader column={column} title='Server' />
        ),
      },
      {
        accessorKey: 'new_ip_address',
        header: ({ column }) => (
          <SortableHeader column={column} title='Private IP' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'verified_status',
        header: ({ column }) => (
          <SortableHeader column={column} title='Status' />
        ),
        cell: ({ row }) => {
          const succeeded = row.original.verified_status === 'verified'
          return (
            <Badge
              variant={succeeded ? 'outline' : 'destructive'}
              className={
                succeeded ? 'border-emerald-500/40 text-emerald-600' : undefined
              }
            >
              {succeeded ? 'Succeeded' : 'Failed'}
            </Badge>
          )
        },
      },
      {
        accessorKey: 'error',
        header: ({ column }) => (
          <SortableHeader column={column} title='Error' />
        ),
        cell: ({ getValue }) => {
          const error = getValue() as string | undefined
          return error ? (
            <p className='max-w-96 text-xs leading-5 break-words text-red-600 dark:text-red-400'>
              {error}
            </p>
          ) : (
            '—'
          )
        },
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <RowActions
            id={`${row.original.server_id}:${row.original.ip_id}`}
            label='operation ID'
          >
            <DropdownMenuItem
              onClick={() =>
                setIpOperationDetail({
                  title: `Attach private IP · ${row.original.server_name}`,
                  request: row.original.request,
                  response: row.original.response,
                  error: row.original.error,
                })
              }
            >
              <Eye /> View API details
            </DropdownMenuItem>
          </RowActions>
        ),
      },
    ],
    []
  )

  function resetImport() {
    setMode('available')
    setAvailableSubnetId('')
    setAvailableAssignmentIds([])
    setAvailableMappingStarted(false)
    setIpText('')
    setCustomRecords([])
    setImportName('')
    setPreviewRows([])
    setExecutionRows([])
    setResults([])
  }

  function downloadTemplate() {
    downloadXlsx(
      ['SERVER ID', 'SERVER NAME', 'CURRENT IP', 'NEW IP ADDRESS'],
      selectedServers.map((server) => [
        server.id,
        server.name,
        server.private_ip?.[0]?.ip_address ?? '',
        '',
      ]),
      `attach-private-ip-template-${project.id}.xlsx`,
      {
        title: 'ATTACH PRIVATE IP TEMPLATE',
        metadata: [
          {
            label: 'Instructions',
            value:
              'Enter one new private IP in NEW IP ADDRESS. Do not change SERVER ID.',
          },
          { label: 'Project', value: project.id },
          { label: 'Selected servers', value: String(selectedServers.length) },
        ],
        sheetName: 'Attach IP Template',
      }
    )
  }

  async function importOrderedFile(file?: File) {
    if (!file) return
    try {
      const records = rowsFromHeader(parseXlsxRows(await file.arrayBuffer()), [
        'IP ADDRESS',
      ])
      const addresses = records
        .map((record) => record['IP ADDRESS'])
        .filter(Boolean)
      setIpText(addresses.join('\n'))
      setImportName(file.name)
      setPreviewRows([])
      toast.success(`${addresses.length} IP address(es) imported.`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'The Excel file is invalid.'
      )
    }
  }

  async function importCustomFile(file?: File) {
    if (!file) return
    try {
      const records = rowsFromHeader(parseXlsxRows(await file.arrayBuffer()), [
        'SERVER ID',
        'NEW IP ADDRESS',
      ])
      setCustomRecords(records)
      setImportName(file.name)
      setPreviewRows([])
      toast.success(`${records.length} custom mapping(s) imported.`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'The Excel file is invalid.'
      )
    }
  }

  async function buildPreview(availableSelection?: PrivateIp[]) {
    setPreviewingMappings(true)
    try {
      const allIps = await fetchProjectPrivateIps(subnets.data?.items ?? [])
      const ipByAddress = new Map(
        allIps.map((ip) => [ip.ip_address, ip] as const)
      )
      const selectedById = new Map(
        selectedServers.map((server) => [server.id, server] as const)
      )
      const inputs =
        mode === 'available'
          ? (availableSelection ?? []).map((ip, index) => ({
              server: selectedServers[index],
              newIp: ip.ip_address,
            }))
          : mode === 'ordered'
            ? ipText
                .split(/[\r\n,;']+/)
                .map((value) => value.trim())
                .filter(Boolean)
                .map((newIp, index) => ({
                  server: selectedServers[index],
                  newIp,
                }))
            : customRecords.map((record) => ({
                server: selectedById.get(record['SERVER ID']),
                newIp: record['NEW IP ADDRESS']?.trim(),
              }))
      const duplicates = new Set<string>()
      const seen = new Set<string>()
      for (const input of inputs) {
        if (seen.has(input.newIp)) duplicates.add(input.newIp)
        seen.add(input.newIp)
      }
      const nextRows = inputs.map(({ server, newIp }, index) => {
        const ip = ipByAddress.get(newIp)
        let validation = 'Ready to attach'
        if (!server) validation = 'Server is not in the selected list'
        else if (!newIp) validation = 'New IP address is required'
        else if (!ip) validation = 'IP address was not found in this project'
        else if (duplicates.has(newIp))
          validation = 'IP address is duplicated in this import'
        else if (ip.server) validation = 'IP address is already attached'
        else if (ip.description)
          validation = 'IP address is reserved or unavailable'
        return {
          server_id: server?.id ?? `invalid-server-${index + 1}`,
          server_name: server?.name ?? 'Unknown server',
          current_ip:
            server?.private_ip?.map((item) => item.ip_address).join(', ') ?? '',
          new_ip_address: newIp,
          ip_id: ip?.id,
          validation,
          ready: validation === 'Ready to attach',
        }
      })
      setPreviewRows(nextRows)
      setResults([])
      if (!nextRows.length)
        toast.warning('No server and IP mappings were found to preview.')
    } catch {
      toast.error('Private IP availability could not be loaded.')
    } finally {
      setPreviewingMappings(false)
    }
  }

  async function executeAttach() {
    setProcessing(true)
    setConfirmOpen(false)
    setAttachProgress({
      completed: 0,
      total: executionRows.length,
      current: '',
      phase: 'Submitting attachments to the Cloud API…',
    })
    try {
      const response = await apiClient.post<{
        items: Array<{
          server_id: string
          ip_id: string
          status: string
          error?: string
          request?: unknown
          response?: unknown
        }>
      }>('/cloud/servers/attach-private-ips', {
        items: executionRows.map((row) => ({
          server_id: row.server_id,
          ip_id: row.ip_id,
        })),
      })
      const apiResults = new Map(
        response.data.items.map((item) => [
          `${item.server_id}:${item.ip_id}`,
          item,
        ])
      )
      const executedAt = new Date().toLocaleString()
      setAttachProgress({
        completed: 0,
        total: executionRows.length,
        current: executionRows[0]?.server_name ?? '',
        phase: 'Reloading servers and verifying attachments…',
      })
      const verifiedRows = await Promise.all(
        executionRows.map(async (row): Promise<AttachResultRow> => {
          const apiResult = apiResults.get(`${row.server_id}:${row.ip_id}`)
          setAttachProgress((current) => ({
            ...current,
            current: row.server_name,
          }))
          try {
            const detail = (
              await apiClient.get<ServerRow>(`/cloud/servers/${row.server_id}`)
            ).data
            const attached = (detail.private_ip ?? []).some(
              (ip) =>
                ip.id === row.ip_id || ip.ip_address === row.new_ip_address
            )
            const result: AttachResultRow = {
              ...row,
              api_status: apiResult?.status ?? 'unknown',
              verified_status: attached ? 'verified' : 'failed',
              executed_at: executedAt,
              error:
                apiResult?.error ??
                (attached
                  ? undefined
                  : 'IP was not present in server detail after attach.'),
              request: apiResult?.request,
              response: apiResult?.response,
            }
            return result
          } catch {
            const result: AttachResultRow = {
              ...row,
              api_status: apiResult?.status ?? 'unknown',
              verified_status: 'failed',
              executed_at: executedAt,
              error: apiResult?.error ?? 'Server detail verification failed.',
              request: apiResult?.request,
              response: apiResult?.response,
            }
            return result
          } finally {
            setAttachProgress((current) => ({
              ...current,
              completed: Math.min(current.total, current.completed + 1),
            }))
          }
        })
      )
      setResults(verifiedRows)
      const verified = verifiedRows.filter(
        (row) => row.verified_status === 'verified'
      )
      setAttachMarks((current) => {
        const next = {
          ...current,
          ...Object.fromEntries(
            verified.map((row) => [row.server_id, executedAt])
          ),
        }
        writeAttachMarkers(project.id, next)
        return next
      })
      setPreviewRows([])
      setExecutionRows([])
      setAttachProgress((current) => ({
        ...current,
        current: '',
        phase: 'Refreshing the server list…',
      }))
      await queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'servers'],
      })
      toast.success(
        `${verified.length}/${verifiedRows.length} attachment(s) verified.`
      )
    } catch {
      toast.error('The attach operation could not be completed.')
    } finally {
      setProcessing(false)
    }
  }

  async function executeDetach(selected?: DetachPrivateIpTarget[]) {
    const targets =
      selected ??
      detachCandidates.filter((item) =>
        detachSelection.includes(`${item.server_id}:${item.ip_id}`)
      )
    if (!targets.length) return
    setProcessing(true)
    setDetachResults([])
    setAttachProgress({
      completed: 0,
      total: targets.length,
      current: '',
      phase: 'Detaching private IPs sequentially…',
    })
    const nextResults: Array<
      DetachPrivateIpTarget & {
        status: string
        error?: string
        request?: unknown
        response?: unknown
      }
    > = []
    try {
      // Small batches keep a large selection observable and avoid a single
      // long-running browser request while the backend remains sequential.
      for (let start = 0; start < targets.length; start += 25) {
        const batch = targets.slice(start, start + 25)
        const response = await apiClient.post<{
          items: Array<{
            server_id: string
            ip_id: string
            status: string
            error?: string
            request?: unknown
            response?: unknown
          }>
        }>('/cloud/servers/detach-private-ips', {
          items: batch.map(({ server_id, ip_id }) => ({ server_id, ip_id })),
        })
        const resultById = new Map(
          response.data.items.map((item) => [
            `${item.server_id}:${item.ip_id}`,
            item,
          ])
        )
        nextResults.push(
          ...batch.map((item) => ({
            ...item,
            status:
              resultById.get(`${item.server_id}:${item.ip_id}`)?.status ??
              'failed',
            error: resultById.get(`${item.server_id}:${item.ip_id}`)?.error,
            request: resultById.get(`${item.server_id}:${item.ip_id}`)?.request,
            response: resultById.get(`${item.server_id}:${item.ip_id}`)
              ?.response,
          }))
        )
        setDetachResults([...nextResults])
        setAttachProgress({
          completed: nextResults.length,
          total: targets.length,
          current: batch[batch.length - 1]?.server_name ?? '',
          phase: 'Detaching private IPs sequentially…',
        })
      }
      await queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'servers'],
      })
      toast.success(
        `${nextResults.filter((item) => item.status !== 'failed').length}/${targets.length} private IP(s) detached.`
      )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Private IP detach failed.'
      )
    } finally {
      setProcessing(false)
    }
  }

  const detailRecord =
    serverDetail.data ??
    (viewServer as unknown as Record<string, unknown> | undefined)
  const detailElasticIps = normalizeServerIps(detailRecord?.elastic_ip)
  const detailPrivateIps = normalizeServerIps(detailRecord?.private_ip)

  return (
    <CloudPageShell
      title='Attach private IPs'
      description='Select servers, map available private IPs and verify every attachment.'
      tableHelp
      help={
        <p className='text-muted-foreground'>
          Select servers first. Import an ordered IP list or download the custom
          Excel template. Every mapping is checked before selection, revalidated
          by the backend, and verified against server detail after attachment.
          Successful server markers are persisted by server ID in the backend.
        </p>
      }
      headless={embedded}
    >
      {!embedded && (
        <>
          <Card>
            <CardContent>
              <CloudDataTable
                data={servers.data ?? []}
                columns={columns}
                getRowId={(row) => row.id}
                loading={servers.isLoading}
                entityName='server'
                exportFileName={`attach-private-ip-servers-${project.id}`}
                searchPlaceholder='Search server, ID, elastic IP, private IP, type or zone...'
                toolbar={(selected) => (
                  <Button
                    className='shadow-sm'
                    onClick={() => {
                      setSelectedServers(selected)
                      resetImport()
                      setAttachOpen(true)
                    }}
                  >
                    <Link2 />
                    Attach private IP addresses
                  </Button>
                )}
              />
            </CardContent>
          </Card>

          <Dialog
            open={Boolean(viewServer)}
            onOpenChange={(open) => !open && setViewServer(undefined)}
          >
            <DialogContent className='max-h-[92vh] overflow-y-auto sm:!max-w-6xl'>
              <DialogHeader>
                <DialogTitle>Server details</DialogTitle>
                <DialogDescription>
                  Live server detail for {viewServer?.name}. IP addresses are
                  separated by type and include their Cloud resource IDs.
                </DialogDescription>
              </DialogHeader>
              {serverDetail.isLoading ? (
                <p className='py-12 text-center text-sm text-muted-foreground'>
                  Loading server details...
                </p>
              ) : serverDetail.isError ? (
                <p className='py-12 text-center text-sm text-destructive'>
                  Server details could not be loaded.
                </p>
              ) : (
                <div className='space-y-5'>
                  <div className='grid gap-4 lg:grid-cols-2'>
                    <ServerIpDetails
                      title='Elastic IP addresses'
                      type='Elastic'
                      addresses={detailElasticIps}
                    />
                    <ServerIpDetails
                      title='Private IP addresses'
                      type='Private'
                      addresses={detailPrivateIps}
                    />
                  </div>
                  <div className='space-y-2'>
                    <h3 className='text-sm font-semibold'>
                      Complete server information
                    </h3>
                    <div className='max-h-[45vh] overflow-auto rounded-md border'>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className='w-56'>Field</TableHead>
                            <TableHead>Value</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {Object.entries(detailRecord ?? {}).map(
                            ([key, value]) => (
                              <TableRow key={key}>
                                <TableCell className='align-top font-mono text-xs font-medium'>
                                  {key}
                                </TableCell>
                                <TableCell>
                                  <ServerDetailValue value={value} />
                                </TableCell>
                              </TableRow>
                            )
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button onClick={() => setViewServer(undefined)}>Close</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}

      <Dialog
        open={attachOpen}
        onOpenChange={(open) => {
          if (processing || previewingMappings) return
          setAttachOpen(open)
          if (!open) onClose?.()
        }}
      >
        <DialogContent className='grid h-[94svh] !w-[96vw] !max-w-[96vw] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:!max-w-[96vw]'>
          <DialogHeader>
            <div className='flex items-center justify-between gap-3 pe-8'>
              <DialogTitle>Private IP</DialogTitle>
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={() => {
                  setAttachOpen(false)
                  onClose?.()
                  void navigate({ to: '/private-ips' })
                }}
              >
                <Plus /> Create private IPs{' '}
                <ExternalLink className='size-3.5' />
              </Button>
            </div>
            <DialogDescription>
              {selectedServers.length} selected server(s). Import and preview
              mappings before choosing the rows to execute.
            </DialogDescription>
          </DialogHeader>
          <div className='min-h-0 overflow-y-auto pe-1'>
            <SegmentedTabs
              value={privateIpTab}
              onValueChange={(value) => {
                setPrivateIpTab(value as 'attach' | 'detach')
                setDetachResults([])
              }}
              tabs={[
                { value: 'attach', label: 'Attach' },
                { value: 'detach', label: 'Detach' },
              ]}
            />
            <div className='mt-4'>
              {privateIpTab === 'detach' ? (
                <div className='space-y-3'>
                  {detachResults.length > 0 ? (
                    <CloudDataTable
                      data={detachResults}
                      columns={[
                        { accessorKey: 'server_name', header: 'Server' },
                        { accessorKey: 'ip_address', header: 'Private IP' },
                        {
                          accessorKey: 'status',
                          header: 'Status',
                          cell: ({ getValue }) => {
                            const status = String(getValue() ?? '')
                            const succeeded = !['failed', 'error'].includes(
                              status.toLowerCase()
                            )
                            return (
                              <Badge
                                variant={succeeded ? 'outline' : 'destructive'}
                                className={
                                  succeeded
                                    ? 'border-emerald-500/40 text-emerald-600'
                                    : undefined
                                }
                              >
                                {succeeded ? 'Succeeded' : 'Failed'}
                              </Badge>
                            )
                          },
                        },
                        {
                          accessorKey: 'error',
                          header: 'Error',
                          cell: ({ getValue }) => {
                            const error = getValue() as string | undefined
                            return error ? (
                              <p className='max-w-96 text-xs leading-5 break-words text-destructive'>
                                {error}
                              </p>
                            ) : (
                              '—'
                            )
                          },
                        },
                        {
                          id: 'actions',
                          header: '',
                          cell: ({ row }) => (
                            <RowActions
                              id={`${row.original.server_id}:${row.original.ip_id}`}
                              label='operation ID'
                            >
                              <DropdownMenuItem
                                onClick={() =>
                                  setIpOperationDetail({
                                    title: `Detach private IP · ${row.original.server_name}`,
                                    request: row.original.request,
                                    response: row.original.response,
                                    error: row.original.error,
                                  })
                                }
                              >
                                <Eye /> View API details
                              </DropdownMenuItem>
                            </RowActions>
                          ),
                        },
                      ]}
                      getRowId={(row) => `${row.server_id}:${row.ip_id}`}
                      entityName='detach result'
                      exportFileName={`detach-private-ip-results-${project.id}`}
                    />
                  ) : (
                    <>
                      <p className='text-sm text-muted-foreground'>
                        Select one or more attached private IPs. Root networking
                        is not changed; each selected address is revalidated and
                        detached sequentially.
                      </p>
                      <CloudDataTable
                        data={detachCandidates}
                        columns={[
                          { accessorKey: 'server_name', header: 'Server' },
                          { accessorKey: 'ip_address', header: 'Private IP' },
                          { accessorKey: 'ip_id', header: 'IP ID' },
                        ]}
                        getRowId={(row) => `${row.server_id}:${row.ip_id}`}
                        entityName='attached private IP'
                        enableSelection
                        toolbar={(selected) => (
                          <Button
                            variant='destructive'
                            onClick={() => {
                              setDetachSelection(
                                selected.map(
                                  (item) => `${item.server_id}:${item.ip_id}`
                                )
                              )
                              setPendingDetachTargets(selected)
                            }}
                          >
                            <Trash2 /> Detach {selected.length} selected IP(s)
                          </Button>
                        )}
                      />
                    </>
                  )}
                </div>
              ) : results.length ? (
                <CloudDataTable
                  data={results}
                  columns={resultColumns}
                  getRowId={(row) => `${row.server_id}-${row.ip_id}`}
                  entityName='attach result'
                  exportFileName={`attach-private-ip-results-${project.id}`}
                  searchPlaceholder='Search verified attach results...'
                />
              ) : (
                <>
                  {mode === 'available' ? (
                    <div className='space-y-4'>
                      <div className='grid items-end gap-3 rounded-md border bg-muted/10 p-4 lg:grid-cols-[minmax(18rem,28rem)_minmax(0,1fr)]'>
                        <div className='space-y-2'>
                          <Label>Subnet</Label>
                          <SearchableSelect
                            value={availableSubnetId}
                            onValueChange={(value) => {
                              setAvailableSubnetId(value)
                              setAvailableAssignmentIds([])
                              setAvailableMappingStarted(false)
                              setPreviewRows([])
                            }}
                            loading={subnets.isLoading}
                            placeholder='Select a subnet'
                            searchPlaceholder='Search subnet, CIDR or region...'
                            options={(subnets.data?.items ?? []).map(
                              (subnet) => ({
                                value: subnet.id,
                                label: subnet.display_name || subnet.name,
                                description: `${subnet.cidr} · ${subnet.region}`,
                              })
                            )}
                          />
                        </div>
                        <div className='flex justify-end'>
                          <div className='flex flex-wrap gap-2'>
                            <Button
                              type='button'
                              size='sm'
                              variant='outline'
                              onClick={downloadTemplate}
                            >
                              <Download /> Template
                            </Button>
                            <Label className='inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border bg-background px-3 text-xs font-medium hover:bg-accent'>
                              <FileUp className='size-3.5' /> Import mapping
                              <Input
                                className='hidden'
                                type='file'
                                accept='.xlsx'
                                onChange={(event) => {
                                  setMode('custom')
                                  void importCustomFile(event.target.files?.[0])
                                  event.currentTarget.value = ''
                                }}
                              />
                            </Label>
                          </div>
                        </div>
                      </div>
                      {availableSubnetId ? (
                        availableIps.isLoading ? (
                          <div className='flex min-h-48 items-center justify-center rounded-md border'>
                            <Loader2 className='animate-spin text-muted-foreground' />
                          </div>
                        ) : !availableMappingStarted ? (
                          <CloudDataTable
                            key={availableSubnetId}
                            data={attachableIps}
                            columns={availableIpColumns}
                            getRowId={(row) => row.id}
                            entityName='available private IP'
                            exportFileName={`available-private-ips-${availableSubnetId}`}
                            searchPlaceholder='Search available IP address or region...'
                            toolbar={(selected) => (
                              <Button
                                disabled={
                                  !selected.length ||
                                  selected.length > selectedServers.length
                                }
                                onClick={() => {
                                  setAvailableAssignmentIds(
                                    selected.map((ip) => ip.id)
                                  )
                                  setAvailableMappingStarted(true)
                                }}
                              >
                                <Link2 /> Auto-map {selected.length} selected
                                IP(s)
                              </Button>
                            )}
                          />
                        ) : !previewRows.length ? (
                          <div className='overflow-hidden rounded-md border'>
                            <div className='flex items-center justify-between gap-3 border-b bg-muted/30 px-4 py-2.5'>
                              <div>
                                <p className='text-sm font-semibold'>
                                  Server and IP mapping
                                </p>
                                <p className='text-xs text-muted-foreground'>
                                  Drag a row onto another row to swap IP
                                  assignments, or search for a specific IP.
                                </p>
                              </div>
                              <Badge variant='outline'>
                                {attachableIps.length} IPs available
                              </Badge>
                            </div>
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead className='w-10' />
                                  <TableHead className='w-14'>#</TableHead>
                                  <TableHead>Server</TableHead>
                                  <TableHead>Current private IP</TableHead>
                                  <TableHead className='w-[38%]'>
                                    New private IP
                                  </TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {selectedServers.map((server, index) => {
                                  const assignedId =
                                    effectiveAssignmentIds[index] ?? ''
                                  return (
                                    <TableRow
                                      key={server.id}
                                      draggable={Boolean(assignedId)}
                                      className={
                                        draggedAssignment === index
                                          ? 'bg-primary/10 opacity-70'
                                          : ''
                                      }
                                      onDragStart={() =>
                                        setDraggedAssignment(index)
                                      }
                                      onDragOver={(event) =>
                                        event.preventDefault()
                                      }
                                      onDrop={() => {
                                        if (
                                          draggedAssignment === undefined ||
                                          draggedAssignment === index
                                        )
                                          return
                                        setAvailableAssignmentIds((current) => {
                                          const next = [
                                            ...(current.length
                                              ? current
                                              : effectiveAssignmentIds),
                                          ]
                                          ;[
                                            next[draggedAssignment],
                                            next[index],
                                          ] = [
                                            next[index],
                                            next[draggedAssignment],
                                          ]
                                          return next
                                        })
                                        setDraggedAssignment(undefined)
                                      }}
                                      onDragEnd={() =>
                                        setDraggedAssignment(undefined)
                                      }
                                    >
                                      <TableCell>
                                        <GripVertical className='size-4 cursor-grab text-muted-foreground' />
                                      </TableCell>
                                      <TableCell>{index + 1}</TableCell>
                                      <TableCell className='font-medium'>
                                        {server.name}
                                      </TableCell>
                                      <TableCell className='font-mono text-xs'>
                                        {server.private_ip
                                          ?.map((ip) => ip.ip_address)
                                          .join(', ') || '—'}
                                      </TableCell>
                                      <TableCell>
                                        <SearchableSelect
                                          value={assignedId}
                                          onValueChange={(nextId) =>
                                            setAvailableAssignmentIds(
                                              (current) => {
                                                const next = [
                                                  ...(current.length
                                                    ? current
                                                    : effectiveAssignmentIds),
                                                ]
                                                const existingIndex =
                                                  next.indexOf(nextId)
                                                if (existingIndex >= 0)
                                                  [
                                                    next[existingIndex],
                                                    next[index],
                                                  ] = [
                                                    next[index],
                                                    next[existingIndex],
                                                  ]
                                                else next[index] = nextId
                                                return next
                                              }
                                            )
                                          }
                                          placeholder='Choose an available IP'
                                          searchPlaceholder='Search IP address...'
                                          options={attachableIps.map((ip) => ({
                                            value: ip.id,
                                            label: ip.ip_address,
                                            description: ip.region,
                                          }))}
                                        />
                                      </TableCell>
                                    </TableRow>
                                  )
                                })}
                              </TableBody>
                            </Table>
                            <div className='flex items-center justify-between gap-3 border-t bg-muted/10 px-4 py-3'>
                              <p className='text-xs text-muted-foreground'>
                                {
                                  effectiveAssignmentIds.filter((id) =>
                                    availableIpById.has(id)
                                  ).length
                                }
                                /{selectedServers.length} server(s) have an IP
                                assigned.
                              </p>
                              <div className='flex gap-2'>
                                <Button
                                  variant='outline'
                                  onClick={() => {
                                    setAvailableMappingStarted(false)
                                    setAvailableAssignmentIds([])
                                  }}
                                >
                                  Choose IPs again
                                </Button>
                                <Button
                                  onClick={() =>
                                    void buildPreview(
                                      effectiveAssignmentIds
                                        .map((id) => availableIpById.get(id))
                                        .filter((ip): ip is PrivateIp =>
                                          Boolean(ip)
                                        )
                                    )
                                  }
                                  disabled={
                                    previewingMappings ||
                                    !effectiveAssignmentIds.some((id) =>
                                      availableIpById.has(id)
                                    )
                                  }
                                >
                                  {previewingMappings ? (
                                    <Loader2 className='animate-spin' />
                                  ) : (
                                    <Eye />
                                  )}
                                  Preview mappings
                                </Button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <></>
                        )
                      ) : (
                        <div className='flex min-h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground'>
                          Select a subnet to build server and IP mappings.
                        </div>
                      )}
                      {availableSubnetId &&
                        !availableIps.isLoading &&
                        !attachableIps.length && (
                          <p className='text-center text-sm text-muted-foreground'>
                            This subnet has no private IP available for
                            attachment.
                          </p>
                        )}
                    </div>
                  ) : mode === 'ordered' ? (
                    <div className='grid gap-4 lg:grid-cols-2'>
                      <div className='space-y-2'>
                        <Label htmlFor='attach-ip-list'>IP address list</Label>
                        <Textarea
                          id='attach-ip-list'
                          className='min-h-52 font-mono text-xs'
                          value={ipText}
                          onChange={(event) => {
                            setIpText(event.target.value)
                            setPreviewRows([])
                          }}
                          placeholder={
                            "10.0.0.10\n10.0.0.11'10.0.0.12,10.0.0.13"
                          }
                        />
                        <p className='text-xs text-muted-foreground'>
                          Values are paired with selected servers in their
                          displayed order and split by new lines, commas,
                          semicolons or single quotes.
                        </p>
                      </div>
                      <div className='space-y-3 rounded-md border p-4'>
                        <Label htmlFor='attach-ip-excel'>
                          Import IP report (.xlsx)
                        </Label>
                        <Input
                          id='attach-ip-excel'
                          type='file'
                          accept='.xlsx'
                          onChange={(event) =>
                            void importOrderedFile(event.target.files?.[0])
                          }
                        />
                        <p className='text-sm text-muted-foreground'>
                          Import the successful IP report exported from Private
                          IPs. CloudTool reads the IP ADDRESS column.
                        </p>
                        {importName && (
                          <p className='text-sm font-medium'>{importName}</p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className='grid gap-4 lg:grid-cols-2'>
                      <div className='space-y-3 rounded-md border p-4'>
                        <p className='text-sm font-medium'>
                          1. Download the prepared template
                        </p>
                        <p className='text-sm text-muted-foreground'>
                          It includes selected server ID, server name, one
                          current IP and an empty NEW IP ADDRESS column.
                        </p>
                        <Button variant='outline' onClick={downloadTemplate}>
                          <Download />
                          Download Excel template
                        </Button>
                      </div>
                      <div className='space-y-3 rounded-md border p-4'>
                        <Label htmlFor='attach-custom-excel'>
                          2. Import completed template
                        </Label>
                        <Input
                          id='attach-custom-excel'
                          type='file'
                          accept='.xlsx'
                          onChange={(event) =>
                            void importCustomFile(event.target.files?.[0])
                          }
                        />
                        <p className='text-sm text-muted-foreground'>
                          {customRecords.length} custom mapping(s) loaded.
                        </p>
                        {importName && (
                          <p className='text-sm font-medium'>{importName}</p>
                        )}
                      </div>
                    </div>
                  )}
                  {mode !== 'available' && (
                    <div className='flex justify-end border-t pt-4'>
                      <Button
                        size='lg'
                        className='min-w-48 shadow-sm'
                        disabled={
                          processing ||
                          previewingMappings ||
                          (mode === 'ordered'
                            ? !ipText.trim()
                            : !customRecords.length)
                        }
                        onClick={() => void buildPreview()}
                      >
                        {previewingMappings ? (
                          <Loader2 className='animate-spin' />
                        ) : (
                          <Eye />
                        )}
                        {previewingMappings
                          ? 'Building preview…'
                          : 'Preview mappings'}
                      </Button>
                    </div>
                  )}
                  {previewRows.length > 0 && (
                    <div className='space-y-3'>
                      <CloudDataTable
                        data={previewRows}
                        columns={previewColumns}
                        getRowId={(row) =>
                          `${row.server_id}-${row.new_ip_address}`
                        }
                        entityName='mapping'
                        exportFileName={`attach-private-ip-preview-${project.id}`}
                        searchPlaceholder='Search mapping, IP or validation...'
                        enableSelection={mode !== 'available'}
                        isRowSelectable={(row) => row.ready}
                        toolbar={
                          mode === 'available'
                            ? undefined
                            : (selected) => (
                                <Button
                                  onClick={() => {
                                    setExecutionRows(selected)
                                    setConfirmOpen(true)
                                  }}
                                >
                                  <Link2 />
                                  Attach {selected.length} selected mapping(s)
                                </Button>
                              )
                        }
                      />
                      {mode === 'available' && (
                        <div className='flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-4 py-3'>
                          <p className='text-sm text-muted-foreground'>
                            {previewRows.filter((row) => row.ready).length}/
                            {previewRows.length} mapping(s) passed validation.
                          </p>
                          <div className='flex gap-2'>
                            <Button
                              variant='outline'
                              onClick={() => setPreviewRows([])}
                            >
                              Edit mappings
                            </Button>
                            <Button
                              disabled={!previewRows.some((row) => row.ready)}
                              onClick={() => {
                                setExecutionRows(
                                  previewRows.filter((row) => row.ready)
                                )
                                setConfirmOpen(true)
                              }}
                            >
                              <Link2 /> Attach all valid mappings
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              disabled={processing || previewingMappings}
              onClick={() => {
                setAttachOpen(false)
                onClose?.()
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(ipOperationDetail)}
        onOpenChange={(open) => !open && setIpOperationDetail(undefined)}
      >
        <DialogContent className='max-h-[88vh] overflow-y-auto sm:!max-w-3xl'>
          <DialogHeader>
            <DialogTitle>
              {ipOperationDetail?.title || 'API details'}
            </DialogTitle>
            <DialogDescription>
              Request and Cloud API response for this private IP operation.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-3'>
            {ipOperationDetail?.error && (
              <p className='rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive'>
                {ipOperationDetail.error}
              </p>
            )}
            <div>
              <Label>Request</Label>
              <pre className='mt-1 max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs break-words whitespace-pre-wrap'>
                {JSON.stringify(ipOperationDetail?.request ?? {}, null, 2)}
              </pre>
            </div>
            <div>
              <Label>Response</Label>
              <pre className='mt-1 max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs break-words whitespace-pre-wrap'>
                {JSON.stringify(ipOperationDetail?.response ?? {}, null, 2)}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => !processing && setConfirmOpen(open)}
        title='Attach selected private IPs?'
        desc={`${executionRows.length} mapping(s) will be revalidated by the backend. CloudTool will then reload each server detail to verify the exact IP attachment.`}
        confirmText='Attach and verify'
        isLoading={processing}
        handleConfirm={executeAttach}
      />
      <ConfirmDialog
        open={pendingDetachTargets.length > 0}
        onOpenChange={(open) =>
          !processing && !open && setPendingDetachTargets([])
        }
        title={`Detach ${pendingDetachTargets.length} private IP(s)?`}
        desc='The selected IP addresses will be detached from their servers one by one. This operation can interrupt workloads that rely on those addresses.'
        confirmText='Detach selected IPs'
        isLoading={processing}
        handleConfirm={() => {
          const targets = [...pendingDetachTargets]
          setPendingDetachTargets([])
          void executeDetach(targets)
        }}
      />

      <Dialog open={previewingMappings} onOpenChange={() => undefined}>
        <DialogContent
          showCloseButton={false}
          className='sm:!max-w-md'
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader className='items-center text-center sm:text-center'>
            <div className='mb-2 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary'>
              <Loader2 className='size-7 animate-spin' />
            </div>
            <DialogTitle>Preparing IP mappings</DialogTitle>
            <DialogDescription>
              Loading private IP availability and matching addresses to the
              selected servers.
            </DialogDescription>
          </DialogHeader>
          <p className='text-center text-xs text-muted-foreground'>
            The preview will open automatically when every mapping is ready.
          </p>
        </DialogContent>
      </Dialog>

      <Dialog open={processing} onOpenChange={() => undefined}>
        <DialogContent
          showCloseButton={false}
          className='sm:!max-w-md'
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader className='items-center text-center sm:text-center'>
            <div className='mb-2 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary'>
              <Loader2 className='size-7 animate-spin' />
            </div>
            <DialogTitle>Attaching private IPs</DialogTitle>
            <DialogDescription>
              Keep this page open while CloudTool attaches and verifies every
              mapping.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-3 rounded-lg border bg-muted/30 p-4'>
            <div className='flex items-center justify-between gap-3 text-sm'>
              <span className='font-medium'>{attachProgress.phase}</span>
              <span className='shrink-0 text-muted-foreground tabular-nums'>
                {attachProgress.completed}/{attachProgress.total}
              </span>
            </div>
            <div className='h-2 overflow-hidden rounded-full bg-muted'>
              <div
                className='h-full rounded-full bg-primary transition-[width] duration-300'
                style={{
                  width: `${attachProgress.total ? Math.min(100, (attachProgress.completed / attachProgress.total) * 100) : 0}%`,
                }}
              />
            </div>
            {attachProgress.current && (
              <p className='truncate text-xs text-muted-foreground'>
                Verifying {attachProgress.current}
              </p>
            )}
          </div>
          <p className='text-center text-xs text-muted-foreground'>
            This may take several minutes for a large server selection.
          </p>
        </DialogContent>
      </Dialog>
    </CloudPageShell>
  )
}

interface ElasticIpResource {
  id: string
  ip_address: string
  status?: string
  server?: { id: string; name?: string } | null
  project?: string
  [key: string]: unknown
}

interface ElasticIpTarget {
  server_id: string
  server_name: string
  ip_id: string
  ip_address: string
}

interface ElasticIpOperation extends ElasticIpTarget {
  status: string
  error?: string
  request?: unknown
  response?: unknown
}

/** Embedded bulk elastic-IP workflow. It deliberately uses small client batches;
 * each gateway request remains sequential to protect the upstream Cloud API. */
function ElasticIpWorkspace({
  initialServers,
  onClose,
}: {
  initialServers: ServerRow[]
  onClose: () => void
}) {
  const project = useCloudStore((state) => state.project)!
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'attach' | 'detach'>('attach')
  const [attachRows, setAttachRows] = useState<ElasticIpTarget[]>([])
  const [results, setResults] = useState<ElasticIpOperation[]>([])
  const [processing, setProcessing] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'attach' | 'detach'>()
  const [pendingTargets, setPendingTargets] = useState<ElasticIpTarget[]>([])
  const [detail, setDetail] = useState<{
    title: string
    request?: unknown
    response?: unknown
    error?: string
  }>()
  const elasticIps = useQuery({
    queryKey: ['cloud', project.id, 'server-elastic-ips', 'attach'],
    queryFn: async ({ signal }) => {
      const items: ElasticIpResource[] = []
      let page = 1
      let total = 0
      do {
        const { data } = await apiClient.get<Page<ElasticIpResource>>(
          '/cloud/server-elastic-ips',
          { params: { page, page_size: 200 }, signal }
        )
        items.push(...data.items)
        total = data.total
        page += 1
      } while (items.length < total)
      return { items, total, page: 1, page_size: 200 }
    },
  })
  const availableIps = useMemo(
    () =>
      (elasticIps.data?.items ?? []).filter(
        (ip) =>
          ip.server == null &&
          (!ip.status || ip.status.toLowerCase() === 'down')
      ),
    [elasticIps.data]
  )
  const detachCandidates = useMemo<ElasticIpTarget[]>(
    () =>
      initialServers.flatMap((server) =>
        (server.elastic_ip ?? []).map((ip) => ({
          server_id: server.id,
          server_name: server.name,
          ip_id: ip.id,
          ip_address: ip.ip_address,
        }))
      ),
    [initialServers]
  )
  useEffect(() => {
    setAttachRows(
      initialServers.map((server, index) => {
        const ip = availableIps[index]
        return {
          server_id: server.id,
          server_name: server.name,
          ip_id: ip?.id ?? '',
          ip_address: ip?.ip_address ?? '',
        }
      })
    )
  }, [availableIps, initialServers])

  const operationColumns = useMemo<ColumnDef<ElasticIpOperation>[]>(
    () => [
      { accessorKey: 'server_name', header: 'Server' },
      {
        accessorKey: 'ip_address',
        header: 'Elastic IP',
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => {
          const value = String(getValue())
          return (
            <span
              className={
                value === 'failed'
                  ? 'font-medium text-destructive'
                  : 'font-medium text-emerald-600 dark:text-emerald-400'
              }
            >
              {value}
            </span>
          )
        },
      },
      {
        accessorKey: 'error',
        header: 'Error',
        cell: ({ getValue }) => {
          const error = getValue() as string | undefined
          return error ? (
            <p className='max-w-96 text-xs leading-5 break-words text-destructive'>
              {error}
            </p>
          ) : (
            '—'
          )
        },
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <RowActions
            id={`${row.original.server_id}:${row.original.ip_id}`}
            label='operation ID'
          >
            <DropdownMenuItem
              onClick={() =>
                setDetail({
                  title: `Elastic IP operation · ${row.original.server_name}`,
                  request: row.original.request,
                  response: row.original.response,
                  error: row.original.error,
                })
              }
            >
              <Eye /> View API details
            </DropdownMenuItem>
          </RowActions>
        ),
      },
    ],
    []
  )

  function downloadTemplate() {
    downloadXlsx(
      ['SERVER ID', 'SERVER NAME', 'ELASTIC IP'],
      initialServers.map((server, index) => [
        server.id,
        server.name,
        availableIps[index]?.ip_address ?? '',
      ]),
      `elastic-ip-attachment-template-${(project.name || project.id).replace(/[^a-zA-Z0-9._-]+/g, '-')}.xlsx`,
      {
        title: 'ELASTIC IP ATTACHMENT TEMPLATE',
        metadata: [
          {
            label: 'Note',
            value:
              'One row maps one selected server to one available Elastic IP. Edit Elastic IP as needed.',
          },
        ],
        sheetName: 'Elastic IPs',
        validations: [
          {
            header: 'ELASTIC IP',
            values: availableIps.map((ip) => ip.ip_address),
            allowBlank: true,
            enforce: false,
          },
        ],
      }
    )
  }

  async function importTemplate(file?: File) {
    if (!file) return
    try {
      const rows = rowsFromHeader(parseXlsxRows(await file.arrayBuffer()), [
        'SERVER ID',
        'ELASTIC IP',
      ])
      const serverById = new Map(
        initialServers.map((server) => [server.id, server])
      )
      const ipByAddress = new Map(availableIps.map((ip) => [ip.ip_address, ip]))
      const imported = rows.map((row) => {
        const server = serverById.get(row['SERVER ID'])
        const ip = ipByAddress.get(row['ELASTIC IP'])
        return {
          server_id: row['SERVER ID'],
          server_name: server?.name ?? row['SERVER NAME'] ?? 'Unknown server',
          ip_id: ip?.id ?? '',
          ip_address: row['ELASTIC IP'] ?? '',
        }
      })
      const invalid = imported.filter(
        (item) => !serverById.has(item.server_id) || !item.ip_id
      )
      setAttachRows(imported)
      toast[invalid.length ? 'warning' : 'success'](
        invalid.length
          ? `${invalid.length} template row(s) need review.`
          : `${imported.length} mapping(s) imported.`
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Elastic IP template could not be imported.'
      )
    }
  }

  async function execute(
    action: 'attach' | 'detach',
    targets = pendingTargets
  ) {
    if (!targets.length) return
    setProcessing(true)
    setResults([])
    const all: ElasticIpOperation[] = []
    try {
      for (let start = 0; start < targets.length; start += 20) {
        const batch = targets.slice(start, start + 20)
        const { data } = await apiClient.post<{ items: ElasticIpOperation[] }>(
          action === 'attach'
            ? '/cloud/servers/attach-elastic-ips'
            : '/cloud/servers/detach-elastic-ips',
          {
            items: batch.map(({ server_id, ip_id }) => ({ server_id, ip_id })),
          },
          { timeout: 60_000 }
        )
        const byKey = new Map(
          data.items.map((item) => [`${item.server_id}:${item.ip_id}`, item])
        )
        all.push(
          ...batch.map((item) => ({
            ...item,
            ...(byKey.get(`${item.server_id}:${item.ip_id}`) ?? {
              status: 'failed',
              error: 'Gateway returned no result.',
            }),
          }))
        )
        setResults([...all])
      }
      await queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'servers'],
      })
      toast.success(
        `${all.filter((item) => item.status !== 'failed').length}/${targets.length} Elastic IP operation(s) completed.`
      )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Elastic IP operation failed.'
      )
    } finally {
      setProcessing(false)
      setConfirmAction(undefined)
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className='flex max-h-[92vh] flex-col overflow-hidden sm:!max-w-6xl'>
          <DialogHeader className='shrink-0'>
            <DialogTitle>Elastic IP addresses</DialogTitle>
            <DialogDescription>
              Attach available Elastic IPs or detach addresses currently
              attached to the selected servers.
            </DialogDescription>
          </DialogHeader>
          <SegmentedTabs
            value={tab}
            onValueChange={(value) => {
              setTab(value as 'attach' | 'detach')
              setResults([])
            }}
            tabs={[
              { value: 'attach', label: 'Attach' },
              { value: 'detach', label: 'Detach' },
            ]}
          />
          <div className='min-h-0 flex-1 overflow-auto pr-1'>
            {results.length ? (
              <CloudDataTable
                data={results}
                columns={operationColumns}
                getRowId={(row) => `${row.server_id}:${row.ip_id}`}
                entityName='operation result'
                exportFileName={`elastic-ip-${tab}-results-${project.id}`}
              />
            ) : tab === 'attach' ? (
              <div className='space-y-4'>
                <div className='flex flex-wrap justify-end gap-2'>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={downloadTemplate}
                  >
                    <Download /> Template
                  </Button>
                  <Label className='inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border bg-background px-3 text-xs font-medium hover:bg-accent'>
                    <FileUp className='size-3.5' /> Import mapping
                    <Input
                      className='hidden'
                      type='file'
                      accept='.xlsx'
                      onChange={(event) => {
                        void importTemplate(event.target.files?.[0])
                        event.currentTarget.value = ''
                      }}
                    />
                  </Label>
                </div>
                <CloudDataTable
                  data={attachRows}
                  columns={[
                    { accessorKey: 'server_name', header: 'Server' },
                    {
                      accessorKey: 'server_id',
                      header: 'Server ID',
                      cell: ({ getValue }) => (
                        <span className='font-mono text-xs'>
                          {getValue() as string}
                        </span>
                      ),
                    },
                    {
                      accessorKey: 'ip_address',
                      header: 'Elastic IP',
                      cell: ({ row }) => {
                        return (
                          <SearchableSelect
                            value={row.original.ip_id}
                            onValueChange={(value) => {
                              const ip = availableIps.find(
                                (item) => item.id === value
                              )
                              setAttachRows((current) => {
                                const currentRow = current.find(
                                  (item) =>
                                    item.server_id === row.original.server_id
                                )
                                const previousIp = currentRow
                                  ? {
                                      ip_id: currentRow.ip_id,
                                      ip_address: currentRow.ip_address,
                                    }
                                  : { ip_id: '', ip_address: '' }
                                const swapServerId = current.find(
                                  (item) =>
                                    item.server_id !== row.original.server_id &&
                                    item.ip_id === value
                                )?.server_id
                                return current.map((item) => {
                                  if (item.server_id === row.original.server_id)
                                    return {
                                      ...item,
                                      ip_id: ip?.id ?? '',
                                      ip_address: ip?.ip_address ?? '',
                                    }
                                  if (item.server_id === swapServerId)
                                    return { ...item, ...previousIp }
                                  return item
                                })
                              })
                            }}
                            options={availableIps.map((ip) => ({
                              value: ip.id,
                              label: ip.ip_address,
                              description: ip.id,
                            }))}
                            placeholder='Select available Elastic IP'
                            searchPlaceholder='Search available Elastic IP...'
                            loading={elasticIps.isLoading}
                            disabled={processing}
                            className='min-w-52'
                          />
                        )
                      },
                    },
                  ]}
                  getRowId={(row) => row.server_id}
                  entityName='mapping'
                  exportFileName={`elastic-ip-mapping-${project.id}`}
                  enableSelection
                  isRowSelectable={(row) => Boolean(row.ip_id)}
                  toolbar={(selected) => (
                    <Button
                      disabled={!selected.length || processing}
                      onClick={() => {
                        setPendingTargets(selected)
                        setConfirmAction('attach')
                      }}
                    >
                      <Link2 /> Attach {selected.length} selected
                    </Button>
                  )}
                />
              </div>
            ) : (
              <CloudDataTable
                data={detachCandidates}
                columns={[
                  { accessorKey: 'server_name', header: 'Server' },
                  {
                    accessorKey: 'ip_address',
                    header: 'Elastic IP',
                    cell: ({ getValue }) => (
                      <span className='font-mono text-xs'>
                        {getValue() as string}
                      </span>
                    ),
                  },
                ]}
                getRowId={(row) => `${row.server_id}:${row.ip_id}`}
                entityName='attached Elastic IP'
                exportFileName={`attached-elastic-ips-${project.id}`}
                enableSelection
                toolbar={(selected) => (
                  <Button
                    variant='destructive'
                    disabled={!selected.length || processing}
                    onClick={() => {
                      setPendingTargets(selected)
                      setConfirmAction('detach')
                    }}
                  >
                    <Link2 /> Detach {selected.length} selected
                  </Button>
                )}
              />
            )}
          </div>
          <DialogFooter className='shrink-0 border-t pt-4'>
            <Button variant='outline' onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(confirmAction)}
        onOpenChange={(open) =>
          !open && !processing && setConfirmAction(undefined)
        }
        title={
          confirmAction === 'detach'
            ? 'Detach selected Elastic IPs?'
            : 'Attach selected Elastic IPs?'
        }
        desc={
          confirmAction === 'detach'
            ? 'Each selected Elastic IP is detached sequentially. The addresses are not deleted.'
            : 'Each available Elastic IP is revalidated and attached sequentially.'
        }
        destructive={confirmAction === 'detach'}
        isLoading={processing}
        confirmText={
          processing ? (
            <>
              <Loader2 className='animate-spin' />
              {confirmAction === 'detach'
                ? 'Detaching Elastic IPs...'
                : 'Attaching Elastic IPs...'}
            </>
          ) : confirmAction === 'detach' ? (
            'Detach Elastic IPs'
          ) : (
            'Attach Elastic IPs'
          )
        }
        handleConfirm={() => {
          if (confirmAction) {
            const action = confirmAction
            void execute(action)
          }
        }}
      />
      <Dialog
        open={Boolean(detail)}
        onOpenChange={(open) => !open && setDetail(undefined)}
      >
        <DialogContent className='max-h-[90vh] overflow-auto sm:!max-w-4xl'>
          <DialogHeader>
            <DialogTitle>{detail?.title}</DialogTitle>
          </DialogHeader>
          {detail?.error && (
            <p className='rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive'>
              {detail.error}
            </p>
          )}
          <Label>Request</Label>
          <pre className='max-h-52 overflow-auto rounded-md border bg-muted/30 p-3 text-xs'>
            {JSON.stringify(detail?.request ?? null, null, 2)}
          </pre>
          <Label>Response</Label>
          <pre className='max-h-72 overflow-auto rounded-md border bg-muted/30 p-3 text-xs'>
            {JSON.stringify(detail?.response ?? null, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function AuditLogPage({ kind }: { kind: 'activity' | 'cloud' }) {
  const project = useCloudStore((state) => state.project)!
  const currentUser = useAuthStore((state) => state.auth.user)
  const currentRole =
    typeof currentUser?.role === 'string'
      ? currentUser.role
      : currentUser?.role.name
  const endpoint = kind === 'activity' ? '/logs/audit' : '/logs/cloud-api'
  const cleanupEndpoint =
    kind === 'activity' ? '/logs/audit' : '/logs/cloud-api'
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [cleanupConfirmOpen, setCleanupConfirmOpen] = useState(false)
  const [cleanupMode, setCleanupMode] = useState<'older' | 'all'>('older')
  const [cleanupDays, setCleanupDays] = useState('90')
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: 50,
  })
  const [filters, setFilters] = useState({
    project_id: '',
    method: '',
    action: '',
    endpoint: '',
    status: '',
  })
  const [logSearch, setLogSearch] = useState('')
  const [debouncedLogSearch, setDebouncedLogSearch] = useState('')
  const [advancedLogSearch, setAdvancedLogSearch] = useState<{
    columnId: string
    values: string[]
    mode?: 'values' | 'comparison'
    expression?: string
  }>()
  const [viewLog, setViewLog] = useState<LogRow>()
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedLogSearch(logSearch.trim())
      setPagination((current) => ({ ...current, pageIndex: 0 }))
    }, 350)
    return () => window.clearTimeout(timeout)
  }, [logSearch])
  const query = useQuery({
    queryKey: [
      'cloud',
      project.id,
      'logs',
      kind,
      endpoint,
      pagination,
      filters,
      debouncedLogSearch,
      advancedLogSearch,
    ],
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Page<LogRow>>(endpoint, {
          params: {
            page: pagination.pageIndex + 1,
            page_size: pagination.pageSize,
            project_id: filters.project_id || undefined,
            method: filters.method || undefined,
            action: filters.action || undefined,
            endpoint: filters.endpoint || undefined,
            status: filters.status || undefined,
            q: debouncedLogSearch || undefined,
            search_column: advancedLogSearch?.columnId,
            search_values: advancedLogSearch
              ? JSON.stringify(advancedLogSearch.values)
              : undefined,
            search_mode: advancedLogSearch?.mode,
            search_expression: advancedLogSearch?.expression,
          }, signal,
        })
      ).data,
    placeholderData: (previous) => previous,
  })
  const cleanup = useMutation({
    mutationFn: async () =>
      (
        await apiClient.delete<{ deleted_count: number }>(cleanupEndpoint, {
          params:
            cleanupMode === 'all'
              ? { all_records: true }
              : { older_than_days: Number(cleanupDays) },
        })
      ).data,
    onSuccess: async (data) => {
      setCleanupConfirmOpen(false)
      setCleanupOpen(false)
      setPagination((current) => ({ ...current, pageIndex: 0 }))
      await query.refetch()
      toast.success(`${data.deleted_count} log record(s) deleted.`)
    },
    onError: () => toast.error('Log cleanup could not be completed.'),
  })
  const columns = useMemo<ColumnDef<LogRow>[]>(() => {
    const common: ColumnDef<LogRow>[] = [
      {
        accessorKey: 'created_at',
        header: ({ column }) => <SortableHeader column={column} title='Time' />,
        cell: ({ getValue }) => (
          <span className='whitespace-nowrap'>
            {new Date(getValue() as string).toLocaleString()}
          </span>
        ),
      },
      {
        accessorKey: 'project_id',
        header: ({ column }) => (
          <SortableHeader column={column} title='Project' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>
            {(getValue() as string | undefined) || '—'}
          </span>
        ),
      },
    ]
    const preview: ColumnDef<LogRow>[] =
      kind === 'activity'
        ? [
            {
              accessorKey: 'actor_email',
              header: ({ column }) => (
                <SortableHeader column={column} title='Actor' />
              ),
            },
            {
              accessorKey: 'action',
              header: ({ column }) => (
                <SortableHeader column={column} title='Action' />
              ),
            },
            {
              id: 'target',
              accessorFn: (row) =>
                [row.target_type, row.target_id].filter(Boolean).join(': '),
              header: ({ column }) => (
                <SortableHeader column={column} title='Target' />
              ),
            },
            {
              accessorKey: 'result',
              header: ({ column }) => (
                <SortableHeader column={column} title='Status' />
              ),
            },
            {
              id: 'metadata_preview',
              accessorFn: (row) => JSON.stringify(row.metadata_json ?? {}),
              header: ({ column }) => (
                <SortableHeader column={column} title='Metadata preview' />
              ),
              cell: ({ getValue }) => (
                <span
                  className='block max-w-80 truncate font-mono text-xs'
                  title={getValue() as string}
                >
                  {getValue() as string}
                </span>
              ),
            },
          ]
        : [
            {
              accessorKey: 'method',
              header: ({ column }) => (
                <SortableHeader column={column} title='Method' />
              ),
            },
            {
              accessorKey: 'endpoint',
              header: ({ column }) => (
                <SortableHeader column={column} title='Endpoint' />
              ),
              cell: ({ getValue }) => (
                <span
                  className='block max-w-96 truncate font-mono text-xs'
                  title={getValue() as string}
                >
                  {getValue() as string}
                </span>
              ),
            },
            {
              accessorKey: 'http_status',
              header: ({ column }) => (
                <SortableHeader column={column} title='HTTP' />
              ),
            },
            {
              accessorKey: 'status',
              header: ({ column }) => (
                <SortableHeader column={column} title='Status' />
              ),
            },
            {
              accessorKey: 'latency_ms',
              header: ({ column }) => (
                <SortableHeader column={column} title='Latency (ms)' />
              ),
            },
            {
              accessorKey: 'error_code',
              header: ({ column }) => (
                <SortableHeader column={column} title='Error code' />
              ),
              cell: ({ getValue }) => (getValue() as string | undefined) || '—',
            },
            {
              id: 'response_preview',
              accessorFn: (row) => JSON.stringify(row.response_meta ?? {}),
              header: ({ column }) => (
                <SortableHeader column={column} title='Response preview' />
              ),
              cell: ({ getValue }) => (
                <span
                  className='block max-w-80 truncate font-mono text-xs'
                  title={getValue() as string}
                >
                  {getValue() as string}
                </span>
              ),
            },
          ]
    return [
      ...common,
      ...preview,
      {
        accessorKey: 'correlation_id',
        header: ({ column }) => (
          <SortableHeader column={column} title='Correlation ID' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>{getValue() as string}</span>
        ),
      },
      {
        id: 'actions',
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions id={row.original.correlation_id} label='correlation ID'>
            <DropdownMenuItem onClick={() => setViewLog(row.original)}>
              <Eye />
              View details
            </DropdownMenuItem>
          </RowActions>
        ),
      },
    ]
  }, [kind])
  const methodOptions = ['', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(
    (value) => ({ value, label: value || 'All methods' })
  )
  const statusValues =
    kind === 'activity'
      ? ['started', 'success', 'failed', 'completed']
      : ['started', 'accepted', 'completed', 'failed']
  const setFilter = (key: keyof typeof filters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }))
    setPagination((current) => ({ ...current, pageIndex: 0 }))
  }
  return (
    <CloudPageShell
      title={kind === 'activity' ? 'User activity' : 'Cloud API history'}
      description='Server-side logs are redacted and can be viewed across all projects.'
      tableHelp
      help={
        <p className='text-muted-foreground'>
          Logs are redacted on the server. Select All projects to review the
          complete history, or select the active project to narrow the results.
          Use correlation IDs to trace a user action across Cloud API requests.
        </p>
      }
      actions={
        <Button
          variant='destructive'
          disabled={currentRole !== 'admin'}
          title={
            currentRole === 'admin'
              ? 'Clean up logs'
              : 'Administrator permission is required'
          }
          onClick={() => setCleanupOpen(true)}
        >
          <Trash2 /> Cleanup
        </Button>
      }
    >
      <Card>
        <CardContent className='space-y-4'>
          <div className='grid gap-3 border-b pb-4 md:grid-cols-2 xl:grid-cols-5'>
            <div className='space-y-2'>
              <Label>Project</Label>
              <SearchableSelect
                value={filters.project_id}
                onValueChange={(value) => setFilter('project_id', value)}
                placeholder='All projects'
                searchPlaceholder='Search projects...'
                options={[
                  {
                    value: '',
                    label: 'All projects',
                    description: 'Include logs without a project context',
                  },
                  {
                    value: project.id,
                    label: project.name,
                    description: project.id,
                  },
                ]}
              />
            </div>
            <div className='space-y-2'>
              <Label>Method</Label>
              <SearchableSelect
                value={filters.method}
                onValueChange={(value) => setFilter('method', value)}
                disabled={kind === 'activity'}
                placeholder={
                  kind === 'activity' ? 'Not applicable' : 'All methods'
                }
                options={methodOptions}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor={`${kind}-action-filter`}>Action</Label>
              <Input
                id={`${kind}-action-filter`}
                value={filters.action}
                disabled={kind === 'cloud'}
                placeholder={
                  kind === 'cloud' ? 'Not applicable' : 'Filter action...'
                }
                onChange={(event) => setFilter('action', event.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor={`${kind}-endpoint-filter`}>Endpoint</Label>
              <Input
                id={`${kind}-endpoint-filter`}
                value={filters.endpoint}
                disabled={kind === 'activity'}
                placeholder={
                  kind === 'activity' ? 'Not applicable' : 'Filter endpoint...'
                }
                onChange={(event) => setFilter('endpoint', event.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label>Status</Label>
              <SearchableSelect
                value={filters.status}
                onValueChange={(value) => setFilter('status', value)}
                placeholder='All statuses'
                searchPlaceholder='Search statuses...'
                options={[
                  { value: '', label: 'All statuses' },
                  ...statusValues.map((value) => ({ value, label: value })),
                ]}
              />
            </div>
          </div>
          <CloudDataTable
            data={query.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={query.isLoading}
            entityName='log'
            exportFileName={`${kind}-logs-${filters.project_id || 'all-projects'}`}
            searchPlaceholder='Search logs, status or correlation ID...'
            serverFiltering={{
              search: logSearch,
              onSearchChange: setLogSearch,
              advanced: advancedLogSearch,
              onAdvancedChange: (value) => {
                setAdvancedLogSearch(value)
                setPagination((current) => ({ ...current, pageIndex: 0 }))
              },
            }}
            serverPagination={{
              pagination,
              totalRows: query.data?.total ?? 0,
              onChange: setPagination,
            }}
            pageSizeOptions={[20, 50, 100, 200]}
            toolbar={(selected, clear) =>
              selected.length ? (
                <Button
                  variant='outline'
                  onClick={() =>
                    copySelected(selected, (row) => row.correlation_id, clear)
                  }
                >
                  <Copy />
                  Copy correlation IDs
                </Button>
              ) : null
            }
          />
        </CardContent>
      </Card>
      <Dialog
        open={Boolean(viewLog)}
        onOpenChange={(open) => !open && setViewLog(undefined)}
      >
        <DialogContent className='max-h-[90vh] overflow-y-auto sm:!max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Log details</DialogTitle>
            <DialogDescription>
              Complete redacted log payload for correlation ID{' '}
              {viewLog?.correlation_id}.
            </DialogDescription>
          </DialogHeader>
          <div className='overflow-x-auto rounded-md border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className='w-56'>Field</TableHead>
                  <TableHead>Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(viewLog ?? {}).map(([key, value]) => (
                  <TableRow key={key}>
                    <TableCell className='align-top font-mono text-xs font-medium'>
                      {key}
                    </TableCell>
                    <TableCell>
                      <ServerDetailValue value={value} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button onClick={() => setViewLog(undefined)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={cleanupOpen}
        onOpenChange={(open) => !cleanup.isPending && setCleanupOpen(open)}
      >
        <DialogContent className='sm:!max-w-xl'>
          <DialogHeader>
            <DialogTitle>
              Cleanup {kind === 'activity' ? 'activity audit' : 'Cloud API'}{' '}
              logs
            </DialogTitle>
            <DialogDescription>
              Delete obsolete records directly from the database to keep log
              queries and storage manageable.
            </DialogDescription>
          </DialogHeader>
          <SegmentedTabs
            value={cleanupMode}
            onValueChange={(value) => setCleanupMode(value)}
            tabs={[
              { value: 'older', label: 'Older than a period' },
              { value: 'all', label: 'Delete all records' },
            ]}
          />
          {cleanupMode === 'older' ? (
            <div className='space-y-3 rounded-lg border p-4'>
              <Label htmlFor={`${kind}-cleanup-days`}>
                Delete records older than
              </Label>
              <div className='flex items-center gap-2'>
                <Input
                  id={`${kind}-cleanup-days`}
                  type='number'
                  min={1}
                  max={3650}
                  value={cleanupDays}
                  onChange={(event) =>
                    setCleanupDays(event.target.value.replace(/^0+(?=\d)/, ''))
                  }
                />
                <span className='shrink-0 text-sm text-muted-foreground'>
                  days
                </span>
              </div>
              <p className='text-xs text-muted-foreground'>
                The backend calculates the cutoff from the current server time
                when you confirm cleanup.
              </p>
            </div>
          ) : (
            <div className='rounded-lg border border-destructive/40 bg-destructive/5 p-4'>
              <p className='font-medium text-destructive'>
                Delete the complete{' '}
                {kind === 'activity' ? 'activity audit' : 'Cloud API history'}{' '}
                table
              </p>
              <p className='mt-1 text-sm text-muted-foreground'>
                This affects logs from every project, not only the current
                filter. The cleanup action itself remains recorded in the audit
                trail.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant='outline' onClick={() => setCleanupOpen(false)}>
              Cancel
            </Button>
            <Button
              variant='destructive'
              disabled={
                cleanupMode === 'older' &&
                (!Number.isInteger(Number(cleanupDays)) ||
                  Number(cleanupDays) < 1 ||
                  Number(cleanupDays) > 3650)
              }
              onClick={() => setCleanupConfirmOpen(true)}
            >
              <Trash2 /> Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={cleanupConfirmOpen}
        onOpenChange={(open) =>
          !cleanup.isPending && setCleanupConfirmOpen(open)
        }
        title={
          cleanupMode === 'all'
            ? 'Delete all log records?'
            : `Delete logs older than ${cleanupDays} days?`
        }
        desc={
          cleanupMode === 'all'
            ? 'All records across every project will be permanently deleted. This cannot be undone.'
            : `All ${kind === 'activity' ? 'activity audit' : 'Cloud API'} records older than ${cleanupDays} days across every project will be permanently deleted.`
        }
        confirmText='Delete logs'
        destructive
        isLoading={cleanup.isPending}
        handleConfirm={() => cleanup.mutateAsync().then(() => undefined)}
      />
    </CloudPageShell>
  )
}

export function PasswordProfilesPage() {
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteProfile, setDeleteProfile] = useState<Profile>()
  const [form, setForm] = useState({
    name: '',
    username: 'root',
    password: '',
  })
  const profiles = useQuery({
    queryKey: ['password-profiles'],
    queryFn: async ({ signal }) =>
      (await apiClient.get<Profile[]>('/password-profiles', { signal })).data,
  })
  const create = useMutation({
    mutationFn: async () => apiClient.post('/password-profiles', form),
    onSuccess: async () => {
      setForm({ name: '', username: 'root', password: '' })
      setCreateOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['password-profiles'] })
      toast.success('The encrypted password profile was created.')
    },
    onError: () =>
      toast.error('The profile could not be created. Check password policy.'),
  })
  const remove = useMutation({
    mutationFn: async (profileId: string) =>
      apiClient.delete(`/password-profiles/${profileId}`),
    onSuccess: async () => {
      setDeleteProfile(undefined)
      await queryClient.invalidateQueries({ queryKey: ['password-profiles'] })
      toast.success('The password profile was deleted.')
    },
    onError: () =>
      toast.error(
        'The password profile could not be deleted. It may still be in use.'
      ),
  })
  const columns = useMemo<ColumnDef<Profile>[]>(
    () => [
      {
        accessorKey: 'name',
        header: ({ column }) => <SortableHeader column={column} title='Name' />,
        cell: ({ getValue }) => (
          <span className='font-medium'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'username',
        header: ({ column }) => (
          <SortableHeader column={column} title='Username' />
        ),
      },
      {
        accessorKey: 'is_active',
        header: ({ column }) => (
          <SortableHeader column={column} title='Status' />
        ),
        cell: ({ getValue }) =>
          (getValue() as boolean) ? 'Active' : 'Disabled',
      },
      {
        accessorKey: 'created_at',
        header: ({ column }) => (
          <SortableHeader column={column} title='Created at' />
        ),
        cell: ({ getValue }) => {
          const value = getValue() as string | undefined
          return value ? new Date(value).toLocaleString() : '—'
        },
      },
      {
        id: 'actions',
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions id={row.original.id} label='profile ID'>
            <DropdownMenuItem disabled>
              <Pencil />
              Edit profile
            </DropdownMenuItem>
            <DropdownMenuItem
              className='text-destructive focus:text-destructive'
              onClick={() => setDeleteProfile(row.original)}
            >
              <Trash2 />
              Delete profile
            </DropdownMenuItem>
          </RowActions>
        ),
      },
    ],
    []
  )
  return (
    <CloudPageShell
      title='Password profiles'
      description='Manage encrypted credentials used by bulk server operations.'
      tableHelp
      help={
        <p className='text-muted-foreground'>
          Passwords are encrypted at rest and never returned to the browser.
          Username is metadata; bulk password changes send only the protected
          credential to the upstream operation.
        </p>
      }
      actions={
        <Button onClick={() => setCreateOpen(true)}>
          <Plus />
          Add new
        </Button>
      }
    >
      <Card>
        <CardContent>
          <CloudDataTable
            data={profiles.data ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={profiles.isLoading}
            entityName='password profile'
            exportFileName='password-profiles'
            searchPlaceholder='Search profile name, username or status...'
            toolbar={(selected, clear) =>
              selected.length ? (
                <Button
                  variant='outline'
                  onClick={() => copySelected(selected, (row) => row.id, clear)}
                >
                  <Copy />
                  Copy selected IDs
                </Button>
              ) : null
            }
          />
        </CardContent>
      </Card>
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!create.isPending) setCreateOpen(open)
        }}
      >
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>Add password profile</DialogTitle>
            <DialogDescription>
              Credentials are encrypted before storage and the password is never
              returned by the API.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='profile-name'>Profile name</Label>
              <Input
                id='profile-name'
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                autoFocus
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='profile-user'>Username</Label>
              <Input
                id='profile-user'
                value={form.username}
                onChange={(event) =>
                  setForm({ ...form, username: event.target.value })
                }
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='profile-password'>Password</Label>
              <Input
                id='profile-password'
                type='password'
                autoComplete='new-password'
                value={form.password}
                onChange={(event) =>
                  setForm({ ...form, password: event.target.value })
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              disabled={create.isPending}
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                !form.name.trim() ||
                !form.username.trim() ||
                !form.password ||
                create.isPending
              }
              onClick={() => create.mutate()}
            >
              <Plus />
              {create.isPending ? 'Creating...' : 'Create profile'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleteProfile)}
        onOpenChange={(open) =>
          !remove.isPending && !open && setDeleteProfile(undefined)
        }
        title='Delete password profile?'
        desc={`Delete ${deleteProfile?.name ?? 'this profile'} permanently. Existing server passwords are not changed.`}
        confirmText='Delete profile'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() =>
          deleteProfile
            ? remove.mutateAsync(deleteProfile.id).then(() => undefined)
            : Promise.resolve()
        }
      />
    </CloudPageShell>
  )
}
