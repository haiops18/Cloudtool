import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import {
  Copy,
  CalendarClock,
  Download,
  Eye,
  FileUp,
  FileJson,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { downloadXlsx } from '@/lib/xlsx-export'
import { parseXlsxRows, rowsFromHeader } from '@/lib/xlsx-import'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import { CloudDataTable } from '@/components/cloud-data-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SearchableSelect } from '@/components/searchable-select'
import { SortableHeader } from '@/components/sortable-header'
import { CloudPageShell } from './page-shell'
import { SecurityGroupRuleQuota } from './security-group-rule-quota'
import {
  SecurityGroupRuleEditor,
  type AdaptiveRuleInput,
} from './security-group-rule-editor'

interface SecurityGroup {
  id: string
  name: string
  display_name?: string
  description?: string
  region?: string
  project?: string
  owner?: string
  created_at?: string
  updated_at?: string
}

interface SecurityRule {
  id: string
  display_name?: string
  description?: string
  direction: 'ingress' | 'egress'
  protocol: string
  port_range_min?: number | null
  port_range_max?: number | null
  remote_ip_prefix: string
  ethertype?: string
  security_group?:
    string | { id?: string; name?: string; display_name?: string }
  project?: string
  owner?: string
  created_at?: string
  updated_at?: string
  delete_at?: string | null
}

interface RuleDraft {
  description: string
  direction: 'ingress' | 'egress'
  protocol: string
  port_range_min: string
  port_range_max: string
  remote_ip_prefix: string
  delete_at?: string | null
}

interface PreviewRule extends RuleDraft {
  key: string
  validation: string
  ready: boolean
}
interface MultiGroupRule extends RuleDraft {
  key: string
  row: number
  security_group_id: string
  security_group_name: string
  validation: string
  ready: boolean
}

interface OperationResult {
  index?: number
  client_id?: string
  rule_id?: string
  status: string
  error?: unknown
  response?: unknown
  rule?: SecurityRule
  input?: Partial<SecurityRule>
}

interface ScheduledRule {
  rule_id: string
  security_group_id: string
  security_group_name?: string
  delete_at: string
  status: string
  last_error?: string
  rule?: SecurityRule
}

interface ScheduledDeleteResult extends OperationResult {
  security_group_name?: string
  delete_at?: string
}

const PROTOCOLS = [
  'tcp',
  'udp',
  'any',
  'icmp',
  'igmp',
  'ip',
  'ipv6-icmp',
  'gre',
  'esp',
  'ah',
  'ospf',
  'sctp',
  'vrrp',
  'rsvp',
  'dccp',
  'egp',
  'hopopt',
  'ipip',
  'ipv6-encap',
  'ipv6-frag',
  'ipv6-nontx',
  'ipv6-opts',
  'ipv6-route',
  'pgm',
  'udplite',
]
const emptyRule = (): RuleDraft => ({
  description: '',
  direction: 'ingress',
  protocol: 'tcp',
  port_range_min: '',
  port_range_max: '',
  remote_ip_prefix: '',
  delete_at: '',
})

function portText(min?: number | string | null, max?: number | string | null) {
  if (min === null || min === undefined || min === '') return 'Any'
  return String(min) === String(max) ? String(min) : `${min}-${max}`
}

function parsePort(value: string): [string, string] {
  const text = value.trim()
  if (!text) return ['', '']
  const parts = text.split('-').map((item) => item.trim())
  return parts.length === 1 ? [parts[0], parts[0]] : [parts[0], parts[1] ?? '']
}

function trafficSignature(rule: RuleDraft) {
  return [
    rule.direction,
    rule.protocol,
    rule.port_range_min || '',
    rule.port_range_max || '',
    rule.remote_ip_prefix.trim(),
  ].join('|')
}

function splitMultiValues(value: string) {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function validIpPrefix(value: string) {
  const [address, prefixText] = value.trim().split('/')
  if (!address) return false
  if (address.includes(':')) {
    if (!/^[0-9a-f:]+$/i.test(address) || !address.includes(':')) return false
    const prefix = prefixText === undefined ? 128 : Number(prefixText)
    return Number.isInteger(prefix) && prefix >= 0 && prefix <= 128
  }
  const octets = address.split('.')
  if (
    octets.length !== 4 ||
    octets.some((item) => !/^\d{1,3}$/.test(item) || Number(item) > 255)
  )
    return false
  const prefix = prefixText === undefined ? 32 : Number(prefixText)
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32
}

function apiErrorMessage(error: unknown) {
  const transportError = error as {
    response?: { data?: unknown }
    message?: string
  }
  if (transportError.response?.data !== undefined)
    return upstreamDetailMessage(transportError.response.data)
  return transportError.message || 'Firewall rules could not be created.'
}

function upstreamDetailMessage(error: unknown): string {
  let source = error
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch {
      return String(source)
    }
  }
  if (!source || typeof source !== 'object')
    return source ? String(source) : '—'
  if (Array.isArray(source))
    return source
      .map((item) => upstreamDetailMessage(item))
      .filter(Boolean)
      .join('; ')
  const record = source as Record<string, unknown>
  const nested = record.upstream_detail
  if (nested !== undefined && nested !== null)
    return typeof nested === 'string' ? nested : JSON.stringify(nested)
  // Gateway responses vary between {detail}, {error} and direct upstream
  // payloads. Walk those wrappers before falling back to JSON.
  if (record.detail !== undefined) return upstreamDetailMessage(record.detail)
  if (record.error !== undefined) return upstreamDetailMessage(record.error)
  if (typeof record.message === 'string') return record.message
  return JSON.stringify(record)
}

function RuleActions({
  rule,
  onEdit,
  onCopyCustomize,
  onEditDescription,
  onView,
  onDelete,
  canDelete = true,
}: {
  rule: SecurityRule
  onEdit: () => void
  onCopyCustomize: () => void
  onEditDescription: () => void
  onView: () => void
  onDelete: () => void
  canDelete?: boolean
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
        <DropdownMenuItem
          onClick={() => {
            void navigator.clipboard.writeText(rule.id)
            toast.success('Rule ID copied.')
          }}
        >
          <Copy /> Copy rule ID
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onView}>
          <Eye /> View details
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>
          <Pencil /> Edit rule
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCopyCustomize}>
          <Copy /> Copy & customize
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEditDescription}>
          <Pencil /> Edit description & schedule
        </DropdownMenuItem>
        {canDelete && (
          <DropdownMenuItem className='text-destructive' onClick={onDelete}>
            <Trash2 /> Delete rule
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function validateRule(rule: RuleDraft): string {
  if (!['ingress', 'egress'].includes(rule.direction))
    return 'Direction must be inbound or outbound'
  if (!PROTOCOLS.includes(rule.protocol)) return 'Unsupported protocol'
  if (!validIpPrefix(rule.remote_ip_prefix))
    return 'Remote IP must be a valid IPv4/IPv6 address or CIDR (for example 1.1.1.1/32)'
  const min = rule.port_range_min ? Number(rule.port_range_min) : undefined
  const max = rule.port_range_max ? Number(rule.port_range_max) : undefined
  if ((min === undefined) !== (max === undefined))
    return 'Enter both port values or leave both empty'
  if (
    min !== undefined &&
    (!Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 1 ||
      max! > 65535 ||
      min > max!)
  )
    return 'Port range must be 1–65535 and ordered'
  if (
    rule.delete_at?.trim() &&
    Number.isNaN(new Date(normalizeRuleDeleteAt(rule.delete_at)!).getTime())
  )
    return 'Delete at must use dd/mm/yyyy HH:mm:ss'
  return 'Ready to create'
}

function payload(rule: RuleDraft) {
  return {
    description: rule.description.trim(),
    direction: rule.direction,
    protocol: rule.protocol,
    port_range_min: rule.port_range_min ? Number(rule.port_range_min) : null,
    port_range_max: rule.port_range_max ? Number(rule.port_range_max) : null,
    remote_ip_prefix: rule.remote_ip_prefix.trim(),
    delete_at: normalizeRuleDeleteAt(rule.delete_at),
  }
}

function normalizeRuleDeleteAt(value?: string | null) {
  const text = value?.trim()
  if (!text) return null
  const vietnamese = text.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/
  )
  if (vietnamese) {
    const [, day, month, year, hour, minute, second = '00'] = vietnamese
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:${second}`
  }
  return text
}

const securityGroupBatchSize = Math.max(
  1,
  Math.min(50, Number(import.meta.env.VITE_SECURITY_GROUP_BATCH_SIZE) || 10)
)
const maxRuleCreateConcurrency = 3

function chunks<T>(items: T[], size = securityGroupBatchSize) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  )
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  )
  return results
}

export function SecurityGroupsPage() {
  const project = useCloudStore((state) => state.project)!
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const multiFileRef = useRef<HTMLInputElement>(null)
  const [securityGroupId, setSecurityGroupId] = useState('')
  const [ruleScope, setRuleScope] = useState<'selected' | 'all_groups'>(
    'selected'
  )
  const [direction, setDirection] = useState<'all' | 'ingress' | 'egress'>(
    'all'
  )
  const [viewRule, setViewRule] = useState<SecurityRule>()
  const [editRule, setEditRule] = useState<SecurityRule>()
  const [editDraft, setEditDraft] = useState<RuleDraft>(emptyRule)
  const [ruleEditorMode, setRuleEditorMode] = useState<'replace' | 'copy'>(
    'replace'
  )
  const [copySourceDraft, setCopySourceDraft] = useState<RuleDraft>()
  const [editConfirm, setEditConfirm] = useState(false)
  const [descriptionRule, setDescriptionRule] = useState<SecurityRule>()
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [descriptionDeleteAt, setDescriptionDeleteAt] = useState('')
  const [descriptionDeleteAtInitial, setDescriptionDeleteAtInitial] =
    useState('')
  const [descriptionConfirm, setDescriptionConfirm] = useState(false)
  const [deleteRules, setDeleteRules] = useState<SecurityRule[]>([])
  const [deletePhrase, setDeletePhrase] = useState('')
  const [deleteResults, setDeleteResults] = useState<OperationResult[]>([])
  const [deleteResultOpen, setDeleteResultOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [adaptiveEditorOpen, setAdaptiveEditorOpen] = useState(false)
  const [adaptiveRows, setAdaptiveRows] = useState<PreviewRule[]>([])
  const [quotaSelectedRows, setQuotaSelectedRows] = useState<PreviewRule[]>([])
  const [createItems, setCreateItems] = useState<PreviewRule[]>([])
  const [createConfirm, setCreateConfirm] = useState(false)
  const [operationResults, setOperationResults] = useState<OperationResult[]>(
    []
  )
  const [multiOpen, setMultiOpen] = useState(false)
  const [multiRows, setMultiRows] = useState<MultiGroupRule[]>([])
  const [multiQuotaSelectedRows, setMultiQuotaSelectedRows] = useState<
    MultiGroupRule[]
  >([])
  const [multiCreateItems, setMultiCreateItems] = useState<MultiGroupRule[]>([])
  const [multiCreateConfirm, setMultiCreateConfirm] = useState(false)
  const [multiResults, setMultiResults] = useState<OperationResult[]>([])
  const [multiResultDetail, setMultiResultDetail] = useState<OperationResult>()
  const [multiJsonOpen, setMultiJsonOpen] = useState(false)
  const [multiJson, setMultiJson] = useState('')
  const [scheduledRulesOpen, setScheduledRulesOpen] = useState(false)
  const [scheduledDeleteIds, setScheduledDeleteIds] = useState<string[]>([])
  const [scheduledDeleteConfirm, setScheduledDeleteConfirm] = useState(false)
  const [scheduledDeleteResults, setScheduledDeleteResults] = useState<
    ScheduledDeleteResult[]
  >([])
  const [scheduledDeleteResultsOpen, setScheduledDeleteResultsOpen] =
    useState(false)

  useEffect(() => {
    if (window.location.pathname !== '/security-groups')
      window.history.replaceState(window.history.state, '', '/security-groups')
  }, [])

  const groups = useQuery({
    queryKey: ['cloud', project.id, 'security-groups'],
    queryFn: async ({ signal }) =>
      (await apiClient.get<SecurityGroup[]>('/cloud/security-groups', { signal })).data,
  })
  const selectedGroup = groups.data?.find(
    (group) => group.id === securityGroupId
  )
  useEffect(() => {
    const firstGroup = groups.data?.[0]
    if (
      firstGroup &&
      securityGroupId !== '__all_security_groups__' &&
      !groups.data?.some((group) => group.id === securityGroupId)
    )
      setSecurityGroupId(firstGroup.id)
  }, [groups.data, securityGroupId])
  const rules = useQuery({
    queryKey: [
      'cloud',
      project.id,
      'security-groups',
      securityGroupId,
      'rules',
      direction,
    ],
    enabled: Boolean(securityGroupId),
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<SecurityRule[]>(
          `/cloud/security-groups/${securityGroupId}/rules`,
          { params: { direction }, signal }
        )
      ).data,
  })
  const allRules = useQuery({
    queryKey: ['cloud', project.id, 'security-groups', 'all-rules', direction],
    enabled: ruleScope === 'all_groups',
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<SecurityRule[]>('/cloud/security-groups/rules', {
          params: { direction }, signal,
        })
      ).data,
  })
  const ruleSchedules = useQuery({
    queryKey: [
      'cloud',
      project.id,
      'security-groups',
      'scheduled-rules',
      scheduledRulesOpen ? 'details' : 'summary',
    ],
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<{
          items: ScheduledRule[]
        }>('/cloud/security-groups/scheduled-rules', {
          params: { include_rule_details: scheduledRulesOpen }, signal,
        })
      ).data,
  })
  const scheduleByRuleId = useMemo(
    () =>
      new Map(
        (ruleSchedules.data?.items ?? []).map((item) => [item.rule_id, item])
      ),
    [ruleSchedules.data?.items]
  )
  const baseDisplayedRules =
    ruleScope === 'all_groups' ? (allRules.data ?? []) : (rules.data ?? [])
  const displayedRules = baseDisplayedRules.map((rule) => ({
    ...rule,
    delete_at: scheduleByRuleId.get(rule.id)?.delete_at,
  }))
  const dueSchedules = (ruleSchedules.data?.items ?? []).filter(
    (item) => new Date(item.delete_at).getTime() <= Date.now()
  )
  const editorValidation =
    ruleEditorMode === 'copy' &&
    copySourceDraft &&
    trafficSignature(editDraft) === trafficSignature(copySourceDraft)
      ? 'Change at least one traffic field before creating a copy.'
      : validateRule(editDraft)
  const groupNameForRule = (rule: SecurityRule) => {
    const value = rule.security_group
    const id = typeof value === 'string' ? value : value?.id
    const group = groups.data?.find((item) => item.id === id)
    return (
      group?.display_name ||
      group?.name ||
      (typeof value === 'object' ? value.display_name || value.name : '') ||
      id ||
      '—'
    )
  }

  const createMutation = useMutation({
    mutationFn: async (items: PreviewRule[]) => {
      const results = await mapWithConcurrency(
        items,
        maxRuleCreateConcurrency,
        async (item, index) => {
          const { data } = await apiClient.post<{
            items: OperationResult[]
          }>(
            `/cloud/security-groups/${securityGroupId}/rules`,
            { items: [payload(item)] },
            { timeout: 120_000 }
          )
          const result = data.items[0]
          if (!result)
            throw new Error('Cloud API did not return a rule result.')
          return { ...result, index }
        }
      )
      return { items: results }
    },
    onSuccess: async (data) => {
      const hydratedItems = data.items.map((item, index) => {
        const source = createItems[item.index ?? index]
        return {
          ...item,
          input: { ...item.input, delete_at: source?.delete_at },
        }
      })
      const createdKeys = new Set<string>()
      hydratedItems.forEach((item, index) => {
        if (item.status !== 'created') return
        const key = createItems[item.index ?? index]?.key
        if (key) createdKeys.add(key)
      })
      if (createdKeys.size)
        setAdaptiveRows((current) =>
          current.filter((item) => !createdKeys.has(item.key))
        )
      setOperationResults(hydratedItems)
      setQuotaSelectedRows([])
      setCreateConfirm(false)
      await queryClient.invalidateQueries({
        queryKey: [
          'cloud',
          project.id,
          'security-groups',
          securityGroupId,
          'rules',
        ],
      })
      const succeeded = hydratedItems.filter(
        (item) => item.status === 'created'
      ).length
      toast.success(
        `${succeeded}/${hydratedItems.length} firewall rule(s) created.`
      )
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'quotas'],
      }),
  })
  const multiCreateMutation = useMutation({
    mutationFn: async (items: MultiGroupRule[]) =>
      (
        await apiClient.post<{ items: OperationResult[] }>(
          '/cloud/security-groups/rules/import',
          {
            items: items.map((item) => ({
              client_id: item.key,
              security_group_id: item.security_group_id,
              ...payload(item),
            })),
          },
          { timeout: 0 }
        )
      ).data,
    onSuccess: async (data) => {
      const sourceById = new Map(
        multiCreateItems.map((item) => [item.key, item])
      )
      setMultiResults(
        data.items.map((item) => {
          const source = sourceById.get(item.client_id || '')
          return {
            ...item,
            input: { ...item.input, delete_at: source?.delete_at },
          }
        })
      )
      setMultiCreateConfirm(false)
      setMultiCreateItems([])
      setMultiQuotaSelectedRows([])
      setMultiOpen(false)
      await queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'security-groups'],
      })
      await queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'security-groups', 'scheduled-rules'],
      })
      toast.success(
        `${data.items.filter((item) => item.status === 'created').length}/${data.items.length} firewall rule(s) created.`
      )
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'quotas'],
      }),
  })
  const editMutation = useMutation({
    mutationFn: async () => {
      if (!editRule) throw new Error('No firewall rule was selected.')
      if (
        ruleEditorMode === 'copy' &&
        copySourceDraft &&
        trafficSignature(editDraft) === trafficSignature(copySourceDraft)
      )
        throw new Error(
          'Change at least one traffic field before creating a copy to avoid a duplicate firewall rule.'
        )
      const groupValue = editRule.security_group
      const targetGroupId =
        (typeof groupValue === 'string' ? groupValue : groupValue?.id) ||
        (ruleScope === 'selected' ? securityGroupId : '')
      if (!targetGroupId || targetGroupId === '__all_security_groups__')
        throw new Error(
          'The Security Group for this rule could not be determined.'
        )
      if (ruleEditorMode === 'replace') {
        await apiClient.delete(
          `/cloud/security-groups/${targetGroupId}/rules/${editRule.id}`
        )
      }
      try {
        const { data } = await apiClient.post<{ items: OperationResult[] }>(
          `/cloud/security-groups/${targetGroupId}/rules`,
          { items: [payload(editDraft)] },
          { timeout: 120_000 }
        )
        const result = data.items?.[0]
        if (result?.status && result.status !== 'created')
          throw new Error(
            result.error
              ? upstreamDetailMessage(result.error)
              : ruleEditorMode === 'copy'
                ? 'The copied firewall rule was not created.'
                : 'The replacement firewall rule was not created.'
          )
        return result
      } catch (error) {
        throw new Error(
          ruleEditorMode === 'replace'
            ? `The original rule was deleted, but its replacement could not be created: ${apiErrorMessage(error)}`
            : `The copied firewall rule could not be created: ${apiErrorMessage(error)}`
        )
      }
    },
    onSuccess: async () => {
      setEditConfirm(false)
      setEditRule(undefined)
      await queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'security-groups'],
      })
      await queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'security-groups', 'scheduled-rules'],
      })
      toast.success(
        ruleEditorMode === 'replace'
          ? 'Firewall rule replaced successfully.'
          : 'Copied firewall rule created successfully.'
      )
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Firewall rule replacement failed.'
      ),
  })
  const descriptionMutation = useMutation({
    mutationFn: async () => {
      if (!descriptionRule) throw new Error('No firewall rule was selected.')
      const groupValue = descriptionRule.security_group
      const targetGroupId =
        (typeof groupValue === 'string' ? groupValue : groupValue?.id) ||
        (ruleScope === 'selected' ? securityGroupId : '')
      if (!targetGroupId || targetGroupId === '__all_security_groups__')
        throw new Error(
          'The Security Group for this rule could not be determined.'
        )
      return (
        await apiClient.put(
          `/cloud/security-groups/${targetGroupId}/rules/${descriptionRule.id}/description`,
          {
            description: descriptionDraft.trim(),
            delete_at: normalizeRuleDeleteAt(descriptionDeleteAt),
          },
          { timeout: 120_000 }
        )
      ).data
    },
    onSuccess: async () => {
      setDescriptionConfirm(false)
      setDescriptionRule(undefined)
      await queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'security-groups'],
      })
      await queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'security-groups', 'scheduled-rules'],
      })
      toast.success('Firewall rule description updated.')
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  })
  const retryMultiResults = (results: OperationResult[]) => {
    const rows = results
      .filter((item) => item.status === 'failed' && item.input)
      .map((item, index) => {
        const input = item.input as Partial<SecurityRule>
        const groupId =
          typeof input.security_group === 'string' ? input.security_group : ''
        return {
          key: `retry-${Date.now()}-${index}`,
          row: index + 1,
          security_group_id: groupId,
          security_group_name:
            groups.data?.find((group) => group.id === groupId)?.display_name ||
            groups.data?.find((group) => group.id === groupId)?.name ||
            groupId,
          description: input.description || '',
          direction: (input.direction || 'ingress') as 'ingress' | 'egress',
          protocol: input.protocol || 'tcp',
          port_range_min:
            input.port_range_min == null ? '' : String(input.port_range_min),
          port_range_max:
            input.port_range_max == null ? '' : String(input.port_range_max),
          remote_ip_prefix: input.remote_ip_prefix || '',
          validation: 'Ready to create',
          ready: true,
        }
      })
    if (!rows.length) return
    setMultiResults([])
    setMultiRows(rows)
    setMultiOpen(true)
  }
  const deleteMutation = useMutation({
    mutationFn: async (items: SecurityRule[]) => {
      if (items.length === 1 && ruleScope === 'selected') {
        await apiClient.delete(
          `/cloud/security-groups/${securityGroupId}/rules/${items[0].id}`
        )
        return [{ rule_id: items[0].id, status: 'deleted', rule: items[0] }]
      }
      const byId = new Map(items.map((item) => [item.id, item]))
      const results: OperationResult[] = []
      for (const batch of chunks(items)) {
        const { data } = await apiClient.post<{ items: OperationResult[] }>(
          ruleScope === 'all_groups'
            ? '/cloud/security-groups/rules/delete'
            : `/cloud/security-groups/${securityGroupId}/rules/delete`,
          { rule_ids: batch.map((item) => item.id) },
          { timeout: 120_000 }
        )
        results.push(...data.items)
      }
      return results.map((result) => ({
        ...result,
        rule: result.rule_id ? byId.get(result.rule_id) : undefined,
      }))
    },
    onSuccess: async (data) => {
      const count = data.filter((item) => item.status === 'deleted').length
      setDeleteResults(data)
      setDeleteResultOpen(true)
      setDeleteRules([])
      setDeletePhrase('')
      await queryClient.invalidateQueries({
        queryKey: ['cloud', project.id, 'security-groups'],
      })
      toast.success(`${count}/${data.length} firewall rule(s) deleted.`)
    },
    onError: () =>
      toast.error('One or more firewall rules could not be deleted.'),
  })
  const scheduledDeleteMutation = useMutation({
    mutationFn: async (ruleIds: string[]) => {
      const scheduleById = new Map(
        (ruleSchedules.data?.items ?? []).map((item) => [item.rule_id, item])
      )
      const data = (
        await apiClient.post<{ items: OperationResult[] }>(
          '/cloud/security-groups/scheduled-rules/delete',
          { rule_ids: ruleIds },
          { timeout: 120_000 }
        )
      ).data
      return {
        items: data.items.map((item) => {
          const scheduled = scheduleById.get(item.rule_id || '')
          return {
            ...item,
            rule: item.rule ?? scheduled?.rule,
            security_group_name: scheduled?.security_group_name,
            delete_at: scheduled?.delete_at,
          } satisfies ScheduledDeleteResult
        }),
      }
    },
    onSuccess: async (data) => {
      const failed = data.items.filter(
        (item) => item.status === 'failed'
      ).length
      setScheduledDeleteResults(data.items)
      setScheduledDeleteResultsOpen(true)
      setScheduledDeleteConfirm(false)
      toast[failed ? 'warning' : 'success'](
        failed
          ? `Scheduled deletion finished with ${failed} failed rule(s).`
          : `Deleted ${data.items.length} scheduled rule(s).`
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['cloud', project.id, 'security-groups'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['cloud', project.id, 'security-groups', 'scheduled-rules'],
        }),
      ])
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  })

  const columns = useMemo<ColumnDef<SecurityRule>[]>(
    () => [
      {
        accessorKey: 'direction',
        header: ({ column }) => (
          <SortableHeader column={column} title='Direction' />
        ),
        cell: ({ getValue }) => (
          <Badge variant={getValue() === 'ingress' ? 'default' : 'secondary'}>
            {getValue() === 'ingress' ? 'Inbound' : 'Outbound'}
          </Badge>
        ),
      },
      ...(ruleScope === 'all_groups'
        ? [
            {
              id: 'security_group',
              accessorFn: (row: SecurityRule) => groupNameForRule(row),
              header: 'Security group',
              cell: ({ row }: { row: { original: SecurityRule } }) => (
                <span className='font-medium'>
                  {groupNameForRule(row.original)}
                </span>
              ),
            } as ColumnDef<SecurityRule>,
          ]
        : []),
      {
        accessorKey: 'protocol',
        header: ({ column }) => (
          <SortableHeader column={column} title='Protocol' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono uppercase'>{getValue() as string}</span>
        ),
      },
      {
        id: 'ports',
        accessorFn: (row) => portText(row.port_range_min, row.port_range_max),
        header: ({ column }) => <SortableHeader column={column} title='Port' />,
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'remote_ip_prefix',
        header: ({ column }) => (
          <SortableHeader column={column} title='Remote IP / CIDR' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono font-medium'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'ethertype',
        header: ({ column }) => (
          <SortableHeader column={column} title='IP version' />
        ),
        cell: ({ getValue }) => (getValue() as string)?.toUpperCase() || '—',
      },
      {
        accessorKey: 'created_at',
        header: ({ column }) => (
          <SortableHeader column={column} title='Created at' />
        ),
        cell: ({ getValue }) =>
          getValue() ? new Date(getValue() as string).toLocaleString() : '—',
      },
      {
        id: 'delete_at',
        accessorFn: (row) => row.delete_at || '',
        header: ({ column }) => (
          <SortableHeader column={column} title='Delete at' />
        ),
        cell: ({ row }) =>
          row.original.delete_at
            ? new Date(row.original.delete_at).toLocaleString()
            : '—',
      },
      {
        id: 'time_remaining',
        accessorFn: (row) => row.delete_at || '',
        header: ({ column }) => (
          <SortableHeader column={column} title='Remaining' />
        ),
        cell: ({ row }) => {
          if (!row.original.delete_at) return '—'
          const seconds = Math.floor(
            (new Date(row.original.delete_at).getTime() - Date.now()) / 1000
          )
          const absoluteSeconds = Math.abs(seconds)
          const days = Math.floor(absoluteSeconds / 86_400)
          const hours = Math.floor((absoluteSeconds % 86_400) / 3_600)
          const minutes = Math.floor((absoluteSeconds % 3_600) / 60)
          const label = `${days ? `${days}d ` : ''}${hours}h ${minutes}m`
          return seconds <= 0 ? (
            <span className='font-medium text-destructive'>
              Overdue {label}
            </span>
          ) : (
            label
          )
        },
      },
      {
        accessorKey: 'description',
        header: ({ column }) => (
          <SortableHeader column={column} title='Description' />
        ),
        cell: ({ getValue }) => {
          const description = (getValue() as string) || ''
          const preview =
            description.length > 100
              ? `${description.slice(0, 100)}…`
              : description
          return description ? (
            <span
              className='block max-w-[42rem] text-sm break-words'
              title={description}
            >
              {preview}
            </span>
          ) : (
            '—'
          )
        },
      },
      {
        id: 'actions',
        enableHiding: false,
        cell: ({ row }) => (
          <RuleActions
            rule={row.original}
            onEdit={() => {
              setRuleEditorMode('replace')
              setCopySourceDraft(undefined)
              setEditDraft({
                description: row.original.description || '',
                direction: row.original.direction,
                protocol: row.original.protocol,
                port_range_min:
                  row.original.port_range_min == null
                    ? ''
                    : String(row.original.port_range_min),
                port_range_max:
                  row.original.port_range_max == null
                    ? ''
                    : String(row.original.port_range_max),
                remote_ip_prefix: row.original.remote_ip_prefix || '',
                delete_at: row.original.delete_at
                  ? row.original.delete_at.slice(0, 16)
                  : '',
              })
              setEditRule(row.original)
            }}
            onCopyCustomize={() => {
              setRuleEditorMode('copy')
              const source: RuleDraft = {
                description: row.original.description || '',
                direction: row.original.direction,
                protocol: row.original.protocol,
                port_range_min:
                  row.original.port_range_min == null
                    ? ''
                    : String(row.original.port_range_min),
                port_range_max:
                  row.original.port_range_max == null
                    ? ''
                    : String(row.original.port_range_max),
                remote_ip_prefix: row.original.remote_ip_prefix || '',
                delete_at: row.original.delete_at
                  ? row.original.delete_at.slice(0, 16)
                  : '',
              }
              setCopySourceDraft(source)
              setEditDraft(source)
              setEditRule(row.original)
            }}
            onEditDescription={() => {
              setDescriptionDraft(row.original.description || '')
              const deleteAt = row.original.delete_at
                ? row.original.delete_at.slice(0, 16)
                : ''
              setDescriptionDeleteAt(deleteAt)
              setDescriptionDeleteAtInitial(deleteAt)
              setDescriptionRule(row.original)
            }}
            onView={() => setViewRule(row.original)}
            onDelete={() => {
              setDeletePhrase('')
              setDeleteRules([row.original])
            }}
            canDelete
          />
        ),
      },
    ],
    [ruleScope, groups.data]
  )
  const previewColumns = useMemo<ColumnDef<PreviewRule>[]>(
    () => [
      {
        accessorKey: 'direction',
        header: 'Direction',
        cell: ({ getValue }) =>
          getValue() === 'ingress' ? 'Inbound' : 'Outbound',
      },
      { accessorKey: 'protocol', header: 'Protocol' },
      {
        id: 'ports',
        accessorFn: (row) => portText(row.port_range_min, row.port_range_max),
        header: 'Port',
      },
      { accessorKey: 'remote_ip_prefix', header: 'Remote IP / CIDR' },
      {
        accessorKey: 'delete_at',
        header: 'Delete at',
        cell: ({ getValue }) =>
          getValue() ? new Date(String(getValue())).toLocaleString() : '—',
      },
      {
        accessorKey: 'validation',
        header: 'Validation',
        cell: ({ row }) => (
          <span
            className={
              row.original.ready ? 'text-emerald-600' : 'text-destructive'
            }
          >
            {row.original.validation}
          </span>
        ),
      },
      { accessorKey: 'description', header: 'Description' },
    ],
    []
  )

  const buildPreview = (rows: RuleDraft[]) =>
    setAdaptiveRows((current) => [
      ...current,
      ...rows.map((row, index) => {
        const validation = validateRule(row)
        return {
          ...row,
          key: `template-${Date.now()}-${index}`,
          validation,
          ready: validation === 'Ready to create',
        }
      }),
    ])
  const addAdaptiveRules = (input: AdaptiveRuleInput) => {
    const expanded = expandTemplateRule(
      input.direction === 'both'
        ? 'inbound,outbound'
        : input.direction === 'ingress'
          ? 'inbound'
          : 'outbound',
      input.protocols.join(','),
      input.ports,
      input.prefixes,
      input.description,
      input.delete_at
    )
    const rows = expanded.map((row, index) => {
      const validation = validateRule(row)
      return {
        ...row,
        key: `adaptive-${Date.now()}-${index}`,
        validation,
        ready: validation === 'Ready to create',
      }
    })
    setAdaptiveRows((current) => [...current, ...rows])
    toast.success(`${rows.length} firewall rule(s) added to the review list.`)
  }
  const expandTemplateRule = (
    directionText: string,
    protocolText: string,
    portValue: string,
    prefix: string,
    description: string,
    deleteAt?: string | null
  ) => {
    const directions = splitMultiValues(
      directionText.replace(
        /\b(?:both|inbound\+outbound)\b/gi,
        'inbound,outbound'
      )
    )
      .map((value) => value.toLowerCase())
      .map((value) =>
        value === 'inbound'
          ? 'ingress'
          : value === 'outbound'
            ? 'egress'
            : (value as 'ingress' | 'egress')
      )
    const protocols = splitMultiValues(protocolText).map((value) =>
      value.toLowerCase()
    )
    const ports = portValue.trim() ? splitMultiValues(portValue) : ['']
    const prefixes = splitMultiValues(prefix).length
      ? splitMultiValues(prefix)
      : ['']
    return directions.flatMap((ruleDirection) =>
      protocols.flatMap((protocol) =>
        ports.flatMap((port) =>
          prefixes.map((remotePrefix) => {
            const [min, max] = parsePort(port)
            return {
              direction: ruleDirection,
              protocol,
              port_range_min: min,
              port_range_max: max,
              remote_ip_prefix: remotePrefix,
              description: description.trim(),
              delete_at: normalizeRuleDeleteAt(deleteAt),
            }
          })
        )
      )
    )
  }
  const importTemplate = async (file?: File) => {
    if (!file) return
    try {
      const records = rowsFromHeader(parseXlsxRows(await file.arrayBuffer()), [
        'NO.',
        'DIRECTION',
        'PROTOCOL',
        'PORT',
        'REMOTE IP PREFIX',
      ])
      const expanded = records.flatMap((record) =>
        expandTemplateRule(
          record.DIRECTION,
          record.PROTOCOL,
          record.PORT ?? '',
          record['REMOTE IP PREFIX'],
          record.DESCRIPTION ?? '',
          record['DELETE AT'] ?? ''
        )
      )
      buildPreview(expanded)
      toast.success(
        `${records.length} template row(s) expanded into ${expanded.length} firewall rule(s).`
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Invalid Security Group template.'
      )
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  const templateDate = (value?: string | null) => {
    if (!value) return ''
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    const pad = (part: number) => String(part).padStart(2, '0')
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  const exportSelectedRulesTemplate = (selected: SecurityRule[]) => {
    if (!selected.length) return
    const commonHeaders = [
      'DIRECTION',
      'PROTOCOL',
      'PORT',
      'REMOTE IP PREFIX',
      'DESCRIPTION',
      'DELETE AT',
    ]
    const ruleValues = (rule: SecurityRule) => [
      rule.direction === 'ingress' ? 'inbound' : 'outbound',
      rule.protocol,
      portText(rule.port_range_min, rule.port_range_max) === 'Any'
        ? ''
        : portText(rule.port_range_min, rule.port_range_max),
      rule.remote_ip_prefix,
      rule.description || '',
      templateDate(rule.delete_at),
    ]
    const allGroups = ruleScope === 'all_groups'
    downloadXlsx(
      allGroups
        ? ['SECURITY GROUP', ...commonHeaders]
        : ['NO.', ...commonHeaders],
      selected.map((rule, index) =>
        allGroups
          ? [groupNameForRule(rule), ...ruleValues(rule)]
          : [index + 1, ...ruleValues(rule)]
      ),
      `${project.name || project.id}-${allGroups ? 'multi-security-group' : 'security-group'}-rules-export`,
      {
        title: allGroups
          ? 'SELECTED MULTI SECURITY GROUP RULES'
          : 'SELECTED SECURITY GROUP RULES',
        metadata: [
          {
            label: 'Re-import',
            value: allGroups
              ? 'Import using the multi-Security-Group rule template flow.'
              : `Import into ${selectedGroup?.display_name || selectedGroup?.name || 'the selected Security Group'}.`,
          },
          {
            label: 'Delete at',
            value: 'Optional: dd/mm/yyyy HH:mm:ss.',
          },
        ],
        validations: [
          ...(allGroups
            ? [
                {
                  header: 'SECURITY GROUP',
                  values: (groups.data ?? [])
                    .flatMap((group) => [group.name, group.display_name || ''])
                    .filter(Boolean),
                  allowBlank: false,
                  enforce: false,
                },
              ]
            : []),
          {
            header: 'DIRECTION',
            values: ['inbound', 'outbound', 'both'],
            allowBlank: false,
            enforce: true,
          },
          {
            header: 'PROTOCOL',
            values: PROTOCOLS,
            allowBlank: false,
            enforce: false,
          },
        ],
        validationRowCount: Math.max(selected.length + 20, 100),
      }
    )
    toast.success(`Exported ${selected.length} selected firewall rule(s).`)
  }

  const downloadTemplate = () =>
    downloadXlsx(
      [
        'NO.',
        'DIRECTION',
        'PROTOCOL',
        'PORT',
        'REMOTE IP PREFIX',
        'DESCRIPTION',
        'DELETE AT',
      ],
      [
        [
          1,
          'inbound',
          'tcp,udp',
          '22,80,443,1000-2000',
          '10.0.0.0/24',
          'Management access',
          '31/12/2026 23:59:00',
        ],
        [2, 'outbound', 'any', '', '0.0.0.0/0', 'Allow outbound', ''],
      ],
      'security-group-rules-template.xlsx',
      {
        title: 'SECURITY GROUP RULE TEMPLATE',
        metadata: [
          {
            label: 'Security Group',
            value: selectedGroup?.name ?? securityGroupId,
          },
          {
            label: 'Directions',
            value: 'Use inbound, outbound, or both.',
          },
          { label: 'Protocols', value: PROTOCOLS.join(', ') },
          {
            label: 'Port',
            value:
              'Single: 22 · range: 22-23 · multiple: 22,80,443,1000-2000 · empty: any port.',
          },
          {
            label: 'Expansion',
            value: 'Each protocol × each port becomes a separate API rule.',
          },
          {
            label: 'Delete at',
            value:
              'Optional: dd/mm/yyyy HH:mm:ss (example: 31/12/2026 23:59:00).',
          },
        ],
        sheetName: 'Firewall Rules',
        validations: [
          {
            header: 'DIRECTION',
            values: ['inbound', 'outbound', 'both'],
            allowBlank: false,
            enforce: true,
            prompt: 'Choose inbound, outbound, or both.',
          },
          {
            header: 'PROTOCOL',
            values: PROTOCOLS,
            allowBlank: false,
            enforce: false,
            prompt:
              'Choose a protocol or enter one or more values separated by commas or new lines.',
          },
        ],
        validationRowCount: 1000,
      }
    )

  const reviewMultiTemplate = async (file?: File) => {
    if (!file) return
    try {
      const records = rowsFromHeader(parseXlsxRows(await file.arrayBuffer()), [
        'SECURITY GROUP',
        'DIRECTION',
        'PROTOCOL',
        'PORT',
        'REMOTE IP PREFIX',
      ])
      const rows = records.flatMap((record, recordIndex) => {
        const groupNames = splitMultiValues(record['SECURITY GROUP'] || '')
        return groupNames.flatMap((groupName) => {
          const group = (groups.data ?? []).find(
            (item) =>
              item.id === groupName ||
              item.name.toLowerCase() === groupName.toLowerCase() ||
              item.display_name?.toLowerCase() === groupName.toLowerCase()
          )
          return expandTemplateRule(
            record.DIRECTION,
            record.PROTOCOL,
            record.PORT ?? '',
            record['REMOTE IP PREFIX'],
            record.DESCRIPTION ?? '',
            record['DELETE AT'] ?? ''
          ).map((rule, ruleIndex) => ({
            ...rule,
            row: recordIndex + 2,
            key: `multi-${recordIndex + 2}-${groupName}-${ruleIndex + 1}`,
            security_group_id: group?.id || '',
            security_group_name:
              group?.display_name || group?.name || groupName,
            validation: group
              ? validateRule(rule)
              : `Security Group '${groupName}' was not found`,
            ready: Boolean(group) && validateRule(rule) === 'Ready to create',
          }))
        })
      })
      setMultiRows(rows)
      setMultiOpen(true)
      toast.success(
        `${records.length} template row(s) expanded into ${rows.length} firewall rule(s).`
      )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Invalid multi-group template.'
      )
    } finally {
      if (multiFileRef.current) multiFileRef.current.value = ''
    }
  }
  const downloadMultiTemplate = () => {
    const sampleGroups =
      (groups.data ?? [])
        .slice(0, 2)
        .map((group) => group.display_name || group.name)
        .filter(Boolean)
        .join(',') || 'SG_All,SG_App'
    return downloadXlsx(
      [
        'SECURITY GROUP',
        'DIRECTION',
        'PROTOCOL',
        'PORT',
        'REMOTE IP PREFIX',
        'DESCRIPTION',
        'DELETE AT',
      ],
      [
        [
          sampleGroups,
          'both',
          'tcp,udp',
          '22,80,443,1000-2000',
          '10.0.0.0/24\n192.168.10.0/24',
          'Example: management and application access',
          '31/12/2026 23:59:00',
        ],
      ],
      `${project.name || project.id}-security-group-multi-rules-template`,
      {
        title: 'MULTI SECURITY GROUP RULE TEMPLATE',
        metadata: [
          {
            label: 'Target & rule',
            value: `SECURITY GROUP / PROTOCOL accept comma or new-line lists. DIRECTION: inbound, outbound, or both. Protocols: ${PROTOCOLS.join(', ')}.`,
          },
          {
            label: 'Network',
            value:
              'REMOTE IP PREFIX accepts comma or new-line CIDRs. PORT accepts 22, 22-25, or comma/new-line lists; leave blank for all ports.',
          },
          {
            label: 'Result',
            value:
              'DESCRIPTION is optional. Every combination is expanded into individual rules and reviewed before creation.',
          },
          {
            label: 'Delete at',
            value:
              'Optional: dd/mm/yyyy HH:mm:ss (example: 31/12/2026 23:59:00).',
          },
        ],
        validations: [
          {
            header: 'SECURITY GROUP',
            values: (groups.data ?? [])
              .flatMap((group) => [group.name, group.display_name || ''])
              .filter(Boolean),
            allowBlank: false,
            enforce: false,
            prompt:
              'Choose a Security Group or enter multiple names separated by commas/new lines.',
          },
          {
            header: 'DIRECTION',
            values: ['inbound', 'outbound', 'both'],
            allowBlank: false,
            enforce: false,
            prompt: 'Use inbound, outbound, or both.',
          },
          {
            header: 'PROTOCOL',
            values: PROTOCOLS,
            allowBlank: false,
            enforce: false,
            prompt:
              'Choose a protocol or enter multiple values separated by commas/new lines.',
          },
        ],
        validationRowCount: 1000,
      }
    )
  }
  const multiJsonSample = JSON.stringify(
    [
      {
        security_group:
          groups.data?.[0]?.display_name || groups.data?.[0]?.name || 'SG_All',
        direction: 'inbound',
        protocol: 'tcp',
        port: '22,443',
        remote_ip_prefix: '10.0.0.0/24',
        description: 'Management access',
      },
    ],
    null,
    2
  )
  const selectableSecurityGroups = (groups.data ?? [])
    .map((group) => group.display_name || group.name)
    .filter(Boolean)
  const multiJsonPrompt = `Create a JSON array for CloudTool multi-Security-Group firewall import. Return JSON only.

Each item requires:
- security_group: exact name from the allowed Security Groups list below.
- direction: "inbound" or "outbound".
- protocol: one exact value from the allowed protocols list below.
- remote_ip_prefix: valid IPv4/IPv6 CIDR.
- port: optional; accepts 22, 22-23, or comma-separated values such as 22,80,443.
- description: optional.

One item expands into multiple Cloud API rules when port contains commas.

Allowed Security Groups for the selected project:
${selectableSecurityGroups.length ? selectableSecurityGroups.map((name) => `- ${name}`).join('\n') : '- No Security Groups were loaded. Refresh this page before generating JSON.'}

Allowed protocols:
${PROTOCOLS.map((protocol) => `- ${protocol}`).join('\n')}

Example:\n${multiJsonSample}`
  const reviewMultiJson = () => {
    try {
      const parsed = JSON.parse(multiJson) as unknown
      if (!Array.isArray(parsed))
        throw new Error('JSON must be an array of firewall rule objects.')
      const records = parsed.map((item) => {
        const value =
          item && typeof item === 'object'
            ? (item as Record<string, unknown>)
            : {}
        const text = (key: string) =>
          value[key] == null ? '' : String(value[key])
        return {
          'SECURITY GROUP': text('security_group'),
          DIRECTION: text('direction'),
          PROTOCOL: text('protocol'),
          PORT: text('port'),
          'REMOTE IP PREFIX': text('remote_ip_prefix'),
          DESCRIPTION: text('description'),
        }
      })
      const rows = records.flatMap((record, recordIndex) => {
        const groupName = record['SECURITY GROUP'].trim()
        const group = (groups.data ?? []).find(
          (item) =>
            item.id === groupName ||
            item.name.toLowerCase() === groupName.toLowerCase() ||
            item.display_name?.toLowerCase() === groupName.toLowerCase()
        )
        return expandTemplateRule(
          record.DIRECTION,
          record.PROTOCOL,
          record.PORT,
          record['REMOTE IP PREFIX'],
          record.DESCRIPTION
        ).map((rule, ruleIndex) => ({
          ...rule,
          row: recordIndex + 1,
          key: `json-${recordIndex + 1}-${ruleIndex + 1}`,
          security_group_id: group?.id || '',
          security_group_name: group?.display_name || group?.name || groupName,
          validation: group
            ? validateRule(rule)
            : `Security Group '${groupName}' was not found`,
          ready: Boolean(group) && validateRule(rule) === 'Ready to create',
        }))
      })
      setMultiRows(rows)
      setMultiJsonOpen(false)
      setMultiOpen(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Invalid JSON.')
    }
  }

  return (
    <CloudPageShell
      title='Security groups'
      description='Manage inbound and outbound firewall rules at scale.'
      tableHelp
      help={
        <p className='text-muted-foreground'>
          Select a Security Group, filter inbound or outbound rules, and search
          any IP/CIDR. Single and bulk changes are previewed before execution.
          Opening firewall access is security-sensitive; use the narrowest CIDR
          and port range possible.
        </p>
      }
      actions={
        <>
          <Button
            size='sm'
            variant='outline'
            onClick={() => setScheduledRulesOpen(true)}
          >
            <CalendarClock />
            Scheduled deletes
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={!groups.data?.length}
            onClick={downloadMultiTemplate}
          >
            <Download /> Template
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={!groups.data?.length}
            onClick={() => multiFileRef.current?.click()}
          >
            <FileUp /> Import
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={!groups.data?.length}
            onClick={() => {
              setMultiJson('')
              setMultiJsonOpen(true)
            }}
          >
            <FileJson /> JSON
          </Button>
        </>
      }
    >
      <Card>
        <CardContent className='space-y-4'>
          <div className='grid gap-3 border-b pb-4 lg:grid-cols-[minmax(20rem,1fr)_auto_auto] lg:items-end'>
            <div className='space-y-2'>
              <Label>Security Group</Label>
              <SearchableSelect
                value={securityGroupId}
                onValueChange={(value) => {
                  if (value === '__all_security_groups__') {
                    setSecurityGroupId(value)
                    setRuleScope('all_groups')
                  } else {
                    setSecurityGroupId(value)
                    setRuleScope('selected')
                  }
                  setDirection('all')
                }}
                loading={groups.isLoading}
                placeholder='Select Security Group'
                searchPlaceholder='Search name, ID or description...'
                options={[
                  {
                    value: '__all_security_groups__',
                    label: '★ ALL SECURITY GROUPS',
                    description:
                      'Project-wide rule inventory — read-only selection mode',
                  },
                  ...(groups.data ?? []).map((group) => ({
                    value: group.id,
                    label: group.display_name || group.name,
                    description: `${group.description || 'No description'} · ${group.id}`,
                  })),
                ]}
              />
            </div>
            <div className='inline-flex h-8 items-center rounded-md border bg-muted/40 p-0.5'>
              {(
                [
                  { value: 'all', label: 'All' },
                  { value: 'ingress', label: 'Inbound' },
                  { value: 'egress', label: 'Outbound' },
                ] as const
              ).map((tab) => (
                <Button
                  key={tab.value}
                  type='button'
                  size='sm'
                  variant={direction === tab.value ? 'secondary' : 'ghost'}
                  className='h-7 px-3 text-xs'
                  onClick={() => setDirection(tab.value)}
                >
                  {tab.label}
                </Button>
              ))}
            </div>
            <Button
              size='sm'
              className='min-w-0 max-w-full justify-self-start lg:max-w-72'
              title={`Add rule to ${selectedGroup?.display_name || selectedGroup?.name || 'selected SG'}`}
              disabled={!securityGroupId || ruleScope === 'all_groups'}
              onClick={() => {
                setAdaptiveRows([])
                setOperationResults([])
                setAddOpen(true)
              }}
            >
              <Plus className='shrink-0' />
              <span className='truncate'>
                Add rule to{' '}
                {selectedGroup?.display_name ||
                  selectedGroup?.name ||
                  'selected SG'}
              </span>
            </Button>
          </div>
          {securityGroupId ? (
            <CloudDataTable
              data={displayedRules}
              columns={columns}
              getRowId={(row) => row.id}
              loading={
                ruleScope === 'all_groups'
                  ? allRules.isLoading
                  : rules.isLoading
              }
              entityName='firewall rule'
              exportFileName={
                ruleScope === 'all_groups'
                  ? 'all-security-group-rules'
                  : `security-group-rules-${securityGroupId}`
              }
              searchPlaceholder='Search IP, CIDR, protocol, port, direction or description...'
              toolbar={(selected) => (
                <div className='flex flex-wrap gap-2'>
                  <Button
                    variant='outline'
                    onClick={() => exportSelectedRulesTemplate(selected)}
                  >
                    <Download /> Export template
                  </Button>
                  <Button
                    variant='destructive'
                    onClick={() => {
                      setDeletePhrase('')
                      setDeleteRules(selected)
                    }}
                  >
                    <Trash2 /> Delete {selected.length} selected rule(s)
                  </Button>
                </div>
              )}
            />
          ) : (
            <div className='flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed text-center text-muted-foreground'>
              <ShieldCheck className='mb-3 size-10' />
              <p className='font-medium'>Select a Security Group</p>
              <p className='text-sm'>
                Its inbound and outbound firewall rules will appear here.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <input
        ref={multiFileRef}
        type='file'
        accept='.xlsx'
        className='hidden'
        onChange={(event) => void reviewMultiTemplate(event.target.files?.[0])}
      />
      <Dialog open={multiJsonOpen} onOpenChange={setMultiJsonOpen}>
        <DialogContent className='max-h-[92vh] sm:max-w-6xl'>
          <DialogHeader>
            <DialogTitle>Import multi-Security-Group JSON</DialogTitle>
            <DialogDescription>
              Generate a plan with an AI agent, then review every expanded
              firewall rule before creating it.
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-4 md:grid-cols-[0.9fr_1.35fr]'>
            <div className='space-y-2'>
              <Label>Prompt for AI agent</Label>
              <Textarea
                readOnly
                value={multiJsonPrompt}
                className='h-[30rem] resize-y font-mono text-xs leading-5'
              />
            </div>
            <div className='space-y-2'>
              <Label>Paste JSON to import</Label>
              <Textarea
                value={multiJson}
                onChange={(event) => setMultiJson(event.target.value)}
                className='h-[30rem] resize-y font-mono text-xs leading-5'
                placeholder={multiJsonSample}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setMultiJson(multiJsonSample)}
            >
              <FileJson /> View sample
            </Button>
            <Button variant='ghost' onClick={() => setMultiJsonOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!multiJson.trim()} onClick={reviewMultiJson}>
              <Eye /> Review JSON
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={multiOpen}
        onOpenChange={(open) =>
          !multiCreateMutation.isPending && setMultiOpen(open)
        }
      >
        <DialogContent className='max-h-[90vh] sm:max-w-7xl'>
          <DialogHeader>
            <DialogTitle>Add rules to multiple Security Groups</DialogTitle>
            <DialogDescription>
              Import one audited Excel template. Each row selects its target
              Security Group by name.
            </DialogDescription>
          </DialogHeader>
          <div className='flex flex-wrap items-center gap-3'>
            <SecurityGroupRuleQuota
              compact
              projectId={project.id}
              planned={
                multiCreateConfirm
                  ? multiCreateItems.length
                  : multiQuotaSelectedRows.length ||
                    multiRows.filter((row) => row.ready).length
              }
              plannedLabel={
                multiCreateConfirm || multiQuotaSelectedRows.length
                  ? 'Selected'
                  : 'Ready'
              }
            />
            {!multiRows.length && (
              <>
                <Button variant='outline' onClick={downloadMultiTemplate}>
                  <Download /> Template
                </Button>
                <Button onClick={() => multiFileRef.current?.click()}>
                  <FileUp /> Import XLSX
                </Button>
              </>
            )}
          </div>
          {multiRows.length > 0 && (
            <CloudDataTable
              data={multiRows}
              onSelectedRowsChange={setMultiQuotaSelectedRows}
              getRowId={(row) => row.key}
              entityName='firewall rule'
              searchPlaceholder='Search imported firewall rules...'
              exportFileName='multi-security-group-rule-review'
              isRowSelectable={(row) => row.ready}
              pageSizeOptions={[10, 25, 50, 100, 200, 500]}
              initialPageSize={100}
              columns={[
                { accessorKey: 'row', header: '#' },
                {
                  accessorKey: 'security_group_name',
                  header: 'Security Group',
                },
                { accessorKey: 'direction', header: 'Direction' },
                { accessorKey: 'protocol', header: 'Protocol' },
                {
                  id: 'ports',
                  accessorFn: (row) =>
                    portText(row.port_range_min, row.port_range_max),
                  header: 'Port',
                },
                { accessorKey: 'remote_ip_prefix', header: 'Remote IP / CIDR' },
                {
                  accessorKey: 'delete_at',
                  header: 'Delete at',
                  cell: ({ getValue }) =>
                    getValue()
                      ? new Date(String(getValue())).toLocaleString()
                      : '—',
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
                { accessorKey: 'description', header: 'Description' },
              ]}
              toolbar={(selected) => (
                <Button
                  disabled={multiCreateMutation.isPending}
                  onClick={() => {
                    setMultiCreateItems(selected)
                    setMultiCreateConfirm(true)
                  }}
                >
                  <ShieldCheck /> Create selected ({selected.length})
                </Button>
              )}
            />
          )}
          <DialogFooter>
            <Button variant='outline' onClick={() => setMultiOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={scheduledRulesOpen} onOpenChange={setScheduledRulesOpen}>
        <DialogContent className='flex max-h-[82vh] flex-col overflow-hidden sm:!max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Scheduled firewall rule deletions</DialogTitle>
            <DialogDescription>
              Rules whose scheduled deletion time has passed. Deletion is sent
              through the audited Cloud API gateway.
            </DialogDescription>
          </DialogHeader>
          <div className='min-h-0 flex-1 overflow-auto'>
            <CloudDataTable
              data={dueSchedules}
              columns={[
                {
                  id: 'security_group',
                  header: 'Security group',
                  accessorFn: (row) =>
                    row.security_group_name || row.security_group_id,
                  cell: ({ row }) =>
                    row.original.security_group_name ||
                    'Unknown security group',
                },
                {
                  id: 'direction',
                  header: 'Direction',
                  accessorFn: (row) => row.rule?.direction || '',
                  cell: ({ row }) =>
                    row.original.rule?.direction === 'ingress'
                      ? 'Inbound'
                      : row.original.rule?.direction === 'egress'
                        ? 'Outbound'
                        : '—',
                },
                {
                  id: 'protocol',
                  header: 'Protocol',
                  accessorFn: (row) => row.rule?.protocol || '',
                  cell: ({ row }) =>
                    row.original.rule?.protocol?.toUpperCase() || '—',
                },
                {
                  id: 'port',
                  header: 'Port',
                  accessorFn: (row) =>
                    portText(
                      row.rule?.port_range_min,
                      row.rule?.port_range_max
                    ),
                  cell: ({ row }) =>
                    portText(
                      row.original.rule?.port_range_min,
                      row.original.rule?.port_range_max
                    ),
                },
                {
                  id: 'remote_ip_prefix',
                  header: 'Remote IP / CIDR',
                  accessorFn: (row) => row.rule?.remote_ip_prefix || '',
                  cell: ({ row }) => (
                    <span className='font-mono text-xs'>
                      {row.original.rule?.remote_ip_prefix || '—'}
                    </span>
                  ),
                },
                {
                  accessorKey: 'delete_at',
                  header: 'Delete at',
                  cell: ({ getValue }) =>
                    new Date(String(getValue())).toLocaleString(),
                },
                {
                  accessorKey: 'last_error',
                  header: 'Last error',
                  cell: ({ getValue }) => (
                    <span className='text-destructive'>
                      {String(getValue() ?? '')}
                    </span>
                  ),
                },
                {
                  id: 'description',
                  header: 'Description',
                  accessorFn: (row) => row.rule?.description || '',
                  cell: ({ row }) => row.original.rule?.description || '—',
                },
              ]}
              getRowId={(row) => row.rule_id}
              entityName='due firewall rule'
              exportFileName='scheduled-firewall-rule-deletions'
              enableSelection
              toolbar={(selected) => (
                <Button
                  variant='destructive'
                  disabled={
                    !selected.length || scheduledDeleteMutation.isPending
                  }
                  onClick={() => {
                    setScheduledDeleteIds(selected.map((row) => row.rule_id))
                    setScheduledDeleteConfirm(true)
                  }}
                >
                  {scheduledDeleteMutation.isPending && (
                    <Loader2 className='animate-spin' />
                  )}
                  Delete selected
                </Button>
              )}
            />
          </div>
          <DialogFooter className='border-t pt-4'>
            <Button
              variant='destructive'
              disabled={
                !dueSchedules.length || scheduledDeleteMutation.isPending
              }
              onClick={() => {
                setScheduledDeleteIds(dueSchedules.map((item) => item.rule_id))
                setScheduledDeleteConfirm(true)
              }}
            >
              {scheduledDeleteMutation.isPending && (
                <Loader2 className='animate-spin' />
              )}
              Delete all due ({dueSchedules.length})
            </Button>
            <Button
              variant='outline'
              onClick={() => setScheduledRulesOpen(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={scheduledDeleteConfirm}
        onOpenChange={(open) =>
          !scheduledDeleteMutation.isPending && setScheduledDeleteConfirm(open)
        }
        title={`Delete ${scheduledDeleteIds.length} due firewall rule(s)?`}
        desc='The selected Cloud firewall rules will be deleted immediately. Their schedule history will be retained.'
        destructive
        confirmText='Delete rules'
        isLoading={scheduledDeleteMutation.isPending}
        handleConfirm={() => {
          scheduledDeleteMutation.mutate(scheduledDeleteIds)
        }}
      />
      <Dialog
        open={scheduledDeleteResultsOpen}
        onOpenChange={setScheduledDeleteResultsOpen}
      >
        <DialogContent className='grid h-[76svh] !w-[92vw] !max-w-[92vw] grid-rows-[auto_minmax(0,1fr)_auto] sm:!max-w-[92vw]'>
          <DialogHeader>
            <DialogTitle>Scheduled firewall rule deletion results</DialogTitle>
            <DialogDescription>
              Individual results returned by the Cloud API gateway.
            </DialogDescription>
          </DialogHeader>
          <div className='min-h-0 overflow-auto rounded-md border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Security group</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Port</TableHead>
                  <TableHead>Remote IP / CIDR</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Delete at</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Error message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scheduledDeleteResults.map((result, index) => (
                  <TableRow key={`${result.rule_id || index}-${index}`}>
                    <TableCell>{index + 1}</TableCell>
                    <TableCell>{result.security_group_name || '—'}</TableCell>
                    <TableCell>
                      {result.rule?.direction === 'ingress'
                        ? 'Inbound'
                        : result.rule?.direction === 'egress'
                          ? 'Outbound'
                          : '—'}
                    </TableCell>
                    <TableCell className='font-mono uppercase'>
                      {result.rule?.protocol || '—'}
                    </TableCell>
                    <TableCell className='font-mono'>
                      {portText(
                        result.rule?.port_range_min,
                        result.rule?.port_range_max
                      )}
                    </TableCell>
                    <TableCell className='font-mono text-xs'>
                      {result.rule?.remote_ip_prefix || '—'}
                    </TableCell>
                    <TableCell>{result.rule?.description || '—'}</TableCell>
                    <TableCell>
                      {result.delete_at
                        ? new Date(result.delete_at).toLocaleString()
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          result.status === 'deleted'
                            ? 'default'
                            : 'destructive'
                        }
                      >
                        {result.status}
                      </Badge>
                    </TableCell>
                    <TableCell className='max-w-80 text-sm whitespace-normal text-destructive'>
                      {result.error ? upstreamDetailMessage(result.error) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button onClick={() => setScheduledDeleteResultsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={multiCreateConfirm}
        onOpenChange={(open) =>
          !multiCreateMutation.isPending && setMultiCreateConfirm(open)
        }
        title={`Create ${multiCreateItems.length} firewall rule(s)?`}
        desc='Rules are created sequentially through the audited Cloud API gateway. A failed rule does not stop the remaining selected rules.'
        confirmText={
          <>
            {multiCreateMutation.isPending && (
              <Loader2 className='animate-spin' />
            )}{' '}
            Create rules
          </>
        }
        isLoading={multiCreateMutation.isPending}
        handleConfirm={() => multiCreateMutation.mutate(multiCreateItems)}
      />

      <Dialog
        open={Boolean(multiResults.length)}
        onOpenChange={(open) => !open && setMultiResults([])}
      >
        <DialogContent className='max-h-[90vh] sm:max-w-7xl'>
          <DialogHeader>
            <DialogTitle>Multi-Security-Group rule results</DialogTitle>
            <DialogDescription>
              {multiResults.filter((item) => item.status === 'created').length}{' '}
              of {multiResults.length} rule(s) created. Each row is independent.
            </DialogDescription>
          </DialogHeader>
          <CloudDataTable
            data={multiResults}
            getRowId={(row) =>
              row.rule?.id ||
              row.rule_id ||
              row.client_id ||
              `${row.status}-${row.input?.remote_ip_prefix || 'rule'}`
            }
            entityName='firewall rule result'
            searchPlaceholder='Search rule results...'
            exportFileName='multi-security-group-rule-results'
            isRowSelectable={(row) =>
              row.status === 'failed' && Boolean(row.input)
            }
            pageSizeOptions={[10, 25, 50, 100, 200, 500]}
            initialPageSize={100}
            columns={[
              { id: 'index', header: '#', cell: ({ row }) => row.index + 1 },
              {
                id: 'security_group',
                accessorFn: (row) =>
                  String(
                    (row.input as { security_group?: string } | undefined)
                      ?.security_group || ''
                  ),
                header: 'Security Group',
                cell: ({ row }) =>
                  groupNameForRule({
                    security_group:
                      (
                        row.original.input as
                          { security_group?: string } | undefined
                      )?.security_group || '',
                  } as SecurityRule),
              },
              {
                id: 'direction',
                accessorFn: (row) => String(row.input?.direction || ''),
                header: 'Direction',
              },
              {
                id: 'protocol',
                accessorFn: (row) => String(row.input?.protocol || ''),
                header: 'Protocol',
              },
              {
                id: 'port',
                accessorFn: (row) =>
                  portText(
                    row.input?.port_range_min,
                    row.input?.port_range_max
                  ),
                header: 'Port',
              },
              {
                id: 'remote_ip_prefix',
                accessorFn: (row) => String(row.input?.remote_ip_prefix || ''),
                header: 'Remote IP / CIDR',
              },
              {
                id: 'delete_at',
                accessorFn: (row) => String(row.input?.delete_at || ''),
                header: 'Delete at',
                cell: ({ row }) =>
                  row.original.input?.delete_at
                    ? new Date(
                        String(row.original.input.delete_at)
                      ).toLocaleString()
                    : '—',
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
                    {row.original.status}
                  </Badge>
                ),
              },
              {
                id: 'error',
                accessorFn: (row) =>
                  row.error ? upstreamDetailMessage(row.error) : '',
                header: 'Detail',
                cell: ({ row }) => (
                  <span
                    className={
                      row.original.status === 'failed'
                        ? 'block max-w-md whitespace-normal text-destructive'
                        : 'text-muted-foreground'
                    }
                  >
                    {row.original.error
                      ? upstreamDetailMessage(row.original.error)
                      : 'Created'}
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
                        onClick={() => setMultiResultDetail(row.original)}
                      >
                        <Eye /> View request / response
                      </DropdownMenuItem>
                      {row.original.status === 'failed' &&
                      row.original.input ? (
                        <DropdownMenuItem
                          onClick={() => retryMultiResults([row.original])}
                        >
                          <FileUp /> Import to review
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ),
              },
            ]}
            toolbar={(selected) => (
              <Button onClick={() => retryMultiResults(selected)}>
                <FileUp /> Import failed to review ({selected.length})
              </Button>
            )}
          />
          <DialogFooter>
            <Button onClick={() => setMultiResults([])}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(multiResultDetail)}
        onOpenChange={(open) => !open && setMultiResultDetail(undefined)}
      >
        <DialogContent className='max-h-[90vh] sm:max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Multi-Security-Group rule detail</DialogTitle>
            <DialogDescription>
              Gateway request body and Cloud API response. Authentication
              headers are never included.
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-4 md:grid-cols-2'>
            <div className='space-y-2'>
              <Label>Gateway request body</Label>
              <Textarea
                readOnly
                value={JSON.stringify(multiResultDetail?.input ?? {}, null, 2)}
                className='h-[25rem] resize-y font-mono text-xs'
              />
            </div>
            <div className='space-y-2'>
              <Label>
                {multiResultDetail?.error
                  ? 'Cloud API error response'
                  : 'Cloud API response'}
              </Label>
              <Textarea
                readOnly
                value={JSON.stringify(
                  multiResultDetail?.response ??
                    (multiResultDetail?.error
                      ? { error: multiResultDetail.error }
                      : (multiResultDetail?.rule ?? {})),
                  null,
                  2
                )}
                className='h-[25rem] resize-y font-mono text-xs'
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setMultiResultDetail(undefined)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(viewRule)}
        onOpenChange={(open) => !open && setViewRule(undefined)}
      >
        <DialogContent className='sm:!max-w-3xl'>
          <DialogHeader>
            <DialogTitle>Firewall rule details</DialogTitle>
            <DialogDescription>
              Complete Cloud API information for this Security Group rule.
            </DialogDescription>
          </DialogHeader>
          <div className='overflow-auto rounded-md border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className='w-52'>Field</TableHead>
                  <TableHead>Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(viewRule ?? {}).map(([key, value]) => (
                  <TableRow key={key}>
                    <TableCell className='font-mono text-xs font-medium'>
                      {key}
                    </TableCell>
                    <TableCell className='font-mono text-xs break-all'>
                      {value === null || value === undefined || value === ''
                        ? '—'
                        : String(value)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button onClick={() => setViewRule(undefined)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(descriptionRule)}
        onOpenChange={(open) =>
          !descriptionMutation.isPending &&
          !open &&
          setDescriptionRule(undefined)
        }
      >
        <DialogContent className='sm:max-w-xl'>
          <DialogHeader>
            <DialogTitle>Edit description & deletion schedule</DialogTitle>
            <DialogDescription>
              Update the optional rule description and scheduled deletion time.
              Rule ID:{' '}
              <span className='font-mono text-foreground'>
                {descriptionRule?.id}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-2'>
            <Label>
              Description{' '}
              <span className='font-normal text-muted-foreground'>
                (optional)
              </span>
            </Label>
            <Textarea
              className='min-h-28 resize-y'
              maxLength={255}
              value={descriptionDraft}
              onChange={(event) => setDescriptionDraft(event.target.value)}
              placeholder='Describe the purpose of this firewall rule'
            />
            <p className='text-right text-xs text-muted-foreground'>
              {descriptionDraft.length}/255
            </p>
            <div className='pt-2'>
              <Label htmlFor='rule-delete-at'>Delete at (optional)</Label>
              <Input
                id='rule-delete-at'
                className='mt-1 h-9 max-w-72'
                type='datetime-local'
                value={descriptionDeleteAt}
                onChange={(event) => setDescriptionDeleteAt(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              disabled={descriptionMutation.isPending}
              onClick={() => setDescriptionRule(undefined)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                descriptionMutation.isPending ||
                (descriptionDraft.trim() ===
                  (descriptionRule?.description || '').trim() &&
                  descriptionDeleteAt === descriptionDeleteAtInitial)
              }
              onClick={() => setDescriptionConfirm(true)}
            >
              <Pencil /> Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editRule)}
        onOpenChange={(open) =>
          !editMutation.isPending && !open && setEditRule(undefined)
        }
      >
        <DialogContent className='sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>
              {ruleEditorMode === 'copy'
                ? 'Copy & customize firewall rule'
                : 'Edit firewall rule'}
            </DialogTitle>
            <DialogDescription>
              {ruleEditorMode === 'copy'
                ? 'Customize the copied values, then create a new firewall rule. The original rule remains unchanged.'
                : 'Update the replacement rule, then review the required delete and create operation.'}
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-4 md:grid-cols-2'>
            <div className='space-y-2'>
              <Label>Direction</Label>
              <SearchableSelect
                value={editDraft.direction}
                onValueChange={(value) =>
                  setEditDraft((current) => ({
                    ...current,
                    direction: value as 'ingress' | 'egress',
                  }))
                }
                options={[
                  { value: 'ingress', label: 'Inbound' },
                  { value: 'egress', label: 'Outbound' },
                ]}
              />
            </div>
            <div className='space-y-2'>
              <Label>Protocol</Label>
              <SearchableSelect
                value={editDraft.protocol}
                onValueChange={(value) =>
                  setEditDraft((current) => ({ ...current, protocol: value }))
                }
                searchPlaceholder='Search protocol...'
                options={PROTOCOLS.map((value) => ({
                  value,
                  label: value.toUpperCase(),
                }))}
              />
            </div>
            <div className='space-y-2'>
              <Label>
                Port or range{' '}
                <span className='font-normal text-muted-foreground'>
                  (optional)
                </span>
              </Label>
              <Input
                value={
                  portText(
                    editDraft.port_range_min,
                    editDraft.port_range_max
                  ) === 'Any'
                    ? ''
                    : portText(
                        editDraft.port_range_min,
                        editDraft.port_range_max
                      )
                }
                onChange={(event) => {
                  const [min, max] = parsePort(event.target.value)
                  setEditDraft((current) => ({
                    ...current,
                    port_range_min: min,
                    port_range_max: max,
                  }))
                }}
                placeholder='22 or 22-23'
              />
            </div>
            <div className='space-y-2'>
              <Label>Remote IP / CIDR</Label>
              <Input
                className='font-mono'
                value={editDraft.remote_ip_prefix}
                onChange={(event) =>
                  setEditDraft((current) => ({
                    ...current,
                    remote_ip_prefix: event.target.value,
                  }))
                }
                placeholder='10.0.0.0/24'
              />
            </div>
          </div>
          <div className='space-y-2'>
            <Label>
              Description{' '}
              <span className='font-normal text-muted-foreground'>
                (optional)
              </span>
            </Label>
            <Textarea
              className='h-20 resize-y'
              value={editDraft.description}
              onChange={(event) =>
                setEditDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
            />
            <Label htmlFor='edit-rule-delete-at'>Delete at (optional)</Label>
            <Input
              id='edit-rule-delete-at'
              className='h-9 max-w-72'
              type='datetime-local'
              value={editDraft.delete_at || ''}
              onChange={(event) =>
                setEditDraft((current) => ({
                  ...current,
                  delete_at: event.target.value,
                }))
              }
            />
          </div>
          <div
            className={`rounded-md border px-3 py-2 text-sm ${editorValidation === 'Ready to create' ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400' : 'border-destructive/30 bg-destructive/5 text-destructive'}`}
          >
            {editorValidation}
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              disabled={editMutation.isPending}
              onClick={() => {
                setEditRule(undefined)
                setRuleEditorMode('replace')
                setCopySourceDraft(undefined)
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={editorValidation !== 'Ready to create'}
              onClick={() => setEditConfirm(true)}
            >
              {ruleEditorMode === 'copy' ? <Copy /> : <Pencil />}
              {ruleEditorMode === 'copy'
                ? ' Create copied rule'
                : ' Save replacement'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => !createMutation.isPending && setAddOpen(open)}
      >
        <DialogContent className='grid h-[94svh] !w-[min(1240px,calc(100vw-2rem))] !max-w-[1240px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:!max-w-[1240px]'>
          <DialogHeader className='border-b bg-muted/20 px-6 py-5'>
            <div>
              <div className='min-w-0'>
                <DialogTitle>
                  Add rules ·{' '}
                  {selectedGroup?.display_name ||
                    selectedGroup?.name ||
                    'Security Group'}
                </DialogTitle>
              </div>
            </div>
          </DialogHeader>
          <div className='min-h-0 overflow-y-auto bg-muted/10 px-6 py-5'>
            <SecurityGroupRuleEditor
              open={adaptiveEditorOpen}
              onOpenChange={setAdaptiveEditorOpen}
              protocols={PROTOCOLS}
              onAdd={addAdaptiveRules}
            />
            {operationResults.length ? (
              <div className='space-y-3'>
                <div className='flex items-center justify-between'>
                  <h3 className='font-semibold'>Operation results</h3>
                  <Button
                    variant='outline'
                    onClick={() => {
                      setOperationResults([])
                    }}
                  >
                    <Plus /> Add more
                  </Button>
                </div>
                <div className='overflow-auto rounded-md border'>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>Direction</TableHead>
                        <TableHead>Protocol</TableHead>
                        <TableHead>Port</TableHead>
                        <TableHead>Remote IP / CIDR</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Delete at</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Rule ID</TableHead>
                        <TableHead>Error message</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {operationResults.map((result, index) => {
                        const input =
                          result.input ??
                          createItems[result.index ?? index] ??
                          {}
                        return (
                          <TableRow
                            key={`${index}-${result.rule_id ?? result.rule?.id}`}
                          >
                            <TableCell>{index + 1}</TableCell>
                            <TableCell>
                              {input.direction === 'ingress'
                                ? 'Inbound'
                                : input.direction === 'egress'
                                  ? 'Outbound'
                                  : '—'}
                            </TableCell>
                            <TableCell className='font-mono uppercase'>
                              {input.protocol || '—'}
                            </TableCell>
                            <TableCell className='font-mono'>
                              {portText(
                                input.port_range_min,
                                input.port_range_max
                              )}
                            </TableCell>
                            <TableCell className='font-mono text-xs'>
                              {input.remote_ip_prefix || '—'}
                            </TableCell>
                            <TableCell>{input.description || '—'}</TableCell>
                            <TableCell>
                              {input.delete_at
                                ? new Date(
                                    String(input.delete_at)
                                  ).toLocaleString()
                                : '—'}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={
                                  result.status === 'created'
                                    ? 'default'
                                    : 'destructive'
                                }
                              >
                                {result.status}
                              </Badge>
                            </TableCell>
                            <TableCell className='font-mono text-xs'>
                              {result.rule?.id || result.rule_id || '—'}
                            </TableCell>
                            <TableCell className='max-w-80 text-sm whitespace-normal text-destructive'>
                              {result.error
                                ? upstreamDetailMessage(result.error)
                                : '—'}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : (
              <div className='w-full space-y-5 py-1'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <div className='flex items-center gap-2'>
                    <span className='text-xs text-muted-foreground'>
                      {adaptiveRows.length} rule(s) in review
                    </span>
                  </div>
                  <SecurityGroupRuleQuota
                    compact
                    projectId={project.id}
                    planned={
                      createConfirm
                        ? createItems.length
                        : quotaSelectedRows.length ||
                          adaptiveRows.filter((row) => row.ready).length
                    }
                    plannedLabel={
                      createConfirm || quotaSelectedRows.length
                        ? 'Selected'
                        : 'Ready'
                    }
                  />
                  <div className='ml-auto flex items-center gap-2'>
                    <Button
                      size='sm'
                      type='button'
                      variant='outline'
                      onClick={() => {
                        downloadTemplate()
                        toast.success('Firewall rule template downloaded.')
                      }}
                    >
                      <Download /> Template
                    </Button>
                    <Button
                      size='sm'
                      type='button'
                      variant='outline'
                      onClick={() => fileRef.current?.click()}
                    >
                      <FileUp /> Import XLSX
                    </Button>
                    <Button
                      size='sm'
                      onClick={() => setAdaptiveEditorOpen(true)}
                    >
                      <Plus /> Add rule
                    </Button>
                    <input
                      ref={fileRef}
                      type='file'
                      accept='.xlsx'
                      className='hidden'
                      onChange={(event) =>
                        void importTemplate(event.target.files?.[0])
                      }
                    />
                  </div>
                </div>
                <CloudDataTable
                  data={adaptiveRows}
                  columns={previewColumns}
                  getRowId={(row) => row.key}
                  onSelectedRowsChange={setQuotaSelectedRows}
                  entityName='rule in review list'
                  exportFileName='security-group-adaptive-rule-review'
                  searchPlaceholder='Search generated rules...'
                  isRowSelectable={(row) => row.ready}
                  toolbar={(selected) => (
                    <div className='flex gap-2'>
                      <Button
                        variant='outline'
                        onClick={() =>
                          setAdaptiveRows((current) =>
                            current.filter(
                              (item) =>
                                !selected.some(
                                  (selectedItem) =>
                                    selectedItem.key === item.key
                                )
                            )
                          )
                        }
                      >
                        <Trash2 /> Remove ({selected.length})
                      </Button>
                      <Button
                        onClick={() => {
                          setCreateItems(selected)
                          setCreateConfirm(true)
                        }}
                      >
                        <ShieldCheck /> Create selected ({selected.length})
                      </Button>
                    </div>
                  )}
                />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={false} onOpenChange={() => undefined}>
        <DialogContent className='hidden'>
          <DialogHeader>
            <DialogTitle>Firewall rule help</DialogTitle>
            <DialogDescription>Single and bulk rule syntax.</DialogDescription>
          </DialogHeader>
          <div className='space-y-4 text-sm'>
            <div>
              <p className='font-medium'>Single rule</p>
              <p className='text-muted-foreground'>
                Choose Inbound/Outbound, protocol, one port such as 22 or range
                such as 22-23, then provide a valid IP/CIDR.
              </p>
            </div>
            <div>
              <p className='font-medium'>Excel bulk template</p>
              <p className='text-muted-foreground'>
                Direction uses inbound/outbound. Protocol and Port support
                comma-separated lists. Every protocol × port combination is
                expanded into a separate API rule.
              </p>
            </div>
            <div>
              <p className='font-medium'>Supported protocols</p>
              <p className='font-mono text-xs break-words text-muted-foreground'>
                {PROTOCOLS.join(', ')}
              </p>
            </div>
            <div>
              <p className='font-medium'>Security</p>
              <p className='text-muted-foreground'>
                Prefer the narrowest possible CIDR and port. Preview expanded
                rules before creating them.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => undefined}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteResultOpen} onOpenChange={setDeleteResultOpen}>
        <DialogContent className='grid h-[80svh] !w-[92vw] !max-w-[92vw] grid-rows-[auto_minmax(0,1fr)_auto] sm:!max-w-[92vw]'>
          <DialogHeader>
            <DialogTitle>Firewall rule deletion results</DialogTitle>
            <DialogDescription>
              Result returned for every selected firewall rule.
            </DialogDescription>
          </DialogHeader>
          <div className='min-h-0 overflow-auto rounded-md border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Port</TableHead>
                  <TableHead>Remote IP / CIDR</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Rule ID</TableHead>
                  <TableHead>Error message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deleteResults.map((result, index) => {
                  const rule = result.rule
                  return (
                    <TableRow key={result.rule_id ?? rule?.id ?? index}>
                      <TableCell>{index + 1}</TableCell>
                      <TableCell>
                        {rule?.direction === 'ingress'
                          ? 'Inbound'
                          : rule?.direction === 'egress'
                            ? 'Outbound'
                            : '—'}
                      </TableCell>
                      <TableCell className='font-mono uppercase'>
                        {rule?.protocol || '—'}
                      </TableCell>
                      <TableCell className='font-mono'>
                        {portText(rule?.port_range_min, rule?.port_range_max)}
                      </TableCell>
                      <TableCell className='font-mono text-xs'>
                        {rule?.remote_ip_prefix || '—'}
                      </TableCell>
                      <TableCell>{rule?.description || '—'}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            result.status === 'deleted'
                              ? 'default'
                              : 'destructive'
                          }
                        >
                          {result.status}
                        </Badge>
                      </TableCell>
                      <TableCell className='font-mono text-xs'>
                        {result.rule_id || rule?.id || '—'}
                      </TableCell>
                      <TableCell className='text-destructive'>
                        {result.error
                          ? upstreamDetailMessage(result.error)
                          : '—'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button onClick={() => setDeleteResultOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteRules.length)}
        onOpenChange={(open) => {
          if (!deleteMutation.isPending && !open) {
            setDeleteRules([])
            setDeletePhrase('')
          }
        }}
        title={`Delete ${deleteRules.length} firewall rule(s)?`}
        desc='Type “Delete” below to permanently remove the selected rules.'
        confirmText={
          <>
            {deleteMutation.isPending && <Loader2 className='animate-spin' />}{' '}
            Delete rules
          </>
        }
        destructive
        disabled={deletePhrase.trim().toLowerCase() !== 'delete'}
        isLoading={deleteMutation.isPending}
        handleConfirm={() =>
          deleteMutation.mutateAsync(deleteRules).then(() => undefined)
        }
      >
        <div className='space-y-2'>
          <Label htmlFor='confirm-firewall-delete'>Confirmation text</Label>
          <Input
            id='confirm-firewall-delete'
            autoComplete='off'
            value={deletePhrase}
            onChange={(event) => setDeletePhrase(event.target.value)}
            placeholder='Delete'
            disabled={deleteMutation.isPending}
          />
          <p className='text-xs text-muted-foreground'>
            Existing traffic may be interrupted immediately.
          </p>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={descriptionConfirm}
        onOpenChange={(open) =>
          !descriptionMutation.isPending && setDescriptionConfirm(open)
        }
        title='Save description and deletion schedule?'
        desc='This updates the description through the Cloud API and saves the optional deletion schedule. The firewall rule itself is not deleted or recreated.'
        confirmText={
          <>
            {descriptionMutation.isPending && (
              <Loader2 className='animate-spin' />
            )}{' '}
            Save changes
          </>
        }
        isLoading={descriptionMutation.isPending}
        handleConfirm={() =>
          descriptionMutation.mutateAsync().then(() => undefined)
        }
      />
      <ConfirmDialog
        open={editConfirm}
        onOpenChange={(open) => !editMutation.isPending && setEditConfirm(open)}
        title={
          ruleEditorMode === 'copy'
            ? 'Create copied firewall rule?'
            : 'Replace this firewall rule?'
        }
        desc={
          ruleEditorMode === 'copy'
            ? 'A new firewall rule will be created using the customized values. The original rule remains unchanged.'
            : 'Cloud API does not support editing a rule in place. Saving will delete the current rule first, then create a new rule with the values above. If the create step fails, the original rule has already been removed.'
        }
        confirmText={
          <>
            {editMutation.isPending && <Loader2 className='animate-spin' />}{' '}
            {ruleEditorMode === 'copy' ? 'Create copied rule' : 'Replace rule'}
          </>
        }
        destructive={ruleEditorMode === 'replace'}
        isLoading={editMutation.isPending}
        handleConfirm={() => editMutation.mutateAsync().then(() => undefined)}
      />
      <ConfirmDialog
        open={createConfirm}
        onOpenChange={(open) =>
          !createMutation.isPending && setCreateConfirm(open)
        }
        title={`Open ${createItems.length} firewall rule(s)?`}
        desc={`Create ${createItems.length} rule(s) in ${selectedGroup?.name}. Review remote CIDRs and ports carefully before continuing.`}
        confirmText={
          <>
            {createMutation.isPending && <Loader2 className='animate-spin' />}{' '}
            Create firewall rules
          </>
        }
        isLoading={createMutation.isPending}
        handleConfirm={() =>
          createMutation.mutateAsync(createItems).then(() => undefined)
        }
      >
        <SecurityGroupRuleQuota
          projectId={project.id}
          planned={createItems.length}
          plannedLabel='Selected'
        />
      </ConfirmDialog>
    </CloudPageShell>
  )
}
