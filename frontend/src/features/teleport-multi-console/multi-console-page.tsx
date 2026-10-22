import { useWindowPointerDrag } from '@/hooks/use-window-pointer-drag'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import RFB from '@novnc/novnc'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  Braces,
  BookOpen,
  CircleHelp,
  ExternalLink,
  FileDown,
  FileUp,
  Upload,
  Highlighter,
  KeyRound,
  LayoutGrid,
  List,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  Pause,
  Pencil,
  PanelRight,
  Play,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  Send,
  Star,
  Trash2,
  Unplug,
  X,
  ZoomIn,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { downloadXlsx } from '@/lib/xlsx-export'
import { parseXlsxRows } from '@/lib/xlsx-import'
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
import { SearchableSelect } from '@/components/searchable-select'
import { SegmentedTabs } from '@/components/segmented-tabs'
import type { Page, Profile, ServerRow, Subnet } from '../cloud/types'
import {
  consoleWebSocketUrl,
  dispatchNoVncKey,
  keyboardKeysym,
  renderServerCommand,
  renderServerCommandParts,
  renderSharedVariableValue,
  serverCommandVariables,
  subnetGatewayIp,
  type RenderedCommandPart,
} from './multi-console-utils'

type SessionState =
  'queued' | 'opening' | 'connected' | 'disconnected' | 'error'
type ConsoleSession = {
  server: ServerRow
  terminalTicket?: string
  url?: string
  websocketUrl?: string
  state: SessionState
  message?: string
}
type UploadResult = {
  id: string
  name: string
  ip: string
  status: 'queued' | 'uploading' | 'success' | 'failed'
  progress: number
  error?: string
}
type CliCommandRecord = {
  id: string
  name: string
  category: string
  description: string
  command: string
  is_favorite: boolean
  shared_variables: Record<string, string>
  created_at: string
  updated_at: string
}
type CliCommandDraft = Omit<
  CliCommandRecord,
  'id' | 'created_at' | 'updated_at'
>
type MultiConsolePasswordMode = 'profile' | 'manual'
type HelpTopic = 'workspace' | 'editor' | 'library' | 'variables' | 'password'

const HELP_CONTENT: Record<
  HelpTopic,
  { title: string; description: string; steps: string[] }
> = {
  workspace: {
    title: 'Multi Console help',
    description:
      'Open and operate several Linux VNC consoles from one workspace.',
    steps: [
      'Select the servers, then open their consoles.',
      'Use Send for the whole CLI editor or Run selection for highlighted text only.',
      'Keyboard Broadcast mirrors physical keystrokes after you focus a connected console.',
    ],
  },
  editor: {
    title: 'Large editor help',
    description: 'Use the expanded editor for long or multi-line commands.',
    steps: [
      'Edit commands using the standard text area.',
      'Highlight only the lines you want to execute, then use Run selection in the main panel.',
      'Use Variables & preview to insert per-server values safely.',
      'Use {{hotkey:Ctrl+C}} for a custom key combination and {{sleep:2s}} or {{sleep:500ms}} to pause between command segments.',
    ],
  },
  library: {
    title: 'Command library help',
    description: 'Save and reuse CLI command templates.',
    steps: [
      'Choose a command to inspect it, then click Edit before changing it.',
      'Insert built-in or imported variables at the cursor.',
      'Use command imports the template into the editor; it does not execute it.',
    ],
  },
  variables: {
    title: 'Variables & preview help',
    description: 'Create one template using server-specific and shared values.',
    steps: [
      'Use built-in variables, import per-server values from Excel, or create shared variables used by every server.',
      'Insert variables in Raw editor, then preview a specific server.',
      'Custom per-server and shared values are inserted exactly as provided.',
    ],
  },
  password: {
    title: 'Change password help',
    description: 'Change passwords for one or more selected servers.',
    steps: [
      'Select the exact target servers.',
      'Enter a compliant password or generate a strong value.',
      'Review the result for each server before closing.',
    ],
  },
}

function HelpButton({
  topic,
  onOpen,
}: {
  topic: HelpTopic
  onOpen: (topic: HelpTopic) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          className='size-7'
          aria-label={`Open ${HELP_CONTENT[topic].title}`}
          onClick={() => onOpen(topic)}
        >
          <CircleHelp />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Help</TooltipContent>
    </Tooltip>
  )
}

const EMPTY_CLI_COMMAND: CliCommandDraft = {
  name: '',
  category: 'General',
  description: '',
  command: '',
  is_favorite: false,
  shared_variables: {},
}

function sharedVariableMode(value: string) {
  if (/\[in(?::[^\]]+)?\]/i.test(value)) return 'Sequence'
  if (/\{\{\s*server\./.test(value)) return 'Server dynamic'
  return 'Static'
}
type NoVncKeyboard = {
  onkeyevent: (keysym: number, code: string, down: boolean) => void
}
type RfbWithKeyboard = RFB & { _keyboard: NoVncKeyboard }

const CONSOLE_WARNING_THRESHOLD = 10
const CONSOLE_OPEN_CONCURRENCY = 2
const CONSOLE_OPEN_STAGGER_MS = 400

const COMMAND_CONTROL_VARIABLES = [
  {
    variable: 'hotkey:Ctrl+C',
    label: 'Send a hotkey; edit Ctrl+C as needed',
    type: 'Control',
    preview: 'Press Ctrl+C',
  },
  {
    variable: 'sleep:2s',
    label: 'Pause before the next command segment; edit the duration',
    type: 'Control',
    preview: 'Wait 2 seconds',
  },
] as const

function backendWebSocketUrl(path: string): string {
  const base = new URL(
    apiClient.defaults.baseURL ?? '/api/v1',
    window.location.origin
  )
  const prefix = base.pathname.replace(/\/$/, '')
  const endpoint = new URL(`${prefix}${path}`, base.origin)
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  return endpoint.toString()
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) =>
    window.setTimeout(resolve, milliseconds)
  )
}

async function typeText(
  rfb: RFB,
  sendKey: (keysym: number, code?: string, down?: boolean) => void,
  value: string,
  appendEnter = true
) {
  rfb.focus({ preventScroll: true })
  for (const character of Array.from(appendEnter ? `${value}\n` : value)) {
    const descriptor = physicalKey(character)
    const keysym = keyboardKeysym(character === '\n' ? 'Enter' : character)
    if (keysym === undefined) continue
    if (descriptor.shift) sendKey(keyboardKeysym('Shift')!, 'ShiftLeft', true)
    sendKey(keysym, descriptor.code, true)
    await wait(22)
    sendKey(keysym, descriptor.code, false)
    if (descriptor.shift) sendKey(keyboardKeysym('Shift')!, 'ShiftLeft', false)
    await wait(22)
  }
}

const SYMBOL_KEYS: Record<string, [string, boolean]> = {
  ' ': ['Space', false],
  '-': ['Minus', false],
  _: ['Minus', true],
  '=': ['Equal', false],
  '+': ['Equal', true],
  '[': ['BracketLeft', false],
  '{': ['BracketLeft', true],
  ']': ['BracketRight', false],
  '}': ['BracketRight', true],
  '\\': ['Backslash', false],
  '|': ['Backslash', true],
  ';': ['Semicolon', false],
  ':': ['Semicolon', true],
  "'": ['Quote', false],
  '"': ['Quote', true],
  ',': ['Comma', false],
  '<': ['Comma', true],
  '.': ['Period', false],
  '>': ['Period', true],
  '/': ['Slash', false],
  '?': ['Slash', true],
  '`': ['Backquote', false],
  '~': ['Backquote', true],
  '!': ['Digit1', true],
  '@': ['Digit2', true],
  '#': ['Digit3', true],
  $: ['Digit4', true],
  '%': ['Digit5', true],
  '^': ['Digit6', true],
  '&': ['Digit7', true],
  '*': ['Digit8', true],
  '(': ['Digit9', true],
  ')': ['Digit0', true],
}

function physicalKey(character: string): { code?: string; shift: boolean } {
  if (character === '\n') return { code: 'Enter', shift: false }
  if (/^[a-z]$/i.test(character)) {
    return {
      code: `Key${character.toUpperCase()}`,
      shift: character !== character.toLowerCase(),
    }
  }
  if (/^[0-9]$/.test(character))
    return { code: `Digit${character}`, shift: false }
  const symbol = SYMBOL_KEYS[character]
  return symbol ? { code: symbol[0], shift: symbol[1] } : { shift: false }
}

type CommandSendStep =
  | { type: 'text'; value: string }
  | { type: 'sleep'; milliseconds: number }
  | { type: 'hotkey'; value: string }

function commandSendSteps(value: string): CommandSendStep[] {
  const steps: CommandSendStep[] = []
  const directive = /\{\{\s*(hotkey|sleep)\s*:\s*([^}]+?)\s*\}\}/gi
  let cursor = 0
  for (const match of value.matchAll(directive)) {
    const index = match.index ?? 0
    if (index > cursor)
      steps.push({ type: 'text', value: value.slice(cursor, index) })
    if (match[1].toLowerCase() === 'hotkey') {
      steps.push({ type: 'hotkey', value: match[2].trim() })
    } else {
      const duration = match[2].trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/i)
      if (!duration)
        throw new Error(
          `Invalid sleep directive "${match[0]}". Use {{sleep:500ms}} or {{sleep:2s}}.`
        )
      const amount = Number(duration[1])
      const milliseconds =
        duration[2]?.toLowerCase() === 's' ? amount * 1000 : amount
      if (!Number.isFinite(milliseconds) || milliseconds < 0)
        throw new Error('Sleep duration must be zero or greater.')
      steps.push({ type: 'sleep', milliseconds })
    }
    cursor = index + match[0].length
  }
  if (cursor < value.length)
    steps.push({ type: 'text', value: value.slice(cursor) })
  return steps
}

const HOTKEY_MODIFIERS: Record<string, { key: string; code: string }> = {
  ctrl: { key: 'Control', code: 'ControlLeft' },
  control: { key: 'Control', code: 'ControlLeft' },
  alt: { key: 'Alt', code: 'AltLeft' },
  shift: { key: 'Shift', code: 'ShiftLeft' },
  meta: { key: 'Meta', code: 'MetaLeft' },
  cmd: { key: 'Meta', code: 'MetaLeft' },
  command: { key: 'Meta', code: 'MetaLeft' },
  win: { key: 'Meta', code: 'MetaLeft' },
}

const HOTKEY_SPECIAL_KEYS: Record<string, { key: string; code: string }> = {
  enter: { key: 'Enter', code: 'Enter' },
  escape: { key: 'Escape', code: 'Escape' },
  esc: { key: 'Escape', code: 'Escape' },
  tab: { key: 'Tab', code: 'Tab' },
  backspace: { key: 'Backspace', code: 'Backspace' },
  delete: { key: 'Delete', code: 'Delete' },
  home: { key: 'Home', code: 'Home' },
  end: { key: 'End', code: 'End' },
  pageup: { key: 'PageUp', code: 'PageUp' },
  pagedown: { key: 'PageDown', code: 'PageDown' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
}

async function sendHotkey(
  rfb: RFB,
  sendKey: (keysym: number, code?: string, down?: boolean) => void,
  value: string
) {
  const tokens = value
    .split('+')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!tokens.length)
    throw new Error('Hotkey cannot be empty. Example: {{hotkey:Ctrl+C}}.')
  const modifierTokens = tokens.slice(0, -1)
  const mainToken = tokens[tokens.length - 1]
  const modifiers = modifierTokens.map(
    (token) => HOTKEY_MODIFIERS[token.toLowerCase()]
  )
  if (
    modifiers.some((modifier) => !modifier) ||
    HOTKEY_MODIFIERS[mainToken.toLowerCase()]
  )
    throw new Error(`Invalid hotkey "${value}". Example: {{hotkey:Ctrl+C}}.`)

  const special = HOTKEY_SPECIAL_KEYS[mainToken.toLowerCase()]
  const functionKey = /^f([1-9]|1[0-2])$/i.test(mainToken)
    ? { key: mainToken.toUpperCase(), code: mainToken.toUpperCase() }
    : undefined
  const character = mainToken.length === 1 ? mainToken.toLowerCase() : undefined
  const main =
    special ??
    functionKey ??
    (character
      ? { key: character, code: physicalKey(character).code }
      : undefined)
  const keysym = main ? keyboardKeysym(main.key) : undefined
  if (!main || keysym === undefined)
    throw new Error(`Unsupported hotkey "${value}".`)

  rfb.focus({ preventScroll: true })
  for (const modifier of modifiers) {
    sendKey(keyboardKeysym(modifier.key)!, modifier.code, true)
    await wait(22)
  }
  sendKey(keysym, main.code, true)
  await wait(22)
  sendKey(keysym, main.code, false)
  for (const modifier of [...modifiers].reverse()) {
    await wait(22)
    sendKey(keyboardKeysym(modifier.key)!, modifier.code, false)
  }
}

async function sendCommandSteps(
  rfb: RFB,
  sendKey: (keysym: number, code?: string, down?: boolean) => void,
  steps: CommandSendStep[]
) {
  for (const step of steps) {
    if (step.type === 'text') {
      if (step.value) await typeText(rfb, sendKey, step.value)
    } else if (step.type === 'sleep') {
      await wait(step.milliseconds)
    } else {
      await sendHotkey(rfb, sendKey, step.value)
    }
  }
}

async function sendClipboardAndPaste(rfb: RFB, text: string) {
  // QEMU/Linux text consoles generally have no guest clipboard provider.
  // Inject the text as native VNC key events into this RFB only. This keeps the
  // action independent from keyboard broadcast and does not append Enter.
  await typeText(rfb, rfb.sendKey.bind(rfb), text, false)
}

