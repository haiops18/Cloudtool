import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import {
  Download,
  Eye,
  FileJson,
  FileSpreadsheet,
  Globe2,
  Loader2,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { downloadXlsx } from '@/lib/xlsx-export'
import { parseXlsxRows, rowsFromHeader } from '@/lib/xlsx-import'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import { Textarea } from '@/components/ui/textarea'
import { CloudDataTable } from '@/components/cloud-data-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SearchableSelect } from '@/components/searchable-select'
import { SegmentedTabs } from '@/components/segmented-tabs'
import { SortableHeader } from '@/components/sortable-header'
import { CloudPageShell } from '@/features/cloud/page-shell'

type ResourceType = 'vpc' | 'subnet' | 'security_group'
type Scope = ResourceType | 'all'
type ResourceRow = {
  id: string
  name: string
  display_name?: string
  description?: string
  cidr?: string
  region?: string | { id?: string; name?: string; display_name?: string }
  vpc?: string | { id?: string; name?: string; display_name?: string }
  internet_access?: boolean
  route_tables?: string[]
  rules_count?: number
  created_at?: string
  [key: string]: unknown
}
type Page<T> = { items: T[]; total: number; page: number; page_size: number }
type FormState = {
  type: ResourceType
  id?: string
  name: string
  description: string
  cidr: string
  region: string
  vpc: string
}
type ImportRow = FormState & {
  client_id: string
  row: number
  errors: string[]
  warnings: string[]
}
type OperationResult = {
  id?: string
  client_id?: string
  status: string
  error?: unknown
  request?: unknown
  response?: unknown
  resource?: ResourceRow
  source?: Pick<
    ImportRow,
    'type' | 'name' | 'region' | 'cidr' | 'vpc' | 'description'
  >
}
type InternetOperationResult = {
  id: string
  name: string
  previous_enabled: boolean
  enabled: boolean
  status: 'updated' | 'failed'
  error?: string
  response?: unknown
}

const headers = [
  'RESOURCE TYPE',
  'NAME',
  'REGION',
  'CIDR',
  'VPC',
  'DESCRIPTION',
]
const emptyForm = (type: ResourceType = 'vpc'): FormState => ({
  type,
  name: '',
  description: '',
  cidr: '',
  region: '',
  vpc: '',
})
const labels: Record<ResourceType, string> = {
  vpc: 'VPC',
  subnet: 'Subnet',
  security_group: 'Security group',
}
const paths: Record<ResourceType, string> = {
  vpc: '/cloud/network/vpcs',
  subnet: '/cloud/network/subnets',
  security_group: '/cloud/network/security-groups',
}

function textValue(value: ResourceRow['region'] | ResourceRow['vpc']) {
  if (!value) return ''
  if (typeof value === 'string') return value
  return String(value.display_name || value.name || value.id || '')
}

function idValue(value: ResourceRow['vpc']) {
  return typeof value === 'string' ? value : String(value?.id || '')
}

function errorValue(value: unknown) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return JSON.stringify(value)
  return ''
}

