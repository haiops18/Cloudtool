import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ColumnDef, PaginationState } from '@tanstack/react-table'
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CircleHelp,
  CircleStop,
  Clock3,
  Download,
  Eye,
  FileText,
  Folder,
  FileText as LogsIcon,
  ImageIcon,
  Loader2,
  MoreVertical,
  GripVertical,
  MonitorCog,
  Paperclip,
  Pencil,
  PenLine,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { useCloudStore } from '@/stores/cloud-store'
import { setCsrfToken } from '@/lib/api-client'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CloudDataTable } from '@/components/cloud-data-table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { SearchableSelectV2 } from '@/components/searchable-select-v2'
import { Textarea } from '@/components/ui/textarea'
import { DisplaySettings } from '@/components/display-settings'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown-teleport'
import { ReleasePageCacheButton } from '@/components/release-page-cache-button'
import { ThemeSwitch } from '@/components/theme-switch'
import { AgentComposer } from './agent-composer'
import { AgentUserQuestions } from './agent-user-questions'
import { ChatTranscript } from './chat-transcript'
import { updateCodexExecution, type CodexExecutionEvent, type CodexExecutionItem } from './codex-execution-state'
import { CodexTerminalDialog } from './codex-terminal-dialog'
import { VmConsoleExecutionDialog } from './vm-console-execution-dialog'

type Evidence = { source: string; count: number; note?: string | null }
type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  evidence?: Evidence[]
  execution?: CodexExecutionItem[]
  attachments?: Array<{
    path: string
    name: string
    media_type: string
    size: number
    data_url?: string
  }>
}
type Attachment = {
  id: string
  name: string
  media_type: string
  content_base64: string
}
type Conversation = {
  id: string
  conversationId?: string
  title: string
  messages: Message[]
  updatedAt: number
  skillIds: string[]
}
type StoredConversation = {
  id: string
  title: string
  updated_at: string
  messages?: Array<Message & { created_at: string }>
  skill_ids?: string[]
}
type CodexHistoryThread = {
  id: string
  title: string
  created_at?: number | null
  updated_at?: number | null
}
type CodexHistoryTranscript = CodexHistoryThread & {
  messages: Array<Pick<Message, 'id' | 'role' | 'text'>>
}
type WorkspaceRefreshRow = {
  id: string
  order: number
  group: string
  content: string
  purpose: string
  destination: string
}
type WorkspaceRefreshResult = {
  source: string
  status: 'success' | 'warning' | 'error'
  detail: string
  files: string[]
}
type WorkspaceManagedItem = { path: string; name: string; kind: 'file' | 'folder'; size: number; modified_at: string; media_type: string }
type ManagedWorkspacePreview = { path: string; kind: 'text' | 'image'; content: string; data_url?: string }
type ChatResult = {
  request_id: string
  conversation_id: string
  answer: string
  evidence: Evidence[]
  attachments?: Array<{
    path: string
    name: string
    media_type: string
    size: number
  }>
  artifacts?: Array<{
    path: string
    name: string
    media_type: string
    size: number
    kind?: string
  }>
  mode: string
  model_used?: string | null
  detail?: string
  csrf_token?: string | null
  vm_action?: VmAction | null
  api_action?: ApiAction | null
  api_actions?: ApiAction[]
}
type VmAction = { server: string; command: string; summary: string }
type ApiAction = {
  id?: string
  project_id?: string
  type: 'security_group_rule.create' | 'vm_deployment.create' | 'private_ip.create' | 'elastic_ip.create' | 'private_ip.attach' | 'elastic_ip.attach'
  security_group_id?: string
  security_group_name?: string
  rule?: Record<string, unknown>
  rules?: Array<Record<string, unknown>>
  deployment?: Record<string, unknown>
  parameters?: Record<string, unknown>
  summary: string
  expires_at?: string
}
type ApiPreviewRow = { id: string } & Record<string, string>
type ApiActionHistory = { id: string; created_at: string; updated_at: string; conversation_id: string; status: string; expires_at?: string; action: ApiAction; audit?: Array<{ at: string; status: string }>; result: Record<string, unknown> }

const apiActionLabels: Record<ApiAction['type'], string> = {
  'security_group_rule.create': 'Security Group rule', 'vm_deployment.create': 'VM deployment',
  'private_ip.create': 'Create private IP', 'elastic_ip.create': 'Create Elastic IP',
  'private_ip.attach': 'Attach private IP', 'elastic_ip.attach': 'Attach Elastic IP',
}

function apiPreviewRows(action?: ApiAction): ApiPreviewRow[] {
  const payload = action?.type === 'security_group_rule.create'
    ? { security_group_id: action.security_group_id, rules: action.rules ?? (action.rule ? [action.rule] : []) }
    : action?.deployment ?? action?.parameters
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const collection = ['rules', 'servers', 'items', 'resources']
    .map((key) => record[key])
    .find((value): value is unknown[] => Array.isArray(value))
  const rows = collection ?? [record]
  return rows.map((value, index) => {
    const source = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : { value }
    return Object.fromEntries([
      ['id', String(index + 1)],
      ...Object.entries(source).map(([key, item]) => [key, item === null || item === undefined ? '' : typeof item === 'object' ? JSON.stringify(item) : String(item)]),
    ]) as ApiPreviewRow
  })
}

function apiActionTarget(action: ApiAction) {
  if (action.security_group_id) return `${action.security_group_name || 'Unnamed Security Group'} · ${action.security_group_id}`
  const payload = action.deployment || action.parameters || action
  if (payload && typeof payload === 'object') {
    const source = payload as Record<string, unknown>
    return String(source.name || source.display_name || source.id || source.server_id || source.subnet_id || source.zone_id || action.type)
  }
  return action.type
}

function apiActionSummary(action: ApiAction) {
  const rules = action.rules ?? (action.rule ? [action.rule] : [])
  if (action.security_group_id && rules.length) {
    const compact = rules.slice(0, 2).map((rule) => {
      const protocol = String(rule.protocol ?? 'any').toUpperCase()
      const low = rule.port_range_min ?? rule.port_min ?? rule.from_port
      const high = rule.port_range_max ?? rule.port_max ?? rule.to_port
      const ports = low === undefined || low === null || low === '' ? 'all ports' : String(low) === String(high ?? low) ? `port ${low}` : `ports ${low}-${high}`
      const cidr = String(rule.remote_ip_prefix ?? rule.cidr ?? rule.cidr_block ?? rule.source ?? rule.remote_group_id ?? 'any source')
      return `${protocol} · ${ports} · ${cidr}`
    })
    return `${compact.join(' | ')}${rules.length > 2 ? ` +${rules.length - 2} more` : ''}`
  }
  const payload = action.deployment ?? action.parameters ?? action as Record<string, unknown>
  const preferred = ['name', 'region', 'zone', 'flavor', 'image', 'subnet', 'vpc', 'count', 'subnet_id', 'zone_id', 'server_id', 'ip_id', 'ip_address']
  const details = preferred.flatMap((key) => payload[key] === undefined || payload[key] === null || payload[key] === '' ? [] : [`${key.replace(/_/g, ' ')}: ${typeof payload[key] === 'object' ? JSON.stringify(payload[key]) : String(payload[key])}`]).slice(0, 3)
  return details.length ? details.join(' · ') : action.summary
}
const snapshotOptions = [
  { id: 'simple_server_inventory_json', order: 10, group: 'Simple JSON', label: 'Server inventory JSON', detail: 'Same compact server facts as CSV, formatted for AI reading' },
  { id: 'simple_vpcs_json', order: 20, group: 'Simple JSON', label: 'VPCs JSON', detail: 'Compact VPC overview in AI-friendly JSON' },
  { id: 'simple_subnets_json', order: 30, group: 'Simple JSON', label: 'Subnets JSON', detail: 'Compact subnet and CIDR overview' },
  { id: 'simple_security_groups_json', order: 40, group: 'Simple JSON', label: 'Security groups JSON', detail: 'Compact Security Group configuration in AI-friendly JSON' },
  { id: 'simple_security_group_rules_json', order: 50, group: 'Simple JSON', label: 'Security group rules JSON', detail: 'Compact firewall-rule overview in AI-friendly JSON' },
  { id: 'security_group_rule_template', order: 60, group: 'Excel templates', label: 'Security Group rule template', detail: 'Project-wide rule workbook; choose the target Security Group in the file' },
  { id: 'server_creation_template', order: 70, group: 'Excel templates', label: 'Server creation template', detail: 'Terraform-compatible server workbook with live Cloud dropdown values' },
  { id: 'inventory', order: 80, group: 'Project data', label: 'Server inventory', detail: 'Detailed, current server inventory for Codex' },
  { id: 'subnets', order: 90, group: 'Project data', label: 'Subnets', detail: 'Network subnets and addressing' },
  { id: 'security_groups', order: 100, group: 'Project data', label: 'Security groups', detail: 'Security Group configuration' },
  { id: 'security_group_rules', order: 110, group: 'Project data', label: 'Security group rules', detail: 'Rules associated with project Security Groups' },
  { id: 'elastic_ips', order: 120, group: 'Project data', label: 'Elastic IPs', detail: 'Project Elastic IP allocations' },
  { id: 'simple_server_inventory', order: 130, group: 'Simple CSV', label: 'Server inventory CSV', detail: 'Compact server facts: compute, IPs, network and volumes' },
  { id: 'simple_vpcs', order: 140, group: 'Simple CSV', label: 'VPCs CSV', detail: 'Compact VPC overview for fast agent reading' },
  { id: 'simple_subnets', order: 150, group: 'Simple CSV', label: 'Subnets CSV', detail: 'Compact subnet and CIDR overview' },
  { id: 'simple_security_groups', order: 160, group: 'Simple CSV', label: 'Security groups CSV', detail: 'Compact Security Group configuration overview' },
  { id: 'simple_security_group_rules', order: 170, group: 'Simple CSV', label: 'Security group rules CSV', detail: 'Compact firewall-rule overview' },
  { id: 'private_ips', order: 180, group: 'Optional data', label: 'Private IPs', detail: 'Private-IP allocation details; not refreshed by default' },
  { id: 'audit_events', order: 190, group: 'Optional data', label: 'Audit events', detail: 'Audit history; not refreshed by default' },
  { id: 'cloud_api_history', order: 200, group: 'Optional data', label: 'Cloud API history', detail: 'Cloud API history; not refreshed by default' },
] as const
const defaultSnapshotSources = snapshotOptions
  .filter((item) => item.group === 'Simple JSON' || item.group === 'Excel templates')
  .map((item) => item.id)
type ModelCatalogItem = {
  id: string
  display_name: string
  description: string
  is_default: boolean
  reasoning_efforts: Array<
    'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  >
  default_reasoning_effort:
    'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
}
type AgentRuntime = {
  models: ModelCatalogItem[]
  configured_model?: string | null
  configured_reasoning_effort:
    'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  policy: string
  policy_detail: string
}
type ActivityEvent = {
  id: string
  label: string
  detail?: string
  state: 'running' | 'complete' | 'attention'
}
type ExecutionLog = {
  id: string
  created_at: string
  actor_email: string
  conversation_id: string
  request_id: string
  status: string
  model?: string | null
  reasoning_effort: string
  mode: string
  user_input: string
  prompt_text: string
  context: Record<string, unknown>
  answer_text: string
  activity: Array<Record<string, unknown>>
  metadata: Record<string, unknown>
  duration_ms: number
}
type ExecutionLogSummary = Pick<ExecutionLog, 'id' | 'created_at' | 'actor_email' | 'conversation_id' | 'request_id' | 'status' | 'model' | 'reasoning_effort' | 'mode' | 'user_input' | 'answer_text' | 'duration_ms'>
type CodexSettings = {
  provider: 'codex_app_server' | 'evidence_only'
  command: string
  model: string
  reasoning_effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  workdir: string
  timeout_seconds: number
  approval_timeout_seconds: number
  system_prompt: string
  workspace_prompt: string
  project_chat_prompt: string
  available: boolean
  version?: string | null
  error?: string | null
  csrf_token?: string | null
}

// Keep the hostname as localhost: CloudTool's authenticated browser cookie is
// scoped to this host and is therefore not sent to 127.0.0.1.
const agentBaseUrl =
  import.meta.env.VITE_AGENT_API_BASE_URL ?? '/agent-api/api/v1'
function id() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

function headers(
  cloudToken: string,
  projectId: string,
  csrfToken?: string | null
) {
  return {
    'Content-Type': 'application/json',
    'X-Cloud-Token': cloudToken,
    'X-Project-Id': projectId,
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
  }
}

function sseFrames(buffer: string) {
  const frames = buffer.split('\n\n')
  return {
    frames: frames.slice(0, -1),
    remainder: frames[frames.length - 1] ?? '',
  }
}

const activityLabels: Record<string, string> = {
  policy: 'Safety policy applied',
  mcp_ready: 'CloudTool retrieval tools ready',
  codex_started: 'Codex is working',
  codex_settings_updated: 'Applying selected Codex settings',
  saving_conversation: 'Saving conversation',
  session_unavailable: 'Codex session unavailable',
}

function MarkdownAnswer({ text }: { text: string }) {
  return (
    <div className='leading-6 break-words [&_a]:text-primary [&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ol>li]:list-decimal [&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:bg-muted [&_th]:p-2'>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

function LogBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className='mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase'>
        {label}
      </p>
      <pre className='max-h-80 overflow-auto rounded-md border bg-background p-3 text-xs leading-5 break-words whitespace-pre-wrap'>
        {value}
      </pre>
    </div>
  )
}

function preview(value: string, length = 90) {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > length ? `${compact.slice(0, length)}…` : compact
}

function commandFromMarkdown(value: string) {
  const match = value.match(/```(?:bash|sh|shell|console)?\s*\n([\s\S]*?)```/i)
  const command = match?.[1]?.trim()
  return command && command.length <= 4000 ? command : undefined
}

