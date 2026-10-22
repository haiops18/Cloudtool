import { useWindowPointerDrag } from '@/hooks/use-window-pointer-drag'
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import {
  BookOpen,
  Eye,
  FileSpreadsheet,
  FileUp,
  Loader2,
  ListChecks,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Save,
  Server,
  SquareTerminal,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api-client'
import { downloadXlsx } from '@/lib/xlsx-export'
import { parseXlsxRows } from '@/lib/xlsx-import'
import { Button } from '@/components/ui/button'
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
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { CloudDataTable } from '@/components/cloud-data-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import type { TeleportConsoleTarget } from './multi-console-page'

type ScriptResult = TeleportConsoleTarget & {
  status: 'queued' | 'running' | 'success' | 'failed'
  output: string
}
type SavedCommand = {
  id: string
  name: string
  category: string
  description: string
  command: string
  is_favorite: boolean
  shared_variables: Record<string, string>
}

export function TerminalScriptDialog({
  open,
  onOpenChange,
  targets,
  linkId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  targets: TeleportConsoleTarget[]
  linkId: string
}) {
  const startWindowPointerDrag = useWindowPointerDrag(open)
  const [command, setCommand] = useState('')
  const [login, setLogin] = useState('root')
  const [concurrency, setConcurrency] = useState(3)
  const [expandedOutput, setExpandedOutput] = useState(false)
  const [editorWidth, setEditorWidth] = useState(28)
  const [targetScope, setTargetScope] = useState<'all' | 'selected'>('all')
  const [selectedResultIds, setSelectedResultIds] = useState<string[]>([])
  const [templateVariables, setTemplateVariables] = useState<
    Record<string, Record<string, string>>
  >({})
  const [templateVariableNames, setTemplateVariableNames] = useState<string[]>(
    []
  )
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewTargetId, setPreviewTargetId] = useState('')
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<ScriptResult[]>([])
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const [remotePath, setRemotePath] = useState('/tmp')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [savedCommandsOpen, setSavedCommandsOpen] = useState(false)
  const [savedCommands, setSavedCommands] = useState<SavedCommand[]>([])
  const [savedSearch, setSavedSearch] = useState('')
  const [savedLoading, setSavedLoading] = useState(false)
  const [savedEditing, setSavedEditing] = useState(false)
  const [deleteSavedConfirmOpen, setDeleteSavedConfirmOpen] = useState(false)
  const [savedDraft, setSavedDraft] = useState<Partial<SavedCommand>>({
    category: 'Teleport Script',
    name: '',
    description: '',
    command: '',
  })
  const controllers = useRef(new Map<string, AbortController>())
  const cancelRequested = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const templateInput = useRef<HTMLInputElement>(null)
  const commandInput = useRef<HTMLTextAreaElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open)
      setResults(
        targets.map((target) => ({
          ...target,
          status: 'queued',
          output: 'Not run yet',
        }))
      )
    if (open) setSelectedResultIds([])
  }, [open, targets])
  const selectedTargets = useMemo(
    () => targets.filter((target) => selectedResultIds.includes(target.id)),
    [selectedResultIds, targets]
  )
  const executionTargets =
    targetScope === 'selected' ? selectedTargets : targets
  const previewTarget =
    targets.find((target) => target.id === previewTargetId) ?? targets[0]
  const renderCommandForTarget = (
    source: string,
    target: TeleportConsoleTarget
  ) =>
    source.replace(
      /\{\{\s*custom\.([a-z][a-z0-9_]*)\s*\}\}/gi,
      (token, variable: string) =>
        templateVariables[target.id]?.[variable] ?? token
    )
  const downloadTemplate = () => {
    downloadXlsx(
      ['teleport_ip', 'teleport_node_name', 'example_variable'],
      targets.map((target) => [target.ip, target.name, '']),
      'teleport-terminal-script-template.xlsx',
      {
        title: 'TELEPORT TERMINAL SCRIPT TEMPLATE',
        metadata: [
          {
            label: 'Instructions',
            value:
              'Keep teleport_ip and teleport_node_name unchanged. Add custom columns using lowercase snake_case.',
          },
          {
            label: 'Usage',
            value:
              'Use a column named example_variable as {{custom.example_variable}} in the CLI command.',
          },
        ],
        sheetName: 'Template variables',
      }
    )
  }
  const importTemplate = async (file: File) => {
    try {
      const rows = parseXlsxRows(await file.arrayBuffer())
      const headerIndex = rows.findIndex((row) => {
        const headers = row.map((item) => item.trim().toLowerCase())
        return (
          headers.includes('teleport_ip') &&
          headers.includes('teleport_node_name')
        )
      })
      if (headerIndex < 0)
        throw new Error(
          'Headers teleport_ip and teleport_node_name were not found.'
        )
      const headers = rows[headerIndex].map((item) => item.trim().toLowerCase())
      if (new Set(headers).size !== headers.length)
        throw new Error('Template contains duplicate column names.')
      const variables = headers.filter(
        (header) => header !== 'teleport_ip' && header !== 'teleport_node_name'
      )
      const invalid = variables.filter(
        (header) => !/^[a-z][a-z0-9_]{0,63}$/.test(header)
      )
      if (invalid.length)
        throw new Error(
          `Invalid variable columns: ${invalid.join(', ')}. Use lowercase snake_case.`
        )
      if (!variables.length)
        throw new Error('Add at least one variable column.')
      const ipIndex = headers.indexOf('teleport_ip')
      const nameIndex = headers.indexOf('teleport_node_name')
      const imported: Record<string, Record<string, string>> = {}
      let matched = 0
      for (const row of rows.slice(headerIndex + 1)) {
        const ip = row[ipIndex]?.trim()
        const name = row[nameIndex]?.trim()
        if (!ip && !name) continue
        const target = targets.find(
          (item) => item.ip === ip && item.name === name
        )
        if (!target) continue
        imported[target.id] = Object.fromEntries(
          variables.map((variable) => [
            variable,
            row[headers.indexOf(variable)]?.trim() ?? '',
          ])
        )
        matched += 1
      }
      setTemplateVariables(imported)
      setTemplateVariableNames(variables)
      toast.success(
        `Imported ${variables.length} variable(s) for ${matched} Teleport VM(s).`
      )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not import template.'
      )
    } finally {
      if (templateInput.current) templateInput.current.value = ''
    }
  }
  const emptySavedDraft = (): Partial<SavedCommand> => ({
    category: 'Teleport Script',
    name: '',
    description: '',
    command: '',
  })
  const loadSavedCommands = async () => {
    setSavedLoading(true)
    try {
      const { data } = await apiClient.get<SavedCommand[]>(
        '/cloud/cli-commands'
      )
      setSavedCommands(
        data.filter((item) => item.category === 'Teleport Script')
      )
    } catch {
      toast.error('Could not load saved CLI commands.')
    } finally {
      setSavedLoading(false)
    }
  }
  const openSavedCommands = () => {
    setSavedCommandsOpen(true)
    void loadSavedCommands()
  }
  const saveSavedCommand = async () => {
    if (!savedDraft.name?.trim() || !savedDraft.command?.trim()) {
      toast.error('Enter a name and CLI command.')
      return
    }
    const payload = {
      name: savedDraft.name.trim(),
      category: 'Teleport Script',
      description: savedDraft.description ?? '',
      command: savedDraft.command,
      is_favorite: false,
      shared_variables: {},
    }
    try {
      const { data } = savedDraft.id
        ? await apiClient.patch<SavedCommand>(
            `/cloud/cli-commands/${savedDraft.id}`,
            payload
          )
        : await apiClient.post<SavedCommand>('/cloud/cli-commands', payload)
      setSavedCommands((current) =>
        savedDraft.id
          ? current.map((item) => (item.id === data.id ? data : item))
          : [data, ...current]
      )
      setSavedDraft(data)
      setSavedEditing(false)
      toast.success(
        savedDraft.id ? 'Saved command updated.' : 'Saved command created.'
      )
    } catch {
      toast.error(
        'Could not save CLI command. Administrator permission may be required.'
      )
    }
  }
  const deleteSavedCommand = async () => {
    if (!savedDraft.id) return
    try {
      await apiClient.delete(`/cloud/cli-commands/${savedDraft.id}`)
      setSavedCommands((current) =>
        current.filter((item) => item.id !== savedDraft.id)
      )
      setSavedDraft(emptySavedDraft())
      setSavedEditing(false)
      toast.success('Saved command deleted.')
    } catch {
      toast.error('Could not delete CLI command.')
    }
  }
  const visibleSavedCommands = useMemo(() => {
    const query = savedSearch.trim().toLowerCase()
    if (!query) return savedCommands
    return savedCommands.filter((item) =>
      `${item.name} ${item.description} ${item.command}`
        .toLowerCase()
        .includes(query)
    )
  }, [savedCommands, savedSearch])
  const columns = useMemo<ColumnDef<ScriptResult>[]>(
    () => [
      {
        id: 'vm',
        header: 'Teleport VM',
        meta: { className: 'min-w-44 max-w-80' },
        cell: ({ row }) => (
          <div>
            <div className='font-mono font-medium'>{row.original.ip}</div>
            <div className='text-xs text-muted-foreground'>
              {row.original.name}
            </div>
          </div>
        ),
      },
      ...(templateVariableNames.length
        ? [
            {
              id: 'template_variable_preview',
              header: 'Variables',
              meta: { className: 'w-32 min-w-32 max-w-36' },
              accessorFn: (row: ScriptResult) =>
                Object.entries(templateVariables[row.id] ?? {})
                  .map(([key, value]) => `${key}=${value}`)
                  .join(', '),
              cell: ({ row }: { row: { original: ScriptResult } }) => {
                const entries = Object.entries(
                  templateVariables[row.original.id] ?? {}
                )
                const preview = entries
                  .map(([key, value]) => `${key}=${value}`)
                  .join('\n')
                return (
                  <div
                    className='space-y-0.5 font-mono text-xs'
                    title={preview}
                  >
                    {entries.length
                      ? entries.map(([key, value]) => (
                          <div className='truncate' key={key}>
                            {key}={value}
                          </div>
                        ))
                      : '-'}
                  </div>
                )
              },
            } as ColumnDef<ScriptResult>,
          ]
        : []),
      {
        accessorKey: 'status',
        header: 'Status',
        meta: { className: 'w-24 min-w-24' },
        cell: ({ row }) => (
          <span
            className={
              row.original.status === 'success'
                ? 'font-medium text-emerald-600'
                : row.original.status === 'failed'
                  ? 'font-medium text-destructive'
                  : 'text-muted-foreground'
            }
          >
            {row.original.status}
          </span>
        ),
      },
      {
        accessorKey: 'output',
        header: 'CLI result',
        meta: { className: 'min-w-[34rem] !whitespace-normal' },
        cell: ({ row }) => (
          <pre
            className={`${expandedOutput ? 'max-h-96' : 'max-h-24'} min-w-80 overflow-auto rounded bg-muted/50 p-2 text-xs break-all whitespace-pre-wrap`}
          >
            {row.original.output ||
              (row.original.status === 'queued'
                ? 'Waiting…'
                : row.original.status === 'running'
                  ? 'Running…'
                  : '—')}
          </pre>
        ),
      },
      ...(templateVariableNames.includes('__legacy_template_preview__')
        ? [
            {
              id: 'template_preview',
              header: 'Template variables',
              meta: { className: 'w-44 min-w-44 max-w-52' },
              accessorFn: (row: ScriptResult) =>
                Object.entries(templateVariables[row.id] ?? {})
                  .map(([key, value]) => `${key}=${value}`)
                  .join(', '),
              cell: ({ row }: { row: { original: ScriptResult } }) => (
                <span
                  className='block truncate font-mono text-xs'
                  title={Object.entries(
                    templateVariables[row.original.id] ?? {}
                  )
                    .map(([key, value]) => `${key}=${value}`)
                    .join(', ')}
                >
                  {Object.entries(templateVariables[row.original.id] ?? {})
                    .map(([key, value]) => `${key}=${value}`)
                    .join(', ') || '—'}
                </span>
              ),
            } as ColumnDef<ScriptResult>,
          ]
        : []),
    ],
    [expandedOutput, templateVariableNames, templateVariables]
  )
  const run = async (commandToRun = command) => {
    if (
      !commandToRun.trim() ||
      !linkId ||
      !executionTargets.length ||
      running
    ) {
      if (targetScope === 'selected' && !selectedTargets.length)
        toast.error('Select at least one VM in the result table.')
      return
    }
    setRunning(true)
    cancelRequested.current = false
    setResults(
      targets.map((target) => ({
        ...target,
        status: 'queued',
        output: executionTargets.some((item) => item.id === target.id)
          ? ''
          : 'Not selected for this run',
      }))
    )
    let cursor = 0
    const worker = async () => {
      while (cursor < executionTargets.length && !cancelRequested.current) {
        const target = executionTargets[cursor++]
        setResults((current) =>
          current.map((item) =>
            item.id === target.id ? { ...item, status: 'running' } : item
          )
        )
        try {
          const controller = new AbortController()
          controllers.current.set(target.id, controller)
          const { data } = await apiClient.post<{
            output?: string
            exit_code?: number
          }>(
            `/teleport-links/${linkId}/tsh/ssh`,
            {
              host: target.name,
              login: login.trim() || 'root',
              command: renderCommandForTarget(commandToRun, target),
            },
            { timeout: 30 * 60_000, signal: controller.signal }
          )
          setResults((current) =>
            current.map((item) =>
              item.id === target.id
                ? {
                    ...item,
                    status: (data.exit_code ?? 0) === 0 ? 'success' : 'failed',
                    output:
                      (data.exit_code ?? 0) === 0
                        ? data.output ||
                          'Completed successfully (exit code 0; no output).'
                        : `Exit code ${data.exit_code}\n${data.output || 'Command failed without output.'}`,
                  }
                : item
            )
          )
        } catch (error) {
          if (cancelRequested.current) {
            controllers.current.delete(target.id)
            continue
          }
          const detail = (
            error as {
              response?: {
                data?: { detail?: string; error?: { message?: string } }
              }
            }
          ).response?.data
          setResults((current) =>
            current.map((item) =>
              item.id === target.id
                ? {
                    ...item,
                    status: 'failed',
                    output:
                      detail?.error?.message ||
                      detail?.detail ||
                      (error instanceof Error
                        ? error.message
                        : 'Command failed'),
                  }
                : item
            )
          )
        }
        controllers.current.delete(target.id)
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, executionTargets.length) },
        worker
      )
    )
    setRunning(false)
    toast.success('Terminal script run completed.')
  }
  const runSelection = () => {
    const editor = commandInput.current
    const selectedCommand = editor?.value.slice(
      editor.selectionStart,
      editor.selectionEnd
    )
    if (!selectedCommand?.trim()) {
      toast.error('Select a CLI command snippet before running it.')
      return
    }
    void run(selectedCommand)
  }
  const stop = () => {
    cancelRequested.current = true
    for (const controller of controllers.current.values()) controller.abort()
    controllers.current.clear()
    setRunning(false)
    setResults((current) =>
      current.map((item) =>
        item.status === 'running' || (item.status === 'queued' && !item.output)
          ? { ...item, status: 'failed', output: 'Stopped by user' }
          : item
      )
    )
  }
  const upload = async (file: File) => {
    if (!linkId || running || !executionTargets.length) {
      if (targetScope === 'selected' && !selectedTargets.length)
        toast.error('Select at least one VM in the result table.')
      return
    }
    setRunning(true)
    cancelRequested.current = false
    setResults(
      targets.map((target) => ({
        ...target,
        status: 'queued',
        output: executionTargets.some((item) => item.id === target.id)
          ? ''
          : 'Not selected for this upload',
      }))
    )
    let cursor = 0
    const worker = async () => {
      while (cursor < executionTargets.length && !cancelRequested.current) {
        const target = executionTargets[cursor++]
        setResults((current) =>
          current.map((item) =>
            item.id === target.id
              ? {
                  ...item,
                  status: 'running',
                  output: `Uploading ${file.name}…`,
                }
              : item
          )
        )
        try {
          const controller = new AbortController()
          controllers.current.set(target.id, controller)
          const form = new FormData()
          form.set('host', target.name)
          form.set('login', login.trim() || 'root')
          form.set('remote_path', remotePath.trim() || '/tmp')
          form.set('file', file)
          await apiClient.post(
            `/teleport-links/${linkId}/tsh/files/upload`,
            form,
            { timeout: 30 * 60_000, signal: controller.signal }
          )
          setResults((current) =>
            current.map((item) =>
              item.id === target.id
                ? {
                    ...item,
                    status: 'success',
                    output: `Uploaded ${file.name}`,
                  }
                : item
            )
          )
          controllers.current.delete(target.id)
        } catch (error) {
          if (cancelRequested.current) {
            controllers.current.delete(target.id)
            continue
          }
          setResults((current) =>
            current.map((item) =>
              item.id === target.id
                ? {
                    ...item,
                    status: 'failed',
                    output:
                      error instanceof Error ? error.message : 'Upload failed',
                  }
                : item
            )
          )
        }
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, executionTargets.length) },
        worker
      )
    )
    setRunning(false)
  }
  const beginWorkspaceResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const workspace = workspaceRef.current
    if (!workspace) return
    event.preventDefault()
    const updateWidth = (moveEvent: PointerEvent) => {
      const bounds = workspace.getBoundingClientRect()
      const percentage =
        ((moveEvent.clientX - bounds.left) / bounds.width) * 100
      setEditorWidth(Math.min(52, Math.max(24, percentage)))
    }
    startWindowPointerDrag(updateWidth)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setCloseConfirmOpen(true)
        else onOpenChange(true)
      }}
    >
      <DialogContent
        showCloseButton={false}
        className='!inset-0 grid !h-[100dvh] !max-h-none !w-screen !max-w-none !min-w-screen !translate-x-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-none border-0 p-0 sm:!w-screen sm:!max-w-none sm:!min-w-screen'
      >
        <DialogHeader className='relative border-b px-5 py-4 pr-52'>
          <DialogTitle className='flex items-center gap-2'>
            <SquareTerminal /> Terminal script
          </DialogTitle>
          <div className='absolute top-3 right-4 flex items-center gap-1'>
            <Button
              onClick={() => setExpandedOutput((value) => !value)}
              size='sm'
              type='button'
              variant='outline'
            >
              {expandedOutput ? <Minimize2 /> : <Maximize2 />}
              {expandedOutput ? 'Compact rows' : 'Expand output'}
            </Button>
            <Button
              aria-label='Close Terminal Script'
              onClick={() => setCloseConfirmOpen(true)}
              size='icon'
              type='button'
              variant='ghost'
            >
              <X />
            </Button>
          </div>
        </DialogHeader>
        <div
          className='grid min-h-0 gap-0 overflow-hidden p-4 lg:grid-cols-[minmax(19rem,var(--terminal-script-editor-width))_0.5rem_minmax(0,1fr)]'
          ref={workspaceRef}
          style={
            {
              '--terminal-script-editor-width': `${editorWidth}%`,
            } as CSSProperties
          }
        >
          <section className='flex min-h-0 flex-col gap-3 rounded-xl border bg-muted/20 p-4'>
            <div className='flex items-center justify-between'>
              <Label htmlFor='terminal-script-command'>CLI command</Label>
              <div className='flex items-center gap-1'>
                <div className='flex h-8 min-w-20 items-center justify-around rounded-md border bg-muted/30 p-0.5'>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label='Download template variables'
                        className='size-7'
                        onClick={downloadTemplate}
                        size='icon'
                        type='button'
                        variant='ghost'
                      >
                        <FileSpreadsheet />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Download Excel template</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label='Import template variables'
                        className='size-7'
                        onClick={() => templateInput.current?.click()}
                        size='icon'
                        type='button'
                        variant='ghost'
                      >
                        <FileUp />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Import Excel variables</TooltipContent>
                  </Tooltip>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label='Preview command variables'
                      className='hover:bg-accent'
                      disabled={!command.trim() || !targets.length}
                      onClick={() => {
                        setPreviewTargetId(
                          (current) => current || targets[0]?.id || ''
                        )
                        setPreviewOpen(true)
                      }}
                      size='icon'
                      type='button'
                      variant='ghost'
                    >
                      <Eye />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Preview command for a VM</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label='Upload file to Teleport VM(s)'
                      className='hover:bg-accent'
                      onClick={() => setUploadOpen(true)}
                      size='icon'
                      type='button'
                      variant='ghost'
                    >
                      <Upload />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Upload file to Teleport VM(s)</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label='Open Saved CLI Commands'
                      className='hover:bg-accent'
                      onClick={openSavedCommands}
                      size='icon'
                      type='button'
                      variant='ghost'
                    >
                      <BookOpen />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Saved CLI Commands</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <input
              accept='.xlsx,.xls'
              className='hidden'
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void importTemplate(file)
              }}
              ref={templateInput}
              type='file'
            />
            <Textarea
              className='min-h-56 flex-1 resize-none font-mono text-sm'
              id='terminal-script-command'
              onChange={(event) => setCommand(event.target.value)}
              placeholder={'apt-get update\napt-get upgrade -y'}
              ref={commandInput}
              spellCheck={false}
              value={command}
            />
            <div className='flex flex-wrap items-end gap-2'>
              <div className='w-32 space-y-1.5'>
                <Label htmlFor='terminal-script-login'>SSH user</Label>
                <Input
                  id='terminal-script-login'
                  onChange={(event) => setLogin(event.target.value)}
                  value={login}
                />
              </div>
              <div className='w-28 space-y-1.5'>
                <Label htmlFor='terminal-script-concurrency'>Parallel</Label>
                <select
                  className='h-9 w-full rounded-md border bg-background px-2 text-sm'
                  id='terminal-script-concurrency'
                  onChange={(event) =>
                    setConcurrency(Number(event.target.value))
                  }
                  value={concurrency}
                >
                  {Array.from({ length: 20 }, (_, index) => index + 1).map(
                    (value) => (
                      <option key={value} value={value}>
                        {value} VM{value === 1 ? '' : 's'}
                      </option>
                    )
                  )}
                </select>
              </div>
              <div className='space-y-1.5'>
                <Label>Target VMs</Label>
                <div className='inline-flex h-9 rounded-md border bg-muted/30 p-1'>
                  <Button
                    className='h-7 px-2'
                    onClick={() => setTargetScope('all')}
                    size='sm'
                    type='button'
                    variant={targetScope === 'all' ? 'secondary' : 'ghost'}
                  >
                    <Server /> All ({targets.length})
                  </Button>
                  <Button
                    className='h-7 px-2'
                    onClick={() => setTargetScope('selected')}
                    size='sm'
                    type='button'
                    variant={targetScope === 'selected' ? 'secondary' : 'ghost'}
                  >
                    <ListChecks /> Selected ({selectedTargets.length})
                  </Button>
                </div>
              </div>
            </div>
            <div className='grid grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)] gap-2 border-t pt-3'>
              <Button
                className='w-full'
                disabled={
                  !running && (!command.trim() || !executionTargets.length)
                }
                onClick={() => (running ? stop() : void run())}
                type='button'
                variant={running ? 'destructive' : 'outline'}
              >
                {running ? <X /> : <Play />}
                {running ? 'Stop' : 'Run all'}
              </Button>
              <Button
                className='w-full'
                disabled={running || !executionTargets.length}
                onClick={runSelection}
                type='button'
              >
                <Play /> Run selection
              </Button>
            </div>
          </section>
          <div
            aria-label='Resize CLI command and result table panels'
            aria-orientation='vertical'
            className='group relative hidden cursor-col-resize touch-none items-center justify-center lg:flex'
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault()
                setEditorWidth((value) => Math.max(24, value - 2))
              }
              if (event.key === 'ArrowRight') {
                event.preventDefault()
                setEditorWidth((value) => Math.min(52, value + 2))
              }
            }}
            onPointerDown={beginWorkspaceResize}
            role='separator'
            tabIndex={0}
          >
            <span className='h-full w-px bg-border transition-colors group-hover:w-1 group-hover:bg-primary group-focus-visible:w-1 group-focus-visible:bg-primary' />
          </div>
          <section className='min-h-0 rounded-xl border bg-card p-3'>
            <CloudDataTable
              columns={columns}
              data={results}
              emptyText='Run a command to see each VM result.'
              entityName='VM result'
              getRowId={(row) => row.id}
              initialPageSize={10}
              loading={running && !results.length}
              onSelectedRowsChange={(rows) => {
                const nextIds = rows.map((row) => row.id)
                setSelectedResultIds((current) =>
                  current.join('\u0000') === nextIds.join('\u0000')
                    ? current
                    : nextIds
                )
              }}
              selectedRowIds={selectedResultIds}
              searchPlaceholder='Search VM or output...'
            />
          </section>
        </div>
      </DialogContent>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className='sm:!max-w-3xl'>
          <DialogHeader>
            <DialogTitle>CLI command preview</DialogTitle>
            <DialogDescription>
              Preview the rendered command for one Teleport VM before running
              it.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-3'>
            <div className='space-y-1.5'>
              <Label htmlFor='terminal-script-preview-target'>
                Teleport VM
              </Label>
              <select
                className='h-9 w-full rounded-md border bg-background px-2 text-sm'
                id='terminal-script-preview-target'
                onChange={(event) => setPreviewTargetId(event.target.value)}
                value={previewTarget?.id ?? ''}
              >
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.ip} — {target.name}
                  </option>
                ))}
              </select>
            </div>
            <div className='space-y-1.5'>
              <Label>Rendered CLI command</Label>
              <pre className='max-h-[50vh] min-h-48 overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-sm break-all whitespace-pre-wrap'>
                {previewTarget
                  ? renderCommandForTarget(command, previewTarget)
                  : 'No Teleport VM selected.'}
              </pre>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setPreviewOpen(false)} type='button'>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className='sm:!max-w-xl'>
          <DialogHeader>
            <DialogTitle>Upload file to Teleport VM(s)</DialogTitle>
            <DialogDescription>
              Upload to {targets.length} VM(s), with up to 3 transfers at once.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4'>
            <Input
              accept='*/*'
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) {
                  void upload(file)
                  setUploadOpen(false)
                }
                event.target.value = ''
              }}
              ref={fileInput}
              type='file'
            />
            <div className='space-y-1.5'>
              <Label>Remote folder</Label>
              <Input
                className='font-mono'
                onChange={(event) => setRemotePath(event.target.value)}
                value={remotePath}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={savedCommandsOpen} onOpenChange={setSavedCommandsOpen}>
        <DialogContent className='!w-[min(96vw,72rem)] !max-w-[72rem] overflow-hidden p-0'>
          <DialogHeader className='border-b px-6 py-5'>
            <DialogTitle className='flex items-center gap-2'>
              <BookOpen /> Saved CLI Commands
            </DialogTitle>
            <DialogDescription>
              Create, edit, and reuse commands for Teleport Terminal Script.
            </DialogDescription>
          </DialogHeader>
          <div className='grid max-h-[72vh] min-h-[32rem] grid-cols-1 overflow-hidden md:grid-cols-[minmax(17rem,.72fr)_minmax(0,1.28fr)]'>
            <aside className='flex min-h-0 flex-col border-b bg-muted/20 p-4 md:border-r md:border-b-0'>
              <div className='flex gap-2'>
                <Input
                  onChange={(event) => setSavedSearch(event.target.value)}
                  placeholder='Search saved commands'
                  value={savedSearch}
                />
                <Button
                  aria-label='New saved command'
                  onClick={() => {
                    setSavedDraft(emptySavedDraft())
                    setSavedEditing(true)
                  }}
                  size='icon'
                  type='button'
                  variant='outline'
                >
                  <Plus />
                </Button>
              </div>
              <div className='mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1'>
                {savedLoading ? (
                  <div className='flex justify-center py-8 text-muted-foreground'>
                    <Loader2 className='animate-spin' />
                  </div>
                ) : visibleSavedCommands.length ? (
                  visibleSavedCommands.map((item) => (
                    <div
                      className={`flex w-full items-start gap-1 rounded-lg border p-1 transition-colors hover:bg-accent ${savedDraft.id === item.id ? 'border-primary bg-primary/5' : 'bg-background'}`}
                      key={item.id}
                    >
                      <button
                        className='min-w-0 flex-1 p-2 text-left'
                        onClick={() => {
                          setSavedDraft(item)
                          setSavedEditing(false)
                        }}
                        type='button'
                      >
                        <div className='truncate font-medium'>{item.name}</div>
                        <div className='mt-1 line-clamp-2 text-xs text-muted-foreground'>
                          {item.description || item.command}
                        </div>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            aria-label={`Actions for ${item.name}`}
                            size='icon'
                            type='button'
                            variant='ghost'
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end'>
                          <DropdownMenuItem
                            onClick={() => {
                              setSavedDraft(item)
                              setSavedEditing(true)
                            }}
                          >
                            <Pencil /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              setSavedDraft(item)
                              setDeleteSavedConfirmOpen(true)
                            }}
                            variant='destructive'
                          >
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))
                ) : (
                  <div className='rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground'>
                    No saved command found.
                  </div>
                )}
              </div>
            </aside>
            <section className='flex min-h-0 flex-col gap-4 p-5'>
              {!savedEditing && savedDraft.id ? (
                <>
                  <div>
                    <h3 className='text-lg font-semibold'>{savedDraft.name}</h3>
                    {savedDraft.description && (
                      <p className='mt-1 text-sm text-muted-foreground'>
                        {savedDraft.description}
                      </p>
                    )}
                  </div>
                  <div className='min-h-0 flex-1 space-y-1.5'>
                    <Label>Command preview</Label>
                    <pre className='h-[min(45vh,28rem)] overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-sm break-all whitespace-pre-wrap'>
                      {savedDraft.command}
                    </pre>
                  </div>
                  <div className='flex justify-end border-t pt-4'>
                    <Button
                      onClick={() => {
                        setCommand(savedDraft.command ?? '')
                        setSavedCommandsOpen(false)
                      }}
                      type='button'
                    >
                      <SquareTerminal /> Use in editor
                    </Button>
                  </div>
                </>
              ) : savedEditing ? (
                <>
                  <div className='grid gap-4 sm:grid-cols-2'>
                    <div className='space-y-1.5'>
                      <Label htmlFor='saved-command-name'>Command name</Label>
                      <Input
                        id='saved-command-name'
                        onChange={(event) =>
                          setSavedDraft((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        placeholder='Update packages'
                        value={savedDraft.name ?? ''}
                      />
                    </div>
                    <div className='space-y-1.5'>
                      <Label htmlFor='saved-command-description'>
                        Description
                      </Label>
                      <Input
                        id='saved-command-description'
                        onChange={(event) =>
                          setSavedDraft((current) => ({
                            ...current,
                            description: event.target.value,
                          }))
                        }
                        placeholder='Optional short description'
                        value={savedDraft.description ?? ''}
                      />
                    </div>
                  </div>
                  <div className='flex min-h-0 flex-1 flex-col space-y-1.5'>
                    <Label htmlFor='saved-command-content'>CLI command</Label>
                    <Textarea
                      className='min-h-48 flex-1 resize-none font-mono text-sm'
                      id='saved-command-content'
                      onChange={(event) =>
                        setSavedDraft((current) => ({
                          ...current,
                          command: event.target.value,
                        }))
                      }
                      placeholder={'apt-get update\napt-get upgrade -y'}
                      spellCheck={false}
                      value={savedDraft.command ?? ''}
                    />
                  </div>
                  <div className='flex flex-wrap justify-end gap-2 border-t pt-4'>
                    <Button
                      onClick={() => void saveSavedCommand()}
                      type='button'
                    >
                      <Save /> Save command
                    </Button>
                  </div>
                </>
              ) : (
                <div className='flex h-full items-center justify-center rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground'>
                  Select a command to preview it, or create a new command.
                </div>
              )}
            </section>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteSavedConfirmOpen}
        onOpenChange={setDeleteSavedConfirmOpen}
        title='Delete saved CLI command?'
        desc={`"${savedDraft.name ?? ''}" will be permanently removed from the command library.`}
        cancelBtnText='Keep command'
        confirmText='Delete'
        destructive
        handleConfirm={() => {
          setDeleteSavedConfirmOpen(false)
          void deleteSavedCommand()
        }}
      />
      <ConfirmDialog
        open={closeConfirmOpen}
        onOpenChange={setCloseConfirmOpen}
        title='Close Terminal Script?'
        desc={
          running
            ? 'Running calls will be stopped.'
            : 'Close this script workspace?'
        }
        cancelBtnText='Keep open'
        confirmText='Close'
        destructive
        handleConfirm={() => {
          if (running) stop()
          setCloseConfirmOpen(false)
          onOpenChange(false)
        }}
      />
    </Dialog>
  )
}