function apiErrorInfo(error: unknown) {
  const data = (
    error as {
      response?: {
        status?: number
        data?: {
          detail?: unknown
          error?: {
            code?: unknown
            message?: unknown
            upstream_status?: unknown
            upstream_detail?: unknown
            correlation_id?: unknown
          }
        }
      }
    }
  )?.response?.data
  const responseStatus = (error as { response?: { status?: number } })?.response
    ?.status
  const gateway = data?.error
  const message =
    errorValue(gateway?.upstream_detail) ||
    errorValue(data?.detail) ||
    errorValue(gateway?.message) ||
    (error instanceof Error ? error.message : 'Operation failed')
  const context = [
    (gateway?.upstream_status ?? responseStatus)
      ? `HTTP ${gateway?.upstream_status ?? responseStatus}`
      : '',
    gateway?.code ? `code: ${String(gateway.code)}` : '',
    gateway?.correlation_id
      ? `correlation: ${String(gateway.correlation_id)}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return { message, context }
}

function errorText(error: unknown) {
  const { message, context } = apiErrorInfo(error)
  return context ? `${message} · ${context}` : message
}

function showApiError(error: unknown) {
  const { message, context } = apiErrorInfo(error)
  toast.error(
    message,
    context ? { description: context, duration: 10_000 } : undefined
  )
}

function resultDetail(row: OperationResult) {
  if (!row.error) return 'Completed'
  if (typeof row.error === 'string') return row.error
  if (typeof row.error === 'object' && row.error) {
    const value = row.error as {
      message?: unknown
      detail?: unknown
      upstream_detail?: unknown
    }
    // The gateway preserves the precise Viettel Cloud/OpenStack explanation in
    // upstream_detail. It is more actionable than the generic gateway message.
    if (
      typeof value.upstream_detail === 'string' &&
      value.upstream_detail.trim()
    )
      return value.upstream_detail
    if (typeof value.message === 'string') return value.message
    if (typeof value.detail === 'string') return value.detail
  }
  return JSON.stringify(row.error)
}

function formatDetail(value: unknown) {
  if (value === undefined || value === null || value === '')
    return 'No data returned.'
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function normalizeType(value: string): ResourceType | undefined {
  const normalized = value.trim().toLowerCase().replace(/[ -]+/g, '_')
  if (normalized === 'vpc') return 'vpc'
  if (normalized === 'subnet') return 'subnet'
  if (['security_group', 'securitygroup', 'sg'].includes(normalized))
    return 'security_group'
}

function resourceRows(
  scope: Scope,
  vpcs: ResourceRow[],
  subnets: ResourceRow[],
  groups: ResourceRow[],
  regionName: (value: ResourceRow['region']) => string
) {
  const wanted =
    scope === 'all'
      ? (['vpc', 'subnet', 'security_group'] as ResourceType[])
      : [scope]
  return wanted.flatMap((type) => {
    const rows = type === 'vpc' ? vpcs : type === 'subnet' ? subnets : groups
    return rows.map((row) => [
      type === 'security_group' ? 'SECURITY_GROUP' : type.toUpperCase(),
      row.name,
      regionName(row.region),
      row.cidr || '',
      textValue(row.vpc),
      row.description || '',
    ])
  })
}

export function NetworkPage() {
  const project = useCloudStore((state) => state.project)!
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const jsonFileRef = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<ResourceType>('vpc')
  const [form, setForm] = useState<FormState>()
  const [deleteTarget, setDeleteTarget] = useState<{
    type: ResourceType
    rows: ResourceRow[]
  }>()
  const [deletePhrase, setDeletePhrase] = useState('')
  const [internetTarget, setInternetTarget] = useState<ResourceRow>()
  const [internetBatchTarget, setInternetBatchTarget] = useState<{
    rows: ResourceRow[]
    enabled: boolean
  }>()
  const [internetResults, setInternetResults] = useState<
    InternetOperationResult[]
  >([])
  const [internetResultDetail, setInternetResultDetail] =
    useState<InternetOperationResult>()
  const [importScope, setImportScope] = useState<Scope>('all')
  const [importRows, setImportRows] = useState<ImportRow[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [jsonOpen, setJsonOpen] = useState(false)
  const [jsonInput, setJsonInput] = useState('')
  const [results, setResults] = useState<OperationResult[]>([])
  const [selectedResultDetail, setSelectedResultDetail] =
    useState<OperationResult>()
  const [importCreateTarget, setImportCreateTarget] = useState<ImportRow[]>()

  const useResources = (type: ResourceType) =>
    useQuery({
      queryKey: ['cloud', project.id, 'network', type],
      queryFn: async ({ signal }) => {
        const items: ResourceRow[] = []
        let page = 1
        let total: number
        do {
          const response = (
            await apiClient.get<Page<ResourceRow>>(paths[type], {
              params: { page, page_size: 200 }, signal,
            })
          ).data
          items.push(...response.items)
          total = response.total
          page += 1
          if (!response.items.length) break
        } while (items.length < total)
        return { items, total, page: 1, page_size: items.length }
      },
      staleTime: 20_000,
    })
  const vpcQuery = useResources('vpc')
  const subnetQuery = useResources('subnet')
  const groupQuery = useResources('security_group')
  const zonesQuery = useQuery({
    queryKey: ['cloud', project.id, 'network', 'zones'],
    queryFn: async ({ signal }) =>
      (await apiClient.get<Page<ResourceRow>>('/cloud/zones', { signal })).data,
    staleTime: 60_000,
  })
  const vpcs = useMemo(() => vpcQuery.data?.items ?? [], [vpcQuery.data?.items])
  const subnets = useMemo(
    () => subnetQuery.data?.items ?? [],
    [subnetQuery.data?.items]
  )
  const groups = useMemo(
    () => groupQuery.data?.items ?? [],
    [groupQuery.data?.items]
  )
  const currentRows = tab === 'vpc' ? vpcs : tab === 'subnet' ? subnets : groups
  const loading =
    vpcQuery.isLoading || subnetQuery.isLoading || groupQuery.isLoading

  const regionOptions = useMemo(() => {
    const names = new Set<string>()
    for (const zone of zonesQuery.data?.items ?? []) {
      const region = zone.region
      if (typeof region === 'object' && region?.name)
        names.add(String(region.name))
    }
    return [...names].sort().map((name) => ({ value: name, label: name }))
  }, [zonesQuery.data?.items])
  const regionNamesById = useMemo(() => {
    const values = new Map<string, string>()
    for (const zone of zonesQuery.data?.items ?? []) {
      const region = zone.region
      if (typeof region === 'object' && region?.name) {
        if (region.id) values.set(String(region.id), String(region.name))
        values.set(String(region.name), String(region.name))
      }
    }
    return values
  }, [zonesQuery.data?.items])
  const regionName = (value: ResourceRow['region']) => {
    if (!value) return ''
    if (typeof value === 'object')
      return String(value.name || value.display_name || '')
    return regionNamesById.get(value) || value
  }
  const vpcOptions = useMemo(
    () =>
      vpcs.map((row) => ({
        value: row.id,
        label: row.name,
        description: row.cidr,
      })),
    [vpcs]
  )

  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: ['cloud', project.id, 'network'],
    })
  }
  const saveMutation = useMutation({
    mutationFn: async (value: FormState) => {
      const body = {
        name: value.name.trim(),
        description: value.description.trim(),
        ...(value.type !== 'security_group' && { cidr: value.cidr.trim() }),
        ...(value.type !== 'subnet' && { region: value.region }),
        ...(value.type === 'subnet' && { vpc: value.vpc }),
      }
      return value.id
        ? (await apiClient.put(`${paths[value.type]}/${value.id}`, body)).data
        : (await apiClient.post(paths[value.type], body)).data
    },
    onSuccess: async (_, value) => {
      toast.success(
        `${labels[value.type]} ${value.id ? 'updated' : 'created'}.`
      )
      setForm(undefined)
      await refresh()
    },
    onError: showApiError,
  })
  const deleteMutation = useMutation({
    mutationFn: async ({
      type,
      rows,
    }: {
      type: ResourceType
      rows: ResourceRow[]
    }) =>
      rows.length === 1
        ? (await apiClient.delete(`${paths[type]}/${rows[0].id}`)).data
        : (
            await apiClient.post(
              `${paths[type]}/delete`,
              { ids: rows.map((row) => row.id) },
              { timeout: 300_000 }
            )
          ).data,
    onSuccess: async (data, value) => {
      const items = (data?.items ?? [
        { id: value.rows[0]?.id, status: 'deleted' },
      ]) as OperationResult[]
      setResults(items)
      setDeleteTarget(undefined)
      setDeletePhrase('')
      await refresh()
    },
    onError: showApiError,
  })
  const internetMutation = useMutation({
    mutationFn: async (row: ResourceRow) =>
      (
        await apiClient.put(
          `${paths.vpc}/${row.id}/internet-access`,
          {
            enabled: !row.internet_access,
            route_table_id: row.route_tables?.[0],
            // This Cloud API operation can take several minutes. The UI stays open
            // and locked until the audited gateway returns a final response.
          },
          { timeout: 0 }
        )
      ).data,
    onSuccess: async () => {
      setInternetTarget(undefined)
      toast.success('Internet access updated.')
      await refresh()
    },
    onError: showApiError,
  })
  const internetBatchMutation = useMutation({
    mutationFn: async (target: { rows: ResourceRow[]; enabled: boolean }) => {
      const items: InternetOperationResult[] = []
      for (const row of target.rows) {
        try {
          const response = (
            await apiClient.put(
              `${paths.vpc}/${row.id}/internet-access`,
              {
                enabled: target.enabled,
                route_table_id: row.route_tables?.[0],
              },
              { timeout: 0 }
            )
          ).data
          items.push({
            id: row.id,
            name: row.name,
            previous_enabled: Boolean(row.internet_access),
            enabled: target.enabled,
            status: 'updated',
            response,
          })
        } catch (error) {
          items.push({
            id: row.id,
            name: row.name,
            previous_enabled: Boolean(row.internet_access),
            enabled: target.enabled,
            status: 'failed',
            error: errorText(error),
            response: (error as { response?: { data?: unknown } })?.response
              ?.data,
          })
        }
      }
      return items
    },
    onSuccess: async (items) => {
      setInternetBatchTarget(undefined)
      setInternetResults(items)
      await refresh()
      toast.success(
        `${items.filter((item) => item.status === 'updated').length}/${items.length} VPC internet operation(s) completed.`
      )
    },
  })
  const importMutation = useMutation({
    mutationFn: async (rows: ImportRow[]) =>
      (
        await apiClient.post(
          '/cloud/network/import',
          {
            items: rows
              .filter((row) => !row.errors.length)
              .map((row) => ({
                client_id: row.client_id,
                resource_type: row.type,
                name: row.name,
                description: row.description,
                region: row.region || null,
                cidr: row.cidr || null,
                vpc: row.vpc || null,
              })),
            // The gateway processes imports sequentially. Disable the browser-side
            // timeout so a large plan can finish while each failed row is isolated.
          },
          { timeout: 0 }
        )
      ).data,
    onSuccess: async (data, submittedRows) => {
      const sourceById = new Map(
        submittedRows.map((row) => [row.client_id, row])
      )
      setResults(
        (data.items ?? []).map((item: OperationResult) => ({
          ...item,
          source: item.client_id ? sourceById.get(item.client_id) : undefined,
        }))
      )
      setImportCreateTarget(undefined)
      setImportOpen(false)
      await refresh()
    },
    onError: showApiError,
  })

  const actionColumn = (type: ResourceType): ColumnDef<ResourceRow> => ({
    id: 'actions',
    header: '',
    enableHiding: false,
    cell: ({ row }) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant='ghost'
            size='icon'
            aria-label={`${labels[type]} actions`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuItem
            onClick={() =>
              setForm({
                type,
                id: row.original.id,
                name: row.original.name,
                description: row.original.description || '',
                cidr: row.original.cidr || '',
                region:
                  typeof row.original.region === 'string'
                    ? row.original.region
                    : String(row.original.region?.id || ''),
                vpc: idValue(row.original.vpc),
              })
            }
          >
            <Pencil /> Edit
          </DropdownMenuItem>
          {type === 'vpc' && (
            <DropdownMenuItem
              disabled={internetMutation.isPending}
              onClick={() => setInternetTarget(row.original)}
            >
              <Globe2 /> {row.original.internet_access ? 'Disable' : 'Enable'}{' '}
              Internet
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className='text-destructive focus:text-destructive'
            onClick={() => {
              setDeletePhrase('')
              setDeleteTarget({ type, rows: [row.original] })
            }}
          >
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  })
  const columns: Record<ResourceType, ColumnDef<ResourceRow>[]> = {
    vpc: [
      {
        accessorKey: 'name',
        header: ({ column }) => <SortableHeader column={column} title='Name' />,
        cell: ({ row }) => (
          <div>
            <div className='font-medium'>{row.original.name}</div>
            <div className='max-w-64 truncate text-xs text-muted-foreground'>
              {row.original.description || 'No description'}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'cidr',
        header: 'CIDR',
        cell: ({ row }) => <code className='text-xs'>{row.original.cidr}</code>,
      },
      {
        id: 'region',
        accessorFn: (row) => regionName(row.region),
        header: 'Region',
      },
      {
        accessorKey: 'internet_access',
        header: 'Internet',
        cell: ({ row }) => (
          <Badge
            variant={row.original.internet_access ? 'default' : 'secondary'}
          >
            {row.original.internet_access ? 'Enabled' : 'Disabled'}
          </Badge>
        ),
      },
      {
        accessorKey: 'created_at',
        header: 'Created',
        cell: ({ row }) =>
          row.original.created_at
            ? new Date(row.original.created_at).toLocaleString()
            : '—',
      },
      actionColumn('vpc'),
    ],
    subnet: [
      {
        accessorKey: 'name',
        header: ({ column }) => <SortableHeader column={column} title='Name' />,
        cell: ({ row }) => (
          <div>
            <div className='font-medium'>{row.original.name}</div>
            <div className='max-w-64 truncate text-xs text-muted-foreground'>
              {row.original.description || 'No description'}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'cidr',
        header: 'CIDR',
        cell: ({ row }) => <code className='text-xs'>{row.original.cidr}</code>,
      },
      {
        id: 'vpc',
        accessorFn: (row) => textValue(row.vpc),
        header: 'VPC',
        cell: ({ row }) => textValue(row.original.vpc) || '—',
      },
      {
        id: 'region',
        accessorFn: (row) => regionName(row.region),
        header: 'Region',
      },
      {
        accessorKey: 'created_at',
        header: 'Created',
        cell: ({ row }) =>
          row.original.created_at
            ? new Date(row.original.created_at).toLocaleString()
            : '—',
      },
      actionColumn('subnet'),
    ],
    security_group: [
      {
        accessorKey: 'name',
        header: ({ column }) => <SortableHeader column={column} title='Name' />,
        cell: ({ row }) => (
          <div>
            <div className='font-medium'>{row.original.name}</div>
            <div className='max-w-96 truncate text-xs text-muted-foreground'>
              {row.original.description || 'No description'}
            </div>
          </div>
        ),
      },
      {
        id: 'region',
        accessorFn: (row) => regionName(row.region),
        header: 'Region',
      },
      {
        accessorKey: 'rules_count',
        header: 'Rules',
        cell: ({ row }) => String(row.original.rules_count ?? '—'),
      },
      {
        accessorKey: 'created_at',
        header: 'Created',
        cell: ({ row }) =>
          row.original.created_at
            ? new Date(row.original.created_at).toLocaleString()
            : '—',
      },
      actionColumn('security_group'),
    ],
  }

  const downloadTemplate = (scope: Scope, includeData = false) => {
    const samples: unknown[][] = [
      [
        'VPC',
        'app-vpc',
        regionOptions[0]?.value || '',
        '10.20.0.0/16',
        '',
        'Application network',
      ],
      [
        'SUBNET',
        'app-subnet',
        '',
        '10.20.1.0/24',
        'app-vpc',
        'Application subnet',
      ],
      [
        'SECURITY_GROUP',
        'app-sg',
        regionOptions[0]?.value || '',
        '',
        '',
        'Application security group',
      ],
    ]
    const typeValues =
      scope === 'all'
        ? ['VPC', 'SUBNET', 'SECURITY_GROUP']
        : [scope === 'security_group' ? 'SECURITY_GROUP' : scope.toUpperCase()]
    const rows = includeData
      ? resourceRows(scope, vpcs, subnets, groups, regionName)
      : samples.filter(
          (row) => normalizeType(String(row[0])) === scope || scope === 'all'
        )
    downloadXlsx(
      headers,
      rows,
      `${project.name || project.id}-network-${scope}`,
      {
        title: `${project.name || project.id} network resources`,
        metadata: [
          { label: 'Project', value: project.name || project.id },
          { label: 'Scope', value: scope },
        ],
        validations: [
          {
            header: 'RESOURCE TYPE',
            values: typeValues,
            allowBlank: false,
            prompt: 'Required. Select the resource type.',
            error: 'RESOURCE TYPE is required and must use a listed value.',
          },
          {
            header: 'NAME',
            values: [],
            type: 'custom',
            allowBlank: false,
            formula: 'LEN(TRIM({cell}))>0',
            prompt: 'Required for every resource.',
            error: 'NAME is required.',
          },
          {
            header: 'REGION',
            values: regionOptions.map((item) => item.value),
            allowBlank: false,
            enforce: true,
            enabledWhen: {
              header: 'RESOURCE TYPE',
              values: ['VPC', 'SECURITY_GROUP'],
            },
            prompt: 'Required for VPC and Security Group; blank for Subnet.',
            error:
              'Select a Region name for VPC/Security Group, or leave blank for Subnet.',
          },
          {
            header: 'CIDR',
            values: [],
            type: 'custom',
            allowBlank: false,
            formula:
              'OR(AND(OR($A{row}="VPC",$A{row}="SUBNET"),LEN(TRIM({cell}))>0),AND($A{row}="SECURITY_GROUP",LEN(TRIM({cell}))=0))',
            prompt: 'Required for VPC/Subnet; blank for Security Group.',
            error:
              'CIDR is required for VPC/Subnet and must be blank for Security Group.',
          },
          {
            header: 'VPC',
            values: vpcs.map((row) => row.name),
            allowBlank: false,
            enforce: true,
            enabledWhen: { header: 'RESOURCE TYPE', values: ['SUBNET'] },
            prompt: 'Required for Subnet; blank for other resource types.',
            error:
              'Select a VPC name for Subnet, or leave blank for other resource types.',
          },
        ],
        validationRowCount: 1000,
      }
    )
  }

  const reviewImportRows = (
    records: Array<Record<string, string>>,
    scope: Scope,
    rowOffset = 2,
    clientPrefix = 'row'
  ) => {
    const existingByType: Record<ResourceType, ResourceRow[]> = {
      vpc: vpcs,
      subnet: subnets,
      security_group: groups,
    }
    const workbookVpcNames = new Set(
      records
        .filter(
          (record) => normalizeType(record['RESOURCE TYPE'] || '') === 'vpc'
        )
        .map((record) => record.NAME?.trim().toLowerCase())
        .filter(Boolean)
    )
    const reviewed = records.map((record, index): ImportRow => {
      const declaredType = normalizeType(record['RESOURCE TYPE'] || '')
      const selectedType = scope === 'all' ? declaredType : scope
      const errors: string[] = []
      const warnings: string[] = []
      if (!record['RESOURCE TYPE']?.trim())
        errors.push('RESOURCE TYPE is required')
      else if (!declaredType) errors.push('Unsupported resource type')
      else if (scope !== 'all' && declaredType !== scope)
        errors.push(`RESOURCE TYPE must be ${labels[scope]}`)
      if (!record.NAME?.trim()) errors.push('Name is required')
      if (
        selectedType &&
        selectedType !== 'security_group' &&
        !record.CIDR?.trim()
      )
        errors.push('CIDR is required')
      if (selectedType && selectedType !== 'subnet' && !record.REGION?.trim())
        errors.push('Region is required')
      if (selectedType === 'subnet' && !record.VPC?.trim())
        errors.push('VPC is required')
      const regionMatch = regionOptions.find(
        (item) => item.value.toLowerCase() === record.REGION?.toLowerCase()
      )
      const vpcMatch = vpcs.find(
        (item) => item.name.toLowerCase() === record.VPC?.toLowerCase()
      )
      if (
        selectedType &&
        selectedType !== 'subnet' &&
        record.REGION?.trim() &&
        !regionMatch
      )
        errors.push(`Region '${record.REGION}' was not found`)
      if (selectedType === 'subnet' && record.REGION?.trim())
        errors.push('REGION must be blank for Subnet')
      const referencesWorkbookVpc = workbookVpcNames.has(
        record.VPC?.trim().toLowerCase()
      )
      if (
        selectedType === 'subnet' &&
        record.VPC?.trim() &&
        !vpcMatch &&
        !referencesWorkbookVpc
      )
        errors.push(`VPC '${record.VPC}' was not found`)
      if (selectedType !== 'subnet' && record.VPC?.trim())
        errors.push('VPC must be blank unless RESOURCE TYPE is Subnet')
      if (selectedType === 'security_group' && record.CIDR?.trim())
        errors.push('CIDR must be blank for Security Group')
      if (selectedType) {
        const currentResources = existingByType[selectedType]
        const normalizedName = record.NAME?.trim().toLowerCase()
        const normalizedCidr = record.CIDR?.trim().toLowerCase()
        if (
          normalizedName &&
          currentResources.some(
            (resource) => resource.name.trim().toLowerCase() === normalizedName
          )
        )
          warnings.push(
            `${labels[selectedType]} name '${record.NAME.trim()}' already exists in this project`
          )
        if (
          normalizedCidr &&
          currentResources.some(
            (resource) =>
              String(resource.cidr || '')
                .trim()
                .toLowerCase() === normalizedCidr
          )
        )
          warnings.push(
            `CIDR '${record.CIDR.trim()}' already exists in this project`
          )
      }
      return {
        client_id: `${clientPrefix}-${index + rowOffset}`,
        row: index + rowOffset,
        type: selectedType || 'vpc',
        name: record.NAME || '',
        description: record.DESCRIPTION || '',
        cidr: record.CIDR || '',
        region: regionMatch?.value || record.REGION || '',
        vpc: vpcMatch?.name || record.VPC || '',
        errors,
        warnings,
      }
    })
    const plannedVpcs = new Map(
      reviewed
        .filter((row) => row.type === 'vpc')
        .map((row) => [row.name.trim().toLowerCase(), row])
    )
    return reviewed.map((row) => {
      if (row.type !== 'subnet') return row
      const vpcName = row.vpc.trim().toLowerCase()
      const plannedVpc = plannedVpcs.get(vpcName)
      if (plannedVpc?.errors.length)
        row.errors.push(
          `VPC '${row.vpc}' has validation errors and cannot be created with this Subnet`
        )
      return row
    })
  }

  const exampleRegion = regionOptions[0]?.value || 'vn-central-1'
  const jsonSample = JSON.stringify(
    {
      version: 1,
      resources: [
        {
          resource_type: 'vpc',
          name: 'app-vpc',
          region: exampleRegion,
          cidr: '10.20.0.0/16',
          description: 'Application network',
        },
        {
          resource_type: 'subnet',
          name: 'Sub_App',
          cidr: '10.20.1.0/24',
          vpc: 'app-vpc',
          description: 'Application subnet',
        },
        {
          resource_type: 'security_group',
          name: 'SG_App',
          region: exampleRegion,
          description: 'Subnet policy',
        },
        {
          resource_type: 'security_group',
          name: 'SG_All',
          region: exampleRegion,
          description: 'Shared rules for all servers',
        },
      ],
    },
    null,
    2
  )
  const regionConstraint = regionOptions.length
    ? regionOptions.map((item) => `- ${item.value}`).join('\n')
    : '- Load the Network page and select the exact Region name shown by CloudTool.'
  const jsonPrompt = `Create a valid CloudTool Network import JSON file. Return only JSON, without Markdown.

Root object
- version: required integer, exactly 1.
- resources: required non-empty array; maximum 1000 items.

Common resource keys
- resource_type: required exact string: "vpc", "subnet", or "security_group".
- name: required non-empty string, maximum 160 characters.
- description: optional string, maximum 500 characters.
- Do not add unsupported keys.

Type constraints
- vpc: requires region and cidr. region must be one of the exact Region names below. cidr must be a valid IPv4/IPv6 network CIDR, for example "10.20.0.0/16". Do not send vpc.
- subnet: requires cidr and vpc. vpc must be the exact name of an existing VPC or a VPC declared in this same resources array. Do not send region.
- security_group: requires region. Do not send cidr or vpc.
- When generating this plan, include one companion security group for every subnet. Prefer the naming convention "Sub_ABC" for the subnet and "SG_ABC" for its security group.
- When generating security groups, include "SG_All" as the shared group for common rules across all servers.
- Region values are names, never IDs. Valid Region names for the selected project:
${regionConstraint}

The system creates VPCs before dependent Subnets automatically. Use this complete example as the file structure:

${jsonSample}`
  const downloadJsonSample = () => {
    const url = URL.createObjectURL(
      new Blob([jsonSample], { type: 'application/json' })
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `${project.name || project.id}-network-template.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const chooseImport = (scope: Scope) => {
    setImportScope(scope)
    fileRef.current?.click()
  }
  const readImport = async (file?: File) => {
    if (!file) return
    try {
      const records = rowsFromHeader(parseXlsxRows(await file.arrayBuffer()), [
        'RESOURCE TYPE',
        'NAME',
      ])
      setImportRows(reviewImportRows(records, importScope))
      setImportOpen(true)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  const reviewJsonContent = (content: string) => {
    try {
      const parsed = JSON.parse(content) as {
        version?: unknown
        resources?: unknown
        items?: unknown
      }
      const items = Array.isArray(parsed.resources)
        ? parsed.resources
        : Array.isArray(parsed.items)
          ? parsed.items
          : undefined
      if (!items) throw new Error('JSON must contain a resources array.')
      if (parsed.version !== 1) throw new Error('JSON version must be 1.')
      const records = items.map((item) => {
        const value =
          item && typeof item === 'object'
            ? (item as Record<string, unknown>)
            : {}
        const text = (field: string) => {
          const current = value[field]
          return current === null || current === undefined
            ? ''
            : String(current)
        }
        return {
          'RESOURCE TYPE': text('resource_type'),
          NAME: text('name'),
          REGION: text('region'),
          CIDR: text('cidr'),
          VPC: text('vpc'),
          DESCRIPTION: text('description'),
        }
      })
      if (!records.length)
        throw new Error('resources must contain at least one resource.')
      setImportScope('all')
      setImportRows(reviewImportRows(records, 'all', 1, 'json'))
      setJsonOpen(false)
      setImportOpen(true)
    } catch (error) {
      toast.error(errorText(error))
    }
  }
  const readJsonImport = async (file?: File) => {
    if (!file) return
    try {
      reviewJsonContent(await file.text())
    } finally {
      if (jsonFileRef.current) jsonFileRef.current.value = ''
    }
  }
  const reviewPastedJson = () => {
    if (!jsonInput.trim()) return toast.error('Paste a JSON document first.')
    reviewJsonContent(jsonInput)
  }
  const importColumns: ColumnDef<ImportRow>[] = [
    { accessorKey: 'row', header: '#', cell: ({ row }) => row.original.row },
    { id: 'type', accessorFn: (row) => labels[row.type], header: 'Type' },
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => (
        <span className='font-medium'>{row.original.name || '—'}</span>
      ),
    },
    {
      accessorKey: 'region',
      header: 'Region',
      cell: ({ row }) => row.original.region || '—',
    },
    {
      accessorKey: 'cidr',
      header: 'CIDR',
      cell: ({ row }) =>
        row.original.cidr ? (
          <code className='text-xs'>{row.original.cidr}</code>
        ) : (
          '—'
        ),
    },
    {
      accessorKey: 'vpc',
      header: 'VPC',
      cell: ({ row }) => row.original.vpc || '—',
    },
    {
      id: 'review',
      accessorFn: (row) => [...row.errors, ...row.warnings].join(' '),
      header: 'Review',
      cell: ({ row }) => {
        const { errors, warnings } = row.original
        if (!errors.length && !warnings.length)
          return (
            <Badge className='bg-emerald-600 text-white hover:bg-emerald-600'>
              Ready
            </Badge>
          )
        return (
          <div className='max-w-96 space-y-1 text-xs leading-5 whitespace-normal'>
            {errors.length ? (
              <div className='text-destructive'>{errors.join('; ')}</div>
            ) : null}
            {warnings.length ? (
              <div className='text-amber-700 dark:text-amber-400'>
                {warnings.join('; ')}
              </div>
            ) : null}
          </div>
        )
      },
    },
  ]
  const createSelectedImportRows = (selected: ImportRow[]) => {
    const selectedVpcNames = new Set(
      selected
        .filter((row) => row.type === 'vpc')
        .map((row) => row.name.trim().toLowerCase())
    )
    const existingVpcNames = new Set(
      vpcs.map((row) => row.name.trim().toLowerCase())
    )
    const missingVpcRows = selected.filter(
      (row) =>
        row.type === 'subnet' &&
        !existingVpcNames.has(row.vpc.trim().toLowerCase()) &&
        !selectedVpcNames.has(row.vpc.trim().toLowerCase())
    )
    if (missingVpcRows.length) {
      const names = [
        ...new Set(missingVpcRows.map((row) => `${row.name} → ${row.vpc}`)),
      ]
      toast.warning(
        `Select the required VPC row with its Subnet before creating: ${names.join(', ')}`
      )
      return
    }
    setImportCreateTarget(selected)
  }

  const importFailedResultsToReview = (failedResults: OperationResult[]) => {
    const retryableRows = failedResults.filter(
      (row) => row.status === 'failed' && row.source
    )
    if (!retryableRows.length) return
    const records = retryableRows.map((row) => ({
      'RESOURCE TYPE': row.source!.type,
      NAME: row.source!.name,
      REGION: row.source!.region,
      CIDR: row.source!.cidr,
      VPC: row.source!.vpc,
      DESCRIPTION: row.source!.description,
    }))
    setImportScope('all')
    setImportRows(reviewImportRows(records, 'all', 1, `retry-${Date.now()}`))
    setResults([])
    setImportOpen(true)
  }
  const resultColumns: ColumnDef<OperationResult>[] = [
    {
      id: 'index',
      header: '#',
      cell: ({ row }) => row.index + 1,
      enableSorting: false,
    },
    {
      id: 'type',
      accessorFn: (row) => (row.source ? labels[row.source.type] : '—'),
      header: 'Type',
    },
    {
      id: 'name',
      accessorFn: (row) =>
        row.resource?.name || row.source?.name || row.id || row.client_id || '',
      header: 'Name',
      cell: ({ row }) => (
        <span className='font-medium'>
          {row.original.resource?.name ||
            row.original.source?.name ||
            row.original.id ||
            row.original.client_id ||
            '—'}
        </span>
      ),
    },
    {
      id: 'region',
      accessorFn: (row) => row.source?.region || '',
      header: 'Region',
      cell: ({ row }) => row.original.source?.region || '—',
    },
    {
      id: 'cidr',
      accessorFn: (row) => row.source?.cidr || '',
      header: 'CIDR',
      cell: ({ row }) =>
        row.original.source?.cidr ? (
          <code className='text-xs'>{row.original.source.cidr}</code>
        ) : (
          '—'
        ),
    },
    {
      id: 'vpc',
      accessorFn: (row) => row.source?.vpc || '',
      header: 'VPC',
      cell: ({ row }) => row.original.source?.vpc || '—',
    },
    {
      id: 'cloud_id',
      accessorFn: (row) => row.resource?.id || row.id || '',
      header: 'Cloud ID',
      cell: ({ row }) => {
        const value = row.original.resource?.id || row.original.id || '—'
        return (
          <span
            className='block max-w-48 truncate font-mono text-xs'
            title={value}
          >
            {value}
          </span>
        )
      },
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <Badge
          variant={row.original.status === 'failed' ? 'destructive' : 'default'}
        >
          {row.original.status}
        </Badge>
      ),
    },
    {
      id: 'detail',
      accessorFn: resultDetail,
      header: 'Detail',
      cell: ({ row }) => (
        <span
          className={
            row.original.error
              ? 'block max-w-md text-sm font-medium whitespace-normal text-destructive'
              : 'block max-w-md text-xs text-muted-foreground'
          }
        >
          {resultDetail(row.original)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      enableHiding: false,
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant='ghost' size='icon' aria-label='Operation actions'>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => setSelectedResultDetail(row.original)}
            >
              <Eye /> View detail
            </DropdownMenuItem>
            {row.original.status === 'failed' && row.original.source ? (
              <DropdownMenuItem
                onClick={() => importFailedResultsToReview([row.original])}
              >
                <Upload /> Import to review
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ]

  return (
    <CloudPageShell
      title='Network'
      description='Manage VPCs, subnets and security groups for the selected project.'
      tableHelp
      help={
        <p>
          Use a unified workbook to create dependent resources in VPC → Subnet →
          Security group order. Every row is processed independently and logged.
        </p>
      }
      actions={
        <>
          <Button variant='outline' onClick={() => downloadTemplate('all')}>
            <FileSpreadsheet /> Template
          </Button>
          <Button variant='outline' onClick={() => chooseImport('all')}>
            <Upload /> Import
          </Button>
          <Button
            variant='outline'
            onClick={() => {
              setJsonInput('')
              setJsonOpen(true)
            }}
          >
            <FileJson /> JSON
          </Button>
          <Button onClick={() => setForm(emptyForm(tab))}>
            <Plus /> Add resource
          </Button>
        </>
      }
    >
      <input
        ref={fileRef}
        type='file'
        accept='.xlsx'
        className='hidden'
        onChange={(event) => void readImport(event.target.files?.[0])}
      />
      <input
        ref={jsonFileRef}
        type='file'
        accept='.json,application/json'
        className='hidden'
        onChange={(event) => void readJsonImport(event.target.files?.[0])}
      />
      <div className='mb-3 grid shrink-0 gap-2 sm:grid-cols-3'>
        {(
          [
            ['vpc', 'VPCs', vpcs.length, Globe2],
            ['subnet', 'Subnets', subnets.length, Network],
            ['security_group', 'Security groups', groups.length, ShieldCheck],
          ] as const
        ).map(([value, title, count, Icon]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 text-start transition-colors ${tab === value ? 'border-primary/50 bg-primary/5' : 'hover:bg-muted/50'}`}
          >
            <Icon
              className={`size-4 ${tab === value ? 'text-primary' : 'text-muted-foreground'}`}
            />
            <span className='text-sm font-medium'>{title}</span>
            <span className='ms-auto text-xl font-semibold tabular-nums'>
              {count}
            </span>
          </button>
        ))}
      </div>
      <Card className='min-h-0 flex-1 gap-3 py-4'>
        <CardHeader className='px-4'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div>
              <CardTitle>{labels[tab]} inventory</CardTitle>
              <CardDescription>
                Live resources in {project.name || project.id}.
              </CardDescription>
            </div>
            <div className='flex gap-2'>
              <Button
                size='sm'
                variant='outline'
                onClick={() => downloadTemplate(tab)}
              >
                <FileSpreadsheet /> Template
              </Button>
              <Button
                size='sm'
                variant='outline'
                onClick={() => chooseImport(tab)}
              >
                <Upload /> Import
              </Button>
              <Button
                size='sm'
                variant='outline'
                onClick={() => downloadTemplate(tab, true)}
              >
                <Download /> Export
              </Button>
              <Button size='sm' onClick={() => setForm(emptyForm(tab))}>
                <Plus /> Add {labels[tab]}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className='min-h-0 flex-1 px-4'>
          <CloudDataTable
            data={currentRows}
            columns={columns[tab]}
            getRowId={(row) => row.id}
            loading={loading}
            entityName={labels[tab]}
            searchPlaceholder={`Search ${labels[tab].toLowerCase()}s...`}
            exportFileName={`${project.name || project.id}-${tab}`}
            toolbar={(selected, clear) =>
              selected.length ? (
                <div className='flex flex-wrap gap-2'>
                  {tab === 'vpc' && (
                    <>
                      <Button
                        disabled={internetBatchMutation.isPending}
                        onClick={() =>
                          setInternetBatchTarget({
                            rows: selected,
                            enabled: true,
                          })
                        }
                      >
                        <Globe2 /> Enable Internet ({selected.length})
                      </Button>
                      <Button
                        variant='outline'
                        disabled={internetBatchMutation.isPending}
                        onClick={() =>
                          setInternetBatchTarget({
                            rows: selected,
                            enabled: false,
                          })
                        }
                      >
                        <Globe2 /> Disable Internet ({selected.length})
                      </Button>
                    </>
                  )}
                  <Button
                    variant='destructive'
                    onClick={() => {
                      setDeletePhrase('')
                      setDeleteTarget({ type: tab, rows: selected })
                      clear()
                    }}
                  >
                    <Trash2 /> Delete {selected.length}
                  </Button>
                </div>
              ) : null
            }
          />
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(form)}
        onOpenChange={(open) => !open && setForm(undefined)}
      >
        <DialogContent className='sm:max-w-xl'>
          <DialogHeader>
            <DialogTitle>
              {form?.id ? 'Edit' : 'Create'}{' '}
              {form ? labels[form.type] : 'resource'}
            </DialogTitle>
            <DialogDescription>
              {form?.id
                ? 'Only mutable name and description fields are changed.'
                : 'Values are sent through the audited Cloud API gateway.'}
            </DialogDescription>
          </DialogHeader>
          {form && (
            <div className='space-y-4'>
              {!form.id && (
                <div className='space-y-1.5'>
                  <Label>Resource type</Label>
                  <SegmentedTabs
                    value={form.type}
                    onValueChange={(type) => setForm(emptyForm(type))}
                    tabs={[
                      { value: 'vpc', label: 'VPC' },
                      { value: 'subnet', label: 'Subnet' },
                      { value: 'security_group', label: 'Security group' },
                    ]}
                  />
                </div>
              )}
              <div className='space-y-1.5'>
                <Label htmlFor='network-name'>Name *</Label>
                <Input
                  id='network-name'
                  autoFocus
                  value={form.name}
                  onChange={(event) =>
                    setForm({ ...form, name: event.target.value })
                  }
                />
              </div>
              {!form.id && form.type !== 'subnet' && (
                <div className='space-y-1.5'>
                  <Label>Region *</Label>
                  <SearchableSelect
                    value={form.region}
                    onValueChange={(region) => setForm({ ...form, region })}
                    options={regionOptions}
                    placeholder='Select region'
                  />
                </div>
              )}
              {!form.id && form.type === 'subnet' && (
                <div className='space-y-1.5'>
                  <Label>VPC *</Label>
                  <SearchableSelect
                    value={form.vpc}
                    onValueChange={(vpc) => setForm({ ...form, vpc })}
                    options={vpcOptions}
                    placeholder='Select VPC'
                  />
                </div>
              )}
              {!form.id && form.type !== 'security_group' && (
                <div className='space-y-1.5'>
                  <Label htmlFor='network-cidr'>CIDR *</Label>
                  <Input
                    id='network-cidr'
                    value={form.cidr}
                    onChange={(event) =>
                      setForm({ ...form, cidr: event.target.value })
                    }
                    placeholder='10.20.0.0/16'
                  />
                </div>
              )}
              <div className='space-y-1.5'>
                <Label htmlFor='network-description'>Description</Label>
                <Textarea
                  id='network-description'
                  className='min-h-24 resize-y'
                  value={form.description}
                  onChange={(event) =>
                    setForm({ ...form, description: event.target.value })
                  }
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant='outline' onClick={() => setForm(undefined)}>
              Cancel
            </Button>
            <Button
              disabled={
                !form?.name.trim() ||
                saveMutation.isPending ||
                (!form.id && form.type !== 'subnet' && !form.region) ||
                (!form.id && form.type === 'subnet' && !form.vpc) ||
                (!form.id &&
                  form.type !== 'security_group' &&
                  !form.cidr.trim())
              }
              onClick={() => form && saveMutation.mutate(form)}
            >
              {saveMutation.isPending && <Loader2 className='animate-spin' />}{' '}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(internetBatchTarget)}
        onOpenChange={(open) => {
          if (!open && !internetBatchMutation.isPending)
            setInternetBatchTarget(undefined)
        }}
        title={`${internetBatchTarget?.enabled ? 'Enable' : 'Disable'} Internet for ${internetBatchTarget?.rows.length || 0} VPC(s)?`}
        desc='Each VPC is sent sequentially through the audited Cloud API gateway. This can take several minutes; keep this dialog open until every selected VPC has returned a result.'
        confirmText={
          <>
            {internetBatchMutation.isPending && (
              <Loader2 className='animate-spin' />
            )}{' '}
            {internetBatchTarget?.enabled ? 'Enable' : 'Disable'} Internet
          </>
        }
        destructive={Boolean(!internetBatchTarget?.enabled)}
        isLoading={internetBatchMutation.isPending}
        handleConfirm={() =>
          internetBatchTarget &&
          internetBatchMutation
            .mutateAsync(internetBatchTarget)
            .then(() => undefined)
        }
      />

      <ConfirmDialog
        open={Boolean(internetTarget)}
        onOpenChange={(open) => {
          if (!open && !internetMutation.isPending) setInternetTarget(undefined)
        }}
        title={`${internetTarget?.internet_access ? 'Disable' : 'Enable'} Internet access?`}
        desc={`This changes the route table internet access for VPC ${internetTarget?.name || ''}. Viettel Cloud can take several minutes to finish; keep this dialog open until a final result is returned.`}
        confirmText={
          <>
            {internetMutation.isPending && <Loader2 className='animate-spin' />}{' '}
            {internetTarget?.internet_access ? 'Disable' : 'Enable'} Internet
          </>
        }
        destructive={Boolean(internetTarget?.internet_access)}
        isLoading={internetMutation.isPending}
        handleConfirm={() =>
          internetTarget &&
          internetMutation.mutateAsync(internetTarget).then(() => undefined)
        }
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            setDeleteTarget(undefined)
            setDeletePhrase('')
          }
        }}
        title={`Delete ${deleteTarget?.rows.length || 0} ${deleteTarget ? labels[deleteTarget.type] : 'resource'}(s)?`}
        desc='This removes the selected cloud resources. Dependencies can cause individual rows to fail; successful rows are not rolled back.'
        destructive
        disabled={
          (deleteTarget?.rows.length || 0) > 1 &&
          deletePhrase.trim().toLowerCase() !== 'delete'
        }
        confirmText={
          <>
            {deleteMutation.isPending && <Loader2 className='animate-spin' />}{' '}
            Delete
          </>
        }
        isLoading={deleteMutation.isPending}
        handleConfirm={() =>
          deleteTarget && deleteMutation.mutate(deleteTarget)
        }
      >
        {(deleteTarget?.rows.length || 0) > 1 ? (
          <div className='space-y-2'>
            <Label htmlFor='network-delete-confirm'>Confirmation text</Label>
            <Input
              id='network-delete-confirm'
              value={deletePhrase}
              onChange={(event) => setDeletePhrase(event.target.value)}
              placeholder='Delete'
              disabled={deleteMutation.isPending}
            />
            <p className='text-xs text-muted-foreground'>
              Type Delete to confirm removing multiple resources.
            </p>
          </div>
        ) : null}
      </ConfirmDialog>

      <Dialog open={jsonOpen} onOpenChange={setJsonOpen}>
        <DialogContent className='max-h-[92vh] overflow-hidden sm:max-w-6xl'>
          <DialogHeader>
            <DialogTitle>Import Network JSON</DialogTitle>
            <DialogDescription>
              Generate a complete network plan with an AI agent, then validate
              every resource before creating it.
            </DialogDescription>
          </DialogHeader>
          <div className='grid min-h-0 gap-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.35fr)]'>
            <div className='min-h-0 space-y-2'>
              <Label htmlFor='network-json-prompt'>Prompt for AI agent</Label>
              <Textarea
                id='network-json-prompt'
                readOnly
                value={jsonPrompt}
                className='h-[32rem] resize-y font-mono text-xs leading-5'
              />
              <p className='text-xs text-muted-foreground'>
                Prompt includes the schema, allowed Region names and a complete
                JSON sample.
              </p>
            </div>
            <div className='min-h-0 space-y-2'>
              <div className='flex items-center justify-between gap-2'>
                <Label htmlFor='network-json-input'>Paste JSON to import</Label>
              </div>
              <Textarea
                id='network-json-input'
                value={jsonInput}
                onChange={(event) => setJsonInput(event.target.value)}
                spellCheck={false}
                placeholder={'{\n  "version": 1,\n  "resources": []\n}'}
                className='h-[32rem] resize-y font-mono text-xs leading-5'
              />
              <p className='text-xs text-muted-foreground'>
                Paste AI output directly, or choose a .json file. Nothing is
                created until the next review confirms it.
              </p>
            </div>
          </div>
          <DialogFooter className='border-t pt-4'>
            <Button variant='outline' onClick={downloadJsonSample}>
              <Download /> Download sample
            </Button>
            <Button variant='outline' onClick={() => setJsonInput(jsonSample)}>
              <FileJson /> View sample
            </Button>
            <Button
              variant='outline'
              onClick={() => jsonFileRef.current?.click()}
            >
              <Upload /> Choose file
            </Button>
            <Button variant='ghost' onClick={() => setJsonOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!jsonInput.trim()} onClick={reviewPastedJson}>
              <FileJson /> Review JSON
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className='max-h-[90vh] sm:max-w-7xl'>
          <DialogHeader>
            <DialogTitle>Review network import</DialogTitle>
            <DialogDescription>
              {importRows.length} rows loaded.{' '}
              {importRows.filter((row) => !row.errors.length).length} ready,{' '}
              {
                importRows.filter(
                  (row) => row.warnings.length && !row.errors.length
                ).length
              }{' '}
              warning(s), {importRows.filter((row) => row.errors.length).length}{' '}
              need review. Duplicate names/CIDRs are warnings only and do not
              block creation.
            </DialogDescription>
          </DialogHeader>
          <div className='max-h-[62vh] min-h-0 overflow-auto [&>table]:hidden'>
            <CloudDataTable
              data={importRows}
              columns={importColumns}
              getRowId={(row) => row.client_id}
              entityName='network resource'
              searchPlaceholder='Search import rows...'
              emptyText='No import rows found.'
              exportFileName={`${project.name || project.id}-network-import-review`}
              isRowSelectable={(row) => !row.errors.length}
              pageSizeOptions={[10, 25, 50, 100]}
              toolbar={(selected) =>
                selected.length ? (
                  <Button
                    disabled={importMutation.isPending}
                    onClick={() => createSelectedImportRows(selected)}
                  >
                    {importMutation.isPending && (
                      <Loader2 className='animate-spin' />
                    )}{' '}
                    Create selected ({selected.length})
                  </Button>
                ) : null
              }
            />
            <table className='w-full text-sm'>
              <thead className='sticky top-0 bg-muted'>
                <tr>
                  {[
                    'Row',
                    'Type',
                    'Name',
                    'CIDR / Region',
                    'VPC',
                    'Review',
                  ].map((value) => (
                    <th
                      key={value}
                      className='px-3 py-2 text-start font-medium'
                    >
                      {value}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {importRows.map((row) => (
                  <tr key={row.client_id} className='border-t'>
                    <td className='px-3 py-2'>{row.row}</td>
                    <td className='px-3 py-2'>{labels[row.type]}</td>
                    <td className='px-3 py-2 font-medium'>{row.name || '—'}</td>
                    <td className='px-3 py-2'>
                      <div>{row.cidr || '—'}</div>
                      <div className='text-xs text-muted-foreground'>
                        {row.region}
                      </div>
                    </td>
                    <td className='px-3 py-2'>{row.vpc || '—'}</td>
                    <td className='px-3 py-2'>
                      {row.errors.length ? (
                        <span className='text-destructive'>
                          {row.errors.join('; ')}
                        </span>
                      ) : (
                        <span className='text-emerald-600'>Ready</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DialogFooter className='hidden'>
            <Button variant='outline' onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                !importRows.some((row) => !row.errors.length) ||
                importMutation.isPending
              }
              onClick={() => importMutation.mutate(importRows)}
            >
              {importMutation.isPending && <Loader2 className='animate-spin' />}{' '}
              Create valid rows
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(importCreateTarget)}
        onOpenChange={(open) => !open && setImportCreateTarget(undefined)}
        title={`Create ${importCreateTarget?.length || 0} selected network resource(s)?`}
        desc='The selected resources will be created sequentially through the audited Cloud API gateway. VPC rows are created before dependent Subnet rows.'
        confirmText={
          importMutation.isPending ? (
            <>
              <Loader2 className='animate-spin' /> Create selected
            </>
          ) : (
            'Create selected'
          )
        }
        isLoading={importMutation.isPending}
        handleConfirm={() =>
          importCreateTarget && importMutation.mutate(importCreateTarget)
        }
      />

      <Dialog
        open={Boolean(internetResults.length)}
        onOpenChange={(open) => !open && setInternetResults([])}
      >
        <DialogContent className='max-h-[90vh] sm:max-w-6xl'>
          <DialogHeader>
            <DialogTitle>VPC Internet access results</DialogTitle>
            <DialogDescription>
              {
                internetResults.filter((item) => item.status === 'updated')
                  .length
              }{' '}
              of {internetResults.length} selected VPC(s) updated.
            </DialogDescription>
          </DialogHeader>
          <CloudDataTable
            data={internetResults}
            getRowId={(row) => row.id}
            entityName='VPC internet operation'
            searchPlaceholder='Search VPC results...'
            exportFileName={`${project.name || project.id}-vpc-internet-results`}
            columns={[
              { id: 'index', header: '#', cell: ({ row }) => row.index + 1 },
              {
                accessorKey: 'name',
                header: 'VPC',
                cell: ({ row }) => (
                  <div>
                    <div className='font-medium'>{row.original.name}</div>
                    <div className='font-mono text-xs text-muted-foreground'>
                      {row.original.id}
                    </div>
                  </div>
                ),
              },
              {
                id: 'change',
                header: 'Internet access',
                cell: ({ row }) => (
                  <span>
                    {row.original.previous_enabled ? 'Enabled' : 'Disabled'}{' '}
                    <span className='text-muted-foreground'>→</span>{' '}
                    {row.original.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                ),
              },
              {
                accessorKey: 'status',
                header: 'Status',
                cell: ({ row }) => (
                  <Badge
                    variant={
                      row.original.status === 'failed'
                        ? 'destructive'
                        : 'default'
                    }
                  >
                    {row.original.status === 'updated' ? 'Updated' : 'Failed'}
                  </Badge>
                ),
              },
              {
                accessorKey: 'error',
                header: 'Detail',
                cell: ({ row }) => (
                  <span
                    className={
                      row.original.error
                        ? 'block max-w-md text-sm whitespace-normal text-destructive'
                        : 'text-muted-foreground'
                    }
                  >
                    {row.original.error || 'Cloud API completed the operation.'}
                  </span>
                ),
              },
              {
                id: 'actions',
                header: '',
                cell: ({ row }) => (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size='icon' variant='ghost'>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align='end'>
                      <DropdownMenuItem
                        onClick={() => setInternetResultDetail(row.original)}
                      >
                        <Eye /> View API result
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ),
              },
            ]}
          />
          <DialogFooter>
            <Button onClick={() => setInternetResults([])}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(internetResultDetail)}
        onOpenChange={(open) => !open && setInternetResultDetail(undefined)}
      >
        <DialogContent className='max-h-[90vh] sm:max-w-4xl'>
          <DialogHeader>
            <DialogTitle>
              {internetResultDetail?.name || 'VPC Internet access detail'}
            </DialogTitle>
            <DialogDescription>
              Cloud API response for this VPC. Authentication headers are never
              included.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-2'>
            <Label>
              {internetResultDetail?.status === 'failed'
                ? 'Error response'
                : 'Cloud API response'}
            </Label>
            <Textarea
              readOnly
              value={formatDetail(
                internetResultDetail?.response ??
                  (internetResultDetail?.error
                    ? { error: internetResultDetail.error }
                    : undefined)
              )}
              className='h-[28rem] resize-y font-mono text-xs leading-5'
            />
          </div>
          <DialogFooter>
            <Button onClick={() => setInternetResultDetail(undefined)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(results.length)}
        onOpenChange={(open) => !open && setResults([])}
      >
        <DialogContent className='max-h-[90vh] sm:max-w-7xl'>
          <DialogHeader>
            <DialogTitle>Network operation results</DialogTitle>
            <DialogDescription>
              {
                results.filter((row) =>
                  ['created', 'deleted'].includes(row.status)
                ).length
              }{' '}
              of {results.length} operation(s) completed.
            </DialogDescription>
          </DialogHeader>
          <div className='max-h-[65vh] overflow-auto rounded-md border p-3'>
            <CloudDataTable
              data={results}
              columns={resultColumns}
              getRowId={(row) =>
                row.client_id ||
                row.id ||
                `${row.status}-${row.source?.name || 'operation'}`
              }
              entityName='network operation'
              searchPlaceholder='Search operation results...'
              emptyText='No operation results.'
              exportFileName={`${project.name || project.id}-network-operation-results`}
              isRowSelectable={(row) =>
                row.status === 'failed' && Boolean(row.source)
              }
              pageSizeOptions={[10, 25, 50, 100, 200, 500]}
              initialPageSize={100}
              toolbar={(selected, clearSelection) =>
                selected.length ? (
                  <Button
                    onClick={() => {
                      importFailedResultsToReview(selected)
                      clearSelection()
                    }}
                  >
                    <Upload /> Import to review ({selected.length})
                  </Button>
                ) : null
              }
            />
          </div>
          <DialogFooter>
            <Button onClick={() => setResults([])}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(selectedResultDetail)}
        onOpenChange={(open) => !open && setSelectedResultDetail(undefined)}
      >
        <DialogContent className='max-h-[90vh] sm:max-w-6xl'>
          <DialogHeader>
            <DialogTitle>
              {selectedResultDetail?.resource?.name ||
                selectedResultDetail?.source?.name ||
                'Network operation detail'}
            </DialogTitle>
            <DialogDescription>
              Gateway request body and the corresponding Cloud API result.
              Authentication headers are never included.
            </DialogDescription>
          </DialogHeader>
          <div className='grid min-h-0 gap-4 lg:grid-cols-2'>
            <div className='space-y-2'>
              <Label>Gateway request body</Label>
              <Textarea
                readOnly
                value={formatDetail(selectedResultDetail?.request)}
                className='h-[26rem] resize-y font-mono text-xs leading-5'
              />
            </div>
            <div className='space-y-2'>
              <Label>
                {selectedResultDetail?.error
                  ? 'Cloud API error'
                  : 'Cloud API response'}
              </Label>
              <Textarea
                readOnly
                value={formatDetail(
                  selectedResultDetail?.error
                    ? (selectedResultDetail.response ?? {
                        error: selectedResultDetail.error,
                      })
                    : (selectedResultDetail?.response ??
                        selectedResultDetail?.resource)
                )}
                className={
                  selectedResultDetail?.error
                    ? 'h-[26rem] resize-y font-mono text-xs leading-5 text-destructive'
                    : 'h-[26rem] resize-y font-mono text-xs leading-5'
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setSelectedResultDetail(undefined)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CloudPageShell>
  )
}