export function AgentPage() {
  const project = useCloudStore((state) => state.project)
  const cloudToken = useCloudStore((state) => state.token)
  const csrfToken = useAuthStore((state) => state.auth.user?.csrf_token)
  const setAuthUser = useAuthStore((state) => state.auth.setUser)
  const role = useAuthStore((state) => state.auth.user?.role)
  const projectId = project?.id
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [conversationsHasMore, setConversationsHasMore] = useState(false)
  const [conversationsLoading, setConversationsLoading] = useState(false)
  const [conversationsCollapsed, setConversationsCollapsed] = useState(false)
  const [conversationsWidth, setConversationsWidth] = useState(288)
  const [activeId, setActiveId] = useState<string>()
  const [draft, setDraft] = useState('')
  const [draftResetKey, setDraftResetKey] = useState(0)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isSending, setIsSending] = useState(false)
  const [requestId, setRequestId] = useState<string>()
  const [conversationSearch, setConversationSearch] = useState('')
  const [editingConversationId, setEditingConversationId] = useState<string>()
  const [editingTitle, setEditingTitle] = useState('')
  const [conversationPendingDelete, setConversationPendingDelete] = useState<Conversation>()
  const [deletingConversation, setDeletingConversation] = useState(false)
  const [chatModel, setChatModel] = useState('')
  const [loadedPreferenceKey, setLoadedPreferenceKey] = useState<string>()
  const [reasoningEffort, setReasoningEffort] = useState<
    'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  >('medium')
  const [runtime, setRuntime] = useState<AgentRuntime>()
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [codexExecution, setCodexExecution] = useState<CodexExecutionItem[]>([])
  const [executionConversationId, setExecutionConversationId] = useState<string>()
  const codexExecutionRef = useRef<CodexExecutionItem[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [vmConsoleOpen, setVmConsoleOpen] = useState(false)
  const [vmCommand, setVmCommand] = useState('')
  const [vmAction, setVmAction] = useState<VmAction>()
  const [apiAction, setApiAction] = useState<ApiAction>()
  const [apiActionQueue, setApiActionQueue] = useState<ApiAction[]>([])
  const [apiExecuting, setApiExecuting] = useState(false)
  const [apiResult, setApiResult] = useState<string>()
  const [apiCloseConfirmOpen, setApiCloseConfirmOpen] = useState(false)
  const [apiCountdownSeconds, setApiCountdownSeconds] = useState<number>()
  const [securityGroupName, setSecurityGroupName] = useState<string>()
  const [apiHistoryOpen, setApiHistoryOpen] = useState(false)
  const [apiHistoryLoading, setApiHistoryLoading] = useState(false)
  const [apiHistory, setApiHistory] = useState<ApiActionHistory[]>([])
  const [apiHistoryReplaying, setApiHistoryReplaying] = useState<string>()
  const [selectedApiHistory, setSelectedApiHistory] = useState<ApiActionHistory>()
  const [permissionMode, setPermissionMode] = useState<'confirm' | 'bypass'>(
    'confirm'
  )
  const [logsOpen, setLogsOpen] = useState(false)
  const [logsLoading, setLogsLoading] = useState(false)
  const [executionLogs, setExecutionLogs] = useState<ExecutionLogSummary[]>([])
  const [logsTotal, setLogsTotal] = useState(0)
  const [logsPagination, setLogsPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 })
  const [logsPurgeDays, setLogsPurgeDays] = useState('30')
  const [logsPurgeOpen, setLogsPurgeOpen] = useState(false)
  const [logsPurging, setLogsPurging] = useState(false)
  const [selectedLogLoading, setSelectedLogLoading] = useState(false)
  const [selectedLog, setSelectedLog] = useState<ExecutionLog>()
  const [settings, setSettings] = useState<CodexSettings>()
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsTesting, setSettingsTesting] = useState(false)
  const [contextRefreshing, setContextRefreshing] = useState(false)
  const [contextRefreshOpen, setContextRefreshOpen] = useState(false)
  const [snapshotSources, setSnapshotSources] = useState<string[]>(defaultSnapshotSources)
  const [workspaceRefreshResults, setWorkspaceRefreshResults] = useState<WorkspaceRefreshResult[]>([])
  const [workspacePathOpen, setWorkspacePathOpen] = useState(false)
  const [workspacePath, setWorkspacePath] = useState('')
  const [workspaceManagementOpen, setWorkspaceManagementOpen] = useState(false)
  const [workspaceManagementLoading, setWorkspaceManagementLoading] = useState(false)
  const [workspaceManagementItems, setWorkspaceManagementItems] = useState<WorkspaceManagedItem[]>([])
  const [managedFile, setManagedFile] = useState<ManagedWorkspacePreview>()
  const [workspaceFilePreviewOpen, setWorkspaceFilePreviewOpen] = useState(false)
  const [workspaceFileEdit, setWorkspaceFileEdit] = useState(false)
  const [workspaceCollapsedFolders, setWorkspaceCollapsedFolders] = useState<Set<string>>(new Set())
  const [managedFileLoading, setManagedFileLoading] = useState(false)
  const [managedFileSaving, setManagedFileSaving] = useState(false)
  const [managedDeletePath, setManagedDeletePath] = useState<string>()
  const [managedRenameItem, setManagedRenameItem] = useState<WorkspaceManagedItem>()
  const [managedRenameName, setManagedRenameName] = useState('')
  const [managedRenameSaving, setManagedRenameSaving] = useState(false)
  const [codexHistoryOpen, setCodexHistoryOpen] = useState(false)
  const [codexHistoryLoading, setCodexHistoryLoading] = useState(false)
  const [codexHistoryThreads, setCodexHistoryThreads] = useState<CodexHistoryThread[]>([])
  const [selectedCodexThread, setSelectedCodexThread] = useState<CodexHistoryTranscript>()
  const [codexThreadLoading, setCodexThreadLoading] = useState(false)
  const [sessionUnavailableOpen, setSessionUnavailableOpen] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const workspaceRefreshInFlight = useRef(false)
  const draftRef = useRef('')
  const runtimeLoadedScope = useRef<string | undefined>(undefined)
  const fileInput = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const autoActionKey = useRef<string | undefined>(undefined)
  const conversationsResize = useRef(false)
  const conversationsRef = useRef<Conversation[]>([])
  const conversationsLoadedScope = useRef<string | undefined>(undefined)
  const reviewTranscriptCommand = useCallback((command: string) => {
    setVmCommand(command)
    setVmConsoleOpen(true)
  }, [])
  const active =
    conversations.find((item) => item.id === activeId) ?? conversations[0]
  useEffect(() => { conversationsRef.current = conversations }, [conversations])
  const activeEvidence = useMemo(
    () =>
      [...(active?.messages ?? [])]
        .reverse()
        .find((item) => item.role === 'assistant' && item.evidence?.length)
        ?.evidence ?? [],
    [active]
  )
  const ready = Boolean(project && cloudToken)
  const isAdmin =
    role === 'admin' || (typeof role === 'object' && role.name === 'admin')
  const agentHeaders = useMemo(
    () => (projectId ? headers(cloudToken, projectId, csrfToken) : undefined),
    [cloudToken, csrfToken, projectId]
  )
  const workspaceRefreshRows = useMemo<WorkspaceRefreshRow[]>(
    () => snapshotOptions.map((item) => ({
      id: item.id,
      order: item.order,
      group: item.group,
      content: item.label,
      purpose: item.detail,
      destination: item.id.includes('template') ? 'excel-template/' : item.id.startsWith('simple_') ? 'project-data-simple/' : 'project-data/',
    })).sort((left, right) => left.order - right.order),
    []
  )
  const selectedWorkspaceSourceCount = workspaceRefreshRows.filter((row) => snapshotSources.includes(row.id)).length
  const loadWorkspaceManagement = useCallback(async () => {
    if (!agentHeaders) return
    setWorkspaceManagementLoading(true)
    try {
      const response = await fetch(`${agentBaseUrl}/project-context/manage/tree`, { credentials: 'include', headers: agentHeaders })
      if (!response.ok) throw new Error('Unable to load workspace')
      const data = await response.json() as { items: WorkspaceManagedItem[] }
      setWorkspaceManagementItems(data.items)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Unable to load workspace.') }
    finally { setWorkspaceManagementLoading(false) }
  }, [agentHeaders])
  const openManagedFile = useCallback(async (item: WorkspaceManagedItem, edit = false) => {
    if (item.kind !== 'file' || !agentHeaders) return
    setWorkspaceFileEdit(edit)
    setWorkspaceFilePreviewOpen(true)
    setManagedFile(undefined)
    setManagedFileLoading(true)
    try {
      const response = await fetch(`${agentBaseUrl}/project-context/manage/file?path=${encodeURIComponent(item.path)}`, { credentials: 'include', headers: agentHeaders })
      const data = await response.json().catch(() => undefined) as { path?: string; kind?: 'text' | 'image'; content?: string; data_url?: string; detail?: string } | undefined
      if (!response.ok || !data?.kind || (data.kind === 'text' && data.content === undefined) || (data.kind === 'image' && !data.data_url)) throw new Error(data?.detail || 'This file cannot be previewed')
      setManagedFile({ path: data.path || item.path, kind: data.kind, content: data.content || '', data_url: data.data_url })
      setWorkspaceFileEdit(data.kind === 'text' && edit)
    } catch (error) { setWorkspaceFilePreviewOpen(false); toast.error(error instanceof Error ? error.message : 'Unable to open file.') }
    finally { setManagedFileLoading(false) }
  }, [agentHeaders])
  const downloadManagedWorkspacePath = useCallback(async (item: WorkspaceManagedItem) => {
    if (!agentHeaders) return
    try {
      const response = await fetch(
        `${agentBaseUrl}/project-context/manage/download?path=${encodeURIComponent(item.path)}`,
        { credentials: 'include', headers: agentHeaders }
      )
      if (!response.ok) {
        const data = await response.json().catch(() => undefined) as { detail?: string; error?: { message?: string } } | undefined
        throw new Error(data?.error?.message || data?.detail || 'Unable to download workspace item.')
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = item.kind === 'folder' ? `${item.name.replace(/\/$/, '')}.zip` : item.name
      document.body.append(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to download workspace item.')
    }
  }, [agentHeaders])
  const renameManagedWorkspaceFile = useCallback(async () => {
    if (!managedRenameItem || !agentHeaders || !managedRenameName.trim()) return
    setManagedRenameSaving(true)
    try {
      const response = await fetch(`${agentBaseUrl}/project-context/manage/file/rename`, {
        method: 'POST', credentials: 'include', headers: agentHeaders,
        body: JSON.stringify({ path: managedRenameItem.path, new_name: managedRenameName.trim() }),
      })
      const data = await response.json().catch(() => undefined) as { detail?: string } | undefined
      if (!response.ok) throw new Error(data?.detail || 'Unable to rename workspace file.')
      setManagedFile(undefined)
      setManagedRenameItem(undefined)
      setManagedRenameName('')
      await loadWorkspaceManagement()
      toast.success('Workspace file renamed.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to rename workspace file.')
    } finally { setManagedRenameSaving(false) }
  }, [agentHeaders, loadWorkspaceManagement, managedRenameItem, managedRenameName])
  const apiPreviewRowsData = useMemo(() => apiPreviewRows(apiAction), [apiAction])
  const apiPreviewColumns = useMemo<ColumnDef<ApiPreviewRow>[]>(() => {
    const fields = [...new Set(apiPreviewRowsData.flatMap((row) => Object.keys(row).filter((key) => key !== 'id')))]
    return fields.map((field) => ({ accessorKey: field, header: field.replace(/_/g, ' ') }))
  }, [apiPreviewRowsData])
  const runtimeScope =
    projectId && cloudToken ? `${projectId}:${cloudToken}` : undefined
  const conversationPreferenceKey =
    projectId && active?.id
      ? `cloudtool:agent-preferences:${projectId}:${active.id}`
      : undefined

  useEffect(() => {
    if (
      !conversationPreferenceKey ||
      !runtime ||
      runtimeLoadedScope.current !== runtimeScope ||
      loadedPreferenceKey === conversationPreferenceKey
    )
      return
    const defaultModel =
      runtime.configured_model ??
      runtime.models.find((item) => item.is_default)?.id ??
      ''
    let model = defaultModel
    let reasoning =
      runtime.models.find((item) => item.id === defaultModel)
        ?.default_reasoning_effort ?? runtime.configured_reasoning_effort
    let permission: typeof permissionMode = 'confirm'
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(conversationPreferenceKey) || '{}'
      ) as {
        model?: string
        reasoning?: typeof reasoningEffort
        permission?: typeof permissionMode
      }
      if (
        saved.model === '' ||
        (typeof saved.model === 'string' &&
          runtime.models.some((item) => item.id === saved.model))
      )
        model = saved.model
      const selectedModel = runtime.models.find((item) => item.id === model)
      reasoning =
        selectedModel?.default_reasoning_effort ?? runtime.configured_reasoning_effort
      if (
        saved.reasoning &&
        (
          selectedModel?.reasoning_efforts ?? [
            'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
          ]
        ).includes(saved.reasoning)
      )
        reasoning = saved.reasoning
      if (saved.permission === 'confirm' || saved.permission === 'bypass')
        permission = saved.permission
    } catch {
      /* Invalid local preferences are safely ignored. */
    }
    setChatModel(model)
    setReasoningEffort(reasoning)
    setPermissionMode(permission)
    setLoadedPreferenceKey(conversationPreferenceKey)
  }, [conversationPreferenceKey, loadedPreferenceKey, runtime, runtimeScope])

  useEffect(() => {
    // Never overwrite a session with the previous session's controls while
    // its saved preferences (or the initial runtime) are still loading.
    if (!conversationPreferenceKey || loadedPreferenceKey !== conversationPreferenceKey)
      return
    try {
      window.localStorage.setItem(
        conversationPreferenceKey,
        JSON.stringify({
          model: chatModel,
          reasoning: reasoningEffort,
          permission: permissionMode,
        })
      )
    } catch {
      /* Storage may be unavailable; chat remains usable. */
    }
  }, [chatModel, conversationPreferenceKey, loadedPreferenceKey, permissionMode, reasoningEffort])

  const syncCsrfToken = (value?: string | null) => {
    if (!value) return
    setCsrfToken(value)
    const current = useAuthStore.getState().auth.user
    if (current) setAuthUser({ ...current, csrf_token: value })
  }

  const visibleConversations = useMemo(() => {
    const query = conversationSearch.trim().toLowerCase()
    return conversations
      .filter(
        (item) =>
          !query ||
          item.title.toLowerCase().includes(query) ||
          item.messages.some((message) =>
            message.text.toLowerCase().includes(query)
          )
      )
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [conversationSearch, conversations])

  const loadConversations = useCallback(async (reset = false) => {
    if (!projectId || !agentHeaders || conversationsLoading || (!reset && !conversationsHasMore)) return
    setConversationsLoading(true)
    const offset = reset ? 0 : conversationsRef.current.filter((item) => item.conversationId).length
    try {
      const response = await fetch(`${agentBaseUrl}/conversations?limit=15&offset=${offset}`, { credentials: 'include', headers: agentHeaders })
      if (!response.ok) return
      const items = await response.json() as StoredConversation[]
      const restored = items.map((item) => ({ id: item.id, conversationId: item.id, title: item.title, messages: item.messages ?? [], updatedAt: new Date(item.updated_at).getTime(), skillIds: item.skill_ids ?? [] }))
      // A project with no persisted chat history still needs an active local
      // conversation.  Previously a successful empty response replaced the
      // initial draft with [], leaving the visible composer without an active
      // target and making Send silently unavailable.
      const next = reset && !restored.length
        ? [{ id: id(), title: 'New analysis', messages: [], updatedAt: Date.now(), skillIds: [] }]
        : restored
      setConversations((current) => reset ? next : [...current, ...next.filter((item) => !current.some((existing) => existing.id === item.id))])
      setConversationsHasMore(response.headers.get('X-Has-More') === 'true')
      if (reset) setActiveId(next[0]?.id)
    } finally { setConversationsLoading(false) }
  }, [agentHeaders, conversationsHasMore, conversationsLoading, projectId])

  const openConversation = useCallback(async (conversation: Conversation) => {
    setActiveId(conversation.id)
    if (!conversation.conversationId || conversation.messages.length || !agentHeaders) return
    try {
      const response = await fetch(`${agentBaseUrl}/conversations/${encodeURIComponent(conversation.conversationId)}`, { credentials: 'include', headers: agentHeaders })
      if (!response.ok) return
      const detail = await response.json() as StoredConversation
      setConversations((items) => items.map((item) => item.id === conversation.id ? { ...item, messages: detail.messages ?? [], skillIds: detail.skill_ids ?? [] } : item))
    } catch { /* keep the summary visible; the next selection can retry */ }
  }, [agentHeaders])

  useEffect(() => {
    if (active) void openConversation(active)
  }, [active?.id, openConversation])

  const addConversation = () => {
    const next = {
      id: id(),
      title: 'New analysis',
      messages: [],
      updatedAt: Date.now(),
      skillIds: [],
    }
    setConversations((items) => [next, ...items])
    setActiveId(next.id)
    setDraft('')
    setAttachments([])
  }

  const changeActive = (change: (item: Conversation) => Conversation) => {
    if (!active) return
    setConversations((items) =>
      items.map((item) => (item.id === active.id ? change(item) : item))
    )
  }

  const renameConversation = async (conversation: Conversation) => {
    const title = editingTitle.trim()
    setEditingConversationId(undefined)
    if (!title || title === conversation.title) return
    setConversations((items) =>
      items.map((item) =>
        item.id === conversation.id ? { ...item, title } : item
      )
    )
    if (!conversation.conversationId) return
    if (!agentHeaders) {
      toast.error('CloudTool authentication is not ready.')
      return
    }
    try {
      const response = await fetch(
        `${agentBaseUrl}/conversations/${encodeURIComponent(conversation.conversationId ?? conversation.id)}`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: agentHeaders,
          body: JSON.stringify({ title }),
        }
      )
      if (!response.ok) throw new Error('Unable to rename conversation')
    } catch {
      setConversations((items) =>
        items.map((item) =>
          item.id === conversation.id
            ? { ...item, title: conversation.title }
            : item
        )
      )
      toast.error('Unable to rename conversation.')
    }
  }

  const confirmDeleteConversation = async () => {
    if (!conversationPendingDelete) return
    const conversation = conversationPendingDelete as Conversation
    setDeletingConversation(true)
    if (false &&
      !window.confirm(`Delete “${conversation.title}”? This cannot be undone.`)
    )
      return
    if (!conversation.conversationId) {
      setConversations((items) =>
        items.filter((item) => item.id !== conversation.id)
      )
      if (active?.id === conversation.id)
        setActiveId(
          conversations.find((item) => item.id !== conversation.id)?.id
        )
      setConversationPendingDelete(undefined)
      setDeletingConversation(false)
      return
    }
    if (!agentHeaders) {
      toast.error('CloudTool authentication is not ready.')
      setDeletingConversation(false)
      return
    }
    try {
      const response = await fetch(
        `${agentBaseUrl}/conversations/${encodeURIComponent(conversation.conversationId)}`,
        { method: 'DELETE', credentials: 'include', headers: agentHeaders }
      )
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
        throw new Error(body?.error?.message || `Unable to delete conversation (${response.status})`)
      }
      setConversations((items) =>
        items.filter((item) => item.id !== conversation.id)
      )
      if (active?.id === conversation.id) {
        const next = conversations.find((item) => item.id !== conversation.id)
        setActiveId(next?.id)
      }
      toast.success('Conversation deleted.')
      setConversationPendingDelete(undefined)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to delete conversation.')
    } finally {
      setDeletingConversation(false)
    }
  }

  const deleteConversation = (conversation: Conversation) => {
    setConversationPendingDelete(conversation)
  }

  useEffect(() => {
    controller.current?.abort()
    setRuntime(undefined)
    setChatModel('')
    setReasoningEffort('medium')
    const timer = window.setTimeout(() => {
      const next = {
        id: id(),
        title: 'New analysis',
        messages: [],
        updatedAt: Date.now(),
        skillIds: [],
      }
      setConversations([next])
      setActiveId(next.id)
      setAttachments([])
      setIsSending(false)
      setRequestId(undefined)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [projectId])

  useEffect(() => {
    if (!projectId || !cloudToken || !agentHeaders) return
    const scope = `${projectId}:${cloudToken}`
    if (conversationsLoadedScope.current === scope) return
    conversationsLoadedScope.current = scope
    void loadConversations(true)
  }, [agentHeaders, cloudToken, loadConversations, projectId])

  useEffect(() => {
    // Runtime is authenticated by CloudTool and therefore needs the current
    // CSRF token. Once loaded for a project/token scope, do not refetch it on
    // later CSRF rotations: that is what previously reset a user's picker.
    if (
      !agentHeaders ||
      !runtimeScope ||
      runtimeLoadedScope.current === runtimeScope
    )
      return
    let alive = true
    void fetch(`${agentBaseUrl}/runtime`, {
      credentials: 'include',
      headers: agentHeaders,
    })
      .then(async (response) =>
        response.ok ? (response.json() as Promise<AgentRuntime>) : undefined
      )
      .then((value) => {
        if (!alive || !value) return
        runtimeLoadedScope.current = runtimeScope
        setRuntime(value)
        // The settings endpoint owns the default.  Reset the request-scoped
        // controls on reload so the selected values match Codex, not a stale
        // React default.
        const selectedModel =
          value.configured_model ??
          value.models.find((item) => item.is_default)?.id ??
          ''
        setChatModel(selectedModel)
        setReasoningEffort(
          value.models.find((item) => item.id === selectedModel)
            ?.default_reasoning_effort ?? value.configured_reasoning_effort
        )
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [agentHeaders, runtimeScope])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [active?.messages, isSending])
  useEffect(() => () => controller.current?.abort(), [])

  const chooseFiles = async (files: FileList | File[] | null) => {
    if (!files) return
    const selected = Array.from(files).slice(0, 5 - attachments.length)
    const accepted = selected.filter((file) => file.size <= 5 * 1024 * 1024)
    if (accepted.length !== selected.length)
      toast.error(
        'Each attachment must be 5 MB or smaller.'
      )
    const next = await Promise.all(
      accepted.map(async (file) => {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
        return {
          id: id(),
          name: file.name,
          media_type: file.type || 'application/octet-stream',
          content_base64: dataUrl.split(',', 2)[1],
        }
      })
    )
    setAttachments((items) => [...items, ...next])
  }

  const loadSettings = async () => {
    if (!agentHeaders) return
    setSettingsLoading(true)
    try {
      const response = await fetch(`${agentBaseUrl}/settings/codex`, {
        credentials: 'include',
        headers: agentHeaders,
      })
      if (!response.ok) throw new Error('Unable to load settings')
      const next = (await response.json()) as CodexSettings
      syncCsrfToken(next.csrf_token)
      setSettings(next)
    } catch {
      toast.error('Unable to load Codex CLI settings.')
      setSettingsOpen(false)
    } finally {
      setSettingsLoading(false)
    }
  }

  const openSettings = () => {
    setSettingsOpen(true)
    void loadSettings()
  }

  const loadLogs = async (pagination = logsPagination) => {
    if (!agentHeaders) return
    setLogsLoading(true)
    try {
      const response = await fetch(`${agentBaseUrl}/logs?limit=${pagination.pageSize}&offset=${pagination.pageIndex * pagination.pageSize}`, {
        credentials: 'include',
        headers: agentHeaders,
      })
      if (!response.ok) throw new Error('Unable to load agent logs')
      const data = await response.json() as { items?: ExecutionLogSummary[]; total?: number }
      setExecutionLogs(data.items ?? [])
      setLogsTotal(data.total ?? 0)
    } catch {
      toast.error('Unable to load AI agent logs.')
    } finally {
      setLogsLoading(false)
    }
  }

  const openLogs = () => {
    const firstPage = { pageIndex: 0, pageSize: logsPagination.pageSize }
    setLogsOpen(true)
    setLogsPagination(firstPage)
    void loadLogs(firstPage)
  }

  const openLogDetail = async (logId: string) => {
    if (!agentHeaders) return
    setSelectedLogLoading(true)
    try {
      const response = await fetch(`${agentBaseUrl}/logs/${encodeURIComponent(logId)}`, { credentials: 'include', headers: agentHeaders })
      if (!response.ok) throw new Error('Unable to load execution log details')
      setSelectedLog((await response.json()) as ExecutionLog)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to load execution log details.')
    } finally {
      setSelectedLogLoading(false)
    }
  }

  const purgeLogs = async () => {
    if (!agentHeaders) return
    setLogsPurging(true)
    try {
      // A future cutoff includes every record in this project while keeping
      // the existing delete API and its project ownership boundary intact.
      const before = logsPurgeDays === 'all'
        ? '9999-12-31T23:59:59.999Z'
        : new Date(Date.now() - Number(logsPurgeDays) * 24 * 60 * 60 * 1000).toISOString()
      const response = await fetch(`${agentBaseUrl}/logs?before=${encodeURIComponent(before)}`, { method: 'DELETE', credentials: 'include', headers: agentHeaders })
      const data = await response.json().catch(() => undefined) as { deleted?: number; error?: { message?: string } } | undefined
      if (!response.ok) throw new Error(data?.error?.message || 'Unable to delete execution logs')
      toast.success(`Deleted ${data?.deleted ?? 0} execution log(s).`)
      setLogsPurgeOpen(false)
      void loadLogs({ pageIndex: 0, pageSize: logsPagination.pageSize })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to delete execution logs.')
    } finally {
      setLogsPurging(false)
    }
  }

  const executionLogColumns = useMemo<ColumnDef<ExecutionLogSummary>[]>(
    () => [
      { accessorKey: 'created_at', header: 'Time', cell: ({ row }) => <span className='text-xs text-muted-foreground'>{new Date(row.original.created_at).toLocaleString()}</span> },
      { accessorKey: 'status', header: 'Status', cell: ({ row }) => <Badge variant={row.original.status === 'success' ? 'secondary' : 'destructive'}>{row.original.status}</Badge> },
      { id: 'model', header: 'Model', accessorFn: (row) => row.model || row.mode, cell: ({ row }) => <span className='max-w-32 truncate text-xs'>{row.original.model || row.original.mode}</span> },
      { accessorKey: 'reasoning_effort', header: 'Reasoning', cell: ({ row }) => <span className='text-xs'>{row.original.reasoning_effort}</span> },
      { accessorKey: 'user_input', header: 'User input', cell: ({ row }) => <span className='block max-w-60 truncate text-xs' title={row.original.user_input}>{preview(row.original.user_input)}</span> },
      { accessorKey: 'answer_text', header: 'AI answer preview', cell: ({ row }) => <span className='block max-w-60 truncate text-xs' title={row.original.answer_text}>{preview(row.original.answer_text)}</span> },
      { accessorKey: 'duration_ms', header: 'Duration', cell: ({ row }) => <span className='text-xs'>{row.original.duration_ms} ms</span> },
      {
        id: 'actions',
        header: 'Action',
        cell: ({ row }) => (
          <div className='text-end'>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button aria-label={`Actions for log ${row.original.id}`} disabled={selectedLogLoading} size='icon' title='Actions' variant='ghost'>
                  {selectedLogLoading ? <Loader2 className='size-4 animate-spin' /> : <MoreVertical className='size-4' />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end'>
                <DropdownMenuItem onClick={() => void openLogDetail(row.original.id)}>
                  <Eye className='mr-2 size-4' /> View details
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
        enableSorting: false,
      },
    ],
    [agentHeaders, selectedLogLoading]
  )

  const refreshProjectContext = async () => {
    if (!agentHeaders || !ready || contextRefreshing || workspaceRefreshInFlight.current) return
    workspaceRefreshInFlight.current = true
    setContextRefreshing(true)
    setWorkspaceRefreshResults([])
    try {
      const response = await fetch(`${agentBaseUrl}/project-context/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: agentHeaders,
        body: JSON.stringify({ sources: snapshotSources }),
      })
      const data = (await response.json().catch(() => undefined)) as
        | {
            files?: string[]
            warnings?: string[]
            results?: WorkspaceRefreshResult[]
            csrf_token?: string | null
            error?: { message?: string }
          }
        | undefined
      if (!response.ok)
        throw new Error(
          data?.error?.message || 'Unable to refresh project context'
      )
      syncCsrfToken(data?.csrf_token)
      const results = data?.results ?? []
      setWorkspaceRefreshResults(results)
      const failed = results.filter((item) => item.status === 'error').length
      if (failed) toast.warning(`Workspace refresh completed with ${failed} item error(s).`)
      else toast.success(`Project context refreshed (${data?.files?.length ?? 0} files).`)
      if (data?.warnings?.length) toast.warning(data.warnings.join(' '))
    } catch (error) {
      setWorkspaceRefreshResults(snapshotSources.map((source) => ({
        source,
        status: 'error',
        detail: error instanceof Error ? error.message : 'Unable to refresh this workspace item.',
        files: [],
      })))
      toast.error(
        error instanceof Error
          ? error.message
          : 'Unable to refresh project context.'
      )
    } finally {
      workspaceRefreshInFlight.current = false
      setContextRefreshing(false)
    }
  }

  const getWorkspacePath = async () => {
    if (!agentHeaders || !ready) return
    try {
      const response = await fetch(`${agentBaseUrl}/project-context/path`, { credentials: 'include', headers: agentHeaders })
      const data = await response.json().catch(() => undefined) as { path?: string; error?: { message?: string } } | undefined
      if (!response.ok) throw new Error(data?.error?.message || 'Unable to get workspace path')
      const path = data?.path
      if (!path) throw new Error('Workspace path is unavailable')
      setWorkspacePath(path)
      setWorkspacePathOpen(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to get workspace path.')
    }
  }

  const formatCodexHistoryTime = (value?: number | null) =>
    value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value * 1000)) : 'Unknown time'

  const loadCodexHistoryThread = async (threadId: string) => {
    if (!agentHeaders) return
    setCodexThreadLoading(true)
    try {
      const response = await fetch(`${agentBaseUrl}/codex-history/threads/${encodeURIComponent(threadId)}`, { credentials: 'include', headers: agentHeaders })
      const data = await response.json().catch(() => undefined) as CodexHistoryTranscript | { detail?: string; error?: { message?: string } } | undefined
      const detail = data && 'detail' in data ? data.detail : undefined
      const message = data && 'error' in data ? data.error?.message : undefined
      if (!response.ok) throw new Error(message || detail || 'Unable to load this Codex chat')
      setSelectedCodexThread(data as CodexHistoryTranscript)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to load this Codex chat.')
    } finally {
      setCodexThreadLoading(false)
    }
  }

  const openCodexHistory = async () => {
    if (!agentHeaders) return
    setCodexHistoryOpen(true)
    setCodexHistoryLoading(true)
    setSelectedCodexThread(undefined)
    try {
      const response = await fetch(`${agentBaseUrl}/codex-history/threads`, { credentials: 'include', headers: agentHeaders })
      const data = await response.json().catch(() => undefined) as { threads?: CodexHistoryThread[]; detail?: string; error?: { message?: string } } | undefined
      if (!response.ok) throw new Error(data?.error?.message || data?.detail || 'Unable to load Codex chat history')
      const threads = data?.threads ?? []
      setCodexHistoryThreads(threads)
      if (threads[0]) void loadCodexHistoryThread(threads[0].id)
    } catch (error) {
      setCodexHistoryThreads([])
      toast.error(error instanceof Error ? error.message : 'Unable to load Codex chat history.')
    } finally {
      setCodexHistoryLoading(false)
    }
  }

  const saveSettings = async () => {
    if (!settings || !agentHeaders) return
    setSettingsSaving(true)
    try {
      const response = await fetch(`${agentBaseUrl}/settings/codex`, {
        method: 'PUT',
        credentials: 'include',
        headers: agentHeaders,
        body: JSON.stringify({
          provider: settings.provider,
          command: settings.command,
          model: settings.model,
          reasoning_effort: settings.reasoning_effort,
          workdir: settings.workdir,
          timeout_seconds: Number(settings.timeout_seconds),
          approval_timeout_seconds: Number(settings.approval_timeout_seconds),
          system_prompt: settings.system_prompt,
          workspace_prompt: settings.workspace_prompt,
          project_chat_prompt: settings.project_chat_prompt,
        }),
      })
      if (!response.ok) throw new Error('Unable to save settings')
      const next = (await response.json()) as CodexSettings
      syncCsrfToken(next.csrf_token)
      setSettings(next)
      // Re-read the runtime contract after an administrator changes the
      // Codex defaults, then make the chat controls reflect that contract.
      const runtimeResponse = await fetch(`${agentBaseUrl}/runtime`, {
        credentials: 'include',
        headers: agentHeaders,
      })
      if (runtimeResponse.ok) {
        const nextRuntime = (await runtimeResponse.json()) as AgentRuntime
        setRuntime(nextRuntime)
        const selectedModel =
          nextRuntime.configured_model ??
          nextRuntime.models.find((item) => item.is_default)?.id ??
          ''
        setChatModel(selectedModel)
        setReasoningEffort(
          nextRuntime.models.find((item) => item.id === selectedModel)
            ?.default_reasoning_effort ??
            nextRuntime.configured_reasoning_effort
        )
      }
      toast.success(
        next.available
          ? 'Codex CLI settings saved.'
          : 'Settings saved, but Codex CLI is unavailable.'
      )
    } catch {
      toast.error('Unable to save Codex CLI settings.')
    } finally {
      setSettingsSaving(false)
    }
  }

  const executeApiAction = async (automatic = false) => {
    if (!apiAction || !agentHeaders) return
    setApiExecuting(true)
    try {
      const response = await fetch(
        `${agentBaseUrl}/pending-actions/${encodeURIComponent(apiAction.id || '')}/decision`,
        {
          method: 'POST',
          credentials: 'include',
          headers: agentHeaders,
          body: JSON.stringify({ decision: automatic ? 'approve' : 'approve' }),
        }
      )
      const data = (await response.json().catch(() => undefined)) as
        { csrf_token?: string | null; status?: string; reason?: unknown; result?: unknown; error?: { message?: string } } | undefined
      if (!response.ok || data?.status === 'failed')
        throw new Error(
          data?.error?.message || (data?.reason ? (typeof data.reason === 'string' ? data.reason : JSON.stringify(data.reason)) : 'CloudTool could not execute this action')
        )
      toast.success('Action approved; Codex is receiving the live result.')
      setApiAction((current) => current?.id === apiAction.id ? undefined : current)
      setApiActionQueue([])
      setApiResult(undefined)
      return
      const advanceQueue = () => {
        autoActionKey.current = undefined
        setApiActionQueue((queued) => {
          const [next, ...remaining] = queued
          setApiAction(next)
          return remaining
        })
      }
      if (automatic) {
        advanceQueue()
        return
      }
      if (apiActionQueue.length) {
        advanceQueue()
        return
      }
      if (automatic)
        setApiResult(
          'Action completed automatically under this conversation’s bypass policy.'
        )
      else setApiAction(undefined)
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'CloudTool action failed.'
      toast.error(message)
      setApiAction((current) => current?.id === apiAction.id ? undefined : current)
      setApiResult(undefined)
    } finally {
      setApiExecuting(false)
    }
  }

  const rejectApiAction = async () => {
    if (!apiAction?.id || !agentHeaders) return
    setApiExecuting(true)
    try {
      const response = await fetch(`${agentBaseUrl}/pending-actions/${encodeURIComponent(apiAction.id)}/decision`, {
        method: 'POST', credentials: 'include', headers: agentHeaders, body: JSON.stringify({ decision: 'reject' }),
      })
      if (!response.ok) throw new Error('Unable to reject this action')
      setApiAction(undefined)
      setApiActionQueue([])
      setApiCloseConfirmOpen(false)
      toast.success('Action rejected; Codex was notified immediately.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to reject this action.')
    } finally {
      setApiExecuting(false)
    }
  }

  useEffect(() => {
    const pendingConversationId = active?.conversationId
    if (!pendingConversationId || !agentHeaders || !isSending) return
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(`${agentBaseUrl}/conversations/${encodeURIComponent(pendingConversationId)}/pending-actions/stream`, { credentials: 'include', headers: agentHeaders, signal: controller.signal })
        if (!response.ok || !response.body) return
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = ''
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read(); if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parsed = sseFrames(buffer); buffer = parsed.remainder
          for (const frame of parsed.frames) {
            const raw = frame.match(/^data:\s*(.+)$/m)?.[1]; if (!raw) continue
            const item = JSON.parse(raw) as { id: string; project_id: string; status: string; expires_at?: string; action: ApiAction }
            if (item.status === 'awaiting_approval') {
              setApiAction({ ...item.action, id: item.id, project_id: item.project_id, expires_at: item.expires_at })
              setActivity((items) => items.some((entry) => entry.id === `pending-${item.id}`) ? items : [...items, { id: `pending-${item.id}`, label: 'Awaiting approval', detail: item.action.summary, state: 'attention' }])
            }
          }
        }
      } catch (error) { if ((error as DOMException).name !== 'AbortError') return }
    })()
    return () => controller.abort()
  }, [active?.conversationId, agentHeaders, isSending])

  useEffect(() => {
    if (!apiAction || permissionMode !== 'bypass' || apiExecuting || apiResult)
      return
    const key = apiAction.id || `${apiAction.type}:${JSON.stringify(apiAction.parameters ?? apiAction.deployment ?? apiAction.rules ?? apiAction.rule)}`
    if (autoActionKey.current === key) return
    autoActionKey.current = key
    void executeApiAction(true)
  }, [apiAction, apiExecuting, apiResult, permissionMode])

  useEffect(() => {
    if (!apiAction?.expires_at) { setApiCountdownSeconds(undefined); return }
    const update = () => {
      const seconds = Math.max(0, Math.ceil((new Date(apiAction.expires_at as string).getTime() - Date.now()) / 1000))
      setApiCountdownSeconds(seconds)
      if (seconds === 0) {
        setApiAction(undefined)
        setApiActionQueue([])
        toast.error('Approval request expired and was cancelled.')
      }
    }
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [apiAction?.id, apiAction?.expires_at])

  useEffect(() => {
    if (!apiAction?.security_group_id || !agentHeaders) { setSecurityGroupName(undefined); return }
    let activeLookup = true
    void fetch(`${agentBaseUrl}/security-groups/${encodeURIComponent(apiAction.security_group_id)}/display-name`, { credentials: 'include', headers: agentHeaders })
      .then((response) => response.ok ? response.json() as Promise<{ name?: string | null }> : undefined)
      .then((data) => { if (activeLookup) setSecurityGroupName(data?.name || undefined) })
      .catch(() => { if (activeLookup) setSecurityGroupName(undefined) })
    return () => { activeLookup = false }
  }, [apiAction?.id, apiAction?.security_group_id, agentHeaders])

  const loadApiHistory = useCallback(async () => {
    if (!agentHeaders) return
    setApiHistoryLoading(true)
    try {
      const response = await fetch(`${agentBaseUrl}/pending-action-history`, { credentials: 'include', headers: agentHeaders })
      if (!response.ok) throw new Error('Unable to load API approval history')
      setApiHistory((await response.json() as { items: ApiActionHistory[] }).items)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Unable to load API approval history.') }
    finally { setApiHistoryLoading(false) }
  }, [agentHeaders])

  const replayApiHistory = useCallback(async (item: ApiActionHistory) => {
    if (!agentHeaders || !active?.conversationId) return
    setApiHistoryReplaying(item.id)
    try {
      const response = await fetch(`${agentBaseUrl}/pending-action-history/${encodeURIComponent(item.id)}/replay`, { method: 'POST', credentials: 'include', headers: agentHeaders, body: JSON.stringify({ conversation_id: active.conversationId }) })
      if (!response.ok) throw new Error('Unable to replay this action')
      const pending = await response.json() as { id: string; project_id: string; expires_at?: string; action: ApiAction }
      setApiAction({ ...pending.action, id: pending.id, project_id: pending.project_id, expires_at: pending.expires_at })
      setApiHistoryOpen(false)
      toast.success('A new approval request was created for this previous action.')
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Unable to replay this action.') }
    finally { setApiHistoryReplaying(undefined) }
  }, [active?.conversationId, agentHeaders])

  const apiHistoryColumns = useMemo<ColumnDef<ApiActionHistory>[]>(() => [
    { accessorKey: 'updated_at', header: 'Updated', cell: ({ row }) => <div className='whitespace-nowrap'><p className='text-sm'>{new Date(row.original.updated_at).toLocaleString()}</p><p className='text-xs text-muted-foreground'>{row.original.conversation_id.slice(0, 8)}</p></div> },
    { id: 'action_type', header: 'Action', cell: ({ row }) => <Badge variant='secondary'>{apiActionLabels[row.original.action.type] || row.original.action.type}</Badge> },
    { id: 'target', header: 'Target', cell: ({ row }) => <div className='max-w-56'><p className='truncate text-sm font-medium' title={apiActionTarget(row.original.action)}>{apiActionTarget(row.original.action)}</p><p className='text-xs text-muted-foreground'>{row.original.action.type === 'security_group_rule.create' ? `${(row.original.action.rules ?? []).length || 1} rule(s)` : 'Action target from payload'}</p></div> },
    { id: 'summary', header: 'Summary', cell: ({ row }) => <p className='max-w-[28rem] truncate text-sm' title={apiActionSummary(row.original.action)}>{apiActionSummary(row.original.action)}</p> },
    { accessorKey: 'status', header: 'Status', cell: ({ row }) => <Badge className={row.original.status === 'completed' || row.original.status === 'queued' ? 'bg-emerald-600' : row.original.status === 'failed' || row.original.status === 'rejected' || row.original.status === 'timed_out' ? 'bg-destructive' : 'bg-amber-600'}>{row.original.status.replace(/_/g, ' ')}</Badge> },
    { id: 'result', header: 'Result', cell: ({ row }) => <span className='max-w-40 truncate text-xs text-muted-foreground'>{String(row.original.result?.reason || row.original.result?.status || row.original.status)}</span> },
    { id: 'actions', enableHiding: false, cell: ({ row }) => <DropdownMenu><DropdownMenuTrigger asChild><Button aria-label='Approval history actions' size='icon' type='button' variant='ghost'><MoreVertical className='size-4' /></Button></DropdownMenuTrigger><DropdownMenuContent align='end'><DropdownMenuItem onClick={() => setSelectedApiHistory(row.original)}><Eye className='mr-2 size-4' /> View details</DropdownMenuItem><DropdownMenuItem disabled={!active?.conversationId || apiHistoryReplaying === row.original.id} onClick={() => void replayApiHistory(row.original)}><RefreshCw className='mr-2 size-4' /> Re-run with approval</DropdownMenuItem></DropdownMenuContent></DropdownMenu> },
  ], [active?.conversationId, apiHistoryReplaying, replayApiHistory])

  const testSettings = async () => {
    if (!agentHeaders) return
    setSettingsTesting(true)
    try {
      const response = await fetch(`${agentBaseUrl}/settings/codex/test`, {
        method: 'POST',
        credentials: 'include',
        headers: agentHeaders,
      })
      if (!response.ok) throw new Error('Unable to test settings')
      const next = (await response.json()) as CodexSettings
      syncCsrfToken(next.csrf_token)
      setSettings(next)
      toast[next.available ? 'success' : 'error'](
        next.available
          ? 'Codex CLI connection succeeded.'
          : next.error || 'Codex CLI is unavailable.'
      )
    } catch {
      toast.error('Codex CLI connection test failed.')
    } finally {
      setSettingsTesting(false)
    }
  }

  const cancel = async () => {
    const currentRequest = requestId
    if (currentRequest && agentHeaders) {
      try {
        const response = await fetch(
          `${agentBaseUrl}/requests/${encodeURIComponent(currentRequest)}/cancel`,
        {
          method: 'POST',
          credentials: 'include',
          headers: agentHeaders,
        })
        if (!response.ok) throw new Error('Stop request was not accepted')
      } catch {
        toast.error('Unable to stop Codex. The request is still running.')
        return
      }
    }
    controller.current?.abort()
    setIsSending(false)
    setRequestId(undefined)
    toast.success('Codex stopped.')
  }

  const send = async (options?: {
    message?: string
    agentEvent?: { action: ApiAction; result: unknown }
  }) => {
    const isAgentEvent = Boolean(options?.agentEvent)
    const message = (options?.message ?? draftRef.current).trim()
    if (!ready) {
      toast.error('Select a cloud project before sending a chat message.')
      return
    }
    if (!active || !agentHeaders) {
      toast.error('Chat is still preparing. Please try again in a moment.')
      return
    }
    if (isSending || (!message && !attachments.length && !isAgentEvent)) return
    // Capture the selection synchronously. Subsequent renders (for example a
    // CSRF refresh) cannot alter the model/reasoning of this request.
    const selectedChatModel = chatModel
    const selectedReasoningEffort = reasoningEffort
    const outgoing = isAgentEvent ? [] : attachments
    const request = id()
    // The pending-action poll must know the conversation before the streaming
    // request returns.  Previously a new conversation had no id until the
    // final SSE frame, which deadlocked approval for a Codex HTTP tool call.
    const conversationId = active.conversationId || id()
    const userText =
      message || `Attached ${outgoing.length} file(s) for analysis.`
    let optimisticUserMessageId: string | undefined
    if (!isAgentEvent) {
      optimisticUserMessageId = id()
      changeActive((item) => ({
        ...item,
        conversationId,
        title: item.messages.length ? item.title : userText.slice(0, 72),
        messages: [...item.messages, {
          id: optimisticUserMessageId!, role: 'user', text: userText,
          attachments: outgoing.map((attachment) => ({
            path: `pending:${attachment.id}`,
            name: attachment.name,
            media_type: attachment.media_type,
            size: Math.floor(attachment.content_base64.length * 3 / 4),
            data_url: `data:${attachment.media_type};base64,${attachment.content_base64}`,
          })),
        }],
        updatedAt: Date.now(),
      }))
      draftRef.current = ''
      setDraft('')
      setDraftResetKey((value) => value + 1)
      setAttachments([])
    }
    setIsSending(true)
    setRequestId(request)
    setActivity([{ id: request, label: 'Request accepted', state: 'running' }])
    codexExecutionRef.current = []
    setCodexExecution([])
    setExecutionConversationId(active.id)
    const abort = new AbortController()
    controller.current = abort

    try {
      const response = await fetch(`${agentBaseUrl}/chat/stream`, {
        method: 'POST',
        credentials: 'include',
        headers: agentHeaders,
        signal: abort.signal,
        body: JSON.stringify({
          message:
            message ||
            'Analyse the attached files in the current project context.',
          conversation_id: conversationId,
          attachments: outgoing.map((attachment) => ({
            name: attachment.name,
            media_type: attachment.media_type,
            content_base64: attachment.content_base64,
          })),
          ...(selectedChatModel ? { model: selectedChatModel } : {}),
          reasoning_effort: selectedReasoningEffort,
          skill_ids: active.skillIds,
          ...(options?.agentEvent ? { agent_event: options.agentEvent } : {}),
          request_id: request,
        }),
      })
      if (!response.ok || !response.body)
        throw new Error(`Agent request failed (${response.status})`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ''
      let completed = false
      while (true) {
        const { value, done } = await reader.read()
        buffered += decoder.decode(value, { stream: !done })
        const parsed = sseFrames(buffered)
        buffered = parsed.remainder
        for (const frame of parsed.frames) {
          const event = frame.match(/^event:\s*(.+)$/m)?.[1]
          const raw = frame.match(/^data:\s*(.+)$/m)?.[1]
          if (!event || !raw) continue
          if (event === 'codex_event') {
            const { request_id: executionRequestId, ...executionEvent } = JSON.parse(raw) as CodexExecutionEvent & { request_id: string }
            if (executionRequestId === request && executionEvent.item_id) {
              codexExecutionRef.current = updateCodexExecution(codexExecutionRef.current, executionEvent)
              setCodexExecution(codexExecutionRef.current)
            }
            continue
          }
          const data = JSON.parse(raw) as ChatResult & { message?: string }
          if (event && activityLabels[event]) {
            const detail =
              typeof data.detail === 'string' ? data.detail : undefined
            setActivity((items) => [
              ...items.map((item) =>
                item.state === 'running'
                  ? { ...item, state: 'complete' as const }
                  : item
              ),
              {
                id: `${request}-${event}`,
                label: activityLabels[event],
                detail,
                state: event === 'policy' ? 'attention' : 'running',
              },
            ])
          }
          if (event === 'session_unavailable') {
            setSessionUnavailableOpen(true)
            if (optimisticUserMessageId) {
              changeActive((item) => ({ ...item, messages: item.messages.filter((message) => message.id !== optimisticUserMessageId) }))
              draftRef.current = userText
              setDraft(userText)
            }
          }
          if (event === 'completed') {
            completed = true
            const finishedExecution = codexExecutionRef.current.filter((entry) =>
              !(entry.kind === 'message' && entry.text?.trim() === data.answer.trim())
            )
            syncCsrfToken(data.csrf_token)
            const requestedVmAction = data.vm_action
            if (requestedVmAction) {
              setVmAction(requestedVmAction)
              setVmCommand(requestedVmAction.command)
              setVmConsoleOpen(true)
              setActivity((items) => [
                ...items,
                {
                  id: `${request}-vm-action`,
                  label: 'VM console approval requested',
                  detail: requestedVmAction.summary,
                  state: 'attention',
                },
              ])
            }
            const proposedApiActions = data.api_actions?.length
              ? data.api_actions
              : data.api_action
                ? [data.api_action]
                : []
            if (proposedApiActions.length) {
              autoActionKey.current = undefined
              setApiResult(undefined)
              setApiAction(proposedApiActions[0])
              // A write action is a real tool turn: return its gateway result
              // to Codex before considering any subsequent proposal.
              setApiActionQueue([])
            }
            setActivity((items) => [
              ...items.map((item) => ({ ...item, state: 'complete' as const })),
              {
                id: `${request}-completed`,
                label: 'Answer ready',
                detail: data.model_used
                  ? `Model: ${data.model_used}`
                  : undefined,
                state: 'complete',
              },
            ])
            changeActive((item) => ({
              ...item,
              conversationId: data.conversation_id,
              messages: [
                ...item.messages.map((message, index) =>
                  index === item.messages.length - 1 && message.role === 'user'
                    ? { ...message, attachments: data.attachments ?? [] }
                    : message
                ),
                {
                  id: id(),
                  role: 'assistant',
                  text: data.answer,
                  evidence: data.evidence,
                  attachments: data.artifacts ?? [],
                  execution: finishedExecution,
                },
              ],
              updatedAt: Date.now(),
            }))
            setCodexExecution([])
          }
          if (event === 'error') {
            setActivity((items) => [
              ...items.map((item) => ({ ...item, state: 'complete' as const })),
              {
                id: `${request}-error`,
                label: 'Request failed',
                detail: data.message,
                state: 'attention',
              },
            ])
            throw new Error(data.message || 'Agent stream failed')
          }
        }
        if (done) break
      }
      if (!completed) throw new Error('Agent stream ended without a response')
    } catch (error) {
      if ((error as DOMException).name !== 'AbortError')
        toast.error(
          error instanceof Error
            ? error.message
            : 'AI analysis is unavailable. No cloud action was performed.'
        )
    } finally {
      if (controller.current === abort) controller.current = null
      setIsSending(false)
      setRequestId(undefined)
    }
  }

  useEffect(() => {
    const handleChatEnter = (event: KeyboardEvent) => {
      const target = event.target
      if (
        !(target instanceof HTMLTextAreaElement) ||
        target.placeholder !== 'Ask about the selected projectâ€¦'
      )
        return
      // Keep Ctrl+Enter as the deliberate multi-line shortcut. Plain Enter
      // behaves like the Send button and never inserts an accidental newline.
      if (event.key !== 'Enter' || event.ctrlKey || event.isComposing) return
      event.preventDefault()
      void send()
    }
    window.addEventListener('keydown', handleChatEnter)
    return () => window.removeEventListener('keydown', handleChatEnter)
  }, [send])

  useEffect(() => {
    const resize = (event: MouseEvent) => {
      if (!conversationsResize.current) return
      setConversationsWidth(Math.min(480, Math.max(224, event.clientX - 16)))
    }
    const stop = () => { conversationsResize.current = false; document.body.style.cursor = '' }
    window.addEventListener('mousemove', resize)
    window.addEventListener('mouseup', stop)
    return () => { window.removeEventListener('mousemove', resize); window.removeEventListener('mouseup', stop) }
  }, [])

  return (
    <>
      <Dialog onOpenChange={setSessionUnavailableOpen} open={sessionUnavailableOpen}>
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>Codex session cannot be resumed</DialogTitle>
            <DialogDescription>
              Codex confirmed that this saved thread no longer exists. Continuing requires a new Codex session.
            </DialogDescription>
          </DialogHeader>
          <p className='text-sm text-muted-foreground'>When you continue, a new empty conversation is created. Previous chat history remains available only for reference and is not sent to the new Codex session. Please provide any required context again.</p>
          <DialogFooter>
            <Button onClick={() => setSessionUnavailableOpen(false)} type='button' variant='outline'>Cancel</Button>
            <Button onClick={() => { setSessionUnavailableOpen(false); addConversation() }} type='button'>I understand — start new session</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={(open) => { setContextRefreshOpen(open); if (open) setWorkspaceRefreshResults([]) }} open={contextRefreshOpen}>
        <DialogContent className='grid h-[min(780px,calc(100svh-2rem))] w-[calc(100vw-2rem)] max-w-6xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:!max-w-6xl'>
          <DialogHeader className='shrink-0'>
            <DialogTitle>Refresh workspace</DialogTitle>
            <DialogDescription>
              Select the data or Excel templates written to this project workspace. Optional log sources and templates are excluded by default.
            </DialogDescription>
          </DialogHeader>
          <div className='min-h-0 overflow-auto rounded-md border'>
            <table className='w-full min-w-[920px] text-sm'>
              <thead className='sticky top-0 z-10 bg-muted/80 text-left text-xs text-muted-foreground backdrop-blur'>
                <tr className='border-b'>
                  <th className='w-12 px-3 py-2.5 text-center font-medium'><Checkbox aria-label='Select all workspace sources' checked={selectedWorkspaceSourceCount === workspaceRefreshRows.length ? true : selectedWorkspaceSourceCount > 0 ? 'indeterminate' : false} onCheckedChange={(checked) => setSnapshotSources(checked === true ? workspaceRefreshRows.map((row) => row.id) : [])} /></th>
                  <th className='px-3 py-2.5 font-medium'>Workspace content</th>
                  <th className='w-40 px-3 py-2.5 font-medium'>Group</th>
                  <th className='w-52 px-3 py-2.5 font-medium'>Destination</th>
                  <th className='min-w-72 px-3 py-2.5 font-medium'>Result</th>
                </tr>
              </thead>
              <tbody>
              {workspaceRefreshRows.map((source) => {
                const selected = snapshotSources.includes(source.id)
                const result = workspaceRefreshResults.find((item) => item.source === source.id)
                return <tr className={`border-b last:border-0 ${selected ? 'bg-primary/8' : 'hover:bg-muted/40'}`} key={source.id}>
                  <td className='px-3 py-3 text-center'><Checkbox aria-label={`Use ${source.content}`} checked={selected} id={`workspace-source-${source.id}`} onCheckedChange={(checked) => setSnapshotSources((current) => checked === true ? [...new Set([...current, source.id])] : current.filter((id) => id !== source.id))} /></td>
                  <td className='px-3 py-3'><label className='block cursor-pointer' htmlFor={`workspace-source-${source.id}`}><span className='font-medium'>{source.content}</span><span className='mt-0.5 block text-xs leading-5 text-muted-foreground'>{source.purpose}</span></label></td>
                  <td className='px-3 py-3 align-top'><span className='inline-flex rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground'>{source.group}</span></td>
                  <td className='px-3 py-3 align-top'><code className='text-xs text-muted-foreground'>{source.destination}</code></td>
                  <td className='px-3 py-3 align-top'>
                    {contextRefreshing && selected ? <span className='inline-flex items-center gap-1.5 text-xs text-muted-foreground'><Loader2 className='size-3.5 animate-spin' /> Refreshing…</span>
                      : result ? <div className='flex items-start gap-2'>
                        {result.status === 'success' ? <CheckCircle2 className='mt-0.5 size-4 shrink-0 text-emerald-600' /> : result.status === 'warning' ? <CircleHelp className='mt-0.5 size-4 shrink-0 text-amber-600' /> : <X className='mt-0.5 size-4 shrink-0 text-destructive' />}
                        <div className='min-w-0'><p className={`text-xs ${result.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{result.detail}</p>{result.files.length > 0 && <p className='mt-1 truncate text-xs text-muted-foreground' title={result.files.join(', ')}>{result.files.join(', ')}</p>}</div>
                      </div> : <span className='text-xs text-muted-foreground'>Not run</span>}
                  </td>
                </tr>
              })}
              </tbody>
            </table>
          </div>
          <DialogFooter className='shrink-0'>
            <Button disabled={contextRefreshing} onClick={() => setContextRefreshOpen(false)} type='button' variant='outline'>Cancel</Button>
            <Button disabled={contextRefreshing || !snapshotSources.length} onClick={() => void refreshProjectContext()} type='button'>
              {contextRefreshing ? <Loader2 className='mr-2 size-4 animate-spin' /> : <RefreshCw className='mr-2 size-4' />}
              Refresh selected data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={setWorkspacePathOpen} open={workspacePathOpen}>
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>Project workspace path</DialogTitle>
            <DialogDescription>The full local path for this project’s isolated Codex workspace.</DialogDescription>
          </DialogHeader>
          <code className='max-h-40 overflow-auto rounded-md border bg-muted/30 p-3 text-xs break-all'>{workspacePath}</code>
          <DialogFooter>
            <Button onClick={() => setWorkspacePathOpen(false)} type='button' variant='outline'>Close</Button>
            <Button onClick={() => { void navigator.clipboard?.writeText(workspacePath); toast.success('Workspace path copied.') }} type='button'>Copy path</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={setWorkspaceManagementOpen} open={workspaceManagementOpen}>
        <DialogContent className='grid h-[min(780px,90svh)] w-[calc(100vw-2rem)] max-w-6xl grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden sm:!max-w-6xl'>
          <DialogHeader className='shrink-0'>
            <DialogTitle>Workspace management</DialogTitle>
            <DialogDescription>Browse the workspace as a folder tree. Only text files up to 500 KB can be viewed or edited.</DialogDescription>
          </DialogHeader>
          <div className='flex items-center justify-end gap-2'>
            <Button aria-label='Refresh workspace' onClick={() => void loadWorkspaceManagement()} size='icon' title='Refresh workspace' type='button' variant='outline'><RefreshCw className='size-4' /></Button>
            <Button onClick={() => setWorkspaceCollapsedFolders(new Set())} size='sm' type='button' variant='outline'>Expand all</Button>
            <Button onClick={() => setWorkspaceCollapsedFolders(new Set(workspaceManagementItems.filter((item) => item.kind === 'folder').map((item) => item.path)))} size='sm' type='button' variant='outline'>Collapse all</Button>
          </div>
          <div className='h-full min-h-0 overflow-hidden rounded-lg border'>
            <aside className='h-full min-h-0 overflow-y-auto overscroll-contain bg-muted/20 p-2'>
              {workspaceManagementLoading ? <div className='flex items-center gap-2 p-3 text-sm text-muted-foreground'><Loader2 className='size-4 animate-spin' /> Loading workspace…</div> : workspaceManagementItems.map((item) => (
                <div className={`group flex min-h-9 items-center gap-2 rounded-md py-1 pr-1 text-sm hover:bg-accent ${managedFile?.path === item.path ? 'bg-accent' : ''} ${item.path.split('/').slice(0, -1).some((_, index, segments) => workspaceCollapsedFolders.has(segments.slice(0, index + 1).join('/'))) ? 'hidden' : ''}`} key={item.path} style={{ paddingLeft: `${8 + (item.path.split('/').length - 1) * 18}px` }}>
                  {item.kind === 'folder' ? <button className='flex min-w-0 flex-1 items-center gap-2 text-left' onClick={() => setWorkspaceCollapsedFolders((current) => { const next = new Set(current); if (next.has(item.path)) next.delete(item.path); else next.add(item.path); return next })} type='button'><ChevronDown className={`size-4 shrink-0 transition-transform ${workspaceCollapsedFolders.has(item.path) ? '-rotate-90' : ''}`} /><Folder className='size-4 shrink-0 text-primary' /><span className='truncate'>{item.name}</span></button> : <><span className='size-4 shrink-0' /><FileText className='size-4 shrink-0 text-muted-foreground' /><span className='min-w-0 flex-1 truncate'>{item.name}</span><span className='hidden shrink-0 text-xs text-muted-foreground sm:inline'>{Math.ceil(item.size / 1024)} KB</span></>}
                  <span className='hidden shrink-0 text-xs text-muted-foreground md:inline' title={new Date(item.modified_at).toLocaleString()}>{new Date(item.modified_at).toLocaleString()}</span>
                  <DropdownMenu><DropdownMenuTrigger asChild><Button aria-label={`Actions for ${item.name}`} className='size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100' size='icon' type='button' variant='ghost'><MoreVertical className='size-4' /></Button></DropdownMenuTrigger><DropdownMenuContent align='end'>{item.kind === 'folder' ? <DropdownMenuItem onClick={() => void downloadManagedWorkspacePath(item)}><Download className='mr-2 size-4' /> Download folder (.zip)</DropdownMenuItem> : <><DropdownMenuItem onClick={() => void openManagedFile(item)}><Eye className='mr-2 size-4' /> View</DropdownMenuItem><DropdownMenuItem onClick={() => void openManagedFile(item, true)}><Pencil className='mr-2 size-4' /> Edit</DropdownMenuItem><DropdownMenuItem onClick={() => { setManagedRenameItem(item); setManagedRenameName(item.name) }}><PenLine className='mr-2 size-4' /> Rename</DropdownMenuItem><DropdownMenuItem onClick={() => void downloadManagedWorkspacePath(item)}><Download className='mr-2 size-4' /> Download</DropdownMenuItem><DropdownMenuItem className='text-destructive focus:text-destructive' onClick={() => setManagedDeletePath(item.path)}><Trash2 className='mr-2 size-4' /> Delete</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu>
                </div>
              ))}
            </aside>
            <section className='hidden min-h-0 flex-col bg-background p-3'>
              {managedFileLoading ? <div className='flex items-center gap-2 text-sm text-muted-foreground'><Loader2 className='size-4 animate-spin' /> Loading file…</div> : managedFile ? <>
                <div className='mb-2 flex items-center justify-between gap-2'><code className='truncate text-xs text-muted-foreground'>{managedFile.path}</code><Button onClick={() => setManagedDeletePath(managedFile.path)} size='sm' type='button' variant='outline'><Trash2 className='mr-2 size-4' /> Delete</Button></div>
                <Textarea className='min-h-0 flex-1 resize-none font-mono text-xs leading-5' onChange={(event) => setManagedFile({ ...managedFile, content: event.target.value })} value={managedFile.content} />
              </> : <div className='grid flex-1 place-items-center text-sm text-muted-foreground'>Select a text file to preview or edit.</div>}
            </section>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={(open) => { if (!open && !managedRenameSaving) { setManagedRenameItem(undefined); setManagedRenameName('') } }} open={Boolean(managedRenameItem)}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader><DialogTitle>Rename workspace file</DialogTitle><DialogDescription>Enter a new name for {managedRenameItem?.name}.</DialogDescription></DialogHeader>
          <div className='grid gap-2'><Label htmlFor='workspace-file-name'>File name</Label><Input autoFocus id='workspace-file-name' onChange={(event) => setManagedRenameName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void renameManagedWorkspaceFile() } }} value={managedRenameName} /></div>
          <DialogFooter><Button disabled={managedRenameSaving} onClick={() => { setManagedRenameItem(undefined); setManagedRenameName('') }} type='button' variant='outline'>Cancel</Button><Button disabled={!managedRenameName.trim() || managedRenameSaving} onClick={() => void renameManagedWorkspaceFile()} type='button'>{managedRenameSaving && <Loader2 className='mr-2 size-4 animate-spin' />}Rename</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={setWorkspaceFilePreviewOpen} open={workspaceFilePreviewOpen}>
        <DialogContent className='grid h-[min(760px,88svh)] w-[calc(100vw-2rem)] max-w-4xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:!max-w-4xl'>
          <DialogHeader className='shrink-0'>
            <DialogTitle>{workspaceFileEdit ? 'Edit workspace file' : 'View workspace file'}</DialogTitle>
            <DialogDescription className='truncate font-mono text-xs'>{managedFile?.path ?? 'Workspace file'}</DialogDescription>
          </DialogHeader>
          {managedFileLoading ? <div className='flex items-center gap-2 text-sm text-muted-foreground'><Loader2 className='size-4 animate-spin' /> Loading file...</div> : managedFile?.kind === 'image' && managedFile.data_url ? <div className='grid min-h-0 place-items-center overflow-auto rounded-lg border bg-muted/20 p-4'><img alt={managedFile.path} className='max-h-full max-w-full rounded-md object-contain shadow-sm' src={managedFile.data_url} /></div> : managedFile ? <Textarea className='min-h-0 resize-none font-mono text-xs leading-5' disabled={!workspaceFileEdit} onChange={(event) => setManagedFile({ ...managedFile, content: event.target.value })} value={managedFile.content} /> : <div className='grid place-items-center text-sm text-muted-foreground'>No supported file selected.</div>}
          <DialogFooter className='shrink-0'><Button onClick={() => setWorkspaceFilePreviewOpen(false)} type='button' variant='outline'>Close</Button>{workspaceFileEdit && <Button disabled={!managedFile || managedFileSaving} onClick={() => { if (!managedFile || !agentHeaders) return; setManagedFileSaving(true); void fetch(`${agentBaseUrl}/project-context/manage/file`, { method: 'PUT', credentials: 'include', headers: agentHeaders, body: JSON.stringify(managedFile) }).then((response) => { if (!response.ok) throw new Error(); toast.success('Workspace file saved.'); setWorkspaceFilePreviewOpen(false); void loadWorkspaceManagement() }).catch(() => toast.error('Unable to save workspace file.')).finally(() => setManagedFileSaving(false)) }} type='button'>{managedFileSaving ? <Loader2 className='mr-2 size-4 animate-spin' /> : <Save className='mr-2 size-4' />}Save changes</Button>}</DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog cancelBtnText='Cancel' confirmText='Delete' desc={`Delete ${managedDeletePath ?? 'this workspace path'}? Folders must be empty.`} destructive handleConfirm={() => { if (!managedDeletePath || !agentHeaders) return; void fetch(`${agentBaseUrl}/project-context/manage/path?path=${encodeURIComponent(managedDeletePath)}`, { method: 'DELETE', credentials: 'include', headers: agentHeaders }).then((response) => { if (!response.ok) throw new Error(); setManagedFile(undefined); setManagedDeletePath(undefined); void loadWorkspaceManagement(); toast.success('Workspace path deleted.') }).catch(() => toast.error('Unable to delete this path.')) }} onOpenChange={(open) => { if (!open) setManagedDeletePath(undefined) }} open={Boolean(managedDeletePath)} title='Delete workspace path?' />
      <Dialog onOpenChange={setCodexHistoryOpen} open={codexHistoryOpen}>
        <DialogContent className='flex h-[min(760px,88vh)] max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl'>
          <DialogHeader className='shrink-0 border-b px-6 py-4 text-left'>
            <DialogTitle>Codex chat history</DialogTitle>
            <DialogDescription>Loaded directly from Codex for this project workspace. Agent Service chat storage is not used.</DialogDescription>
          </DialogHeader>
          <div className='grid min-h-0 flex-1 grid-cols-[minmax(210px,0.38fr)_minmax(0,1fr)]'>
            <aside className='min-h-0 overflow-y-auto border-r bg-muted/20 p-2'>
              {codexHistoryLoading ? (
                <div className='flex items-center justify-center gap-2 p-5 text-sm text-muted-foreground'><Loader2 className='size-4 animate-spin' /> Loading Codex chats…</div>
              ) : codexHistoryThreads.length ? codexHistoryThreads.map((thread) => (
                <button
                  className={`mb-1 w-full rounded-lg px-3 py-2.5 text-left transition-colors ${selectedCodexThread?.id === thread.id ? 'bg-primary text-primary-foreground shadow-sm' : 'hover:bg-muted'}`}
                  key={thread.id}
                  onClick={() => void loadCodexHistoryThread(thread.id)}
                  type='button'
                >
                  <p className='truncate text-sm font-medium'>{thread.title}</p>
                  <p className={`mt-1 text-xs ${selectedCodexThread?.id === thread.id ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}>{formatCodexHistoryTime(thread.updated_at ?? thread.created_at)}</p>
                </button>
              )) : <p className='p-4 text-center text-sm text-muted-foreground'>No Codex chats were found for this workspace.</p>}
            </aside>
            <section className='min-h-0 bg-muted/10'>
              {codexThreadLoading ? (
                <div className='flex h-full items-center justify-center gap-2 text-sm text-muted-foreground'><Loader2 className='size-4 animate-spin' /> Loading conversation…</div>
              ) : selectedCodexThread ? (
                <div className='flex h-full min-h-0 flex-col'>
                  <div className='shrink-0 border-b bg-background px-5 py-3'>
                    <p className='truncate text-sm font-semibold'>{selectedCodexThread.title}</p>
                    <p className='mt-0.5 text-xs text-muted-foreground'>{formatCodexHistoryTime(selectedCodexThread.updated_at ?? selectedCodexThread.created_at)} · {selectedCodexThread.messages.length} messages</p>
                  </div>
                  <ChatTranscript agentBaseUrl={agentBaseUrl} headers={agentHeaders} isAdmin={false} isSending={false} messages={selectedCodexThread.messages} onReviewCommand={() => undefined} />
                </div>
              ) : <div className='flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground'>Select a Codex chat to view its complete transcript.</div>}
            </section>
          </div>
          <DialogFooter className='shrink-0 border-t px-6 py-3'><Button onClick={() => setCodexHistoryOpen(false)} type='button' variant='outline'>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Header fixed>
        <h1 className='truncate text-base font-semibold'>AI assistant</h1>
        <div className='ms-auto flex items-center gap-2'>
          {isAdmin ? <>
          <div data-slot='page-actions' className='flex min-w-0 items-center gap-1.5 [&>button]:h-8 [&>button]:gap-1.5 [&>button]:px-2.5 [&>button]:text-xs [&>button_svg]:size-3.5'>
            <Button
              disabled={!ready}
              onClick={() => setVmConsoleOpen(true)}
              size='sm'
              variant='outline'
            >
              <MonitorCog className='mr-2 size-4' /> VM console
            </Button>
            <Button
              onClick={() => setTerminalOpen(true)}
              size='sm'
              variant='outline'
            >
              <Terminal className='mr-2 size-4' /> Terminal
            </Button>
            <Button onClick={() => void openLogs()} size='sm' variant='outline'>
              <LogsIcon className='mr-2 size-4' /> Logs
            </Button>
            <Button onClick={openSettings} size='sm' variant='outline'>
              <Settings2 className='mr-2 size-4' /> Settings
            </Button>
          </div>
          <div aria-hidden='true' className='mx-0.5 h-5 w-px shrink-0 bg-border' />
          </> : null}
          <Dialog>
            <DialogTrigger asChild>
              <Button
                aria-label='AI agent help'
                className='rounded-full'
                size='icon'
                variant='ghost'
              >
                <CircleHelp className='size-[1.2rem]' />
              </Button>
            </DialogTrigger>
            <DialogContent className='sm:!max-w-xl'>
              <DialogHeader>
                <DialogTitle>AI agent help</DialogTitle>
                <DialogDescription>
                  Read-only analysis for the selected cloud project.
                </DialogDescription>
              </DialogHeader>
              <div className='space-y-3 text-sm text-muted-foreground'>
                <p>
                  Ask about server state, IP/subnet mapping, security groups,
                  inventory, or Cloud API history.
                </p>
                <p>
                  Files of any format up to 5 MB are stored only in the
                  current project workspace and sent only for the current agent request.
                </p>
                <p>
                  For a named VM console diagnostic, Codex proposes a command
                  and opens the VNC review dialog. The browser performs password
                  reset and root login only after approval, unless the
                  administrator enables the explicit local bypass option.
                </p>
              </div>
            </DialogContent>
          </Dialog>
          <ReleasePageCacheButton />
          <ThemeSwitch />
          <DisplaySettings />
          <ProfileDropdown />
        </div>
      </Header>
      <Main fixed className='p-4 lg:p-6'>
        {!ready ? (
          <div className='grid flex-1 place-items-center rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground'>
            Select a cloud project first. The agent only reads resources from
            the selected project.
          </div>
        ) : (
          <section className='flex min-h-0 flex-1 overflow-hidden rounded-lg border bg-card shadow-xs'>
            {!conversationsCollapsed ? <>
            <aside
              className='hidden shrink-0 flex-col border-r bg-muted/20 md:flex'
              style={{ width: conversationsWidth }}
            >
              <div className='p-4'>
                <div className='flex items-center gap-2'>
                  <Bot className='size-5 shrink-0' />
                  <span className='font-semibold'>Conversations</span>
                  <Button
                    className='ml-auto'
                    onClick={() => setConversationsCollapsed((value) => !value)}
                    size='icon'
                    title='Collapse conversations'
                    variant='ghost'
                  >
                    <ChevronLeft className='size-4' />
                  </Button>
                  <Button onClick={addConversation} size='icon' title='New conversation' variant='ghost'><Plus className='size-4' /></Button>
                </div>
                <label className='mt-4 flex h-9 items-center gap-2 rounded-md border bg-background px-2 focus-within:ring-1 focus-within:ring-ring'>
                  <Search className='size-4 text-muted-foreground' />
                  <input
                    className='min-w-0 flex-1 bg-transparent text-sm outline-none'
                    onChange={(event) =>
                      setConversationSearch(event.target.value)
                    }
                    placeholder='Search conversations'
                    value={conversationSearch}
                  />
                </label>
              </div>
              <Separator />
              <div className='min-h-0 flex-1 overflow-y-auto p-2' onScroll={(event) => {
                const element = event.currentTarget
                if (element.scrollTop + element.clientHeight >= element.scrollHeight - 48) void loadConversations()
              }}>
                {visibleConversations.map((item) => (
                  <div
                    className={`group mb-1 flex w-full items-center gap-1 rounded-md px-2 py-2 text-left text-sm hover:bg-accent ${item.id === active?.id ? 'bg-muted' : ''}`}
                    key={item.id}
                  >
                    <div
                      className='min-w-0 flex-1 cursor-pointer'
                          onClick={() => void openConversation(item)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ')
                          void openConversation(item)
                      }}
                      role='button'
                      tabIndex={0}
                    >
                      {editingConversationId === item.id ? (
                        <Input
                          autoFocus
                          className='h-7 text-sm'
                          onBlur={() => void renameConversation(item)}
                          onChange={(event) =>
                            setEditingTitle(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter')
                              void renameConversation(item)
                            if (event.key === 'Escape')
                              setEditingConversationId(undefined)
                          }}
                          value={editingTitle}
                        />
                      ) : (
                        <>
                          <span className='block truncate font-medium'>
                            {item.title}
                          </span>
                          <span className='block truncate text-xs text-muted-foreground'>
                            {item.messages[item.messages.length - 1]?.text ||
                              'No messages yet'}
                          </span>
                        </>
                      )}
                    </div>
                    <div className='flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100'>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button aria-label={`Actions for ${item.title}`} size='icon' title='Conversation actions' type='button' variant='ghost'>
                            <MoreVertical className='size-4' />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end'>
                          <DropdownMenuItem onClick={() => { setEditingConversationId(item.id); setEditingTitle(item.title) }}>
                            <Pencil className='mr-2 size-4' /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem className='text-destructive focus:text-destructive' onClick={() => deleteConversation(item)}>
                            <Trash2 className='mr-2 size-4' /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))}
                {conversationsLoading ? <div className='p-2 text-center text-xs text-muted-foreground'>Loading conversations…</div> : null}
              </div>
            </aside>
            <div aria-label='Resize conversations panel' className='group hidden w-2 shrink-0 cursor-col-resize items-center justify-center hover:bg-muted md:flex' onMouseDown={(event) => { event.preventDefault(); conversationsResize.current = true; document.body.style.cursor = 'col-resize' }}><GripVertical className='size-4 text-muted-foreground opacity-0 group-hover:opacity-100' /></div>
            </> : null}
            <div className='flex min-w-0 flex-1 flex-col'>
              <div className='flex flex-wrap items-center gap-3 border-b p-4'>
                {conversationsCollapsed ? <Button aria-label='Expand conversations' onClick={() => setConversationsCollapsed(false)} size='icon' title='Expand conversations' type='button' variant='ghost'><ChevronRight className='size-4' /></Button> : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button aria-label='Chat actions' className='order-last shrink-0' size='icon' title='Chat actions' type='button' variant='ghost'>
                      <MoreVertical className='size-4' />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align='end' className='w-56'>
                    <DropdownMenuItem disabled={contextRefreshing || isSending} onClick={() => setContextRefreshOpen(true)}>
                      {contextRefreshing ? <Loader2 className='mr-2 size-4 animate-spin' /> : <RefreshCw className='mr-2 size-4' />}
                      Refresh workspace
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!ready || isSending} onClick={() => void openCodexHistory()}>
                      <FileText className='mr-2 size-4' />
                      Codex chat history
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!ready} onClick={() => { setApiHistoryOpen(true); void loadApiHistory() }}>
                      <Clock3 className='mr-2 size-4' />
                      API approval history
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!ready} onClick={() => { setWorkspaceManagementOpen(true); void loadWorkspaceManagement() }}>
                      <Folder className='mr-2 size-4' />
                      Workspace management
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!ready} onClick={() => void getWorkspacePath()}>
                      <FileText className='mr-2 size-4' />
                      Get workspace path
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Bot className='size-5' />
                <div>
                  <p className='text-sm font-semibold'>CloudTool agent</p>
                  <p className='text-xs text-muted-foreground'>
                    {project?.display_name || project?.name}
                  </p>
                </div>
                {activeEvidence.length ? (
                  <div className='order-3 flex w-full flex-wrap gap-1.5 lg:order-none lg:w-auto'>
                    {activeEvidence.map((entry) => (
                      <Badge key={entry.source} variant='secondary'>
                        {entry.source.replace(/_/g, ' ')} · {entry.count}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <select
                  aria-label='Codex model'
                  className='legacy-agent-file-input hidden'
                  onChange={(event) => {
                    const selected = runtime?.models.find(
                      (item) => item.id === event.target.value
                    )
                    setChatModel(event.target.value)
                    if (
                      selected &&
                      !selected.reasoning_efforts.includes(reasoningEffort)
                    )
                      setReasoningEffort(selected.default_reasoning_effort)
                  }}
                  value={chatModel}
                >
                  <option value=''>CLI default model</option>
                  {runtime?.models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.display_name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label='Reasoning effort'
                  className='hidden'
                  onChange={(event) =>
                    setReasoningEffort(
                      event.target.value as typeof reasoningEffort
                    )
                  }
                  value={reasoningEffort}
                >
                  {(
                    runtime?.models.find((item) => item.id === chatModel)
                      ?.reasoning_efforts ?? [
                      'low',
                      'medium',
                      'high',
                      'xhigh',
                      'max',
                    ]
                  ).map((effort) => (
                    <option key={effort} value={effort}>
                      Reasoning: {effort}
                    </option>
                  ))}
                </select>
                <div className='order-[9998] ml-auto'>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      aria-label='View agent activity'
                      className='relative'
                      size='icon'
                      title='Agent activity'
                      variant='ghost'
                    >
                      <Activity className='size-4' />
                      {isSending ? (
                        <span className='absolute top-1 right-1 size-1.5 animate-pulse rounded-full bg-primary' />
                      ) : null}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align='end' className='w-96'>
                    <p className='mb-3 flex items-center gap-2 text-sm font-medium'>
                      <Activity className='size-4' /> Agent activity
                    </p>
                    {activity.length ? (
                      <div className='flex max-h-72 flex-col gap-2 overflow-auto'>
                        {activity.map((item) => (
                          <div
                            className='flex items-start gap-2 text-xs text-muted-foreground'
                            key={item.id}
                          >
                            {item.state === 'running' ? (
                              <Clock3 className='mt-0.5 size-3.5 shrink-0 animate-pulse text-primary' />
                            ) : item.state === 'attention' ? (
                              <ShieldCheck className='mt-0.5 size-3.5 shrink-0 text-amber-600' />
                            ) : (
                              <CheckCircle2 className='mt-0.5 size-3.5 shrink-0 text-emerald-600' />
                            )}
                            <div>
                              <span className='font-medium text-foreground'>
                                {item.label}
                              </span>
                              {item.detail ? (
                                <p className='mt-0.5'>{item.detail}</p>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className='text-xs text-muted-foreground'>
                        Activity for the next request will appear here.
                      </p>
                    )}
                  </PopoverContent>
                </Popover>
                </div>
              </div>
              {false ? <>
              <div className='hidden min-h-0 flex-1 overflow-y-auto bg-muted/10 p-4 sm:p-6'>
                <div className='flex w-full max-w-none flex-col gap-4'>
                  {active?.messages.map((item) => (
                    <div
                      className={
                        item.role === 'user'
                          ? 'max-w-[80%] self-end rounded-2xl rounded-br-none bg-primary px-3 py-2 text-sm text-primary-foreground'
                          : 'max-w-[96%] self-start rounded-2xl rounded-bl-none bg-background px-4 py-3 text-sm shadow-sm ring-1 ring-border'
                      }
                      key={item.id}
                    >
                      {item.role === 'assistant' ? (
                        <>
                          <MarkdownAnswer text={item.text} />
                          {isAdmin && commandFromMarkdown(item.text) ? (
                            <Button
                              className='mt-3'
                              onClick={() => {
                                setVmCommand(
                                  commandFromMarkdown(item.text) ?? ''
                                )
                                setVmConsoleOpen(true)
                              }}
                              size='sm'
                              type='button'
                              variant='outline'
                            >
                              <MonitorCog className='mr-2 size-4' />
                              Review and run in VM console
                            </Button>
                          ) : null}
                        </>
                      ) : (
                        <div className='leading-6 whitespace-pre-wrap'>
                          {item.text}
                        </div>
                      )}
                    </div>
                  ))}
                  {isSending ? (
                    <div className='flex items-center gap-2 self-start rounded-2xl bg-background px-3 py-2 text-sm text-muted-foreground ring-1 ring-border'>
                      <Loader2 className='size-4 animate-spin' /> Analysing
                      project evidence…
                    </div>
                  ) : null}
                  <div ref={endRef} />
                </div>
              </div>
              <form
                className='border-t p-3'
                onSubmit={(event) => {
                  event.preventDefault()
                  void send()
                }}
              >
                <input
                  accept='*/*'
                  className='hidden'
                  multiple
                  onChange={(event) => {
                    void chooseFiles(event.target.files)
                    event.currentTarget.value = ''
                  }}
                  ref={fileInput}
                  type='file'
                />
                <div className='flex gap-2'>
                  <Button
                    disabled={isSending || attachments.length >= 5}
                    onClick={() => fileInput.current?.click()}
                    size='icon'
                    type='button'
                    variant='outline'
                  >
                    <Paperclip className='size-4' />
                  </Button>
                  <Textarea
                    className='min-h-11 flex-1'
                    disabled={isSending}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder='Ask about the selected project…'
                    value={draft}
                  />
                  {isSending ? (
                    <Button
                      onClick={() => void cancel()}
                      size='icon'
                      title='Stop analysis'
                      type='button'
                      variant='destructive'
                    >
                      <CircleStop className='size-4' />
                    </Button>
                  ) : (
                    <Button
                      disabled={!draft.trim() && !attachments.length}
                      size='icon'
                      type='submit'
                    >
                      <Send className='size-4' />
                    </Button>
                  )}
                </div>
              </form>
              <style>
                {
                  "form:has(input.legacy-agent-file-input) { display: none; } form:has(input.legacy-agent-file-input) ~ div.flex.flex-wrap.gap-2.border-t { display: none; } .flex.flex-wrap.items-center.gap-3.border-b.p-4 > select[aria-label='Codex model'], .flex.flex-wrap.items-center.gap-3.border-b.p-4 > select[aria-label='Reasoning effort'] { display: none; }"
                }
              </style>
              </> : null}
              <ChatTranscript
                execution={executionConversationId === active?.id ? codexExecution : []}
                agentBaseUrl={agentBaseUrl}
                headers={agentHeaders}
                isAdmin={isAdmin}
                isSending={isSending}
                messages={active?.messages ?? []}
                onReviewCommand={reviewTranscriptCommand}
              />
              <AgentUserQuestions key={`${projectId}:${active?.conversationId ?? ''}`}
                agentBaseUrl={agentBaseUrl} headers={agentHeaders}
                conversationId={active?.conversationId} sending={isSending} />
              <AgentComposer
                agentBaseUrl={agentBaseUrl}
                attachments={attachments}
                disabled={isSending}
                headers={agentHeaders}
                model={chatModel}
                models={runtime?.models ?? []}
              onChange={(value) => { draftRef.current = value; setDraft(value) }}
              resetKey={draftResetKey}
                onFiles={(files) => void chooseFiles(files)}
                onModelChange={(model) => {
                  const selected = runtime?.models.find(
                    (item) => item.id === model
                  )
                  setChatModel(model)
                  if (
                    selected &&
                    !selected.reasoning_efforts.includes(reasoningEffort)
                  )
                    setReasoningEffort(selected.default_reasoning_effort)
                }}
                onPermissionChange={setPermissionMode}
                onSelectedSkillIdsChange={(skillIds) => changeActive((item) => ({ ...item, skillIds }))}
                onReasoningChange={(effort) =>
                  setReasoningEffort(effort as typeof reasoningEffort)
                }
                onRemove={(attachmentId) =>
                  setAttachments((items) =>
                    items.filter((item) => item.id !== attachmentId)
                  )
                }
                onSend={() => void send()}
                onStop={() => void cancel()}
                permission={permissionMode}
                reasoning={reasoningEffort}
                sending={isSending}
                selectedSkillIds={active?.skillIds ?? []}
                value={draft}
              />
              {attachments.length ? (
                <div className='flex flex-wrap gap-2 border-t px-4 py-2'>
                  {attachments.map((item) => (
                    <Badge
                      className='gap-1.5 py-1'
                      key={item.id}
                      variant='secondary'
                    >
                      {item.media_type.startsWith('image/') ? (
                        <ImageIcon className='size-3.5' />
                      ) : (
                        <FileText className='size-3.5' />
                      )}
                      <span className='max-w-44 truncate'>{item.name}</span>
                      <button
                        aria-label={`Remove ${item.name}`}
                        onClick={() =>
                          setAttachments((items) =>
                            items.filter(
                              (attachment) => attachment.id !== item.id
                            )
                          )
                        }
                        type='button'
                      >
                        <X className='size-3.5' />
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        )}
      </Main>
      <ConfirmDialog
        cancelBtnText='Cancel'
        confirmText='Delete conversation'
        desc={`Delete “${conversationPendingDelete?.title ?? 'this conversation'}”? This cannot be undone.`}
        destructive
        handleConfirm={() => void confirmDeleteConversation()}
        isLoading={deletingConversation}
        onOpenChange={(open) => { if (!open && !deletingConversation) setConversationPendingDelete(undefined) }}
        open={Boolean(conversationPendingDelete)}
        title='Delete conversation?'
      />
      <Dialog
        onOpenChange={(open) => {
          if (!open && apiAction && !apiExecuting) setApiCloseConfirmOpen(true)
        }}
        open={Boolean(apiAction)}
      >
        <DialogContent
          className='flex h-[min(820px,92svh)] w-[calc(100vw-2rem)] max-w-6xl flex-col gap-3 overflow-hidden p-4 sm:!max-w-6xl sm:p-6'
          onEscapeKeyDown={(event) => { event.preventDefault(); if (!apiExecuting) setApiCloseConfirmOpen(true) }}
          onPointerDownOutside={(event) => { event.preventDefault(); if (!apiExecuting) setApiCloseConfirmOpen(true) }}
        >
          <DialogHeader className='shrink-0 pr-6'>
            <DialogTitle>
              {permissionMode === 'bypass'
                ? 'AI agent API activity'
                : 'Confirm CloudTool API action'}
            </DialogTitle>
            <DialogDescription>
              {permissionMode === 'bypass'
                ? 'Bypass confirmation is active for this conversation. The action is shown here and runs automatically.'
                : 'Codex proposes a write action. Nothing is sent to CloudTool until you confirm.'}
            </DialogDescription>
          </DialogHeader>
          {apiAction ? (
            <div className='flex min-h-0 min-w-0 flex-1 flex-col gap-3 text-sm'>
              {apiCountdownSeconds !== undefined ? <div className='flex items-center justify-between rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200'><span className='flex items-center gap-2'><Clock3 className='size-4' /> Approval request expires automatically</span><strong>{Math.floor(apiCountdownSeconds / 60)}:{String(apiCountdownSeconds % 60).padStart(2, '0')} remaining</strong></div> : null}
              <p className='line-clamp-2 shrink-0 break-words' title={apiAction.summary}>{apiAction.summary}</p>
              <div className='grid shrink-0 grid-cols-2 gap-3 rounded-md border bg-muted/30 p-3'>
                <div className='min-w-0'>
                  <p className='text-xs font-medium text-muted-foreground'>Project</p>
                  <p className='mt-1 truncate text-xs font-medium' title={project?.name}>{project?.name || 'Current project'}</p>
                  <p className='mt-0.5 truncate font-mono text-xs text-muted-foreground' title={apiAction.project_id || projectId}>
                    {apiAction.project_id || projectId || 'Unknown project'}
                  </p>
                </div>
                <div className='min-w-0'>
                  <p className='text-xs font-medium text-muted-foreground'>
                    {apiActionLabels[apiAction.type]}
                  </p>
                  <p className='mt-1 truncate text-xs font-medium' title={apiActionTarget(apiAction)}>
                    {apiAction.type === 'vm_deployment.create'
                      ? String(apiAction.deployment?.name || 'Server deployment')
                      : apiAction.type === 'security_group_rule.create' ? securityGroupName || 'Loading Security Group name...' : apiActionTarget(apiAction)}
                  </p>
                  {apiAction.type === 'security_group_rule.create' ? <p className='mt-0.5 truncate font-mono text-xs text-muted-foreground' title={apiAction.security_group_id}>{apiAction.security_group_id}</p> : null}
                </div>
              </div>
              <div className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border p-2'>
                <div className='mb-2 flex shrink-0 items-center justify-between text-xs text-muted-foreground'>
                  <span>API request preview</span><span>{apiPreviewRowsData.length} row(s)</span>
                </div>
                <CloudDataTable columns={apiPreviewColumns} data={apiPreviewRowsData} enableSelection={false} entityName='API request row' exportFileName='pending-api-action-preview' fillHeight getRowId={(row) => row.id} initialPageSize={20} searchPlaceholder='Search API request payload...' />
              </div>
              {apiResult ? (
                <p className='line-clamp-2 shrink-0 rounded-md bg-emerald-500/10 p-2 text-xs text-emerald-700' title={apiResult}>
                  {apiResult}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter className='shrink-0'>
            {permissionMode === 'bypass' ? (
              <Button
                disabled={apiExecuting}
                  onClick={() => {
                    setApiAction(undefined)
                    setApiActionQueue([])
                    setApiResult(undefined)
                }}
                type='button'
              >
                {apiExecuting ? (
                  <Loader2 className='mr-2 size-4 animate-spin' />
                ) : null}
                {apiResult ? 'Close' : 'Running…'}
              </Button>
            ) : (
              <>
                <Button
                  disabled={apiExecuting}
                  onClick={() => void rejectApiAction()}
                  type='button'
                  variant='outline'
                >
                  Cancel
                </Button>
                <Button
                  disabled={apiExecuting}
                  onClick={() => void executeApiAction()}
                  type='button'
                >
                  {apiExecuting ? (
                    <Loader2 className='mr-2 size-4 animate-spin' />
                  ) : null}
                  {apiAction?.type.endsWith('.attach') ? 'Confirm and attach IP' : `Confirm and create ${apiAction?.type === 'security_group_rule.create' && apiPreviewRowsData.length > 1 ? `${apiPreviewRowsData.length} rules` : 'action'}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        cancelBtnText='Keep reviewing'
        confirmText='Reject action'
        desc='Closing this modal rejects the pending CloudTool action. Codex will immediately receive a rejected result.'
        destructive
        handleConfirm={() => void rejectApiAction()}
        isLoading={apiExecuting}
        onOpenChange={setApiCloseConfirmOpen}
        open={apiCloseConfirmOpen}
        title='Reject pending CloudTool action?'
      />
      <Dialog onOpenChange={setApiHistoryOpen} open={apiHistoryOpen}>
        <DialogContent className='grid h-[min(820px,90svh)] w-[calc(100vw-2rem)] max-w-[96rem] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:!max-w-[96rem]'>
          <DialogHeader>
            <DialogTitle>CloudTool API approval history</DialogTitle>
            <DialogDescription>Stored approval decisions and results for this project. Re-run creates a fresh approval request; it never executes immediately.</DialogDescription>
          </DialogHeader>
          <div className='min-h-0'><CloudDataTable columns={apiHistoryColumns} data={apiHistory} emptyText='No CloudTool API approvals have been recorded for this project.' entityName='API approval' exportFileName='cloudtool-api-approval-history' fillHeight getRowId={(row) => row.id} initialPageSize={25} loading={apiHistoryLoading} pageSizeOptions={[25, 50, 100]} searchPlaceholder='Search approval history...' /></div>
          <DialogFooter><Button onClick={() => void loadApiHistory()} type='button' variant='outline'><RefreshCw className='mr-2 size-4' /> Refresh</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={(open) => { if (!open) setSelectedApiHistory(undefined) }} open={Boolean(selectedApiHistory)}>
        <DialogContent className='grid h-[min(760px,90svh)] w-[calc(100vw-2rem)] max-w-4xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:!max-w-4xl'>
          <DialogHeader>
            <DialogTitle>API approval details</DialogTitle>
            <DialogDescription>{selectedApiHistory?.action.summary}</DialogDescription>
          </DialogHeader>
          {selectedApiHistory ? <div className='min-h-0 space-y-4 overflow-y-auto'><div className='grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-2'><div><p className='text-xs text-muted-foreground'>Status</p><p className='mt-1 font-medium'>{selectedApiHistory.status.replace(/_/g, ' ')}</p></div><div><p className='text-xs text-muted-foreground'>Updated</p><p className='mt-1'>{new Date(selectedApiHistory.updated_at).toLocaleString()}</p></div><div><p className='text-xs text-muted-foreground'>Conversation</p><code className='mt-1 block break-all text-xs'>{selectedApiHistory.conversation_id}</code></div><div><p className='text-xs text-muted-foreground'>Expires at</p><p className='mt-1'>{selectedApiHistory.expires_at ? new Date(selectedApiHistory.expires_at).toLocaleString() : '—'}</p></div></div><div><p className='mb-2 text-sm font-medium'>Request payload</p><pre className='max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs'>{JSON.stringify(selectedApiHistory.action, null, 2)}</pre></div><div><p className='mb-2 text-sm font-medium'>Result</p><pre className='max-h-48 overflow-auto rounded-lg bg-muted p-3 text-xs'>{JSON.stringify(selectedApiHistory.result, null, 2)}</pre></div><div><p className='mb-2 text-sm font-medium'>Approval timeline</p><div className='space-y-2'>{(selectedApiHistory.audit || []).map((event, index) => <div className='flex items-center justify-between rounded-md border px-3 py-2 text-xs' key={`${event.at}-${index}`}><span className='font-medium'>{event.status.replace(/_/g, ' ')}</span><span className='text-muted-foreground'>{new Date(event.at).toLocaleString()}</span></div>)}</div></div></div> : null}
          <DialogFooter><Button onClick={() => setSelectedApiHistory(undefined)} type='button' variant='outline'>Close</Button>{selectedApiHistory ? <Button disabled={!active?.conversationId || apiHistoryReplaying === selectedApiHistory.id} onClick={() => void replayApiHistory(selectedApiHistory)} type='button'>{apiHistoryReplaying === selectedApiHistory.id ? <Loader2 className='mr-2 size-4 animate-spin' /> : <RefreshCw className='mr-2 size-4' />}Re-run with approval</Button> : null}</DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={setLogsOpen} open={logsOpen}>
        <DialogContent className='grid h-[90svh] w-[calc(100vw-2rem)] max-w-[96rem] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:!max-w-[96rem]'>
          <DialogHeader>
            <div className='flex flex-wrap items-center justify-between gap-3 pr-6'>
              <DialogTitle>AI agent execution logs</DialogTitle>
            </div>
            <DialogDescription>
              Redacted diagnostic history for this project. Only the current page is loaded; open a row to load its full prompt, context and lifecycle details.
            </DialogDescription>
            <div className='flex flex-wrap items-center gap-2 pt-1'>
              <select aria-label='Delete logs older than' className='h-9 rounded-md border bg-background px-2 text-sm' onChange={(event) => setLogsPurgeDays(event.target.value)} value={logsPurgeDays}>
                <option value='all'>All logs</option>
                <option value='1'>Older than 1 day</option>
                <option value='3'>Older than 3 days</option>
                <option value='7'>Older than 7 days</option>
                <option value='30'>Older than 30 days</option>
                <option value='90'>Older than 90 days</option>
                <option value='180'>Older than 180 days</option>
              </select>
              <Button disabled={!logsTotal} onClick={() => setLogsPurgeOpen(true)} size='sm' type='button' variant='destructive'><Trash2 className='mr-2 size-4' /> Delete logs</Button>
            </div>
          </DialogHeader>
          <div className='min-h-0'>
            <CloudDataTable columns={executionLogColumns} data={executionLogs} emptyText='No execution logs have been recorded for this project yet.' entityName='execution log' exportFileName='ai-agent-execution-logs' fillHeight getRowId={(row) => row.id} initialPageSize={50} loading={logsLoading} pageSizeOptions={[25, 50, 100]} searchPlaceholder='Search the loaded log page...' serverPagination={{ pagination: logsPagination, totalRows: logsTotal, onChange: (next) => { setLogsPagination(next); void loadLogs(next) } }} />
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog cancelBtnText='Cancel' confirmText='Delete logs' desc={logsPurgeDays === 'all' ? 'Delete all execution logs for this project. This cannot be undone.' : `Delete execution logs older than ${logsPurgeDays} day(s) for this project. This cannot be undone.`} destructive handleConfirm={() => void purgeLogs()} isLoading={logsPurging} onOpenChange={setLogsPurgeOpen} open={logsPurgeOpen} title={logsPurgeDays === 'all' ? 'Delete all execution logs?' : 'Delete old execution logs?'} />
      <CodexTerminalDialog
        agentBaseUrl={agentBaseUrl}
        headers={agentHeaders}
        onOpenChange={setTerminalOpen}
        open={terminalOpen}
      />
      <VmConsoleExecutionDialog
        action={vmAction}
        agentBaseUrl={agentBaseUrl}
        agentHeaders={agentHeaders}
        conversationId={active?.conversationId}
        initialCommand={vmCommand}
        onChatExchange={({ userText, answer, conversationId, evidence }) =>
          changeActive((item) => ({
            ...item,
            conversationId: conversationId ?? item.conversationId,
            messages: [
              ...item.messages,
              { id: id(), role: 'user', text: userText },
              { id: id(), role: 'assistant', text: answer, evidence },
            ],
            updatedAt: Date.now(),
          }))
        }
        onCsrfToken={syncCsrfToken}
        onNextAction={(next) => {
          setVmAction(next)
          setVmCommand(next.command)
        }}
        onOpenChange={(value) => {
          setVmConsoleOpen(value)
          if (!value) setVmAction(undefined)
        }}
        open={vmConsoleOpen}
      />
      <Dialog
        onOpenChange={(open) => !open && setSelectedLog(undefined)}
        open={Boolean(selectedLog)}
      >
        <DialogContent className='grid max-h-[90svh] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:!max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Execution log details</DialogTitle>
            <DialogDescription>
              {selectedLog
                ? `${selectedLog.created_at} · ${selectedLog.model || selectedLog.mode} · ${selectedLog.duration_ms} ms`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {selectedLog ? (
            <div className='min-h-0 space-y-4 overflow-auto pr-1 text-sm'>
              <div className='flex flex-wrap gap-2'>
                <Badge
                  variant={
                    selectedLog.status === 'success'
                      ? 'secondary'
                      : 'destructive'
                  }
                >
                  {selectedLog.status}
                </Badge>
                <Badge variant='outline'>Model: {selectedLog.model || selectedLog.mode}</Badge>
                <Badge variant='outline'>Reasoning: {selectedLog.reasoning_effort}</Badge>
                <Badge variant='outline'>{selectedLog.actor_email}</Badge>
              </div>
              <LogBlock label='User input' value={selectedLog.user_input} />
              <LogBlock
                label='Prompt sent to Codex'
                value={selectedLog.prompt_text}
              />
              <LogBlock
                label='CloudTool context supplied'
                value={JSON.stringify(selectedLog.context, null, 2)}
              />
              <div>
                <p className='mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase'>
                  AI answer
                </p>
                <div className='rounded-md border bg-background p-3'>
                  <MarkdownAnswer text={selectedLog.answer_text} />
                </div>
              </div>
              <LogBlock
                label='Activity timeline'
                value={JSON.stringify(selectedLog.activity, null, 2)}
              />
              <LogBlock
                label='Extensible metadata'
                value={JSON.stringify(
                  {
                    request_id: selectedLog.request_id,
                    conversation_id: selectedLog.conversation_id,
                    reasoning_effort: selectedLog.reasoning_effort,
                    mode: selectedLog.mode,
                    ...selectedLog.metadata,
                  },
                  null,
                  2
                )}
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
        <DialogContent className='grid max-h-[90svh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:!max-w-2xl'>
          <DialogHeader>
            <DialogTitle>Codex CLI settings</DialogTitle>
            <DialogDescription>
              Runs locally on the agent-service host. Project chat remains
              read-only.
            </DialogDescription>
          </DialogHeader>
          <form
            className='min-h-0 overflow-y-auto pr-1'
            id='codex-settings-form'
            onSubmit={(event) => {
              event.preventDefault()
              void saveSettings()
            }}
          >
            {settingsLoading || !settings ? (
              <div className='flex min-h-48 items-center justify-center text-sm text-muted-foreground'>
                <Loader2 className='mr-2 size-4 animate-spin' /> Loading
                settings…
              </div>
            ) : (
              <div className='grid gap-4 py-1 sm:grid-cols-2'>
                <div className='space-y-2 sm:col-span-2'>
                  <Label htmlFor='codex-provider'>Provider</Label>
                  <SearchableSelectV2
                    defaultValue={settings.provider}
                    isControlled
                    onValueChange={(provider) => setSettings({ ...settings, provider: provider as CodexSettings['provider'] })}
                    items={[{ value: 'codex_app_server', label: 'Codex app-server (local)' }, { value: 'evidence_only', label: 'Evidence only' }]}
                    placeholder='Select provider'
                  />
                  <p className='text-xs text-muted-foreground'>
                    The persistent local Codex app-server is the chat provider.
                    Evidence only disables AI generation intentionally.
                  </p>
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='codex-command'>
                    Codex CLI executable path
                  </Label>
                  <Input
                    id='codex-command'
                    onChange={(event) =>
                      setSettings({ ...settings, command: event.target.value })
                    }
                    value={settings.command}
                  />
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='approval-timeout'>Approval timeout (seconds)</Label>
                  <Input
                    id='approval-timeout'
                    max={900}
                    min={60}
                    onChange={(event) => setSettings({ ...settings, approval_timeout_seconds: Number(event.target.value) || 180 })}
                    type='number'
                    value={settings.approval_timeout_seconds}
                  />
                  <p className='text-xs text-muted-foreground'>Default: 180 seconds. Expired approval is returned to Codex as rejected.</p>
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='codex-model'>Default Codex model</Label>
                  <SearchableSelectV2
                    defaultValue={settings.model || '__cli_default__'}
                    isControlled
                    onValueChange={(model) => setSettings({ ...settings, model: model === '__cli_default__' ? '' : model })}
                    items={[{ value: '__cli_default__', label: 'Use CLI default' }, ...(runtime?.models.map((item) => ({ value: item.id, label: item.display_name })) ?? [])]}
                    placeholder='Use CLI default'
                  />
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='codex-reasoning'>
                    Default reasoning effort
                  </Label>
                  <SearchableSelectV2
                    defaultValue={settings.reasoning_effort}
                    isControlled
                    onValueChange={(reasoning_effort) => setSettings({ ...settings, reasoning_effort: reasoning_effort as CodexSettings['reasoning_effort'] })}
                    items={['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((value) => ({ value, label: value === 'xhigh' ? 'Extra high' : value[0]?.toUpperCase() + value.slice(1) }))}
                    placeholder='Select reasoning effort'
                  />
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='codex-timeout'>Timeout (seconds)</Label>
                  <Input
                    id='codex-timeout'
                    max={600}
                    min={30}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        timeout_seconds: Number(event.target.value) || 30,
                      })
                    }
                    type='number'
                    value={settings.timeout_seconds}
                  />
                </div>
                <div className='rounded-md border bg-muted/30 p-3 text-sm'>
                  <p
                    className={
                      settings.available
                        ? 'font-medium text-emerald-600'
                        : 'font-medium text-destructive'
                    }
                  >
                    {settings.available
                      ? 'Codex CLI available'
                      : 'Codex CLI unavailable'}
                  </p>
                  <p className='mt-1 text-xs break-all text-muted-foreground'>
                    {settings.version ||
                      settings.error ||
                      'Save settings to check the local CLI.'}
                  </p>
                </div>
                <div className='space-y-2 sm:col-span-2'>
                  <Label htmlFor='codex-system-prompt'>
                    System instruction
                  </Label>
                  <Textarea
                    className='min-h-44 font-mono text-xs leading-5'
                    id='codex-system-prompt'
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        system_prompt: event.target.value,
                      })
                    }
                    value={settings.system_prompt}
                  />
                  <p className='text-xs text-muted-foreground'>
                    Keep the MCP tool guide and read-only limits if you
                    customize this instruction.
                  </p>
                </div>
                <div className='space-y-2 sm:col-span-2'>
                  <Label htmlFor='codex-workspace-prompt'>Workspace and @mention instruction</Label>
                  <Textarea
                    className='min-h-32 font-mono text-xs leading-5'
                    id='codex-workspace-prompt'
                    onChange={(event) => setSettings({ ...settings, workspace_prompt: event.target.value })}
                    value={settings.workspace_prompt}
                  />
                  <p className='text-xs text-muted-foreground'>Use <code>{'{project_id}'}</code> for the current project ID. This is appended to every project chat.</p>
                </div>
                <div className='space-y-2 sm:col-span-2'>
                  <Label htmlFor='codex-project-chat-prompt'>Project chat policy</Label>
                  <Textarea className='min-h-32 font-mono text-xs leading-5' id='codex-project-chat-prompt' onChange={(event) => setSettings({ ...settings, project_chat_prompt: event.target.value })} value={settings.project_chat_prompt} />
                  <p className='text-xs text-muted-foreground'>Short, reusable instruction for MCP retrieval, approved Cloud actions, and VM diagnostics.</p>
                </div>
              </div>
            )}
          </form>
          <DialogFooter className='shrink-0 border-t pt-4'>
            <Button disabled={settingsLoading || settingsTesting} onClick={() => void testSettings()} type='button' variant='outline'>
              {settingsTesting ? <Loader2 className='mr-2 size-4 animate-spin' /> : null}
              Test connection
            </Button>
            <Button onClick={() => setSettingsOpen(false)} type='button' variant='outline'>Cancel</Button>
            <Button disabled={!settings || settingsLoading || settingsSaving} form='codex-settings-form' type='submit'>
              {settingsSaving ? <Loader2 className='mr-2 size-4 animate-spin' /> : <Save className='mr-2 size-4' />}
              Save settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