function ConsoleTile({
  session,
  onState,
  register,
  expanded,
  onToggleExpand,
  onActivate,
  onRegistryChange,
  onChangePassword,
  onReload,
  onClose,
  starred = false,
  onToggleStar,
  compact = false,
  listItem = false,
  hoverZoom = false,
  hoverZoomLevel = 3,
  hoverZoomWidth = 480,
  hoverZoomMode = 'full',
  registerTerminal,
  onTerminalInput,
  onUpload,
}: {
  session: ConsoleSession
  onState: (state: SessionState, message?: string) => void
  register: (rfb?: RFB) => void
  expanded: boolean
  onToggleExpand: () => void
  onActivate: () => void
  onRegistryChange: () => void
  onChangePassword: () => void
  onReload: () => Promise<void>
  onClose: () => void
  starred?: boolean
  onToggleStar?: () => void
  compact?: boolean
  listItem?: boolean
  hoverZoom?: boolean
  hoverZoomLevel?: number
  hoverZoomWidth?: number
  hoverZoomMode?: 'full' | 'lens'
  registerTerminal?: (send?: (data: string) => void) => void
  onTerminalInput?: (data: string) => void
  onUpload?: () => void
}) {
  const targetRef = useRef<HTMLDivElement>(null)
  const onStateRef = useRef(onState)
  const registerRef = useRef(register)
  const registryChangeRef = useRef(onRegistryChange)
  const terminalInputRef = useRef(onTerminalInput)
  const clientRef = useRef<RFB | undefined>(undefined)
  const lensRef = useRef<HTMLCanvasElement>(null)
  const [magnifying, setMagnifying] = useState(false)
  const [sendingClipboard, setSendingClipboard] = useState(false)
  const [reloading, setReloading] = useState(false)

  useEffect(() => {
    onStateRef.current = onState
    registerRef.current = register
    registryChangeRef.current = onRegistryChange
    terminalInputRef.current = onTerminalInput
  }, [onState, register, onRegistryChange, onTerminalInput])

  useEffect(() => {
    if (!session.url || !targetRef.current) return
    let client: RFB | undefined
    try {
      client = new RFB(
        targetRef.current,
        session.websocketUrl ?? consoleWebSocketUrl(session.url),
        {
          shared: true,
        }
      )
      client.scaleViewport = true
      client.resizeSession = false
      // RFB blocks programmatic sendKey calls in view-only mode. Interaction is
      // instead isolated by disabling pointer events on the canvas container.
      client.viewOnly = false
      client.focusOnClick = true
      client.qualityLevel = 5
      client.compressionLevel = 6
      clientRef.current = client
      registerRef.current(client)
      const connected = () => {
        if (client) registerRef.current(client)
        registryChangeRef.current()
        client?.focus({ preventScroll: true })
        onStateRef.current('connected')
      }
      const disconnected = (event: Event) => {
        registerRef.current(undefined)
        registryChangeRef.current()
        const clean = Boolean(
          (event as CustomEvent<{ clean?: boolean }>).detail?.clean
        )
        onStateRef.current(
          clean ? 'disconnected' : 'error',
          clean ? undefined : 'VNC connection closed unexpectedly.'
        )
      }
      const credentials = () => {
        registerRef.current(undefined)
        registryChangeRef.current()
        onStateRef.current(
          'error',
          'The VNC gateway requested credentials that were not supplied by the console API.'
        )
      }
      const securityFailure = () => {
        registerRef.current(undefined)
        registryChangeRef.current()
        onStateRef.current('error', 'The VNC gateway rejected the session.')
      }
      client.addEventListener('connect', connected)
      client.addEventListener('disconnect', disconnected)
      client.addEventListener('credentialsrequired', credentials)
      client.addEventListener('securityfailure', securityFailure)
      return () => {
        registerRef.current(undefined)
        clientRef.current = undefined
        registryChangeRef.current()
        client?.disconnect()
      }
    } catch (error) {
      onStateRef.current(
        'error',
        error instanceof Error ? error.message : 'Could not start noVNC.'
      )
    }
  }, [session.url, session.websocketUrl])

  useEffect(() => {
    if (!session.terminalTicket || !targetRef.current) return
    const host = targetRef.current
    const terminal = new Xterm({
      cursorBlink: true,
      cursorStyle: 'block',
      convertEol: true,
      fontFamily: 'Cascadia Mono, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: {
        background: '#000000',
        foreground: '#e4e4e7',
        cursor: '#fafafa',
        selectionBackground: '#3f3f46',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    const base = new URL(
      apiClient.defaults.baseURL ?? '/api/v1',
      window.location.origin
    )
    const endpoint = new URL(
      `${base.pathname.replace(/\/$/, '')}/teleport-links/tsh/terminal/ws`,
      base.origin
    )
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    endpoint.searchParams.set('ticket', session.terminalTicket)
    const socket = new WebSocket(endpoint)
    registerTerminal?.((data) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'input', data }))
    })
    const resize = () => {
      fit.fit()
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            type: 'resize',
            cols: terminal.cols,
            rows: terminal.rows,
          })
        )
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    const input = terminal.onData((data) => {
      onActivate()
      if (terminalInputRef.current) terminalInputRef.current(data)
      else if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'input', data }))
    })
    socket.onopen = () => {
      resize()
      terminal.focus()
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as {
        type: string
        data?: string
        message?: string
        state?: string
      }
      if (message.type === 'output' && message.data)
        terminal.write(message.data)
      if (message.type === 'status')
        onState(
          message.state === 'ready' ? 'connected' : 'opening',
          message.message
        )
      if (message.type === 'error')
        onState('error', message.message || 'Teleport terminal error')
    }
    socket.onclose = (event) => {
      if (event.code !== 1000)
        onState(
          'disconnected',
          event.reason || 'Teleport terminal disconnected'
        )
    }
    socket.onerror = () =>
      onState('error', 'Teleport terminal connection failed')
    return () => {
      observer.disconnect()
      input.dispose()
      registerTerminal?.(undefined)
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'close' }))
      socket.close()
      terminal.dispose()
    }
    // The terminal must survive status updates from its own socket. Recreating
    // it on each parent render would immediately close the SSH session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.terminalTicket])

  const updateMagnifier = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!hoverZoom || !targetRef.current || !lensRef.current) return
    const source = targetRef.current.querySelector<HTMLCanvasElement>(
      'canvas:not([data-console-lens])'
    )
    if (!source) return
    const sourceRect = source.getBoundingClientRect()
    if (!sourceRect.width || !sourceRect.height) return
    const lens = lensRef.current
    const x = Math.min(
      Math.max(event.clientX - sourceRect.left, 0),
      sourceRect.width
    )
    const y = Math.min(
      Math.max(event.clientY - sourceRect.top, 0),
      sourceRect.height
    )
    const sourceX = (x / sourceRect.width) * source.width
    const sourceY = (y / sourceRect.height) * source.height
    const zoom = hoverZoomLevel
    if (hoverZoomMode === 'full') {
      const requestedWidth =
        hoverZoomWidth === -1 ? window.innerWidth * 0.9 : hoverZoomWidth
      const renderWidth = Math.min(
        1920,
        Math.max(
          source.width,
          Math.round(requestedWidth * window.devicePixelRatio)
        )
      )
      const targetHeight = Math.max(
        1,
        Math.round(renderWidth * (source.height / source.width))
      )
      if (lens.width !== renderWidth || lens.height !== targetHeight) {
        lens.width = renderWidth
        lens.height = targetHeight
      }
    } else if (lens.width !== 960 || lens.height !== 600) {
      lens.width = 960
      lens.height = 600
    }
    const context = lens.getContext('2d')
    if (!context) return
    context.imageSmoothingEnabled = false
    context.clearRect(0, 0, lens.width, lens.height)
    if (hoverZoomMode === 'full') {
      context.drawImage(
        source,
        0,
        0,
        source.width,
        source.height,
        0,
        0,
        lens.width,
        lens.height
      )
    } else {
      const cropWidth = lens.width / zoom
      const cropHeight = lens.height / zoom
      context.drawImage(
        source,
        Math.max(
          0,
          Math.min(source.width - cropWidth, sourceX - cropWidth / 2)
        ),
        Math.max(
          0,
          Math.min(source.height - cropHeight, sourceY - cropHeight / 2)
        ),
        cropWidth,
        cropHeight,
        0,
        0,
        lens.width,
        lens.height
      )
    }
    context.fillStyle = 'rgba(0, 0, 0, 0.12)'
    context.fillRect(6, 6, 48, 22)
    context.fillStyle = 'rgba(255, 255, 255, 0.28)'
    context.font = '500 13px sans-serif'
    context.fillText(hoverZoomMode === 'full' ? 'FULL' : `${zoom}Ã—`, 13, 21)
    const aspectRatio = lens.height / lens.width
    const maxWidth =
      hoverZoomMode === 'full'
        ? window.innerWidth * 0.9
        : window.innerWidth - 16
    const maxHeight =
      hoverZoomMode === 'full'
        ? window.innerHeight * 0.9
        : window.innerHeight - 16
    let displayWidth = Math.min(
      hoverZoomWidth === -1 ? maxWidth : hoverZoomWidth,
      maxWidth
    )
    let displayHeight = displayWidth * aspectRatio
    if (displayHeight > maxHeight) {
      displayHeight = maxHeight
      displayWidth = displayHeight / aspectRatio
    }
    displayWidth = Math.round(displayWidth)
    displayHeight = Math.round(displayHeight)
    const left =
      hoverZoomMode === 'full'
        ? hoverZoomWidth === -1
          ? Math.round((window.innerWidth - displayWidth) / 2)
          : event.clientX < window.innerWidth / 2
            ? window.innerWidth - displayWidth - 16
            : 16
        : Math.max(
            8,
            Math.min(window.innerWidth - displayWidth - 8, event.clientX + 18)
          )
    const top =
      hoverZoomMode === 'full'
        ? Math.max(16, Math.round((window.innerHeight - displayHeight) / 2))
        : Math.max(
            8,
            Math.min(window.innerHeight - displayHeight - 8, event.clientY + 18)
          )
    lens.style.left = `${left}px`
    lens.style.top = `${top}px`
    lens.style.width = `${displayWidth}px`
    lens.style.height = `${displayHeight}px`
    lens.style.display = 'block'
  }

  return (
    <Card
      className={`relative flex h-full min-h-0 flex-col gap-0 overflow-hidden py-0 transition-[border-color,box-shadow] duration-150 ease-out ${hoverZoom && magnifying ? 'border-amber-400 ring-4 ring-amber-400 ring-offset-2 ring-offset-background dark:border-yellow-300 dark:ring-yellow-300' : ''}`}
      onClickCapture={(event) => {
        if (
          compact ||
          listItem ||
          (event.target as HTMLElement).tagName === 'CANVAS'
        )
          onActivate()
      }}
      onPointerMoveCapture={
        listItem
          ? (event) => {
              if (hoverZoom) setMagnifying(true)
              updateMagnifier(event)
            }
          : undefined
      }
      onPointerLeave={
        listItem
          ? () => {
              setMagnifying(false)
              if (lensRef.current) lensRef.current.style.display = 'none'
            }
          : undefined
      }
    >
      <div
        className={`relative z-10 flex items-center gap-2 border-b ${listItem ? 'h-11 px-3' : compact ? 'h-8 px-2' : 'h-11 px-3'}`}
        onClick={onActivate}
      >
        <Monitor className='size-4' />
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <span className='min-w-0 flex-1 cursor-help truncate text-sm font-medium'>
              {session.server.private_ip?.[0]?.ip_address ?? '—'} ·{' '}
              {session.server.name}
            </span>
          </TooltipTrigger>
          <TooltipContent
            side='bottom'
            align='start'
            className='w-80 max-w-[calc(100vw-2rem)] space-y-2 border-slate-700 bg-slate-950 p-3 text-xs text-slate-100 shadow-xl'
          >
            <p className='truncate text-sm font-semibold text-white'>
              {session.server.private_ip?.[0]?.ip_address ?? '—'} ·{' '}
              {session.server.name}
            </p>
            <div className='grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-slate-300'>
              <span>Teleport IP</span>
              <code
                className='truncate text-white'
                title={session.server.private_ip?.[0]?.ip_address}
              >
                {session.server.private_ip?.[0]?.ip_address ?? '—'}
              </code>
              <span>Teleport labels</span>
              <span className='truncate text-white'>
                {session.server.server_type || 'â€”'}
              </span>
              <span>Zone</span>
              <span className='truncate text-white'>
                {session.server.zone_display_name || 'â€”'}
              </span>
              <span>Private IP</span>
              <span
                className='truncate font-mono text-white'
                title={(session.server.private_ip ?? [])
                  .map((item) => item.ip_address)
                  .join(', ')}
              >
                {(session.server.private_ip ?? [])
                  .map((item) => item.ip_address)
                  .join(', ') || 'â€”'}
              </span>
              <span>Elastic IP</span>
              <span
                className='truncate font-mono text-white'
                title={(session.server.elastic_ip ?? [])
                  .map((item) => item.ip_address)
                  .join(', ')}
              >
                {(session.server.elastic_ip ?? [])
                  .map((item) => item.ip_address)
                  .join(', ') || 'â€”'}
              </span>
              <span>Bandwidth</span>
              <span className='text-white'>
                {session.server.bandwidth != null
                  ? `${session.server.bandwidth} Mbps`
                  : 'â€”'}
              </span>
              <span>Power state</span>
              <span className='text-white capitalize'>
                {session.server.power_state || 'unknown'}
              </span>
            </div>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={`size-2.5 shrink-0 rounded-full ring-2 ring-background ${session.state === 'connected' ? 'bg-emerald-500' : session.state === 'error' ? 'bg-red-500' : session.state === 'disconnected' ? 'bg-slate-400' : session.state === 'opening' ? 'animate-pulse bg-amber-500' : 'bg-blue-400'}`}
              aria-label={`Console status: ${session.state}`}
            />
          </TooltipTrigger>
          <TooltipContent side='bottom'>Status: {session.state}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type='button'
              variant='ghost'
              size='icon'
              className={`size-7 shrink-0 ${
                starred
                  ? 'text-amber-500 hover:text-amber-600'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              aria-label={
                starred
                  ? `Remove star from ${session.server.name}`
                  : `Mark ${session.server.name} for attention`
              }
              onClick={(event) => {
                event.stopPropagation()
                onToggleStar?.()
              }}
            >
              <Star
                className='size-3.5'
                fill={starred ? 'currentColor' : 'none'}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side='bottom'>
            {starred ? 'Remove attention mark' : 'Mark for attention'}
          </TooltipContent>
        </Tooltip>
        {false && !compact && !listItem && (
          <Button
            variant='outline'
            size='sm'
            className='h-7 px-2 text-xs'
            disabled={session.state !== 'connected'}
            onClick={(event) => {
              event.stopPropagation()
              clientRef.current?.sendCtrlAltDel()
            }}
          >
            Send CtrlAltDel
          </Button>
        )}
        {false && !compact && !listItem && (
          <Button
            variant='outline'
            size='sm'
            className='h-7 px-2 text-xs'
            disabled={session.state !== 'connected' || sendingClipboard}
            onClick={async (event) => {
              event.stopPropagation()
              const text = window.prompt(
                'Clipboard text to send and paste into this console'
              )
              const client = clientRef.current
              if (text === null || !client) return
              setSendingClipboard(true)
              try {
                onActivate()
                await sendClipboardAndPaste(client, text)
                toast.success(`Clipboard text sent to ${session.server.name}.`)
              } catch {
                toast.error(
                  `Could not send clipboard text to ${session.server.name}.`
                )
              } finally {
                setSendingClipboard(false)
              }
            }}
          >
            {sendingClipboard && <Loader2 className='animate-spin' />}
            {sendingClipboard ? 'Sendingâ€¦' : 'Send Clipboard'}
          </Button>
        )}
        {false && !compact && !listItem && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type='button'
                variant='ghost'
                size='icon'
                className='size-8'
                aria-label={`Change password for ${session.server.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onChangePassword()
                }}
              >
                <KeyRound />
              </Button>
            </TooltipTrigger>
            <TooltipContent side='bottom'>Change password</TooltipContent>
          </Tooltip>
        )}
        {!compact && !listItem && onUpload && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type='button'
                variant='ghost'
                size='icon'
                className='size-8 text-primary hover:bg-primary/10 hover:text-primary'
                aria-label={`Upload file to ${session.server.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onUpload()
                }}
              >
                <Upload />
              </Button>
            </TooltipTrigger>
            <TooltipContent side='bottom'>
              Upload file to this VM
            </TooltipContent>
          </Tooltip>
        )}
        {!compact && !listItem && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type='button'
                variant='ghost'
                size='icon'
                className='size-8'
                disabled={reloading}
                aria-label='Reload Cloud VNC console'
                onClick={async (event) => {
                  event.stopPropagation()
                  setReloading(true)
                  try {
                    await onReload()
                    toast.success(`Reloading ${session.server.name} console.`)
                  } catch {
                    toast.error(
                      `Could not reload ${session.server.name} console.`
                    )
                  } finally {
                    setReloading(false)
                  }
                }}
              >
                <RefreshCw className={reloading ? 'animate-spin' : ''} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side='bottom'>
              Reload Cloud VNC console
            </TooltipContent>
          </Tooltip>
        )}
        {session.url && !compact && !listItem && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant='ghost' size='icon' className='size-8' asChild>
                <a
                  href={session.url}
                  target='_blank'
                  rel='noopener noreferrer'
                  aria-label={`Open ${session.server.name} in a new tab`}
                >
                  <ExternalLink />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent side='bottom'>Open VM in a new tab</TooltipContent>
          </Tooltip>
        )}
        {!compact && !listItem && (
          <Button
            variant='ghost'
            size='icon'
            className='size-8'
            onClick={(event) => {
              event.stopPropagation()
              onToggleExpand()
            }}
            aria-label={
              expanded
                ? `Restore ${session.server.name}`
                : `Expand ${session.server.name}`
            }
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </Button>
        )}
        {!compact && !listItem && (
          <Button
            variant='ghost'
            size='icon'
            className='size-8 text-destructive hover:text-destructive'
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
            aria-label={`Close ${session.server.name} console`}
          >
            <X />
          </Button>
        )}
      </div>
      <CardContent
        className={
          listItem
            ? 'pointer-events-none absolute inset-0 min-h-0 overflow-hidden bg-black p-0 opacity-0'
            : 'min-h-0 flex-1 bg-black p-0'
        }
      >
        <div
          ref={targetRef}
          className={`relative flex h-full items-center justify-center overflow-hidden text-sm text-white/70 ${compact && !hoverZoom ? 'pointer-events-none min-h-0' : compact ? 'min-h-0' : 'min-h-64'}`}
          onPointerMoveCapture={(event) => {
            if (hoverZoom) event.stopPropagation()
            if (hoverZoom) setMagnifying(true)
            updateMagnifier(event)
          }}
          onPointerLeave={() => {
            setMagnifying(false)
            if (lensRef.current) lensRef.current.style.display = 'none'
          }}
        >
          {session.state === 'queued' && 'Waiting for a connection slot'}
          {session.state === 'opening' && (
            <Loader2 className='size-6 animate-spin' />
          )}
          {session.state === 'error' && (
            <span className='max-w-md p-5 text-center text-red-300'>
              {session.message}
            </span>
          )}
          {createPortal(
            <canvas
              ref={lensRef}
              data-console-lens
              width={960}
              height={600}
              className='pointer-events-none fixed z-[100] hidden rounded-lg border-2 border-primary bg-black shadow-2xl'
              aria-hidden='true'
            />,
            document.body
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function MultiConsoleDialog({
  open,
  onOpenChange,
  servers,
  teleportLinkId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  servers: ServerRow[]
  teleportLinkId?: string
}) {
  const startWindowPointerDrag = useWindowPointerDrag(open)
  const currentUser = useAuthStore((state) => state.auth.user)
  const project = useCloudStore((state) => state.project)
  const isAdmin =
    (typeof currentUser?.role === 'string'
      ? currentUser.role
      : currentUser?.role?.name) === 'admin'
  const canManageServerOperations = ['admin', 'operator'].includes(
    typeof currentUser?.role === 'string'
      ? currentUser.role
      : (currentUser?.role?.name ?? '')
  )
  const [sessions, setSessions] = useState<ConsoleSession[]>([])
  const [sshLogin, setSshLogin] = useState('root')
  const [command, setCommand] = useState('')
  const [broadcast, setBroadcast] = useState(false)
  const [runToAllConsoles, setRunToAllConsoles] = useState(true)
  const [reviewSharedVariablesBeforeRun, setReviewSharedVariablesBeforeRun] =
    useState(true)
  const [sharedVariableRunReviewOpen, setSharedVariableRunReviewOpen] =
    useState(false)
  const [sending, setSending] = useState(false)
  const [reloadingFailedConsoles, setReloadingFailedConsoles] = useState(false)
  const [expandedId, setExpandedId] = useState<string>()
  const [activeId, setActiveId] = useState<string>()
  const [inputReadyCount, setInputReadyCount] = useState(0)
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>(() =>
    servers.map((server) => server.id)
  )
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [passwordCandidates, setPasswordCandidates] = useState<ServerRow[]>([])
  const [passwordTargetIds, setPasswordTargetIds] = useState<string[]>([])
  const [passwordMode, setPasswordMode] =
    useState<MultiConsolePasswordMode>('manual')
  const [passwordProfileId, setPasswordProfileId] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordResults, setPasswordResults] = useState<
    Array<{ server_id: string; status: string; error?: string }>
  >([])
  const uploadResultColumns = useMemo<ColumnDef<UploadResult>[]>(
    () => [
      {
        id: 'vm',
        header: 'Teleport VM',
        cell: ({ row }) => (
          <div className='min-w-48'>
            <div className='font-mono font-medium'>{row.original.ip}</div>
            <div className='text-xs text-muted-foreground'>
              {row.original.name}
              {row.original.error ? ` · ${row.original.error}` : ''}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'progress',
        header: 'Progress',
        cell: ({ row }) => (
          <div className='min-w-24'>
            <div className='h-1.5 overflow-hidden rounded-full bg-muted'>
              <div
                className='h-full bg-primary transition-all'
                style={{
                  width: `${row.original.status === 'success' ? 100 : row.original.progress}%`,
                }}
              />
            </div>
            <span className='mt-1 block text-xs'>
              {row.original.status === 'success'
                ? '100%'
                : row.original.status === 'uploading'
                  ? `${row.original.progress}%`
                  : '—'}
            </span>
          </div>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Result',
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.status === 'failed' ? 'destructive' : 'outline'
            }
            className={
              row.original.status === 'success'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : ''
            }
          >
            {row.original.status}
          </Badge>
        ),
      },
    ],
    []
  )
  const [controlWidth, setControlWidth] = useState(460)
  const [serverPanelHeight, setServerPanelHeight] = useState(280)
  const [customVariables, setCustomVariables] = useState<
    Record<string, Record<string, string>>
  >({})
  const [customVariableNames, setCustomVariableNames] = useState<string[]>([])
  const [sharedVariables, setSharedVariables] = useState<
    Record<string, string>
  >({})
  const [sharedVariableName, setSharedVariableName] = useState('')
  const [sharedVariableValue, setSharedVariableValue] = useState('')
  const [draftSharedName, setDraftSharedName] = useState('')
  const [draftSharedValue, setDraftSharedValue] = useState('')
  const [sequenceStart, setSequenceStart] = useState('1')
  const [sequenceStep, setSequenceStep] = useState('1')
  const [sequencePad, setSequencePad] = useState('2')
  const [variablesOpen, setVariablesOpen] = useState(false)
  const [commandsOpen, setCommandsOpen] = useState(false)
  const [commandEditorOpen, setCommandEditorOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadFile, setUploadFile] = useState<File>()
  const [uploadRemotePath, setUploadRemotePath] = useState('/tmp')
  const [uploadingFile, setUploadingFile] = useState(false)
  const [uploadTargetIds, setUploadTargetIds] = useState<string[]>([])
  const [uploadResults, setUploadResults] = useState<
    Array<{
      id: string
      name: string
      ip: string
      status: 'queued' | 'uploading' | 'success' | 'failed'
      progress: number
      error?: string
    }>
  >([])
  const [helpTopic, setHelpTopic] = useState<HelpTopic>()
  const [cliCommands, setCliCommands] = useState<CliCommandRecord[]>([])
  const [commandsLoading, setCommandsLoading] = useState(false)
  const [commandsSaving, setCommandsSaving] = useState(false)
  const [commandSearch, setCommandSearch] = useState('')
  const [selectedCommandId, setSelectedCommandId] = useState<string>()
  const [starredServerIds, setStarredServerIds] = useState<string[]>([])
  const [commandEditing, setCommandEditing] = useState(true)
  const canEditCliCommand = isAdmin && commandEditing
  const [commandDraft, setCommandDraft] =
    useState<CliCommandDraft>(EMPTY_CLI_COMMAND)
  const [previewServerId, setPreviewServerId] = useState('')
  const [variableSearch, setVariableSearch] = useState('')
  const [variableViewMode, setVariableViewMode] = useState<'raw' | 'preview'>(
    'raw'
  )
  const [highlightedVariable, setHighlightedVariable] = useState('')
  const [previewCursor, setPreviewCursor] = useState<{
    partIndex: number
    offset: number
    sourcePosition: number
  }>()
  const [workspaceLayout, setWorkspaceLayout] = useState<
    'grid' | 'speaker' | 'speaker-list'
  >('grid')
  const [speakerId, setSpeakerId] = useState<string>()
  const [hoverZoom, setHoverZoom] = useState(false)
  const [hoverZoomLevel, setHoverZoomLevel] = useState(3)
  const [hoverZoomWidth, setHoverZoomWidth] = useState(480)
  const [hoverZoomMode, setHoverZoomMode] = useState<'full' | 'lens'>('full')
  const passwordProfiles = useQuery({
    queryKey: ['password-profiles'],
    queryFn: async ({ signal }) =>
      (await apiClient.get<Profile[]>('/password-profiles', { signal })).data,
    enabled: passwordOpen,
  })
  const projectSubnets = useQuery({
    queryKey: ['cloud', project?.id, 'subnets', 'multi-console-gateways'],
    enabled: open && Boolean(project?.id),
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Page<Subnet>>('/cloud/subnets', {
          params: { page_size: 1000 }, signal,
        })
      ).data,
  })
  const rfbs = useRef(new Map<string, RFB>())
  const terminalSenders = useRef(new Map<string, (data: string) => void>())
  const uploadControllers = useRef(new Map<string, AbortController>())
  const originalSendKeys = useRef(
    new Map<string, (keysym: number, code?: string, down?: boolean) => void>()
  )
  const broadcastRef = useRef(false)
  const keyboardTarget = useRef<HTMLDivElement>(null)
  const commandInputRef = useRef<HTMLTextAreaElement>(null)
  const variablesEditorRef = useRef<HTMLTextAreaElement>(null)
  const libraryCommandRef = useRef<HTMLTextAreaElement>(null)
  const variablesFileRef = useRef<HTMLInputElement>(null)
  const serverSelectionAnchorRef = useRef<string | undefined>(undefined)
  const serverSelectionModifiersRef = useRef({ shift: false, additive: false })
  const nextConsoleOpenAtRef = useRef(0)
  const consoleOpenTimersRef = useRef(new Set<number>())
  const pendingCommandRunRef = useRef<
    { sourceCommand: string; selectionOnly: boolean } | undefined
  >(undefined)
  const subnetGatewayById = useMemo(
    () =>
      new Map(
        (projectSubnets.data?.items ?? [])
          .map((subnet) => [subnet.id, subnetGatewayIp(subnet.cidr)] as const)
          .filter(([, gateway]) => Boolean(gateway))
      ),
    [projectSubnets.data?.items]
  )
  const serversToOpen = useMemo(
    () =>
      servers
        .filter((server) => selectedServerIds.includes(server.id))
        .map((server) => ({
          ...server,
          gw_private_ip: (server.private_ip ?? []).map((privateIp) => {
            const subnet = privateIp.subnet
            const subnetId = typeof subnet === 'string' ? subnet : subnet?.id
            return { ip_address: subnetGatewayById.get(subnetId ?? '') ?? '' }
          }),
        })),
    [selectedServerIds, servers, subnetGatewayById]
  )
  const selectableServerCount = servers.length
  const starredServers = servers.filter((server) =>
    starredServerIds.includes(server.id)
  )
  const toggleStarredServer = (serverId: string) => {
    setStarredServerIds((current) =>
      current.includes(serverId)
        ? current.filter((id) => id !== serverId)
        : [...current, serverId]
    )
  }
  const allSelectableServersSelected =
    selectableServerCount > 0 && serversToOpen.length === selectableServerCount
  const updateServerSelection = (
    serverId: string,
    options: { shift?: boolean; additive?: boolean; checked?: boolean } = {}
  ) => {
    if (sessions.length) return
    const serverIndex = servers.findIndex((server) => server.id === serverId)
    const anchorIndex = servers.findIndex(
      (server) => server.id === serverSelectionAnchorRef.current
    )
    if (options.shift && anchorIndex >= 0 && serverIndex >= 0) {
      const [start, end] =
        anchorIndex < serverIndex
          ? [anchorIndex, serverIndex]
          : [serverIndex, anchorIndex]
      const range = servers.slice(start, end + 1).map((server) => server.id)
      setSelectedServerIds((current) => {
        const next = options.additive ? [...current] : []
        for (const id of range) {
          if (!next.includes(id)) next.push(id)
        }
        if (
          current.length <= CONSOLE_WARNING_THRESHOLD &&
          next.length > CONSOLE_WARNING_THRESHOLD
        )
          toast.warning(
            `Opening more than ${CONSOLE_WARNING_THRESHOLD} servers may fail.`
          )
        return next
      })
      return
    }

    serverSelectionAnchorRef.current = serverId
    setSelectedServerIds((current) => {
      const selected = current.includes(serverId)
      const shouldSelect = options.checked ?? !selected
      if (!shouldSelect) return current.filter((id) => id !== serverId)
      if (selected) return current
      if (current.length === CONSOLE_WARNING_THRESHOLD) {
        toast.warning(
          `Opening more than ${CONSOLE_WARNING_THRESHOLD} servers may fail.`
        )
      }
      return [...current, serverId]
    })
  }
  const commandPreviewServer =
    serversToOpen.find((server) => server.id === previewServerId) ??
    servers.find((server) => server.id === activeId) ??
    serversToOpen[0]
  const commandPreviewServerIndex = Math.max(
    0,
    serversToOpen.findIndex((server) => server.id === commandPreviewServer?.id)
  )
  const detectedSharedVariableNames = Array.from(
    new Set(
      Array.from(
        command.matchAll(/\{\{\s*shared\.([a-z][a-z0-9_]*)\s*\}\}/gi),
        (match) => match[1].toLowerCase()
      )
    )
  )
  const pendingSharedVariableNames = Array.from(
    new Set(
      Array.from(
        (pendingCommandRunRef.current?.sourceCommand ?? '').matchAll(
          /\{\{\s*shared\.([a-z][a-z0-9_]*)\s*\}\}/gi
        ),
        (match) => match[1].toLowerCase()
      )
    )
  )
  const effectiveSharedVariables: Record<string, string> = Object.fromEntries([
    ...detectedSharedVariableNames.map((name) => [name, ''] as const),
    ...Object.entries(sharedVariables),
  ])
  const availableServerVariables = serverCommandVariables(serversToOpen)
  const usedVariableCounts = Array.from(
    command.matchAll(/\{\{\s*([\w.]+(?:\[\d+\])?)\s*\}\}/g)
  ).reduce<Record<string, number>>((counts, match) => {
    counts[match[1]] = (counts[match[1]] ?? 0) + 1
    return counts
  }, {})
  const standardVariableRows = [
    ...availableServerVariables.map(([variable, label]) => ({
      variable,
      label,
      type: 'Built-in',
    })),
    ...customVariableNames.map((variable) => ({
      variable: `custom.${variable}`,
      label: 'Imported from Excel',
      type: 'Custom',
    })),
    ...Object.keys(effectiveSharedVariables).map((variable) => ({
      variable: `shared.${variable}`,
      label: 'Same value for every server',
      type: 'Shared',
    })),
  ].map((item) => ({
    ...item,
    preview: commandPreviewServer
      ? renderServerCommand(
          `{{${item.variable}}}`,
          commandPreviewServer,
          customVariables[commandPreviewServer.id],
          effectiveSharedVariables,
          commandPreviewServerIndex
        )
      : '',
    usageCount: usedVariableCounts[item.variable] ?? 0,
  }))
  const variableRows = [
    ...standardVariableRows,
    ...COMMAND_CONTROL_VARIABLES.map((item) => ({
      ...item,
      usageCount: command.split(`{{${item.variable}}}`).length - 1,
    })),
  ].filter((item) =>
    `${item.variable} ${item.label} ${item.type} ${item.preview}`
      .toLowerCase()
      .includes(variableSearch.trim().toLowerCase())
  )
  const renderedCommandParts =
    commandPreviewServer && command
      ? renderServerCommandParts(
          command,
          commandPreviewServer,
          customVariables[commandPreviewServer.id],
          effectiveSharedVariables,
          commandPreviewServerIndex
        )
      : []
  const primaryConsoleId =
    (speakerId && sessions.some((item) => item.server.id === speakerId)
      ? speakerId
      : activeId && sessions.some((item) => item.server.id === activeId)
        ? activeId
        : sessions[0]?.server.id) ?? ''
  const speakerSideCount = Math.max(sessions.length, 1)
  const activeConsoleName = sessions.find((item) => item.server.id === activeId)
    ?.server.name
  const focusedConsoleReady = Boolean(
    activeId &&
    sessions.some(
      (item) => item.server.id === activeId && item.state === 'connected'
    )
  )
  const passwordTargets = passwordCandidates.filter((server) =>
    passwordTargetIds.includes(server.id)
  )
  const updateSession = (
    serverId: string,
    state: SessionState,
    message?: string
  ) =>
    setSessions((current) =>
      current.map((item) =>
        item.server.id === serverId ? { ...item, state, message } : item
      )
    )

  const registerRfb = (serverId: string, rfb?: RFB) => {
    if (!rfb) {
      rfbs.current.delete(serverId)
      originalSendKeys.current.delete(serverId)
      return
    }
    const original = rfb.sendKey.bind(rfb)
    originalSendKeys.current.set(serverId, original)
    ;(rfb as RfbWithKeyboard)._keyboard.onkeyevent = (keysym, code, down) => {
      dispatchNoVncKey(
        broadcastRef.current,
        serverId,
        originalSendKeys.current,
        keysym,
        code,
        down
      )
    }
    rfbs.current.set(serverId, rfb)
  }

  useEffect(() => {
    const opening = sessions.filter((item) => item.state === 'opening').length
    const slots = Math.max(0, CONSOLE_OPEN_CONCURRENCY - opening)
    const queued = sessions.filter((item) => item.state === 'queued')
    const batch = queued.slice(0, slots)
    if (!batch.length) return
    const now = Date.now()
    let nextOpenAt = Math.max(now, nextConsoleOpenAtRef.current)
    const scheduled = batch.map((item) => {
      const delay = nextOpenAt - now
      nextOpenAt += CONSOLE_OPEN_STAGGER_MS
      return { item, delay }
    })
    nextConsoleOpenAtRef.current = nextOpenAt
    const ids = new Set(batch.map((item) => item.server.id))
    setSessions((current) =>
      current.map((item) =>
        ids.has(item.server.id) ? { ...item, state: 'opening' } : item
      )
    )
    for (const { item, delay } of scheduled) {
      const timer = window.setTimeout(() => {
        consoleOpenTimersRef.current.delete(timer)
        void apiClient
          .post<{ url: string; websocket_path?: string }>(
            `/cloud/servers/${item.server.id}/console`
          )
          .then(({ data }) => {
            setSessions((current) =>
              current.map((session) =>
                session.server.id === item.server.id
                  ? {
                      ...session,
                      url: data.url,
                      websocketUrl: data.websocket_path
                        ? backendWebSocketUrl(data.websocket_path)
                        : undefined,
                      state: 'opening',
                    }
                  : session
              )
            )
          })
          .catch(() =>
            updateSession(
              item.server.id,
              'error',
              'Cloud API could not open this console.'
            )
          )
      }, delay)
      consoleOpenTimersRef.current.add(timer)
    }
  }, [sessions])

  useEffect(
    () => () => {
      for (const rfb of rfbs.current.values()) rfb.disconnect()
      rfbs.current.clear()
      originalSendKeys.current.clear()
      for (const timer of consoleOpenTimersRef.current)
        window.clearTimeout(timer)
      consoleOpenTimersRef.current.clear()
    },
    []
  )

  useEffect(() => {
    if (!broadcast) return
    const blockBrowserHotkeys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      )
        return
      event.preventDefault()
    }
    window.addEventListener('keydown', blockBrowserHotkeys, true)
    return () =>
      window.removeEventListener('keydown', blockBrowserHotkeys, true)
  }, [broadcast])

  useEffect(() => {
    if (!commandsOpen) return
    let active = true
    void apiClient
      .get<CliCommandRecord[]>('/cloud/cli-commands')
      .then(({ data }) => {
        if (active) setCliCommands(data)
      })
      .catch(() => {
        if (active) toast.error('Could not load the CLI command library.')
      })
      .finally(() => {
        if (active) setCommandsLoading(false)
      })
    return () => {
      active = false
    }
  }, [commandsOpen])

  const openCommandsLibrary = () => {
    setCommandsLoading(true)
    setCommandsOpen(true)
  }

  const selectCliCommand = (item: CliCommandRecord) => {
    setSelectedCommandId(item.id)
    setCommandEditing(false)
    setCommandDraft({
      name: item.name,
      category: item.category,
      description: item.description,
      command: item.command,
      is_favorite: item.is_favorite,
      shared_variables: item.shared_variables ?? {},
    })
  }

  const editCliCommand = (item?: CliCommandRecord) => {
    if (!isAdmin) return toast.error('Administrator permission is required.')
    setSelectedCommandId(item?.id)
    setCommandEditing(true)
    setCommandDraft(
      item
        ? {
            name: item.name,
            category: item.category,
            description: item.description,
            command: item.command,
            is_favorite: item.is_favorite,
            shared_variables: item.shared_variables ?? {},
          }
        : EMPTY_CLI_COMMAND
    )
  }

  const insertLibraryVariable = (variable: string) => {
    const editor = libraryCommandRef.current
    const token = `{{${variable}}}`
    if (!editor) {
      setCommandDraft((current) => ({
        ...current,
        command: `${current.command}${token}`,
      }))
      return
    }
    const from = editor.selectionStart
    const to = editor.selectionEnd
    setCommandDraft((current) => ({
      ...current,
      command: `${current.command.slice(0, from)}${token}${current.command.slice(to)}`,
    }))
    requestAnimationFrame(() => {
      editor.focus()
      editor.setSelectionRange(from + token.length, from + token.length)
    })
  }

  const normalizedSharedName = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')

  const addSessionSharedVariable = () => {
    const name = normalizedSharedName(sharedVariableName)
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      toast.error('Variable name must start with a letter and use snake_case.')
      return
    }
    setSharedVariables((current) => ({
      ...current,
      [name]: sharedVariableValue,
    }))
    setSharedVariableName('')
    setSharedVariableValue('')
  }

  const addDraftSharedVariable = () => {
    const name = normalizedSharedName(draftSharedName)
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      toast.error('Variable name must start with a letter and use snake_case.')
      return
    }
    setCommandDraft((current) => ({
      ...current,
      shared_variables: {
        ...current.shared_variables,
        [name]: draftSharedValue,
      },
    }))
    setDraftSharedName('')
    setDraftSharedValue('')
  }

  const sequenceToken = () =>
    `[in:start=${Number(sequenceStart) || 0},step=${Number(sequenceStep) || 1},pad=${Math.max(1, Math.min(12, Number(sequencePad) || 1))}]`

  const sequenceBuilder = (insert: (token: string) => void) => (
    <details className='rounded-md border bg-background/70 px-2.5 py-1.5 text-xs'>
      <summary className='cursor-pointer font-medium select-none'>
        Advanced sequence options
      </summary>
      <div className='mt-2 grid grid-cols-[repeat(3,minmax(4.5rem,1fr))_auto] items-end gap-2'>
        <div className='space-y-1'>
          <Label className='text-[10px]'>Start</Label>
          <Input
            type='number'
            value={sequenceStart}
            onChange={(event) => setSequenceStart(event.target.value)}
            className='h-8'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[10px]'>Step</Label>
          <Input
            type='number'
            value={sequenceStep}
            onChange={(event) => setSequenceStep(event.target.value)}
            className='h-8'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[10px]'>Digits</Label>
          <Input
            type='number'
            min={1}
            max={12}
            value={sequencePad}
            onChange={(event) => setSequencePad(event.target.value)}
            className='h-8'
          />
        </div>
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='h-8'
          onClick={() => insert(sequenceToken())}
        >
          Insert sequence
        </Button>
      </div>
      <p className='mt-1.5 font-mono text-[10px] text-muted-foreground'>
        {sequenceToken()}
      </p>
    </details>
  )

  const saveCliCommand = async () => {
    if (!isAdmin) return toast.error('Administrator permission is required.')
    if (!commandDraft.name.trim() || !commandDraft.command.trim()) {
      toast.error('Command name and CLI command are required.')
      return
    }
    setCommandsSaving(true)
    try {
      const payload = {
        ...commandDraft,
        name: commandDraft.name.trim(),
        category: commandDraft.category.trim() || 'General',
        description: commandDraft.description.trim(),
      }
      const { data } = selectedCommandId
        ? await apiClient.patch<CliCommandRecord>(
            `/cloud/cli-commands/${selectedCommandId}`,
            payload
          )
        : await apiClient.post<CliCommandRecord>('/cloud/cli-commands', payload)
      setCliCommands((current) =>
        selectedCommandId
          ? current.map((item) => (item.id === data.id ? data : item))
          : [data, ...current]
      )
      selectCliCommand(data)
      toast.success(
        selectedCommandId ? 'CLI command updated.' : 'CLI command saved.'
      )
    } catch {
      toast.error(
        'Could not save the CLI command. Make sure its name is unique.'
      )
    } finally {
      setCommandsSaving(false)
    }
  }

  const deleteCliCommand = async (item: CliCommandRecord) => {
    if (!isAdmin) return toast.error('Administrator permission is required.')
    if (!window.confirm(`Delete CLI command "${item.name}"?`)) return
    try {
      await apiClient.delete(`/cloud/cli-commands/${item.id}`)
      setCliCommands((current) =>
        current.filter((commandItem) => commandItem.id !== item.id)
      )
      if (selectedCommandId === item.id) editCliCommand()
      toast.success('CLI command deleted.')
    } catch {
      toast.error('Could not delete the CLI command.')
    }
  }

  const clearPendingConsoleOpens = () => {
    for (const timer of consoleOpenTimersRef.current) window.clearTimeout(timer)
    consoleOpenTimersRef.current.clear()
    nextConsoleOpenAtRef.current = 0
  }

  const start = async () => {
    if (!serversToOpen.length) return toast.error('Select at least one server.')
    if (!teleportLinkId) return toast.error('Select a Teleport link first.')
    setBroadcast(false)
    broadcastRef.current = false
    setExpandedId(undefined)
    setActiveId(undefined)
    setSpeakerId(undefined)
    rfbs.current.clear()
    originalSendKeys.current.clear()
    clearPendingConsoleOpens()
    setInputReadyCount(0)
    setSessions(
      serversToOpen.map((server) => ({
        server,
        state: 'opening',
        message: 'Authorizing Teleport terminal…',
      }))
    )
    const next = await Promise.all(
      serversToOpen.map(async (server): Promise<ConsoleSession> => {
        try {
          const { data } = await apiClient.post<{
            ticket: string
            resolved_host?: string
          }>(`/teleport-links/${teleportLinkId}/tsh/terminal-ticket`, {
            host: server.name,
            login: sshLogin.trim() || 'root',
          })
          return {
            server,
            terminalTicket: data.ticket,
            state: 'opening',
            message: `Connecting to ${data.resolved_host ?? server.name}…`,
          }
        } catch (error) {
          return {
            server,
            state: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Could not authorize Teleport terminal.',
          }
        }
      })
    )
    setSessions(next)
  }

  const generatePassword = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(18))
    const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const random = Array.from(
      bytes,
      (value) => alphabet[value % alphabet.length]
    ).join('')
    setNewPassword(`Aa1!${random}`)
  }

  const openPasswordDialog = (targets: ServerRow[]) => {
    if (!canManageServerOperations)
      return toast.error('Operator permission is required.')
    setPasswordCandidates(targets)
    setPasswordTargetIds(targets.map((server) => server.id))
    setPasswordResults([])
    setNewPassword('')
    setPasswordOpen(true)
  }

  const changePasswords = async () => {
    if (!canManageServerOperations)
      return toast.error('Operator permission is required.')
    if (
      !passwordTargets.length ||
      (passwordMode === 'profile' ? !passwordProfileId : !newPassword)
    )
      return
    setChangingPassword(true)
    try {
      const { data } = await apiClient.post<{
        items: Array<{ server_id: string; status: string; error?: string }>
      }>('/cloud/servers/change-password', {
        server_ids: passwordTargets.map((server) => server.id),
        ...(passwordMode === 'profile'
          ? { profile_id: passwordProfileId }
          : { password: newPassword }),
      })
      setPasswordResults(data.items)
      toast.success(
        `Password request completed for ${data.items.length} server(s).`
      )
    } catch {
      toast.error(
        'Password change failed. Check password complexity and audit logs.'
      )
    } finally {
      setChangingPassword(false)
    }
  }

  const sendCommandNow = async (
    sourceCommand = command,
    selectionOnly = false
  ) => {
    if (teleportLinkId) {
      if (!sourceCommand.trim() || !terminalSenders.current.size) return
      const targets = Array.from(terminalSenders.current.entries()).filter(
        ([id]) => runToAllConsoles || id === activeId
      )
      if (!targets.length) {
        toast.info('Click a connected Teleport terminal to focus it first.')
        return
      }
      setSending(true)
      try {
        for (const [id, send] of targets) {
          const server = sessions.find((item) => item.server.id === id)?.server
          const serverIndex = Math.max(
            0,
            serversToOpen.findIndex((item) => item.id === id)
          )
          const rendered = server
            ? renderServerCommand(
                sourceCommand,
                server,
                customVariables[server.id],
                effectiveSharedVariables,
                serverIndex
              )
            : sourceCommand
          send(`${rendered}\r`)
        }
        toast.success(
          `${selectionOnly ? 'Selected command' : 'Command'} sent to ${targets.length} Teleport terminal(s).`
        )
      } finally {
        setSending(false)
      }
      return
    }
    if (!sourceCommand.trim() || !rfbs.current.size) return
    const targets = Array.from(rfbs.current.entries()).filter(
      ([id]) => runToAllConsoles || id === activeId
    )
    if (!targets.length) {
      toast.info(
        'Click a connected console to focus it before running the command.'
      )
      return
    }
    setSending(true)
    try {
      const renderedTargets = targets.map(([id, rfb]) => {
        const server = sessions.find((item) => item.server.id === id)?.server
        const serverIndex = Math.max(
          0,
          serversToOpen.findIndex((item) => item.id === id)
        )
        const renderedCommand = server
          ? renderServerCommand(
              sourceCommand,
              server,
              customVariables[server.id],
              effectiveSharedVariables,
              serverIndex
            )
          : sourceCommand
        return {
          rfb,
          sendKey: originalSendKeys.current.get(id)!,
          steps: commandSendSteps(renderedCommand),
        }
      })
      await Promise.all(
        renderedTargets.map(({ rfb, sendKey, steps }) =>
          sendCommandSteps(rfb, sendKey, steps)
        )
      )
      toast.success(
        `${selectionOnly ? 'Selected command' : 'Command'} sent to ${targets.length} connected console(s).`
      )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not send the command.'
      )
    } finally {
      setSending(false)
    }
  }

  const cancelSharedVariableRunReview = () => {
    pendingCommandRunRef.current = undefined
    setSharedVariableRunReviewOpen(false)
  }

  const sendCommand = async (
    sourceCommand = command,
    selectionOnly = false
  ) => {
    if (
      /\{\{\s*server\.gw_private_ip(?:_(?:\d+)|\[\d+\])?\s*\}\}/i.test(
        sourceCommand
      ) &&
      (projectSubnets.isLoading || !projectSubnets.data)
    ) {
      toast.info('Loading project subnets to resolve private IP gatewaysâ€¦')
      return
    }
    const usedSharedVariables = Array.from(
      new Set(
        Array.from(
          sourceCommand.matchAll(/\{\{\s*shared\.([a-z][a-z0-9_]*)\s*\}\}/gi),
          (match) => match[1].toLowerCase()
        )
      )
    )
    if (!reviewSharedVariablesBeforeRun || !usedSharedVariables.length)
      return sendCommandNow(sourceCommand, selectionOnly)

    pendingCommandRunRef.current = { sourceCommand, selectionOnly }
    setSharedVariableRunReviewOpen(true)
  }

  const runAfterSharedVariableReview = () => {
    const pending = pendingCommandRunRef.current
    if (!pending) return
    pendingCommandRunRef.current = undefined
    setSharedVariableRunReviewOpen(false)
    void sendCommandNow(pending.sourceCommand, pending.selectionOnly)
  }

  const sendSelectedCommand = async () => {
    const editor = commandInputRef.current
    if (!editor) return
    const selected = editor.value.slice(
      editor.selectionStart,
      editor.selectionEnd
    )
    if (!selected.trim()) {
      toast.info('Highlight the command lines you want to run first.')
      editor.focus()
      return
    }
    await sendCommand(selected, true)
  }

  const uploadTeleportFile = async () => {
    if (
      !teleportLinkId ||
      !uploadFile ||
      !uploadRemotePath.trim() ||
      !serversToOpen.length
    )
      return
    setUploadingFile(true)
    const targets = serversToOpen.filter((server) =>
      uploadTargetIds.includes(server.id)
    )
    if (!targets.length) return
    setUploadResults(
      targets.map((server) => ({
        id: server.id,
        name: server.name,
        ip: server.private_ip?.[0]?.ip_address ?? '—',
        status: 'queued',
        progress: 0,
      }))
    )
    let cursor = 0
    const uploadOne = async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++]
        setUploadResults((current) =>
          current.map((item) =>
            item.id === target.id ? { ...item, status: 'uploading' } : item
          )
        )
        try {
          const controller = new AbortController()
          uploadControllers.current.set(target.id, controller)
          const form = new FormData()
          form.set('host', target.name)
          form.set('login', sshLogin.trim() || 'root')
          form.set('remote_path', uploadRemotePath.trim())
          form.set('file', uploadFile)
          await apiClient.post(
            `/teleport-links/${teleportLinkId}/tsh/files/upload`,
            form,
            {
              timeout: 30 * 60_000,
              signal: controller.signal,
              onUploadProgress: (event) => {
                if (!event.total) return
                const progress = Math.min(
                  99,
                  Math.round((event.loaded / event.total) * 100)
                )
                setUploadResults((current) =>
                  current.map((item) =>
                    item.id === target.id ? { ...item, progress } : item
                  )
                )
              },
            }
          )
          setUploadResults((current) =>
            current.map((item) =>
              item.id === target.id
                ? { ...item, status: 'success', progress: 100 }
                : item
            )
          )
        } catch (error) {
          setUploadResults((current) =>
            current.map((item) =>
              item.id === target.id
                ? {
                    ...item,
                    status: 'failed',
                    error:
                      error instanceof Error ? error.message : 'Upload failed',
                  }
                : item
            )
          )
        }
        uploadControllers.current.delete(target.id)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(2, targets.length) }, uploadOne)
    )
    setUploadingFile(false)
    toast.success('Teleport upload job finished. Review the results below.')
  }

  const cancelTeleportUpload = () => {
    for (const controller of uploadControllers.current.values())
      controller.abort()
    uploadControllers.current.clear()
    setUploadingFile(false)
    setUploadResults((current) =>
      current.map((item) =>
        item.status === 'uploading' || item.status === 'queued'
          ? { ...item, status: 'failed', error: 'Cancelled by user' }
          : item
      )
    )
    toast.info('Upload cancellation requested.')
  }

  useEffect(() => {
    const handleCommandShortcut = (event: KeyboardEvent) => {
      if (event.key !== 'F8' && event.key !== 'F9') return

      // Function keys are reserved for console commands while this modal is
      // open, including when the CLI editor has focus.
      event.preventDefault()

      const canRun =
        !sending &&
        Boolean(command.trim()) &&
        inputReadyCount > 0 &&
        (runToAllConsoles || focusedConsoleReady)
      if (!canRun) return

      if (event.key === 'F8') {
        void sendSelectedCommand()
        return
      }
      void sendCommand()
    }

    window.addEventListener('keydown', handleCommandShortcut)
    return () => window.removeEventListener('keydown', handleCommandShortcut)
  }, [command, focusedConsoleReady, inputReadyCount, runToAllConsoles, sending])

  const insertVariable = (variable: string) => {
    const editor =
      variablesOpen && variableViewMode === 'raw'
        ? variablesEditorRef.current
        : commandInputRef.current
    const placeholder = `{{${variable}}}`
    if (!editor) {
      setCommand((current) => `${current}${placeholder}`)
      return
    }
    const from = editor.selectionStart
    const to = editor.selectionEnd
    setCommand(
      (current) => `${current.slice(0, from)}${placeholder}${current.slice(to)}`
    )
    requestAnimationFrame(() => {
      editor.setSelectionRange(
        from + placeholder.length,
        from + placeholder.length
      )
      if (!variablesOpen || variableViewMode === 'raw') editor.focus()
    })
  }

  const insertVariableFromButton = (
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    const variable = event.currentTarget.dataset.variable
    if (variable) insertVariable(variable)
  }

  const setPreviewCursorFromClick = (event: React.MouseEvent<HTMLElement>) => {
    const partIndex = Number(event.currentTarget.dataset.partIndex)
    const part: RenderedCommandPart | undefined =
      renderedCommandParts[partIndex]
    if (!part) return
    let renderedOffset: number
    const documentWithCaret = event.currentTarget.ownerDocument as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    const caret = documentWithCaret.caretRangeFromPoint?.(
      event.clientX,
      event.clientY
    )
    if (caret && event.currentTarget.contains(caret.startContainer)) {
      const measured = documentWithCaret.createRange()
      measured.selectNodeContents(event.currentTarget)
      measured.setEnd(caret.startContainer, caret.startOffset)
      renderedOffset = measured.toString().length
    } else {
      const rect = event.currentTarget.getBoundingClientRect()
      renderedOffset =
        event.clientX < rect.left + rect.width / 2 ? 0 : part.text.length
    }
    const offset = Math.max(0, Math.min(part.text.length, renderedOffset))
    const sourcePosition = part.variable
      ? offset < part.text.length / 2
        ? part.sourceFrom
        : part.sourceTo
      : Math.min(part.sourceTo, part.sourceFrom + offset)
    commandInputRef.current?.setSelectionRange(sourcePosition, sourcePosition)
    setPreviewCursor({ partIndex, offset, sourcePosition })
  }

  const downloadVariablesTemplate = () => {
    downloadXlsx(
      ['server_id', 'server_name', 'note_file', 'disk_name'],
      serversToOpen.map((server) => [server.id, server.name, '', '']),
      'multi-console-custom-variables.xlsx',
      {
        title: 'MULTI CONSOLE CUSTOM VARIABLES',
        metadata: [
          {
            label: 'Instructions',
            value:
              'Keep server_id and server_name unchanged. Add custom columns using lowercase snake_case names.',
          },
          {
            label: 'Usage',
            value:
              'A column named note_file is available as {{custom.note_file}}.',
          },
          {
            label: 'Safety',
            value:
              'Imported values are inserted exactly as provided into the command.',
          },
        ],
        sheetName: 'Custom variables',
      }
    )
  }

  const importVariables = async (file: File) => {
    try {
      const rows = parseXlsxRows(await file.arrayBuffer())
      const headerIndex = rows.findIndex((row) => {
        const normalized = row.map((value) => value.trim().toLowerCase())
        return (
          normalized.includes('server_id') && normalized.includes('server_name')
        )
      })
      if (headerIndex < 0)
        throw new Error('Headers server_id and server_name were not found.')
      const headers = rows[headerIndex].map((value) =>
        value.trim().toLowerCase()
      )
      if (new Set(headers).size !== headers.length)
        throw new Error('Excel contains duplicate column names.')
      const customHeaders = headers.filter(
        (header) => header !== 'server_id' && header !== 'server_name'
      )
      const invalid = customHeaders.filter(
        (header) => !/^[a-z][a-z0-9_]{0,63}$/.test(header)
      )
      if (invalid.length)
        throw new Error(
          `Invalid custom columns: ${invalid.join(', ')}. Use lowercase snake_case.`
        )
      if (!customHeaders.length)
        throw new Error('Add at least one custom variable column.')
      const idIndex = headers.indexOf('server_id')
      const imported: Record<string, Record<string, string>> = {}
      for (const row of rows.slice(headerIndex + 1)) {
        const serverId = row[idIndex]?.trim()
        if (!serverId) continue
        imported[serverId] = Object.fromEntries(
          customHeaders.map((header) => [
            header,
            row[headers.indexOf(header)]?.trim() ?? '',
          ])
        )
      }
      setCustomVariables(imported)
      setCustomVariableNames(customHeaders)
      toast.success(
        `Imported ${customHeaders.length} custom variable(s) for ${Object.keys(imported).length} server ID(s).`
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not import custom variables.'
      )
    } finally {
      if (variablesFileRef.current) variablesFileRef.current.value = ''
    }
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = controlWidth
    const move = (pointerEvent: PointerEvent) =>
      setControlWidth(
        Math.min(
          Math.min(960, window.innerWidth * 0.72),
          Math.max(240, startWidth + pointerEvent.clientX - startX)
        )
      )
    startWindowPointerDrag(move)
  }

  const startServerPanelResize = (
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = serverPanelHeight
    const move = (pointerEvent: PointerEvent) =>
      setServerPanelHeight(
        Math.min(
          Math.max(150, window.innerHeight * 0.72),
          Math.max(120, startHeight + pointerEvent.clientY - startY)
        )
      )
    startWindowPointerDrag(move)
  }

  const closeConsole = (serverId: string) => {
    terminalSenders.current.delete(serverId)
    rfbs.current.get(serverId)?.disconnect()
    rfbs.current.delete(serverId)
    originalSendKeys.current.delete(serverId)
    setInputReadyCount(
      teleportLinkId ? terminalSenders.current.size : rfbs.current.size
    )
    setSessions((current) =>
      current.filter((item) => item.server.id !== serverId)
    )
    if (activeId === serverId) setActiveId(undefined)
    if (expandedId === serverId) setExpandedId(undefined)
    if (speakerId === serverId) setSpeakerId(undefined)
  }

  const reloadConsole = async (serverId: string) => {
    if (!teleportLinkId) throw new Error('Select a Teleport link first.')
    const server = servers.find((item) => item.id === serverId)
    if (!server) throw new Error('Teleport server was not found.')
    setSessions((current) =>
      current.map((item) =>
        item.server.id === serverId
          ? {
              ...item,
              terminalTicket: undefined,
              state: 'opening',
              message: undefined,
            }
          : item
      )
    )
    try {
      const { data } = await apiClient.post<{
        ticket: string
        resolved_host?: string
      }>(`/teleport-links/${teleportLinkId}/tsh/terminal-ticket`, {
        host: server.name,
        login: sshLogin.trim() || 'root',
      })
      setSessions((current) =>
        current.map((item) =>
          item.server.id === serverId
            ? {
                ...item,
                terminalTicket: data.ticket,
                state: 'opening',
              }
            : item
        )
      )
    } catch (error) {
      updateSession(
        serverId,
        'error',
        'Teleport could not reload this terminal.'
      )
      throw error
    }
  }

  const reloadDisconnectedConsoles = async () => {
    const targets = sessions.filter(
      (session) => session.state === 'error' || session.state === 'disconnected'
    )
    if (!targets.length) {
      toast.info('There are no disconnected consoles to reload.')
      return
    }
    setReloadingFailedConsoles(true)
    let failures = 0
    try {
      for (const [index, session] of targets.entries()) {
        try {
          await reloadConsole(session.server.id)
        } catch {
          failures += 1
        }
        if (index < targets.length - 1) await wait(500)
      }
      if (failures)
        toast.error(
          `Could not reload ${failures} of ${targets.length} disconnected console(s).`
        )
      else
        toast.success(
          `Reloading ${targets.length} disconnected console(s) in sequence.`
        )
    } finally {
      setReloadingFailedConsoles(false)
    }
  }

  const closeWorkspace = () => {
    setBroadcast(false)
    broadcastRef.current = false
    setExpandedId(undefined)
    setSessions([])
    rfbs.current.clear()
    originalSendKeys.current.clear()
    clearPendingConsoleOpens()
    setInputReadyCount(0)
    setCloseConfirmOpen(false)
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setCloseConfirmOpen(true)
          return
        }
        onOpenChange(next)
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (broadcast) event.preventDefault()
        }}
        className='!inset-0 !top-0 !left-0 !h-svh !max-h-svh !w-screen !max-w-none !translate-x-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none border-0 p-2 sm:!h-svh sm:!w-screen sm:!max-w-none'
      >
        <DialogHeader className='h-10 shrink-0 justify-center gap-0 pe-10'>
          <div className='relative flex min-w-0 items-center gap-2'>
            <div className='flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary'>
              <Monitor className='size-4' />
            </div>
            <DialogTitle className='shrink-0'>Multi console</DialogTitle>
            <HelpButton topic='workspace' onOpen={setHelpTopic} />
            <div className='pointer-events-none absolute left-[50vw] flex -translate-x-1/2 items-center gap-2 text-xs whitespace-nowrap'>
              <Badge
                variant='outline'
                className='flex h-7 max-w-[28rem] items-center gap-1.5 rounded-md bg-background px-2 font-normal text-muted-foreground shadow-none'
              >
                <Monitor className='size-3 shrink-0 text-primary' />
                {activeConsoleName ? (
                  <>
                    <span>Active:</span>
                    <span className='truncate font-medium text-foreground'>
                      {activeConsoleName}
                    </span>
                  </>
                ) : (
                  <span>Choose a console</span>
                )}
              </Badge>
              <Badge
                variant='outline'
                className='pointer-events-auto h-7 shrink-0 gap-1.5 rounded-md bg-background px-2 font-normal text-muted-foreground shadow-none'
              >
                <span
                  className={`size-1.5 rounded-full ${inputReadyCount ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`}
                />
                {inputReadyCount} input-ready
              </Badge>
            </div>
          </div>
          <DialogDescription className='sr-only'>
            Broadcast CLI commands or keyboard input to selected Linux servers.
          </DialogDescription>
        </DialogHeader>
        <div
          className='grid min-h-0 flex-1 overflow-visible'
          style={{
            gridTemplateColumns: `${controlWidth}px 6px minmax(0, 1fr)`,
          }}
        >
          <Card className='min-h-0 overflow-hidden py-3'>
            <CardContent className='flex h-full min-h-0 flex-col px-3'>
              <div
                className='flex min-h-0 shrink-0 flex-col'
                style={{ height: serverPanelHeight }}
              >
                <div className='flex shrink-0 items-center gap-1'>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className='inline-flex'>
                        <Checkbox
                          checked={allSelectableServersSelected}
                          disabled={
                            sessions.length > 0 || !selectableServerCount
                          }
                          aria-label={
                            allSelectableServersSelected
                              ? 'Clear server selection'
                              : 'Select all servers'
                          }
                          onCheckedChange={(checked) => {
                            serverSelectionAnchorRef.current = undefined
                            setSelectedServerIds(
                              checked ? servers.map((server) => server.id) : []
                            )
                            if (
                              checked &&
                              servers.length > CONSOLE_WARNING_THRESHOLD
                            )
                              toast.info(
                                `Opening more than ${CONSOLE_WARNING_THRESHOLD} servers may fail.`
                              )
                          }}
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side='top'>
                      {allSelectableServersSelected
                        ? 'Clear selection'
                        : 'Select all servers'}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className='inline-flex'>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon'
                          className='size-7 text-amber-500 hover:bg-amber-500/10 hover:text-amber-600'
                          disabled={
                            sessions.length > 0 || !starredServers.length
                          }
                          aria-label='Select starred servers'
                          onClick={() => {
                            serverSelectionAnchorRef.current = undefined
                            setSelectedServerIds(
                              starredServers.map((server) => server.id)
                            )
                            if (
                              starredServers.length > CONSOLE_WARNING_THRESHOLD
                            )
                              toast.info(
                                `Opening more than ${CONSOLE_WARNING_THRESHOLD} servers may fail.`
                              )
                          }}
                        >
                          <Star className='size-3.5' fill='currentColor' />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side='top'>
                      Select all starred servers ({starredServers.length})
                    </TooltipContent>
                  </Tooltip>
                  <Input
                    aria-label='Teleport SSH user'
                    className='h-7 w-20 px-2 text-xs'
                    disabled={sessions.length > 0}
                    onChange={(event) => setSshLogin(event.target.value)}
                    placeholder='SSH user'
                    value={sshLogin}
                  />
                  <Label className='min-w-0 flex-1'>
                    Servers to open ({serversToOpen.length}/{servers.length}{' '}
                    selected)
                  </Label>
                  {false && canManageServerOperations && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant='secondary'
                          size='icon'
                          className='size-7'
                          aria-label='Change password for selected servers'
                          disabled={!serversToOpen.length}
                          onClick={() => openPasswordDialog(serversToOpen)}
                        >
                          <KeyRound />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side='top'>
                        Change password
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {!sessions.length ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size='icon'
                          className='size-7'
                          aria-label={`Open ${serversToOpen.length} consoles`}
                          onClick={() => void start()}
                          disabled={!serversToOpen.length}
                        >
                          <PlugZap />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side='top'>
                        Open {serversToOpen.length} console(s)
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant='destructive'
                          size='icon'
                          className='size-7'
                          aria-label='Close all consoles'
                          onClick={() => {
                            setBroadcast(false)
                            broadcastRef.current = false
                            setSessions([])
                            rfbs.current.clear()
                            originalSendKeys.current.clear()
                            setInputReadyCount(0)
                          }}
                        >
                          <Unplug />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side='top'>
                        Close all consoles
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <div className='mt-2 min-h-0 space-y-0.5 overflow-y-auto overscroll-contain rounded-md border p-1'>
                  {servers.map((server) => (
                    <div
                      key={server.id}
                      className='flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 hover:bg-muted/60'
                      onClick={(event) => {
                        const target = event.target as HTMLElement
                        if (target.closest('button, input, [role="checkbox"]'))
                          return
                        updateServerSelection(server.id, {
                          shift: event.shiftKey,
                          additive: event.ctrlKey || event.metaKey,
                        })
                      }}
                    >
                      <Checkbox
                        checked={serversToOpen.some(
                          (item) => item.id === server.id
                        )}
                        disabled={sessions.length > 0}
                        onPointerDown={(event) => {
                          serverSelectionModifiersRef.current = {
                            shift: event.shiftKey,
                            additive: event.ctrlKey || event.metaKey,
                          }
                        }}
                        onKeyDown={(event) => {
                          serverSelectionModifiersRef.current = {
                            shift: event.shiftKey,
                            additive: event.ctrlKey || event.metaKey,
                          }
                        }}
                        onCheckedChange={(checked) =>
                          updateServerSelection(server.id, {
                            ...serverSelectionModifiersRef.current,
                            checked: Boolean(checked),
                          })
                        }
                      />
                      <span className='min-w-0 truncate text-xs leading-4'>
                        <span className='font-mono font-medium'>
                          {server.private_ip?.[0]?.ip_address ?? '—'}
                        </span>{' '}
                        <span className='text-muted-foreground'>·</span>{' '}
                        {server.name}
                      </span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type='button'
                            variant='ghost'
                            size='icon'
                            className={`ml-auto size-6 shrink-0 ${
                              starredServerIds.includes(server.id)
                                ? 'text-amber-500 hover:text-amber-600'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                            aria-label={
                              starredServerIds.includes(server.id)
                                ? `Remove star from ${server.name}`
                                : `Mark ${server.name} for attention`
                            }
                            onClick={() => toggleStarredServer(server.id)}
                          >
                            <Star
                              className='size-3.5'
                              fill={
                                starredServerIds.includes(server.id)
                                  ? 'currentColor'
                                  : 'none'
                              }
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side='right'>
                          {starredServerIds.includes(server.id)
                            ? 'Remove attention mark'
                            : 'Mark for attention'}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  ))}
                </div>
              </div>
              <div
                role='separator'
                aria-label='Resize server selection and CLI command panels'
                aria-orientation='horizontal'
                tabIndex={0}
                className='group my-2 flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none'
                onPointerDown={startServerPanelResize}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp')
                    setServerPanelHeight((value) => Math.max(120, value - 16))
                  if (event.key === 'ArrowDown')
                    setServerPanelHeight((value) =>
                      Math.min(
                        Math.max(150, window.innerHeight * 0.72),
                        value + 16
                      )
                    )
                }}
              >
                <div className='h-px w-full bg-border transition-colors group-hover:h-1 group-hover:bg-primary group-focus:h-1 group-focus:bg-primary' />
              </div>
              <div className='flex min-h-0 flex-1 flex-col gap-2'>
                <div className='flex items-center justify-between gap-2'>
                  <div className='flex items-center gap-2'>
                    <Label htmlFor='multi-console-command'>CLI command</Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type='button'
                          role='switch'
                          aria-checked={reviewSharedVariablesBeforeRun}
                          aria-label='Review shared variables before running commands'
                          className='inline-flex items-center gap-1 text-xs text-muted-foreground'
                          onClick={() =>
                            setReviewSharedVariablesBeforeRun((value) => !value)
                          }
                        >
                          <span
                            className={`flex h-4 w-7 items-center rounded-full p-0.5 transition-colors ${reviewSharedVariablesBeforeRun ? 'justify-end bg-primary' : 'justify-start bg-muted-foreground/40'}`}
                          >
                            <span className='size-3 rounded-full bg-background shadow-sm' />
                          </span>
                          Review variables
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side='top'>
                        Review and edit shared variables before running a
                        command.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <div className='flex items-center gap-1'>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon'
                          className='size-7'
                          aria-label='Open large CLI editor'
                          onClick={() => setCommandEditorOpen(true)}
                        >
                          <Maximize2 />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side='top'>
                        Open large CLI editor
                      </TooltipContent>
                    </Tooltip>
                    {teleportLinkId && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type='button'
                            variant='ghost'
                            size='icon'
                            className='size-7 text-primary hover:bg-primary/10 hover:text-primary'
                            aria-label='Upload file to Teleport server'
                            onClick={() => {
                              setUploadTargetIds(
                                serversToOpen.map((server) => server.id)
                              )
                              setUploadResults([])
                              setUploadOpen(true)
                            }}
                          >
                            <Upload />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side='top'>
                          Upload file to active Teleport server
                        </TooltipContent>
                      </Tooltip>
                    )}
                    <span className='mx-0.5 h-4 w-px bg-border' aria-hidden />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon'
                          className='size-7 text-primary hover:bg-primary/10 hover:text-primary'
                          aria-label='Open command library'
                          onClick={openCommandsLibrary}
                        >
                          <BookOpen />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side='top'>
                        Command library
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon'
                          className='size-7 text-primary hover:bg-primary/10 hover:text-primary'
                          aria-label='Open variables and preview'
                          onClick={() => setVariablesOpen(true)}
                        >
                          <Braces />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side='top'>
                        Variables & preview
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                <Textarea
                  ref={commandInputRef}
                  id='multi-console-command'
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder='echo {{server.name}}'
                  spellCheck={false}
                  className='min-h-24 flex-1 resize-none overflow-auto font-mono text-sm leading-5'
                />
                <div className='flex shrink-0 items-center gap-2'>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type='button'
                        role='switch'
                        aria-checked={runToAllConsoles}
                        aria-label={`Run commands on ${runToAllConsoles ? 'all connected consoles' : 'the focused console only'}`}
                        className='inline-flex h-8 w-[4.75rem] shrink-0 items-center gap-1.5 rounded-full border bg-background px-1.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none'
                        onClick={() => setRunToAllConsoles((value) => !value)}
                      >
                        <span
                          className={`flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors ${runToAllConsoles ? 'justify-end bg-foreground' : 'justify-start bg-muted-foreground/40'}`}
                          aria-hidden
                        >
                          <span className='size-3 rounded-full bg-background shadow-sm' />
                        </span>
                        {runToAllConsoles ? 'All' : 'Focus'}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side='top'>
                      {runToAllConsoles
                        ? 'Commands run on every connected console. Click to target only the focused console.'
                        : 'Commands run only on the focused console. Click to target every connected console.'}
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    className='h-8 shrink-0 border-sky-300 px-2 text-xs text-sky-700 hover:bg-sky-50 hover:text-sky-800 dark:border-sky-800 dark:text-sky-300 dark:hover:bg-sky-950/40'
                    onClick={() => void sendCommand()}
                    disabled={
                      sending ||
                      !command.trim() ||
                      !inputReadyCount ||
                      (!runToAllConsoles && !focusedConsoleReady)
                    }
                    aria-keyshortcuts='F9'
                    title='Run command (F9)'
                  >
                    {sending ? <Loader2 className='animate-spin' /> : <Send />}{' '}
                    {sending ? 'Typingâ€¦' : 'Run all (F9)'}
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type='button'
                        size='sm'
                        className='h-8 min-w-0 flex-1'
                        onClick={() => void sendSelectedCommand()}
                        disabled={
                          sending ||
                          !command.trim() ||
                          !inputReadyCount ||
                          (!runToAllConsoles && !focusedConsoleReady)
                        }
                        aria-keyshortcuts='F8'
                      >
                        <Play className='size-3.5' /> Run selection (F8)
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side='top'>
                      Run only highlighted text (F8)
                    </TooltipContent>
                  </Tooltip>
                </div>
                {broadcast && (
                  <p className='text-xs font-medium text-amber-600 dark:text-amber-400'>
                    Click inside one console to focus it before typing.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <div
            role='separator'
            aria-label='Resize control panel'
            aria-orientation='vertical'
            tabIndex={0}
            className='group flex cursor-col-resize touch-none items-center justify-center outline-none'
            onPointerDown={startResize}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft')
                setControlWidth((value) => Math.max(240, value - 16))
              if (event.key === 'ArrowRight')
                setControlWidth((value) =>
                  Math.min(Math.min(960, window.innerWidth * 0.72), value + 16)
                )
            }}
          >
            <div className='h-full w-px bg-border transition-colors group-hover:w-1 group-hover:bg-primary group-focus:w-1 group-focus:bg-primary' />
          </div>

          <div className='relative flex min-h-0 min-w-0 flex-col gap-2 overflow-visible ps-2'>
            <div
              ref={keyboardTarget}
              tabIndex={-1}
              className='absolute -top-10 right-10 z-20 flex h-9 items-center justify-end gap-2 outline-none'
            >
              <Tooltip delayDuration={250}>
                <TooltipTrigger asChild>
                  <Button
                    type='button'
                    variant='outline'
                    size='icon'
                    className='size-8'
                    aria-label='Reload disconnected Cloud VNC consoles'
                    disabled={
                      reloadingFailedConsoles ||
                      !sessions.some(
                        (session) =>
                          session.state === 'error' ||
                          session.state === 'disconnected'
                      )
                    }
                    onClick={() => void reloadDisconnectedConsoles()}
                  >
                    <RefreshCw
                      className={reloadingFailedConsoles ? 'animate-spin' : ''}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side='bottom' className='max-w-72 p-3'>
                  Reload all disconnected Cloud VNC consoles one at a time, with
                  a 0.5-second delay between requests.
                </TooltipContent>
              </Tooltip>
              <Tooltip delayDuration={250}>
                <TooltipTrigger asChild>
                  <Button
                    variant={broadcast ? 'destructive' : 'default'}
                    size='icon'
                    className={`ms-auto size-8 ${broadcast ? 'animate-pulse' : 'bg-amber-500 text-amber-950 hover:bg-amber-400'}`}
                    aria-label={
                      broadcast
                        ? 'Stop keyboard broadcast'
                        : 'Start keyboard broadcast'
                    }
                    disabled={!inputReadyCount}
                    onClick={() => {
                      const next = !broadcast
                      broadcastRef.current = next
                      setBroadcast(next)
                      setTimeout(() => {
                        if (next && activeId)
                          rfbs.current
                            .get(activeId)
                            ?.focus({ preventScroll: true })
                        else keyboardTarget.current?.focus()
                      }, 0)
                    }}
                  >
                    {broadcast ? <Pause /> : <Play />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side='bottom'
                  className='max-w-72 space-y-1.5 p-3'
                >
                  <p className='font-semibold'>
                    {broadcast
                      ? 'Stop keyboard broadcast'
                      : 'Start keyboard broadcast'}
                  </p>
                  <p className='text-xs font-normal text-muted-foreground'>
                    Mirrors physical keystrokes to every input-ready console.
                    Enable it, then click inside one console before typing.
                  </p>
                  <p className='text-xs font-medium text-amber-600 dark:text-amber-400'>
                    Browser hotkeys are blocked while active.
                  </p>
                </TooltipContent>
              </Tooltip>
              {false && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={hoverZoom ? 'default' : 'outline'}
                      size='icon'
                      className='size-8'
                      aria-label={
                        hoverZoom ? 'Disable canvas lens' : 'Enable canvas lens'
                      }
                      onClick={() => setHoverZoom((value) => !value)}
                    >
                      <ZoomIn />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side='bottom'>
                    {hoverZoom ? 'Disable canvas lens' : 'Enable canvas lens'}
                  </TooltipContent>
                </Tooltip>
              )}
              {false && hoverZoom && (
                <div className='flex items-center gap-1.5'>
                  <select
                    aria-label='Zoom display mode'
                    title='Zoom display mode'
                    className='h-8 w-[7.5rem] rounded-md border bg-background px-2 text-xs'
                    value={hoverZoomMode}
                    onChange={(event) => {
                      const mode = event.target.value as 'full' | 'lens'
                      setHoverZoomMode(mode)
                      if (
                        mode === 'lens' &&
                        (hoverZoomWidth === -1 || hoverZoomWidth > 800)
                      )
                        setHoverZoomWidth(800)
                    }}
                  >
                    <option value='full'>Full canvas</option>
                    <option value='lens'>Follow cursor</option>
                  </select>
                  {hoverZoomMode === 'lens' && (
                    <select
                      aria-label='Magnification level'
                      title='Magnification level'
                      className='h-8 w-[4.5rem] rounded-md border bg-background px-2 text-xs'
                      value={hoverZoomLevel}
                      onChange={(event) =>
                        setHoverZoomLevel(Number(event.target.value))
                      }
                    >
                      {[1.5, 2, 2.5, 3, 4, 5].map((value) => (
                        <option key={value} value={value}>
                          {value}Ã—
                        </option>
                      ))}
                    </select>
                  )}
                  <select
                    aria-label='Magnifier window size'
                    title='Magnifier window size'
                    className='h-8 w-[6.5rem] rounded-md border bg-background px-2 text-xs'
                    value={hoverZoomWidth}
                    onChange={(event) =>
                      setHoverZoomWidth(Number(event.target.value))
                    }
                  >
                    <option value={320}>Small</option>
                    <option value={480}>Medium</option>
                    <option value={640}>Large</option>
                    <option value={800}>X-Large</option>
                    {hoverZoomMode === 'full' && (
                      <option value={960}>XX-Large</option>
                    )}
                    {hoverZoomMode === 'full' && (
                      <option value={1200}>1200px</option>
                    )}
                    {hoverZoomMode === 'full' && (
                      <option value={-1}>90% screen</option>
                    )}
                  </select>
                </div>
              )}
              <div className='flex items-center rounded-md border bg-background p-0.5'>
                <Button
                  variant={workspaceLayout === 'grid' ? 'secondary' : 'ghost'}
                  size='icon'
                  className='size-7'
                  title='Grid view'
                  onClick={() => {
                    setWorkspaceLayout('grid')
                    setExpandedId(undefined)
                  }}
                >
                  <LayoutGrid />
                </Button>
                <Button
                  variant={
                    workspaceLayout === 'speaker' ? 'secondary' : 'ghost'
                  }
                  size='icon'
                  className='size-7'
                  title='Speaker view'
                  onClick={() => {
                    setWorkspaceLayout('speaker')
                    setExpandedId(undefined)
                    setSpeakerId(activeId ?? sessions[0]?.server.id)
                  }}
                >
                  <PanelRight />
                </Button>
                <Button
                  variant={
                    workspaceLayout === 'speaker-list' ? 'secondary' : 'ghost'
                  }
                  size='icon'
                  className='size-7'
                  title='Speaker with compact list'
                  onClick={() => {
                    setWorkspaceLayout('speaker-list')
                    setExpandedId(undefined)
                    setSpeakerId(activeId ?? sessions[0]?.server.id)
                  }}
                >
                  <List />
                </Button>
              </div>
            </div>
            {!sessions.length ? (
              <div className='flex min-h-0 flex-1 flex-col items-center justify-center rounded-lg border border-dashed text-center text-muted-foreground'>
                <Monitor className='mb-3 size-12' />
                <p className='font-medium'>
                  Select servers and open the workspace
                </p>
                <p className='text-sm'>
                  Opening more than {CONSOLE_WARNING_THRESHOLD} consoles may
                  fail.
                </p>
              </div>
            ) : (
              <div
                className={`grid min-h-0 flex-1 gap-3 overflow-hidden ${workspaceLayout === 'grid' ? 'auto-rows-[minmax(20rem,1fr)] overflow-y-auto xl:grid-cols-2' : ''}`}
                style={
                  workspaceLayout === 'speaker'
                    ? {
                        gridTemplateColumns:
                          sessions.length > 1
                            ? 'minmax(0, 1fr) 14rem'
                            : 'minmax(0, 1fr)',
                        gridTemplateRows: `repeat(${speakerSideCount}, minmax(0, 1fr))`,
                      }
                    : workspaceLayout === 'speaker-list'
                      ? {
                          gridTemplateColumns:
                            sessions.length > 1
                              ? 'minmax(0, 1fr) 16rem'
                              : 'minmax(0, 1fr)',
                          gridTemplateRows: `repeat(${sessions.length}, 2.75rem) minmax(0, 1fr)`,
                        }
                      : undefined
                }
              >
                {(workspaceLayout === 'speaker' ||
                  workspaceLayout === 'speaker-list') &&
                  sessions.length > 1 &&
                  (() => {
                    const selectedSession = sessions.find(
                      (item) => item.server.id === primaryConsoleId
                    )
                    if (!selectedSession) return null
                    const selectedIndex = sessions.findIndex(
                      (item) => item.server.id === primaryConsoleId
                    )
                    return (
                      <button
                        type='button'
                        aria-current='true'
                        className={`relative z-10 col-start-2 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border-2 border-primary bg-card p-0 text-left ring-2 ring-primary transition-colors ring-inset hover:bg-primary/5 ${workspaceLayout === 'speaker-list' ? 'h-11' : 'h-full'}`}
                        style={{ gridRow: `${selectedIndex + 1}` }}
                        onClick={() => setActiveId(selectedSession.server.id)}
                      >
                        <span
                          className={`flex w-full shrink-0 items-center gap-2 bg-primary/15 px-2 ${workspaceLayout === 'speaker-list' ? 'h-full' : 'h-8 border-b border-primary/40'}`}
                        >
                          <Monitor className='size-4 shrink-0' />
                          <span className='min-w-0 flex-1 truncate text-sm font-semibold text-primary'>
                            {selectedSession.server.name}
                          </span>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                className={`size-2.5 shrink-0 rounded-full ring-2 ring-background ${selectedSession.state === 'connected' ? 'bg-emerald-500' : selectedSession.state === 'error' ? 'bg-red-500' : selectedSession.state === 'disconnected' ? 'bg-slate-400' : selectedSession.state === 'opening' ? 'animate-pulse bg-amber-500' : 'bg-blue-400'}`}
                                aria-label={`Console status: ${selectedSession.state}`}
                              />
                            </TooltipTrigger>
                            <TooltipContent side='bottom'>
                              Selected Â· {selectedSession.state}
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Star
                                className={`size-3.5 shrink-0 ${
                                  starredServerIds.includes(
                                    selectedSession.server.id
                                  )
                                    ? 'text-amber-500'
                                    : 'text-muted-foreground'
                                }`}
                                fill={
                                  starredServerIds.includes(
                                    selectedSession.server.id
                                  )
                                    ? 'currentColor'
                                    : 'none'
                                }
                                aria-label={`${selectedSession.server.name} attention mark`}
                              />
                            </TooltipTrigger>
                            <TooltipContent side='bottom'>
                              {starredServerIds.includes(
                                selectedSession.server.id
                              )
                                ? 'Marked for attention'
                                : 'Not marked for attention'}
                            </TooltipContent>
                          </Tooltip>
                        </span>
                        {workspaceLayout === 'speaker' && (
                          <span className='flex min-h-0 w-full flex-1 items-center justify-center bg-black px-2 text-center text-[11px] text-white/55'>
                            Displayed in main view
                          </span>
                        )}
                      </button>
                    )
                  })()}
                {sessions.map((session) => {
                  const isPrimary = session.server.id === primaryConsoleId
                  const sideIndex = sessions.findIndex(
                    (item) => item.server.id === session.server.id
                  )
                  return (
                    <div
                      key={`${session.server.id}-${session.url ?? 'waiting'}`}
                      className={`${workspaceLayout === 'grid' && expandedId && expandedId !== session.server.id ? 'hidden' : workspaceLayout === 'grid' && expandedId === session.server.id ? 'col-span-full min-h-0' : 'min-h-0'} ${workspaceLayout === 'grid' && activeId === session.server.id ? 'rounded-xl bg-primary/10 p-1 shadow-[0_0_24px_hsl(var(--primary)/0.35)] ring-4 ring-primary' : ''}`}
                      style={
                        workspaceLayout === 'speaker' ||
                        workspaceLayout === 'speaker-list'
                          ? isPrimary
                            ? {
                                gridColumn: '1',
                                gridRow:
                                  workspaceLayout === 'speaker-list'
                                    ? '1 / -1'
                                    : `1 / span ${speakerSideCount}`,
                              }
                            : {
                                gridColumn: '2',
                                gridRow: `${sideIndex + 1}`,
                                height:
                                  workspaceLayout === 'speaker-list'
                                    ? '2.75rem'
                                    : undefined,
                              }
                          : undefined
                      }
                    >
                      <ConsoleTile
                        session={session}
                        expanded={
                          workspaceLayout === 'grid' &&
                          expandedId === session.server.id
                        }
                        compact={workspaceLayout === 'speaker' && !isPrimary}
                        listItem={
                          workspaceLayout === 'speaker-list' && !isPrimary
                        }
                        hoverZoom={hoverZoom}
                        hoverZoomLevel={hoverZoomLevel}
                        hoverZoomWidth={hoverZoomWidth}
                        hoverZoomMode={hoverZoomMode}
                        onToggleExpand={() =>
                          setExpandedId((current) =>
                            current === session.server.id
                              ? undefined
                              : session.server.id
                          )
                        }
                        onActivate={() => {
                          setActiveId(session.server.id)
                          if (
                            (workspaceLayout === 'speaker' ||
                              workspaceLayout === 'speaker-list') &&
                            !isPrimary
                          )
                            setSpeakerId(session.server.id)
                          window.setTimeout(
                            () =>
                              rfbs.current
                                .get(session.server.id)
                                ?.focus({ preventScroll: true }),
                            0
                          )
                        }}
                        onState={(state, message) =>
                          updateSession(session.server.id, state, message)
                        }
                        register={(rfb) => registerRfb(session.server.id, rfb)}
                        registerTerminal={(send) => {
                          if (send)
                            terminalSenders.current.set(session.server.id, send)
                          else terminalSenders.current.delete(session.server.id)
                          setInputReadyCount(terminalSenders.current.size)
                        }}
                        onTerminalInput={(data) => {
                          if (broadcastRef.current) {
                            for (const send of terminalSenders.current.values())
                              send(data)
                          } else {
                            terminalSenders.current.get(session.server.id)?.(
                              data
                            )
                          }
                        }}
                        onUpload={() => {
                          setUploadTargetIds([session.server.id])
                          setUploadResults([])
                          setUploadOpen(true)
                        }}
                        onRegistryChange={() =>
                          setInputReadyCount(rfbs.current.size)
                        }
                        onChangePassword={() =>
                          openPasswordDialog([session.server])
                        }
                        onReload={() => reloadConsole(session.server.id)}
                        onClose={() => closeConsole(session.server.id)}
                        starred={starredServerIds.includes(session.server.id)}
                        onToggleStar={() =>
                          toggleStarredServer(session.server.id)
                        }
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
      <Dialog
        open={sharedVariableRunReviewOpen}
        onOpenChange={(open) => {
          if (!open) cancelSharedVariableRunReview()
        }}
      >
        <DialogContent className='sm:max-w-xl'>
          <DialogHeader>
            <DialogTitle>Review shared variables</DialogTitle>
            <DialogDescription>
              This command uses shared variables. Review or edit their values,
              then choose Run now when they are ready.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-3'>
            {pendingSharedVariableNames.map((name) => (
              <div
                key={name}
                className='grid gap-1.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center'
              >
                <Label className='font-mono text-xs'>{`{{shared.${name}}}`}</Label>
                <Input
                  value={sharedVariables[name] ?? ''}
                  onChange={(event) => {
                    setSharedVariables((current) => ({
                      ...current,
                      [name]: event.target.value,
                    }))
                  }}
                  placeholder='Enter shared value'
                />
              </div>
            ))}
            {false && uploadResults.length > 0 && (
              <div className='max-h-64 overflow-auto rounded-md border'>
                <div className='grid grid-cols-[minmax(0,1fr)_5rem_4rem] gap-2 border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground'>
                  <span>VM</span>
                  <span>Progress</span>
                  <span>Status</span>
                </div>
                {uploadResults.map((result) => (
                  <div
                    className='grid grid-cols-[minmax(0,1fr)_5rem_4rem] gap-2 border-b px-3 py-2 text-xs last:border-0'
                    key={result.id}
                  >
                    <span className='min-w-0'>
                      <span className='block truncate font-mono text-foreground'>
                        {result.ip}
                      </span>
                      <span className='block truncate text-muted-foreground'>
                        {result.name}
                        {result.error ? ` · ${result.error}` : ''}
                      </span>
                    </span>
                    <span className='pt-1'>
                      {result.status === 'uploading'
                        ? `${result.progress}%`
                        : result.status === 'success'
                          ? '100%'
                          : '—'}
                    </span>
                    <span
                      className={`pt-1 font-medium ${result.status === 'failed' ? 'text-destructive' : result.status === 'success' ? 'text-emerald-600' : 'text-muted-foreground'}`}
                    >
                      {result.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={cancelSharedVariableRunReview}>
              Cancel
            </Button>
            <Button onClick={runAfterSharedVariableReview}>
              <Play /> Run now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={commandEditorOpen} onOpenChange={setCommandEditorOpen}>
        <DialogContent className='grid h-[94svh] !w-[96vw] !max-w-[96vw] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 sm:!max-w-[96vw]'>
          <DialogHeader>
            <div className='flex items-center gap-1'>
              <DialogTitle>Large CLI command editor</DialogTitle>
              <HelpButton topic='editor' onOpen={setHelpTopic} />
            </div>
            <DialogDescription>
              Edit Bash commands with syntax highlighting, search, keyboard
              shortcuts, and full mouse scrolling.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder='Enter a Bash or CLI commandâ€¦'
            spellCheck={false}
            className='h-full min-h-0 resize-none overflow-auto rounded-lg font-mono text-sm leading-5'
          />
          <DialogFooter className='items-center sm:justify-between'>
            <span className='text-xs text-muted-foreground'>
              {command.split('\n').length} lines Â· {command.length} characters
            </span>
            <Button onClick={() => setCommandEditorOpen(false)}>
              Done editing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={commandsOpen} onOpenChange={setCommandsOpen}>
        <DialogContent className='grid h-[98svh] !w-[99vw] !max-w-[99vw] grid-rows-[auto_minmax(0,1fr)] gap-4 sm:!max-w-[99vw]'>
          <DialogHeader>
            <div className='flex items-center gap-1'>
              <DialogTitle>CLI command library</DialogTitle>
              <HelpButton topic='library' onOpen={setHelpTopic} />
            </div>
            <DialogDescription>
              Save reusable command templates, organize them by category, and
              import one into the Multi Console command editor.
            </DialogDescription>
          </DialogHeader>
          <div className='grid min-h-0 gap-4 md:grid-cols-[minmax(18rem,0.7fr)_minmax(0,1.3fr)]'>
            <div className='flex min-h-0 flex-col rounded-lg border bg-muted/10'>
              <div className='flex shrink-0 gap-2 border-b p-3'>
                <Input
                  value={commandSearch}
                  onChange={(event) => setCommandSearch(event.target.value)}
                  placeholder='Search commandsâ€¦'
                />
                {isAdmin && (
                  <Button
                    type='button'
                    size='icon'
                    title='Add a new command'
                    onClick={() => editCliCommand()}
                  >
                    <Plus />
                  </Button>
                )}
              </div>
              <div className='min-h-0 flex-1 space-y-1 overflow-y-auto p-2'>
                {commandsLoading ? (
                  <div className='flex h-32 items-center justify-center'>
                    <Loader2 className='animate-spin text-muted-foreground' />
                  </div>
                ) : cliCommands.filter((item) =>
                    `${item.name} ${item.category} ${item.description}`
                      .toLowerCase()
                      .includes(commandSearch.trim().toLowerCase())
                  ).length ? (
                  cliCommands
                    .filter((item) =>
                      `${item.name} ${item.category} ${item.description}`
                        .toLowerCase()
                        .includes(commandSearch.trim().toLowerCase())
                    )
                    .map((item) => (
                      <div
                        key={item.id}
                        className={`group flex items-center gap-1 rounded-md border p-1 ${selectedCommandId === item.id ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'border-transparent hover:bg-muted'}`}
                      >
                        <button
                          type='button'
                          className='min-w-0 flex-1 px-2 py-1.5 text-left'
                          onClick={() => selectCliCommand(item)}
                        >
                          <span className='flex items-center gap-1.5 font-medium'>
                            <Star
                              className={`size-3.5 ${item.is_favorite ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground'}`}
                            />
                            <span className='truncate'>{item.name}</span>
                          </span>
                          <span className='mt-0.5 block truncate text-xs text-muted-foreground'>
                            {item.category}
                            {item.description ? ` Â· ${item.description}` : ''}
                          </span>
                        </button>
                        {isAdmin && (
                          <>
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon'
                              className='size-7 opacity-70 group-hover:opacity-100'
                              title={`Edit ${item.name}`}
                              onClick={() => editCliCommand(item)}
                            >
                              <Pencil />
                            </Button>
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon'
                              className='size-7 text-destructive opacity-70 group-hover:opacity-100 hover:text-destructive'
                              title={`Delete ${item.name}`}
                              onClick={() => void deleteCliCommand(item)}
                            >
                              <Trash2 />
                            </Button>
                          </>
                        )}
                      </div>
                    ))
                ) : (
                  <div className='flex h-32 flex-col items-center justify-center px-4 text-center text-sm text-muted-foreground'>
                    <BookOpen className='mb-2 size-8' />
                    <span>No saved commands found.</span>
                  </div>
                )}
              </div>
            </div>
            <div className='flex h-full max-h-full min-h-0 flex-col overflow-hidden rounded-lg border'>
              <div className='min-h-0 flex-1 [scrollbar-gutter:stable] space-y-3 overflow-x-hidden overflow-y-auto overscroll-contain p-4'>
                <div className='flex items-center justify-between gap-2'>
                  <div>
                    <h3 className='font-semibold'>
                      {selectedCommandId
                        ? commandEditing
                          ? 'Edit command'
                          : 'Command details'
                        : 'New command'}
                    </h3>
                    {selectedCommandId && !commandEditing && (
                      <p className='text-xs text-muted-foreground'>
                        Read-only Â· click Edit to make changes
                      </p>
                    )}
                  </div>
                  <Label
                    className={`flex items-center gap-2 text-xs ${canEditCliCommand ? 'cursor-pointer' : 'opacity-60'}`}
                  >
                    <Checkbox
                      disabled={!canEditCliCommand}
                      checked={commandDraft.is_favorite}
                      onCheckedChange={(checked) =>
                        setCommandDraft((current) => ({
                          ...current,
                          is_favorite: checked === true,
                        }))
                      }
                    />{' '}
                    Favorite
                  </Label>
                </div>
                <div className='grid shrink-0 gap-3 sm:grid-cols-2'>
                  <div className='space-y-1.5'>
                    <Label htmlFor='cli-library-name'>Name</Label>
                    <Input
                      id='cli-library-name'
                      disabled={!canEditCliCommand}
                      value={commandDraft.name}
                      onChange={(event) =>
                        setCommandDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      placeholder='Check disk usage'
                    />
                  </div>
                  <div className='space-y-1.5'>
                    <Label htmlFor='cli-library-category'>Category</Label>
                    <Input
                      id='cli-library-category'
                      disabled={!canEditCliCommand}
                      value={commandDraft.category}
                      onChange={(event) =>
                        setCommandDraft((current) => ({
                          ...current,
                          category: event.target.value,
                        }))
                      }
                      placeholder='Maintenance'
                    />
                  </div>
                </div>
                <div className='shrink-0 space-y-1.5'>
                  <Label htmlFor='cli-library-description'>Description</Label>
                  <Input
                    id='cli-library-description'
                    disabled={!canEditCliCommand}
                    value={commandDraft.description}
                    onChange={(event) =>
                      setCommandDraft((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                    placeholder='Optional usage note'
                  />
                </div>
                <div className='shrink-0 space-y-2 rounded-md border bg-muted/10 p-2.5'>
                  <div className='flex items-center justify-between gap-2'>
                    <Label>Shared variables</Label>
                    <span className='text-[11px] text-muted-foreground'>
                      Static, <code>{'{{server.name}}'}</code>, or sequence{' '}
                      <code>[in]</code>
                    </span>
                  </div>
                  {Object.entries(commandDraft.shared_variables).map(
                    ([name, value]) => (
                      <div
                        key={name}
                        className='grid grid-cols-[minmax(6rem,0.65fr)_minmax(0,1fr)_minmax(7rem,0.8fr)_auto] gap-2'
                      >
                        <Input
                          value={name}
                          disabled
                          className='h-8 font-mono text-xs'
                        />
                        <Input
                          value={value}
                          disabled={!canEditCliCommand}
                          className='h-8 font-mono text-xs'
                          onChange={(event) =>
                            setCommandDraft((current) => ({
                              ...current,
                              shared_variables: {
                                ...current.shared_variables,
                                [name]: event.target.value,
                              },
                            }))
                          }
                        />
                        <div className='flex h-8 min-w-0 items-center gap-1 rounded-md border bg-background px-2 text-xs'>
                          <Badge
                            variant='outline'
                            className='shrink-0 px-1 text-[9px]'
                          >
                            {sharedVariableMode(value)}
                          </Badge>
                          <code
                            className='truncate'
                            title={
                              commandPreviewServer
                                ? renderSharedVariableValue(
                                    value,
                                    commandPreviewServer,
                                    commandPreviewServerIndex
                                  )
                                : value
                            }
                          >
                            {commandPreviewServer
                              ? renderSharedVariableValue(
                                  value,
                                  commandPreviewServer,
                                  commandPreviewServerIndex
                                )
                              : value || 'âˆ…'}
                          </code>
                        </div>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon'
                          className='size-8 text-destructive'
                          disabled={!canEditCliCommand}
                          aria-label={`Delete shared variable ${name}`}
                          onClick={() =>
                            setCommandDraft((current) => {
                              const next = { ...current.shared_variables }
                              delete next[name]
                              return { ...current, shared_variables: next }
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    )
                  )}
                  {canEditCliCommand && (
                    <div className='grid grid-cols-[minmax(6rem,0.65fr)_minmax(0,1fr)_minmax(7rem,0.8fr)_auto] gap-2'>
                      <Input
                        value={draftSharedName}
                        onChange={(event) =>
                          setDraftSharedName(event.target.value)
                        }
                        className='h-8 font-mono text-xs'
                        placeholder='library_version'
                      />
                      <Input
                        value={draftSharedValue}
                        onChange={(event) =>
                          setDraftSharedValue(event.target.value)
                        }
                        className='h-8 font-mono text-xs'
                        placeholder='1.2.3, {{server.name}}, worker_[in]'
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') addDraftSharedVariable()
                        }}
                      />
                      <div className='flex h-8 items-center rounded-md border bg-muted/20 px-2 text-[10px] text-muted-foreground'>
                        Preview after adding
                      </div>
                      <Button
                        type='button'
                        variant='outline'
                        size='icon'
                        className='size-8'
                        aria-label='Add shared variable'
                        onClick={addDraftSharedVariable}
                      >
                        <Plus />
                      </Button>
                    </div>
                  )}
                  {sequenceBuilder((token) =>
                    setDraftSharedValue((current) => `${current}${token}`)
                  )}
                </div>
                <details className='shrink-0 rounded-md border bg-background/70 px-2.5 py-1.5 text-xs'>
                  <summary className='cursor-pointer font-medium select-none'>
                    Available variables
                  </summary>
                  <div className='mt-2 flex max-h-36 flex-wrap gap-1.5 overflow-y-auto rounded-md border bg-muted/20 p-1.5'>
                    {availableServerVariables.map(([variable, label]) => (
                      <Button
                        key={variable}
                        type='button'
                        disabled={!canEditCliCommand}
                        variant='outline'
                        size='sm'
                        className='h-6 px-2 font-mono text-[10px]'
                        title={label}
                        onClick={() => insertLibraryVariable(variable)}
                      >{`{{${variable}}}`}</Button>
                    ))}
                    {customVariableNames.map((variable) => (
                      <Button
                        key={variable}
                        type='button'
                        disabled={!canEditCliCommand}
                        variant='secondary'
                        size='sm'
                        className='h-6 px-2 font-mono text-[10px]'
                        title={`Custom variable: ${variable}`}
                        onClick={() =>
                          insertLibraryVariable(`custom.${variable}`)
                        }
                      >{`{{custom.${variable}}}`}</Button>
                    ))}
                    {Object.keys(commandDraft.shared_variables).map(
                      (variable) => (
                        <Button
                          key={variable}
                          type='button'
                          disabled={!canEditCliCommand}
                          variant='secondary'
                          size='sm'
                          className='h-6 px-2 font-mono text-[10px]'
                          title={`Shared value: ${commandDraft.shared_variables[variable]}`}
                          onClick={() =>
                            insertLibraryVariable(`shared.${variable}`)
                          }
                        >{`{{shared.${variable}}}`}</Button>
                      )
                    )}
                    {COMMAND_CONTROL_VARIABLES.map((item) => (
                      <Button
                        key={item.variable}
                        type='button'
                        disabled={!canEditCliCommand}
                        variant='outline'
                        size='sm'
                        className='h-6 px-2 font-mono text-[10px]'
                        title={item.label}
                        onClick={() => insertLibraryVariable(item.variable)}
                      >{`{{${item.variable}}}`}</Button>
                    ))}
                    {!customVariableNames.length && (
                      <span className='self-center text-[11px] text-muted-foreground'>
                        Import the Excel variable template to add custom
                        variables.
                      </span>
                    )}
                  </div>
                </details>
                <div className='flex shrink-0 flex-col space-y-1.5'>
                  <Label htmlFor='cli-library-command'>
                    CLI command template
                  </Label>
                  <Textarea
                    ref={libraryCommandRef}
                    id='cli-library-command'
                    value={commandDraft.command}
                    disabled={!canEditCliCommand}
                    readOnly={!canEditCliCommand}
                    spellCheck={false}
                    placeholder='hostname && echo {{server.name}}'
                    onChange={(event) =>
                      setCommandDraft((current) => ({
                        ...current,
                        command: event.target.value,
                      }))
                    }
                    className={`h-72 max-h-[60svh] min-h-72 flex-none resize-y overflow-auto font-mono text-sm leading-5 ${canEditCliCommand ? '' : 'bg-muted/30'}`}
                  />
                </div>
                <p className='shrink-0 text-xs text-muted-foreground'>
                  Variables remain dynamic and are rendered separately for each
                  server when the command is sent.
                </p>
              </div>
              <div className='relative z-10 flex shrink-0 flex-wrap items-center gap-2 border-t bg-background p-3'>
                {isAdmin && (
                  <Button
                    type='button'
                    variant='outline'
                    onClick={() => editCliCommand()}
                  >
                    <Plus /> New
                  </Button>
                )}
                {isAdmin && selectedCommandId && !commandEditing && (
                  <Button
                    type='button'
                    variant='outline'
                    onClick={() => setCommandEditing(true)}
                  >
                    <Pencil /> Edit
                  </Button>
                )}
                {canEditCliCommand && (
                  <Button
                    type='button'
                    variant='secondary'
                    disabled={
                      commandsSaving ||
                      !commandDraft.name.trim() ||
                      !commandDraft.command.trim()
                    }
                    onClick={() => void saveCliCommand()}
                  >
                    {commandsSaving ? (
                      <Loader2 className='animate-spin' />
                    ) : (
                      <Save />
                    )}{' '}
                    {selectedCommandId ? 'Save changes' : 'Save new'}
                  </Button>
                )}
                <Button
                  type='button'
                  className='ms-auto min-w-40 bg-emerald-600 text-white shadow-sm hover:bg-emerald-500'
                  disabled={!commandDraft.command.trim()}
                  onClick={() => {
                    setCommand(commandDraft.command)
                    setSharedVariables(commandDraft.shared_variables ?? {})
                    setCommandsOpen(false)
                    toast.success('Command imported into the CLI editor.')
                  }}
                >
                  <Send /> Use command
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={variablesOpen} onOpenChange={setVariablesOpen}>
        <DialogContent className='grid h-[94svh] !w-[94vw] !max-w-[94vw] grid-rows-[auto_minmax(0,1fr)_auto] sm:!max-w-[94vw]'>
          <DialogHeader>
            <div className='flex items-center gap-1'>
              <DialogTitle>CLI variables and preview</DialogTitle>
              <HelpButton topic='variables' onOpen={setHelpTopic} />
            </div>
            <DialogDescription>
              Insert built-in or Excel variables and preview the exact command
              generated for each server.
            </DialogDescription>
          </DialogHeader>
          <div className='grid min-h-0 gap-4 overflow-hidden md:grid-cols-[minmax(36rem,0.95fr)_minmax(0,1.05fr)]'>
            <div className='flex min-h-0 flex-col gap-3 overflow-hidden rounded-lg border bg-muted/10 p-3'>
              <div className='flex shrink-0 gap-2'>
                <Button
                  type='button'
                  variant='outline'
                  onClick={downloadVariablesTemplate}
                  disabled={!serversToOpen.length}
                >
                  <FileDown /> Download template
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => variablesFileRef.current?.click()}
                  disabled={!serversToOpen.length}
                >
                  <FileUp /> Import Excel
                </Button>
                <input
                  ref={variablesFileRef}
                  type='file'
                  accept='.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                  className='hidden'
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void importVariables(file)
                  }}
                />
              </div>
              <div className='shrink-0 space-y-2 rounded-md border bg-background p-2.5'>
                <div className='flex items-center justify-between gap-2'>
                  <Label>Shared variables</Label>
                  <span className='text-[11px] text-muted-foreground'>
                    One value applied to every server
                  </span>
                </div>
                <div className='max-h-28 space-y-1.5 overflow-y-auto'>
                  {Object.entries(effectiveSharedVariables).map(
                    ([name, value]) => (
                      <div
                        key={name}
                        className='grid grid-cols-[minmax(6rem,0.65fr)_minmax(0,1fr)_minmax(7rem,0.85fr)_auto] gap-2'
                      >
                        <div
                          className='flex h-8 items-center truncate rounded-md border bg-muted/30 px-2 font-mono text-xs'
                          title={`{{shared.${name}}}`}
                        >
                          {name}
                        </div>
                        <Input
                          value={value}
                          className='h-8 font-mono text-xs'
                          aria-label={`Value for shared variable ${name}`}
                          onChange={(event) =>
                            setSharedVariables((current) => ({
                              ...current,
                              [name]: event.target.value,
                            }))
                          }
                        />
                        <div className='flex h-8 min-w-0 items-center gap-1 rounded-md border bg-muted/20 px-2 text-xs'>
                          <Badge
                            variant='outline'
                            className='shrink-0 px-1 text-[9px]'
                          >
                            {sharedVariableMode(value)}
                          </Badge>
                          <code
                            className='truncate'
                            title={
                              commandPreviewServer
                                ? renderSharedVariableValue(
                                    value,
                                    commandPreviewServer,
                                    commandPreviewServerIndex
                                  )
                                : value
                            }
                          >
                            {commandPreviewServer
                              ? renderSharedVariableValue(
                                  value,
                                  commandPreviewServer,
                                  commandPreviewServerIndex
                                )
                              : value || 'âˆ…'}
                          </code>
                        </div>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon'
                          className='size-8 text-destructive'
                          disabled={detectedSharedVariableNames.includes(name)}
                          title={
                            detectedSharedVariableNames.includes(name)
                              ? 'Remove this variable from the command before deleting it'
                              : 'Delete shared variable'
                          }
                          aria-label={`Delete shared variable ${name}`}
                          onClick={() =>
                            setSharedVariables((current) => {
                              const next = { ...current }
                              delete next[name]
                              return next
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    )
                  )}
                </div>
                <div className='grid grid-cols-[minmax(6rem,0.65fr)_minmax(0,1fr)_minmax(7rem,0.85fr)_auto] gap-2'>
                  <Input
                    value={sharedVariableName}
                    onChange={(event) =>
                      setSharedVariableName(event.target.value)
                    }
                    className='h-8 font-mono text-xs'
                    placeholder='library_version'
                  />
                  <Input
                    value={sharedVariableValue}
                    onChange={(event) =>
                      setSharedVariableValue(event.target.value)
                    }
                    className='h-8 font-mono text-xs'
                    placeholder='1.2.3, {{server.name}}, worker_[in]'
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') addSessionSharedVariable()
                    }}
                  />
                  <div className='flex h-8 items-center rounded-md border bg-muted/20 px-2 text-[10px] text-muted-foreground'>
                    Preview after adding
                  </div>
                  <Button
                    type='button'
                    variant='outline'
                    size='icon'
                    className='size-8'
                    aria-label='Add shared variable'
                    onClick={addSessionSharedVariable}
                  >
                    <Plus />
                  </Button>
                </div>
                {sequenceBuilder((token) =>
                  setSharedVariableValue((current) => `${current}${token}`)
                )}
              </div>
              <div className='shrink-0 space-y-1.5'>
                <Label htmlFor='variable-search'>
                  Variables ({variableRows.length})
                </Label>
                <Input
                  id='variable-search'
                  value={variableSearch}
                  onChange={(event) => setVariableSearch(event.target.value)}
                  placeholder='Search name, type or descriptionâ€¦'
                />
              </div>
              <div className='min-h-0 flex-1 overflow-y-auto rounded-md border bg-background'>
                <div className='sticky top-0 z-10 grid grid-cols-[minmax(9rem,1fr)_5rem_minmax(7rem,0.8fr)_minmax(8rem,1fr)_4.5rem] gap-2 border-b bg-muted px-3 py-2 text-xs font-semibold'>
                  <span>Variable</span>
                  <span>Type</span>
                  <span>Description</span>
                  <span>Preview value</span>
                  <span />
                </div>
                {variableRows.length ? (
                  variableRows.map((item) => (
                    <div
                      key={item.variable}
                      className={`grid grid-cols-[minmax(9rem,1fr)_5rem_minmax(7rem,0.8fr)_minmax(8rem,1fr)_4.5rem] items-center gap-2 border-b px-3 py-2 text-xs last:border-0 hover:bg-muted/50 ${highlightedVariable === item.variable ? 'bg-fuchsia-500/10 ring-1 ring-fuchsia-500/60 ring-inset' : item.usageCount ? 'bg-emerald-500/10' : ''}`}
                    >
                      <code
                        className={`truncate font-semibold ${item.usageCount ? 'text-emerald-600 dark:text-emerald-400' : 'text-primary'}`}
                        title={`{{${item.variable}}}`}
                      >{`{{${item.variable}}}`}</code>
                      <div className='flex flex-col items-stretch gap-1'>
                        <Badge
                          variant={
                            item.type === 'Custom' ? 'default' : 'outline'
                          }
                          className='justify-center text-[10px]'
                        >
                          {item.type}
                        </Badge>
                        {item.usageCount > 0 && (
                          <Badge className='justify-center bg-emerald-600 text-[9px] text-white hover:bg-emerald-600'>
                            Used {item.usageCount}Ã—
                          </Badge>
                        )}
                      </div>
                      <span
                        className='truncate text-muted-foreground'
                        title={item.label}
                      >
                        {item.label}
                      </span>
                      <code
                        className='truncate rounded bg-muted px-1.5 py-1'
                        title={item.preview}
                      >
                        {item.preview || 'âˆ…'}
                      </code>
                      <div className='flex items-center justify-end gap-0.5'>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type='button'
                              variant={
                                highlightedVariable === item.variable
                                  ? 'default'
                                  : 'ghost'
                              }
                              size='icon'
                              className='size-7'
                              aria-label={`Highlight ${item.variable}`}
                              aria-pressed={
                                highlightedVariable === item.variable
                              }
                              onClick={() =>
                                setHighlightedVariable((current) =>
                                  current === item.variable ? '' : item.variable
                                )
                              }
                            >
                              <Highlighter />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side='left'>
                            {highlightedVariable === item.variable
                              ? 'Clear highlight'
                              : 'Highlight replacements'}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon'
                              className='size-7'
                              data-variable={item.variable}
                              aria-label={`Insert ${item.variable}`}
                              onClick={insertVariableFromButton}
                            >
                              <Plus />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side='left'>
                            Insert at preview cursor
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className='flex h-32 items-center justify-center text-sm text-muted-foreground'>
                    No variables match your search.
                  </div>
                )}
              </div>
              <p className='shrink-0 text-xs text-muted-foreground'>
                Use the + button to insert at the current CLI cursor.
              </p>
            </div>
            <div className='flex min-h-0 flex-col gap-3 rounded-lg border bg-muted/20 p-4'>
              <div className='shrink-0 space-y-2'>
                <div className='flex items-center justify-between gap-3'>
                  <Label htmlFor='command-preview-server'>Preview server</Label>
                  <div className='flex items-center rounded-md border bg-background p-0.5'>
                    <Button
                      type='button'
                      variant={
                        variableViewMode === 'raw' ? 'secondary' : 'ghost'
                      }
                      size='sm'
                      className='h-7'
                      onClick={() => setVariableViewMode('raw')}
                    >
                      Raw editor
                    </Button>
                    <Button
                      type='button'
                      variant={
                        variableViewMode === 'preview' ? 'secondary' : 'ghost'
                      }
                      size='sm'
                      className='h-7'
                      onClick={() => setVariableViewMode('preview')}
                    >
                      Rendered preview
                    </Button>
                  </div>
                </div>
                <select
                  id='command-preview-server'
                  className='h-9 w-full rounded-md border bg-background px-3 text-sm'
                  value={commandPreviewServer?.id ?? ''}
                  onChange={(event) => setPreviewServerId(event.target.value)}
                >
                  {serversToOpen.map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.name}
                    </option>
                  ))}
                </select>
              </div>
              {variableViewMode === 'raw' ? (
                <div className='flex min-h-0 flex-1 flex-col'>
                  <div className='mb-1 flex items-center justify-between gap-3'>
                    <p className='text-sm font-semibold'>
                      Raw command template
                    </p>
                    <span className='text-xs text-muted-foreground'>
                      Edit freely, then click + to insert a variable at the text
                      cursor
                    </span>
                  </div>
                  <Textarea
                    ref={variablesEditorRef}
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder='Enter a Bash command and insert variables from the listâ€¦'
                    spellCheck={false}
                    className='min-h-0 flex-1 resize-none overflow-auto font-mono text-sm leading-5'
                  />
                </div>
              ) : (
                <div className='flex min-h-0 flex-1 flex-col'>
                  <div className='mb-1 flex items-center justify-between gap-3'>
                    <p className='text-sm font-semibold'>Rendered command</p>
                    <span className='text-xs text-muted-foreground'>
                      {previewCursor
                        ? `Insert position: character ${previewCursor.sourcePosition}`
                        : 'Click in the preview to choose where the next variable is inserted'}
                    </span>
                  </div>
                  <pre className='min-h-0 flex-1 overflow-auto rounded-md border bg-background p-5 font-mono text-sm leading-6 break-words whitespace-pre-wrap shadow-inner'>
                    {renderedCommandParts.length ? (
                      renderedCommandParts.map((part, index) => {
                        const cursorOffset =
                          previewCursor?.partIndex === index
                            ? previewCursor.offset
                            : undefined
                        const before =
                          cursorOffset === undefined
                            ? part.text
                            : part.text.slice(0, cursorOffset)
                        const after =
                          cursorOffset === undefined
                            ? ''
                            : part.text.slice(cursorOffset)
                        const isFocusedVariable = Boolean(
                          highlightedVariable &&
                          part.variable === highlightedVariable
                        )
                        const isOtherVariable = Boolean(
                          highlightedVariable &&
                          part.variable &&
                          part.variable !== highlightedVariable
                        )
                        return (
                          <span
                            key={`${part.variable ?? 'literal'}-${index}`}
                            data-part-index={index}
                            title={
                              part.variable
                                ? `Replaced {{${part.variable}}} Â· click to insert before or after`
                                : 'Click to set the insertion cursor'
                            }
                            onClick={setPreviewCursorFromClick}
                            className={`cursor-text rounded-sm transition-colors ${isFocusedVariable ? 'bg-fuchsia-400/45 text-fuchsia-950 ring-2 ring-fuchsia-500 dark:bg-fuchsia-400/30 dark:text-fuchsia-100' : part.variable ? (isOtherVariable ? 'bg-amber-400/5 text-muted-foreground' : 'bg-amber-300/70 text-amber-950 ring-1 ring-amber-500/60 dark:bg-amber-400/25 dark:text-amber-100 dark:ring-amber-400/50') : 'hover:bg-sky-500/10'}`}
                          >
                            {before}
                            {cursorOffset !== undefined && (
                              <span className='-mb-1 inline-block h-[1.25em] border-l-2 border-sky-500 align-middle shadow-[0_0_4px_rgb(14_165_233)]' />
                            )}
                            {part.text ? after : 'âˆ…'}
                          </span>
                        )
                      })
                    ) : (
                      <span className='text-muted-foreground'>
                        Enter a CLI command to preview it here.
                      </span>
                    )}
                  </pre>
                </div>
              )}
              {variableViewMode === 'preview' &&
                commandPreviewServer &&
                customVariableNames.length > 0 && (
                  <div className='max-h-[22%] shrink-0 overflow-auto rounded-md border bg-background text-xs'>
                    {customVariableNames.map((name) => (
                      <div
                        key={name}
                        className='grid grid-cols-[8rem_minmax(0,1fr)] border-b px-2 py-1.5 last:border-0'
                      >
                        <span className='font-mono font-medium'>{name}</span>
                        <span className='break-all'>
                          {customVariables[commandPreviewServer.id]?.[name] ??
                            ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setVariablesOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent className='sm:!max-w-xl'>
          <DialogHeader>
            <div className='flex items-center gap-1'>
              <DialogTitle>Change server password</DialogTitle>
              <HelpButton topic='password' onOpen={setHelpTopic} />
            </div>
            <DialogDescription>
              Apply a password profile or one custom password to{' '}
              {passwordTargets.length} server(s).
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4'>
            <div className='space-y-2'>
              <div className='flex items-center justify-between'>
                <Label>
                  Target servers ({passwordTargets.length}/
                  {passwordCandidates.length})
                </Label>
                {passwordCandidates.length > 1 && (
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    className='h-7 text-xs'
                    onClick={() =>
                      setPasswordTargetIds((current) =>
                        current.length === passwordCandidates.length
                          ? []
                          : passwordCandidates.map((server) => server.id)
                      )
                    }
                  >
                    {passwordTargetIds.length === passwordCandidates.length
                      ? 'Clear all'
                      : 'Select all'}
                  </Button>
                )}
              </div>
              <div className='max-h-44 space-y-1 overflow-y-auto rounded-md border bg-muted/20 p-2'>
                {passwordCandidates.map((server) => (
                  <label
                    key={server.id}
                    className='flex cursor-pointer items-center gap-2 rounded px-2 py-2 hover:bg-muted'
                  >
                    <Checkbox
                      checked={passwordTargetIds.includes(server.id)}
                      onCheckedChange={(checked) =>
                        setPasswordTargetIds((current) =>
                          checked
                            ? [...current, server.id]
                            : current.filter((id) => id !== server.id)
                        )
                      }
                    />
                    <span className='min-w-0 flex-1 truncate text-sm'>
                      {server.name}
                    </span>
                    <span className='font-mono text-[10px] text-muted-foreground'>
                      {server.id.slice(0, 8)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <SegmentedTabs<MultiConsolePasswordMode>
              value={passwordMode}
              onValueChange={setPasswordMode}
              tabs={[
                { value: 'profile', label: 'Password profile' },
                { value: 'manual', label: 'Enter password' },
              ]}
            />
            {passwordMode === 'profile' ? (
              <div className='space-y-2'>
                <Label>Password profile</Label>
                <SearchableSelect
                  value={passwordProfileId}
                  onValueChange={setPasswordProfileId}
                  loading={passwordProfiles.isLoading}
                  placeholder='Select password profile'
                  searchPlaceholder='Search password profiles...'
                  options={passwordProfiles.data?.map((profile) => ({
                    value: profile.id,
                    label: profile.name,
                    description: profile.username,
                  }))}
                />
              </div>
            ) : (
              <div className='space-y-2'>
                <Label htmlFor='multi-console-password'>New password</Label>
                <div className='flex gap-2'>
                  <Input
                    id='multi-console-password'
                    type='text'
                    autoComplete='new-password'
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    placeholder='Enter a custom password'
                  />
                  <Button
                    type='button'
                    variant='outline'
                    onClick={generatePassword}
                  >
                    Generate
                  </Button>
                </div>
                <p className='text-xs text-muted-foreground'>
                  More than 8 characters with uppercase, lowercase, number and
                  special character.
                </p>
              </div>
            )}
            {passwordResults.length > 0 && (
              <div className='max-h-48 overflow-y-auto rounded-md border'>
                {passwordResults.map((result) => (
                  <div
                    key={result.server_id}
                    className='flex items-center justify-between gap-3 border-b px-3 py-2 text-sm last:border-0'
                  >
                    <span className='truncate'>
                      {servers.find((server) => server.id === result.server_id)
                        ?.name ?? result.server_id}
                    </span>
                    <Badge
                      variant={
                        result.status === 'failed' ? 'destructive' : 'default'
                      }
                    >
                      {result.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setPasswordOpen(false)}>
              Close
            </Button>
            <Button
              disabled={
                !passwordTargets.length ||
                changingPassword ||
                (passwordMode === 'profile' ? !passwordProfileId : !newPassword)
              }
              onClick={() => void changePasswords()}
            >
              {changingPassword ? (
                <Loader2 className='animate-spin' />
              ) : (
                <KeyRound />
              )}
              Change password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(helpTopic)}
        onOpenChange={(next) => {
          if (!next) setHelpTopic(undefined)
        }}
      >
        <DialogContent className='!w-[min(96vw,82rem)] !max-w-[min(96vw,82rem)] sm:!max-w-[min(96vw,82rem)]'>
          {helpTopic && (
            <>
              <DialogHeader>
                <DialogTitle>{HELP_CONTENT[helpTopic].title}</DialogTitle>
                <DialogDescription>
                  {HELP_CONTENT[helpTopic].description}
                </DialogDescription>
              </DialogHeader>
              <ol className='space-y-3'>
                {HELP_CONTENT[helpTopic].steps.map((step, index) => (
                  <li key={step} className='flex gap-3 text-sm'>
                    <span className='flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary'>
                      {index + 1}
                    </span>
                    <span className='pt-0.5'>{step}</span>
                  </li>
                ))}
              </ol>
              <DialogFooter>
                <Button onClick={() => setHelpTopic(undefined)}>Got it</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={uploadOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && uploadingFile) cancelTeleportUpload()
          setUploadOpen(nextOpen)
        }}
      >
        <DialogContent className='[width:calc(100vw-2rem)!important] [max-width:calc(100vw-2rem)!important] sm:[width:32rem!important] sm:[max-width:32rem!important]'>
          <DialogHeader>
            <DialogTitle>Upload file to Teleport server</DialogTitle>
            <DialogDescription>
              {uploadTargetIds.length === 1
                ? (() => {
                    const target = serversToOpen.find(
                      (server) => server.id === uploadTargetIds[0]
                    )
                    return target ? (
                      <>
                        <span className='font-mono text-foreground'>
                          {target.private_ip?.[0]?.ip_address ?? '—'}
                        </span>{' '}
                        · {target.name}
                      </>
                    ) : (
                      'Selected Teleport VM is unavailable.'
                    )
                  })()
                : `Batch upload to ${uploadTargetIds.length} selected Teleport VM(s) · at most 2 transfers at once.`}
              {false &&
                (() => {
                  const target =
                    servers.find((server) => server.id === activeId) ??
                    serversToOpen[0]
                  return target ? (
                    <>
                      <span className='font-mono text-foreground'>
                        {target.private_ip?.[0]?.ip_address ?? '—'}
                      </span>{' '}
                      · {target.name}
                    </>
                  ) : (
                    'Select a Teleport server first.'
                  )
                })()}
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4'>
            <div className='space-y-1.5'>
              <Label htmlFor='teleport-multi-upload-file'>Local file</Label>
              <Input
                id='teleport-multi-upload-file'
                onChange={(event) => setUploadFile(event.target.files?.[0])}
                type='file'
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='teleport-multi-upload-path'>
                Remote destination folder
              </Label>
              <Input
                className='font-mono'
                id='teleport-multi-upload-path'
                onChange={(event) => setUploadRemotePath(event.target.value)}
                placeholder='/tmp'
                value={uploadRemotePath}
              />
              <p className='text-xs text-muted-foreground'>
                The uploaded file keeps its original filename.
              </p>
            </div>
            {uploadResults.length > 0 && (
              <div className='min-h-0 rounded-xl border bg-card p-2'>
                <CloudDataTable
                  columns={uploadResultColumns}
                  data={uploadResults}
                  emptyText='No upload results yet.'
                  entityName='upload result'
                  getRowId={(row) => row.id}
                  initialPageSize={10}
                  searchPlaceholder='Search VM, IP or upload result...'
                />
              </div>
            )}
            {false && uploadResults.length > 0 && (
              <div className='overflow-hidden rounded-xl border bg-card shadow-sm'>
                <div className='grid min-w-[46rem] grid-cols-[minmax(24rem,1fr)_9rem_9rem] gap-4 bg-muted/60 px-5 py-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase'>
                  <span>Teleport VM</span>
                  <span>Progress</span>
                  <span>Result</span>
                </div>
                <div className='max-h-72 overflow-x-auto overflow-y-auto'>
                  {uploadResults.map((result) => (
                    <div
                      className='grid min-w-[46rem] grid-cols-[minmax(24rem,1fr)_9rem_9rem] gap-4 border-t px-5 py-3 text-sm transition-colors hover:bg-muted/30'
                      key={result.id}
                    >
                      <span className='min-w-0'>
                        <span className='block truncate font-mono text-foreground'>
                          {result.ip}
                        </span>
                        <span className='block truncate text-muted-foreground'>
                          {result.name}
                          {result.error ? ` · ${result.error}` : ''}
                        </span>
                      </span>
                      <span className='pt-1'>
                        {result.status === 'uploading'
                          ? `${result.progress}%`
                          : result.status === 'success'
                            ? '100%'
                            : '—'}
                      </span>
                      <span
                        className={`pt-1 font-medium ${result.status === 'success' ? 'text-emerald-600' : result.status === 'failed' ? 'text-destructive' : result.status === 'uploading' ? 'text-amber-600' : 'text-muted-foreground'}`}
                      >
                        {result.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={() => setUploadOpen(false)}
              type='button'
              variant='outline'
            >
              Cancel
            </Button>
            {uploadingFile && (
              <Button
                onClick={cancelTeleportUpload}
                type='button'
                variant='destructive'
              >
                Stop all uploads
              </Button>
            )}
            <Button
              disabled={
                !uploadFile ||
                !uploadRemotePath.trim() ||
                !teleportLinkId ||
                uploadingFile
              }
              onClick={() => void uploadTeleportFile()}
              type='button'
            >
              {uploadingFile ? (
                <Loader2 className='animate-spin' />
              ) : (
                <FileUp />
              )}{' '}
              Upload file
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={closeConfirmOpen}
        onOpenChange={setCloseConfirmOpen}
        title='Close Multi Console?'
        desc={
          <p>
            {sessions.length
              ? `${sessions.length} console session(s) will be closed.`
              : 'The current Multi Console workspace will be closed.'}{' '}
            This will stop the current workspace view.
          </p>
        }
        cancelBtnText='Keep open'
        confirmText='Close workspace'
        destructive
        handleConfirm={closeWorkspace}
      />
    </Dialog>
  )
}

export type TeleportConsoleTarget = {
  id: string
  name: string
  ip: string
  labels: string
}

/**
 * Teleport uses the same workspace UI as Servers. The terminal transport is
 * supplied by the Teleport workspace integration; this adapter preserves the
 * server-shaped data required by command variables, selection and layouts.
 */
export function TeleportMultiConsoleDialog({
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
  const servers: ServerRow[] = targets.map((target) => ({
    id: target.id,
    name: target.name,
    server_type: target.labels || 'No Teleport labels',
    private_ip: [{ id: target.id, ip_address: target.ip }],
  }))
  return (
    <MultiConsoleDialog
      onOpenChange={onOpenChange}
      open={open}
      servers={servers}
      teleportLinkId={linkId}
    />
  )
}
