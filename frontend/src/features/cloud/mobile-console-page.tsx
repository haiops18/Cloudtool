import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import RFB from '@novnc/novnc'
import {
  ArrowLeft,
  ClipboardPaste,
  Keyboard,
  KeyRound,
  Loader2,
  Monitor,
  Mouse,
  Power,
  RefreshCw,
  WifiOff,
} from 'lucide-react'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { consoleWebSocketUrl, keyboardKeysym } from './multi-console-utils'
import type { ServerRow } from './types'

type ConsoleState = 'loading' | 'connecting' | 'connected' | 'error'

type VirtualKey = { label: string; key: string; code: string }
type FloatingPosition = { x: number; y: number }
type HotkeyModifier = 'Control' | 'Alt' | 'Shift'
type TrackpadPointer = {
  pointerId: number
  x: number
  y: number
  moved: boolean
}
type TrackpadGesture = {
  twoFinger: boolean
  moved: boolean
  scrollY: number
}

const HOTKEY_MODIFIERS: Record<
  HotkeyModifier,
  { label: string; code: string }
> = {
  Control: { label: 'Ctrl', code: 'ControlLeft' },
  Alt: { label: 'Alt', code: 'AltLeft' },
  Shift: { label: 'Shift', code: 'ShiftLeft' },
}

const VIRTUAL_KEYS = {
  esc: { label: 'Esc', key: 'Escape', code: 'Escape' },
  capsLock: { label: 'Caps', key: 'CapsLock', code: 'CapsLock' },
  tab: { label: 'Tab', key: 'Tab', code: 'Tab' },
  enter: { label: 'Enter', key: 'Enter', code: 'Enter' },
  backspace: { label: '⌫', key: 'Backspace', code: 'Backspace' },
  delete: { label: 'Del', key: 'Delete', code: 'Delete' },
  up: { label: '↑', key: 'ArrowUp', code: 'ArrowUp' },
  down: { label: '↓', key: 'ArrowDown', code: 'ArrowDown' },
  left: { label: '←', key: 'ArrowLeft', code: 'ArrowLeft' },
  right: { label: '→', key: 'ArrowRight', code: 'ArrowRight' },
  win: { label: 'Win', key: 'Meta', code: 'MetaLeft' },
  home: { label: 'Home', key: 'Home', code: 'Home' },
  end: { label: 'End', key: 'End', code: 'End' },
  pageUp: { label: 'PgUp', key: 'PageUp', code: 'PageUp' },
  pageDown: { label: 'PgDn', key: 'PageDown', code: 'PageDown' },
  insert: { label: 'Ins', key: 'Insert', code: 'Insert' },
  f1: { label: 'F1', key: 'F1', code: 'F1' },
  f2: { label: 'F2', key: 'F2', code: 'F2' },
  f3: { label: 'F3', key: 'F3', code: 'F3' },
  f4: { label: 'F4', key: 'F4', code: 'F4' },
  f5: { label: 'F5', key: 'F5', code: 'F5' },
  f6: { label: 'F6', key: 'F6', code: 'F6' },
  f7: { label: 'F7', key: 'F7', code: 'F7' },
  f8: { label: 'F8', key: 'F8', code: 'F8' },
  f9: { label: 'F9', key: 'F9', code: 'F9' },
  f10: { label: 'F10', key: 'F10', code: 'F10' },
  f11: { label: 'F11', key: 'F11', code: 'F11' },
  f12: { label: 'F12', key: 'F12', code: 'F12' },
} satisfies Record<string, VirtualKey>

function backendWebSocketUrl(path: string) {
  const base = new URL(
    apiClient.defaults.baseURL ?? '/api/v1',
    window.location.origin
  )
  const url = new URL(`${base.pathname.replace(/\/$/, '')}${path}`, base.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function ipList(value: ServerRow['private_ip'] | ServerRow['elastic_ip']) {
  return (
    value
      ?.map((item) => item.ip_address)
      .filter(Boolean)
      .join(', ') || '—'
  )
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function MobileConsolePage() {
  const serverId =
    new URLSearchParams(window.location.search).get('server_id') ?? ''
  const projectId =
    new URLSearchParams(window.location.search).get('project_id') ?? ''
  const canvasHost = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const phoneKeyboardInputRef = useRef<HTMLTextAreaElement>(null)
  const phoneKeyboardRequestedRef = useRef(false)
  const keyFeedbackTimerRef = useRef<number | undefined>(undefined)
  const trackpadPointersRef = useRef(new Map<number, TrackpadPointer>())
  const trackpadGestureRef = useRef<TrackpadGesture>({
    twoFinger: false,
    moved: false,
    scrollY: 0,
  })
  const trackpadCursorRef = useRef({ x: 0, y: 0 })
  const [server, setServer] = useState<ServerRow>()
  const [consoleUrl, setConsoleUrl] = useState('')
  const [websocketUrl, setWebsocketUrl] = useState('')
  const [state, setState] = useState<ConsoleState>('loading')
  const [sendingClipboard, setSendingClipboard] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [ctrlAltDelOpen, setCtrlAltDelOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [phoneKeyboardActive, setPhoneKeyboardActive] = useState(false)
  const [functionKeysOpen, setFunctionKeysOpen] = useState(false)
  const [activeModifiers, setActiveModifiers] = useState<HotkeyModifier[]>([])
  const [trackpadOpen, setTrackpadOpen] = useState(false)
  const [keyFeedback, setKeyFeedback] = useState<{
    label: string
    x: number
    y: number
  }>()
  const [viewportSize, setViewportSize] = useState({ width: 375, height: 667 })
  const [launcherPosition, setLauncherPosition] = useState<FloatingPosition>()
  const launcherDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origin: FloatingPosition
    moved: boolean
  } | null>(null)
  const [message, setMessage] = useState('Loading VM information…')

  const openConsole = useCallback(async () => {
    if (!serverId) {
      setState('error')
      setMessage('A VM server ID is required.')
      return
    }
    if (!projectId) {
      setState('error')
      setMessage('A cloud project is required.')
      return
    }
    setState('loading')
    setMessage('Requesting a secure console session…')
    try {
      const [detail, consoleSession] = await Promise.all([
        apiClient.get<ServerRow>(`/cloud/servers/${serverId}`, {
          headers: { 'X-Project-Id': projectId },
        }),
        apiClient.post<{ url: string; websocket_path?: string }>(
          `/cloud/servers/${serverId}/console`,
          undefined,
          { headers: { 'X-Project-Id': projectId } }
        ),
      ])
      setServer(detail.data)
      setConsoleUrl(consoleSession.data.url)
      setWebsocketUrl(
        consoleSession.data.websocket_path
          ? backendWebSocketUrl(consoleSession.data.websocket_path)
          : consoleWebSocketUrl(consoleSession.data.url)
      )
      setState('connecting')
      setMessage('Connecting to VNC console…')
    } catch (error) {
      setState('error')
      setMessage(
        error instanceof Error
          ? error.message
          : 'The Cloud console could not be opened.'
      )
    }
  }, [projectId, serverId])

  useEffect(() => {
    void openConsole()
  }, [openConsole])

  useEffect(
    () => () => {
      if (keyFeedbackTimerRef.current) {
        window.clearTimeout(keyFeedbackTimerRef.current)
      }
    },
    []
  )

  useEffect(() => {
    const viewport = window.visualViewport
    const updateViewport = () => {
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      setViewportSize({ width, height })
      setLauncherPosition(
        (current) =>
          current ?? {
            x: Math.max(8, width - 58),
            y: Math.max(60, height - 126),
          }
      )
    }
    updateViewport()
    viewport?.addEventListener('resize', updateViewport)
    viewport?.addEventListener('scroll', updateViewport)
    window.addEventListener('resize', updateViewport)
    return () => {
      viewport?.removeEventListener('resize', updateViewport)
      viewport?.removeEventListener('scroll', updateViewport)
      window.removeEventListener('resize', updateViewport)
    }
  }, [])

  useEffect(() => {
    const host = canvasHost.current
    if (!host || !consoleUrl || !websocketUrl) return
    let client: RFB | undefined
    let disposed = false
    const timer = window.setTimeout(() => {
      if (disposed) return
      try {
        client = new RFB(host, websocketUrl, { shared: true })
        client.scaleViewport = true
        client.resizeSession = false
        client.viewOnly = false
        client.focusOnClick = true
        client.addEventListener('connect', () => {
          setState('connected')
          setMessage('Connected')
          client?.focus({ preventScroll: true })
        })
        client.addEventListener('disconnect', (event) => {
          const clean = Boolean(
            (event as CustomEvent<{ clean?: boolean }>).detail?.clean
          )
          setState('error')
          setMessage(
            clean
              ? 'Console disconnected.'
              : 'Console connection closed unexpectedly.'
          )
        })
        client.addEventListener('securityfailure', () => {
          setState('error')
          setMessage('The VNC gateway rejected the console session.')
        })
        rfbRef.current = client
      } catch (error) {
        setState('error')
        setMessage(
          error instanceof Error ? error.message : 'Could not start VNC.'
        )
      }
    }, 0)
    return () => {
      disposed = true
      window.clearTimeout(timer)
      client?.disconnect()
      rfbRef.current = null
    }
  }, [consoleUrl, websocketUrl])

  useEffect(() => {
    // Prompt noVNC to recalculate its scaled viewport after the console area
    // makes room for the on-screen keyboard controls.
    const frame = window.requestAnimationFrame(() =>
      window.dispatchEvent(new Event('resize'))
    )
    return () => window.cancelAnimationFrame(frame)
  }, [functionKeysOpen, keyboardOpen])

  useEffect(() => {
    const alignConsoleCanvas = () => {
      const canvas = canvasHost.current?.querySelector('canvas')
      if (!canvas) return
      // noVNC centers its canvas with margin:auto by default. When controls
      // are visible, keep the console visually attached to the top toolbar.
      canvas.style.margin = keyboardOpen ? '0 auto auto' : 'auto'
    }
    alignConsoleCanvas()
    const frame = window.requestAnimationFrame(alignConsoleCanvas)
    return () => window.cancelAnimationFrame(frame)
  }, [consoleUrl, keyboardOpen])

  const close = () => {
    window.close()
    window.setTimeout(() => window.history.back(), 100)
  }

  const sendClipboard = async () => {
    const text = window.prompt(
      'Clipboard text to send and paste into this console'
    )
    const client = rfbRef.current
    if (text === null || !client) return

    setSendingClipboard(true)
    try {
      // Text consoles often have no guest clipboard provider, so use VNC keys.
      client.focus({ preventScroll: true })
      for (const character of Array.from(text)) {
        const keysym = character.codePointAt(0)
        if (keysym === undefined) continue
        client.sendKey(keysym, undefined, true)
        await new Promise<void>((resolve) => window.setTimeout(resolve, 18))
        client.sendKey(keysym, undefined, false)
        await new Promise<void>((resolve) => window.setTimeout(resolve, 18))
      }
      setMessage('Clipboard sent')
    } catch {
      setMessage('Could not send clipboard text.')
    } finally {
      setSendingClipboard(false)
    }
  }

  const sendVirtualKey = (virtualKey: VirtualKey) => {
    const client = rfbRef.current
    const keysym = keyboardKeysym(virtualKey.key)
    if (!client || keysym === undefined) return
    const keepPhoneKeyboard = phoneKeyboardRequestedRef.current
    if (!keepPhoneKeyboard) client.focus({ preventScroll: true })
    for (const modifier of activeModifiers) {
      const modifierKeysym = keyboardKeysym(modifier)
      if (modifierKeysym !== undefined) {
        client.sendKey(modifierKeysym, HOTKEY_MODIFIERS[modifier].code, true)
      }
    }
    client.sendKey(keysym, virtualKey.code, true)
    client.sendKey(keysym, virtualKey.code, false)
    for (const modifier of [...activeModifiers].reverse()) {
      const modifierKeysym = keyboardKeysym(modifier)
      if (modifierKeysym !== undefined) {
        client.sendKey(modifierKeysym, HOTKEY_MODIFIERS[modifier].code, false)
      }
    }
    if (activeModifiers.length) setActiveModifiers([])
    if (keepPhoneKeyboard) {
      phoneKeyboardInputRef.current?.focus({ preventScroll: true })
    }
  }

  const sendCtrlShortcut = async (key: string) => {
    const client = rfbRef.current
    const keysym = keyboardKeysym(key)
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
    const control = keyboardKeysym('Control')
    if (!client || keysym === undefined || control === undefined) return
    const keepPhoneKeyboard = phoneKeyboardRequestedRef.current
    if (!keepPhoneKeyboard) client.focus({ preventScroll: true })
    client.sendKey(control, 'ControlLeft', true)
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20))
    client.sendKey(keysym, code, true)
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20))
    client.sendKey(keysym, code, false)
    client.sendKey(control, 'ControlLeft', false)
    if (keepPhoneKeyboard) {
      phoneKeyboardInputRef.current?.focus({ preventScroll: true })
    }
  }

  const sendPhoneText = (text: string) => {
    const client = rfbRef.current
    if (!client || !text) return
    for (const character of Array.from(text)) {
      const keysym = keyboardKeysym(character)
      if (keysym === undefined) continue
      for (const modifier of activeModifiers) {
        const modifierKeysym = keyboardKeysym(modifier)
        if (modifierKeysym !== undefined) {
          client.sendKey(modifierKeysym, HOTKEY_MODIFIERS[modifier].code, true)
        }
      }
      client.sendKey(keysym, undefined, true)
      client.sendKey(keysym, undefined, false)
      for (const modifier of [...activeModifiers].reverse()) {
        const modifierKeysym = keyboardKeysym(modifier)
        if (modifierKeysym !== undefined) {
          client.sendKey(modifierKeysym, HOTKEY_MODIFIERS[modifier].code, false)
        }
      }
      if (activeModifiers.length) {
        setActiveModifiers([])
        break
      }
    }
  }

  const toggleModifier = (modifier: HotkeyModifier) => {
    setActiveModifiers((current) =>
      current.includes(modifier)
        ? current.filter((item) => item !== modifier)
        : [...current, modifier]
    )
  }

  const openPhoneKeyboard = () => {
    if (state !== 'connected') return
    if (phoneKeyboardRequestedRef.current) {
      phoneKeyboardRequestedRef.current = false
      setPhoneKeyboardActive(false)
      phoneKeyboardInputRef.current?.blur()
      return
    }
    phoneKeyboardRequestedRef.current = true
    setPhoneKeyboardActive(true)
    // This must be called directly from the touch event for iOS to open its
    // software keyboard rather than treating it as a programmatic focus.
    phoneKeyboardInputRef.current?.focus({ preventScroll: true })
  }

  const handlePhoneKeyboardInput = (value: string, inputType?: string) => {
    if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
      sendVirtualKey(VIRTUAL_KEYS.enter)
      return
    }
    if (inputType === 'deleteContentBackward') {
      sendVirtualKey(VIRTUAL_KEYS.backspace)
      return
    }
    if (inputType === 'deleteContentForward') {
      sendVirtualKey(VIRTUAL_KEYS.delete)
      return
    }
    sendPhoneText(value)
  }

  const handlePhoneKeyboardBlur = () => {
    window.setTimeout(() => {
      // Keep the software keyboard open through any console UI interaction.
      // The explicit ABC control is the only action that clears this flag.
      if (phoneKeyboardRequestedRef.current) {
        phoneKeyboardInputRef.current?.focus({ preventScroll: true })
        return
      }
      setPhoneKeyboardActive(false)
    }, 0)
  }

  const showKeyFeedback = (button: HTMLButtonElement) => {
    const label = button.dataset.keyFeedback
    if (!label) return
    const rect = button.getBoundingClientRect()
    setKeyFeedback({
      label,
      x: rect.left + rect.width / 2,
      y: Math.max(8, rect.top - 8),
    })
    if (keyFeedbackTimerRef.current) {
      window.clearTimeout(keyFeedbackTimerRef.current)
    }
    keyFeedbackTimerRef.current = window.setTimeout(
      () => setKeyFeedback(undefined),
      520
    )
  }

  const moveRemoteMouse = (x: number, y: number, buttonMask?: number) => {
    const canvas = canvasHost.current?.querySelector('canvas')
    const client = rfbRef.current as unknown as {
      _handleMouseMove: (mouseX: number, mouseY: number) => void
      _handleMouseButton: (mouseX: number, mouseY: number, mask: number) => void
    } | null
    if (!canvas || !client || state !== 'connected') return
    const rect = canvas.getBoundingClientRect()
    const next = {
      x: clamp(x, 0, Math.max(0, rect.width - 1)),
      y: clamp(y, 0, Math.max(0, rect.height - 1)),
    }
    trackpadCursorRef.current = next
    if (buttonMask === undefined) client._handleMouseMove(next.x, next.y)
    else client._handleMouseButton(next.x, next.y, buttonMask)
  }

  const clickRemoteMouse = (buttonMask = 1) => {
    const canvas = canvasHost.current?.querySelector('canvas')
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const current = trackpadCursorRef.current
    const x = current.x || rect.width / 2
    const y = current.y || rect.height / 2
    moveRemoteMouse(x, y, buttonMask)
    moveRemoteMouse(x, y, 0)
  }

  const scrollRemoteMouse = (deltaY: number) => {
    const current = trackpadCursorRef.current
    // VNC encodes wheel up/down as mouse-button 4/5 (bit 3/4).
    const wheelMask = deltaY < 0 ? 1 << 3 : 1 << 4
    moveRemoteMouse(current.x, current.y, wheelMask)
    moveRemoteMouse(current.x, current.y, 0)
  }

  const beginTrackpad = (event: ReactPointerEvent<HTMLDivElement>) => {
    const canvas = canvasHost.current?.querySelector('canvas')
    if (
      canvas &&
      !trackpadCursorRef.current.x &&
      !trackpadCursorRef.current.y
    ) {
      const rect = canvas.getBoundingClientRect()
      trackpadCursorRef.current = { x: rect.width / 2, y: rect.height / 2 }
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const pointers = trackpadPointersRef.current
    pointers.set(event.pointerId, {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    })
    if (pointers.size === 2) {
      trackpadGestureRef.current = {
        twoFinger: true,
        moved: false,
        scrollY: 0,
      }
    }
  }

  const moveTrackpad = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = trackpadPointersRef.current
    const pointer = pointers.get(event.pointerId)
    if (!pointer) return
    const deltaX = event.clientX - pointer.x
    const deltaY = event.clientY - pointer.y
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) pointer.moved = true
    pointer.x = event.clientX
    pointer.y = event.clientY
    if (pointers.size >= 2 || trackpadGestureRef.current.twoFinger) {
      const gesture = trackpadGestureRef.current
      if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) gesture.moved = true
      gesture.scrollY += deltaY
      if (Math.abs(gesture.scrollY) >= 16) {
        scrollRemoteMouse(gesture.scrollY)
        gesture.scrollY = 0
      }
      return
    }
    const current = trackpadCursorRef.current
    moveRemoteMouse(current.x + deltaX * 1.4, current.y + deltaY * 1.4)
  }

  const endTrackpad = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = trackpadPointersRef.current
    const pointer = pointers.get(event.pointerId)
    if (!pointer) return
    const gesture = trackpadGestureRef.current
    const usedTwoFingers = gesture.twoFinger || pointers.size >= 2
    pointers.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (pointers.size) return
    if (usedTwoFingers) {
      if (!gesture.moved) clickRemoteMouse(4)
      trackpadGestureRef.current = {
        twoFinger: false,
        moved: false,
        scrollY: 0,
      }
      return
    }
    if (!pointer.moved) clickRemoteMouse()
  }

  const sendCtrlAltDel = () => {
    rfbRef.current?.sendCtrlAltDel()
    rfbRef.current?.focus({ preventScroll: true })
    setCtrlAltDelOpen(false)
  }

  const openPasswordDialog = () => {
    setNewPassword('')
    setPasswordError('')
    setPasswordOpen(true)
  }

  const changePassword = async () => {
    if (!serverId || !projectId || !newPassword) return
    setChangingPassword(true)
    setPasswordError('')
    try {
      const { data } = await apiClient.post<{
        items?: Array<{ server_id: string; status: string; error?: string }>
      }>(
        '/cloud/servers/change-password',
        { server_ids: [serverId], password: newPassword },
        { headers: { 'X-Project-Id': projectId }, timeout: 45_000 }
      )
      const outcome = data.items?.[0]
      if (outcome?.error || outcome?.status === 'failed') {
        setPasswordError(outcome.error || 'Password change failed.')
        return
      }
      setPasswordOpen(false)
      setNewPassword('')
      setMessage('Password changed')
    } catch (error) {
      setPasswordError(
        error instanceof Error ? error.message : 'Password change failed.'
      )
    } finally {
      setChangingPassword(false)
    }
  }

  const currentLauncherPosition = launcherPosition ?? {
    x: viewportSize.width - 58,
    y: viewportSize.height - 126,
  }
  const keyboardBarWidth = Math.max(280, viewportSize.width - 16)
  const keyboardBarHeight =
    viewportSize.width >= 768 ? 52 : functionKeysOpen ? 152 : 80
  const keyboardBarPosition = {
    x: clamp(
      currentLauncherPosition.x - keyboardBarWidth + 44,
      8,
      Math.max(8, viewportSize.width - keyboardBarWidth - 8)
    ),
    y:
      currentLauncherPosition.y > keyboardBarHeight + 12
        ? currentLauncherPosition.y - keyboardBarHeight - 8
        : Math.min(
            viewportSize.height - keyboardBarHeight - 8,
            currentLauncherPosition.y + 54
          ),
  }

  const beginLauncherDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    launcherDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: currentLauncherPosition,
      moved: false,
    }
  }

  const moveLauncher = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = launcherDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const deltaX = event.clientX - drag.startX
    const deltaY = event.clientY - drag.startY
    if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) drag.moved = true
    setLauncherPosition({
      x: clamp(drag.origin.x + deltaX, 8, Math.max(8, viewportSize.width - 52)),
      y: clamp(
        drag.origin.y + deltaY,
        52,
        Math.max(52, viewportSize.height - 52)
      ),
    })
  }

  const endLauncherDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (launcherDragRef.current?.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <main className='fixed inset-0 z-40 flex min-h-svh flex-col bg-slate-950 font-sans text-slate-100'>
      <textarea
        ref={phoneKeyboardInputRef}
        className='pointer-events-none fixed -top-px -left-px size-px opacity-0'
        tabIndex={-1}
        autoCapitalize='none'
        autoCorrect='off'
        autoComplete='off'
        spellCheck={false}
        aria-label='Mobile console keyboard input'
        onBlur={handlePhoneKeyboardBlur}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            sendVirtualKey(VIRTUAL_KEYS.enter)
            event.currentTarget.value = ''
          }
          if (event.key === 'Backspace') {
            event.preventDefault()
            sendVirtualKey(VIRTUAL_KEYS.backspace)
          }
          if (event.key === 'Delete') {
            event.preventDefault()
            sendVirtualKey(VIRTUAL_KEYS.delete)
          }
        }}
        onBeforeInput={(event) => {
          const inputEvent = event.nativeEvent as InputEvent
          if (
            inputEvent.inputType === 'insertLineBreak' ||
            inputEvent.inputType === 'insertParagraph'
          ) {
            event.preventDefault()
            sendVirtualKey(VIRTUAL_KEYS.enter)
          }
          if (inputEvent.inputType === 'deleteContentBackward') {
            event.preventDefault()
            sendVirtualKey(VIRTUAL_KEYS.backspace)
          }
          if (inputEvent.inputType === 'deleteContentForward') {
            event.preventDefault()
            sendVirtualKey(VIRTUAL_KEYS.delete)
          }
        }}
        onInput={(event) => {
          const inputEvent = event.nativeEvent as InputEvent
          if (inputEvent.isComposing) return
          const input = event.currentTarget
          handlePhoneKeyboardInput(input.value, inputEvent.inputType)
          input.value = ''
        }}
        onCompositionEnd={(event) => {
          const input = event.currentTarget
          handlePhoneKeyboardInput(input.value)
          input.value = ''
        }}
      />
      <header className='flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-slate-700 bg-slate-900 px-3 whitespace-nowrap shadow-lg'>
        <button
          type='button'
          onClick={close}
          className='inline-flex size-8 items-center justify-center rounded-md text-slate-300 transition hover:bg-slate-800 hover:text-white'
          aria-label='Close mobile console'
          title='Close console'
        >
          <ArrowLeft className='size-4' />
        </button>
        <div className='flex min-w-0 items-center gap-2 border-s border-slate-700 ps-3 text-xs'>
          <span className='max-w-52 truncate font-semibold text-white'>
            {server?.name || 'Loading VM…'}
          </span>
          <span className='text-slate-600'>•</span>
          <span className='max-w-48 truncate font-mono text-slate-300'>
            {ipList(server?.private_ip)}
          </span>
          <span className='hidden text-slate-600 lg:inline'>•</span>
          <span className='hidden max-w-36 truncate text-slate-300 lg:inline'>
            {server?.zone_display_name || '—'}
          </span>
        </div>
        <div className='ms-auto flex shrink-0 items-center gap-1.5'>
          <span
            className={`inline-flex size-8 items-center justify-center rounded-full border ${
              state === 'connected'
                ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                : state === 'error'
                  ? 'border-red-500/50 bg-red-500/10 text-red-300'
                  : 'border-amber-500/50 bg-amber-500/10 text-amber-200'
            }`}
            title={message}
            aria-label={message}
          >
            {state === 'connected' ? (
              <Monitor className='size-3' />
            ) : state === 'error' ? (
              <WifiOff className='size-3' />
            ) : (
              <Loader2 className='size-3 animate-spin' />
            )}
          </span>
          <button
            type='button'
            onClick={() => void sendClipboard()}
            disabled={state !== 'connected' || sendingClipboard}
            className='inline-flex size-8 items-center justify-center rounded-md border border-slate-700 text-slate-200 transition hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-45'
            aria-label='Send clipboard text'
            title='Send clipboard text'
          >
            {sendingClipboard ? (
              <Loader2 className='size-3.5 animate-spin' />
            ) : (
              <ClipboardPaste className='size-3.5' />
            )}
          </button>
          <button
            type='button'
            onClick={() => setCtrlAltDelOpen(true)}
            disabled={state !== 'connected'}
            className='inline-flex size-8 items-center justify-center rounded-md border border-slate-700 text-slate-200 transition hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-45'
            aria-label='Send CtrlAltDel'
            title='Send CtrlAltDel'
          >
            <Power className='size-3.5' />
          </button>
          <button
            type='button'
            onClick={openPasswordDialog}
            disabled={!serverId || changingPassword}
            className='inline-flex size-8 items-center justify-center rounded-md border border-slate-700 text-slate-200 transition hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-45'
            aria-label='Change server password'
            title='Change password'
          >
            <KeyRound className='size-3.5' />
          </button>
          <button
            type='button'
            onClick={() => void openConsole()}
            className='inline-flex size-8 items-center justify-center rounded-md border border-slate-700 text-slate-300 transition hover:bg-slate-800 hover:text-white'
            aria-label='Reconnect console'
            title='Reconnect console'
          >
            <RefreshCw
              className={state === 'loading' ? 'size-4 animate-spin' : 'size-4'}
            />
          </button>
        </div>
      </header>
      <section
        className='relative min-h-0 flex-1 overflow-hidden bg-black transition-[margin] duration-200'
        style={
          keyboardOpen
            ? { marginBottom: `${keyboardBarHeight + 16}px` }
            : undefined
        }
      >
        {state !== 'connected' && (
          <div className='pointer-events-none absolute inset-0 z-10 grid place-items-center bg-black/20'>
            <div className='rounded-md bg-slate-900/90 px-4 py-3 text-sm text-slate-200 shadow-xl'>
              {message}
            </div>
          </div>
        )}
        <div ref={canvasHost} className='size-full' />
        {trackpadOpen && (
          <div
            className='absolute inset-0 z-20 touch-none bg-transparent'
            onPointerDown={beginTrackpad}
            onPointerMove={moveTrackpad}
            onPointerUp={endTrackpad}
            onPointerCancel={endTrackpad}
            aria-label='VNC trackpad'
          />
        )}
      </section>
      {!keyboardOpen && (
        <button
          type='button'
          onPointerDown={beginLauncherDrag}
          onPointerMove={moveLauncher}
          onPointerUp={endLauncherDrag}
          onPointerCancel={endLauncherDrag}
          onClick={() => {
            const drag = launcherDragRef.current
            if (drag?.moved) {
              launcherDragRef.current = null
              return
            }
            launcherDragRef.current = null
            setKeyboardOpen((open) => !open)
          }}
          style={{
            left: `${currentLauncherPosition.x}px`,
            top: `${currentLauncherPosition.y}px`,
          }}
          className={`fixed z-50 inline-flex size-11 touch-none items-center justify-center rounded-full border shadow-lg transition-[background-color,border-color,color] ${
            keyboardOpen
              ? 'border-sky-400 bg-sky-500 text-white'
              : 'border-slate-600 bg-slate-800/95 text-slate-100 hover:bg-slate-700'
          }`}
          aria-label={
            keyboardOpen
              ? 'Hide virtual keyboard bar'
              : 'Show virtual keyboard bar'
          }
          title={keyboardOpen ? 'Hide keyboard bar' : 'Show keyboard bar'}
        >
          <Keyboard className='size-5' />
        </button>
      )}
      {keyboardOpen && (
        <nav
          style={{
            left: `${keyboardBarPosition.x}px`,
            top: `${keyboardBarPosition.y}px`,
            width: `${keyboardBarWidth}px`,
          }}
          onPointerDownCapture={(event) => {
            if (phoneKeyboardActive) event.preventDefault()
          }}
          onClickCapture={(event) => {
            const button = (
              event.target as HTMLElement
            ).closest<HTMLButtonElement>('button[data-key-feedback]')
            if (button) showKeyFeedback(button)
          }}
          className='fixed z-40 grid grid-cols-10 gap-0.5 overflow-x-auto rounded-lg border border-slate-700 bg-slate-900/98 p-1.5 shadow-2xl backdrop-blur sm:grid-cols-12 md:flex md:flex-nowrap md:gap-1 md:p-2'
          aria-label='Virtual console keyboard'
        >
          {(Object.keys(HOTKEY_MODIFIERS) as HotkeyModifier[]).map(
            (modifier) => (
              <button
                key={modifier}
                type='button'
                onClick={() => toggleModifier(modifier)}
                className={`inline-flex h-7 min-w-0 touch-manipulation items-center justify-center rounded border px-1 text-[10px] font-bold transition md:h-9 md:w-auto md:shrink-0 md:rounded-md md:px-2.5 md:text-xs ${
                  activeModifiers.includes(modifier)
                    ? 'border-sky-300 bg-sky-500 text-white'
                    : 'border-sky-500/50 bg-sky-500/10 text-sky-100 hover:bg-sky-500/20'
                }`}
                aria-pressed={activeModifiers.includes(modifier)}
                title={`${HOTKEY_MODIFIERS[modifier].label} modifier`}
                data-key-feedback={HOTKEY_MODIFIERS[modifier].label}
              >
                {HOTKEY_MODIFIERS[modifier].label}
              </button>
            )
          )}
          {(
            [
              VIRTUAL_KEYS.enter,
              VIRTUAL_KEYS.tab,
              VIRTUAL_KEYS.esc,
              VIRTUAL_KEYS.capsLock,
              VIRTUAL_KEYS.backspace,
              VIRTUAL_KEYS.up,
              VIRTUAL_KEYS.down,
              VIRTUAL_KEYS.left,
              VIRTUAL_KEYS.right,
              VIRTUAL_KEYS.delete,
              VIRTUAL_KEYS.win,
            ] as VirtualKey[]
          ).map((virtualKey) => (
            <button
              key={virtualKey.key}
              type='button'
              onClick={() => sendVirtualKey(virtualKey)}
              disabled={state !== 'connected'}
              data-key-feedback={virtualKey.label}
              className='inline-flex h-7 min-w-0 touch-manipulation items-center justify-center rounded border border-slate-600 bg-slate-800 px-1 text-[10px] font-medium text-slate-100 transition hover:bg-slate-700 disabled:opacity-40 md:h-9 md:w-auto md:shrink-0 md:rounded-md md:px-3 md:text-xs'
            >
              {virtualKey.label}
            </button>
          ))}
          <button
            type='button'
            onClick={openPhoneKeyboard}
            disabled={state !== 'connected'}
            className={`inline-flex h-7 min-w-0 touch-manipulation items-center justify-center rounded border px-1 text-[10px] font-bold transition disabled:opacity-40 md:h-9 md:w-auto md:shrink-0 md:rounded-md md:px-2.5 md:text-xs ${
              phoneKeyboardActive
                ? 'border-emerald-400/70 bg-emerald-500/20 text-emerald-100'
                : 'border-violet-500/50 bg-violet-500/10 text-violet-100 hover:bg-violet-500/20'
            }`}
            title='Open phone keyboard for text input'
            data-key-feedback='ABC'
          >
            ABC
          </button>
          <button
            type='button'
            onClick={() => setFunctionKeysOpen((open) => !open)}
            className={`inline-flex h-7 min-w-0 touch-manipulation items-center justify-center rounded border px-1 text-[10px] font-bold transition md:h-9 md:w-auto md:shrink-0 md:rounded-md md:px-2.5 md:text-xs ${
              functionKeysOpen
                ? 'border-amber-400/70 bg-amber-500/20 text-amber-100'
                : 'border-slate-500 bg-slate-800 text-slate-100 hover:bg-slate-700'
            }`}
            title='Show function keys'
            data-key-feedback='Fn'
          >
            Fn
          </button>
          {['c', 'v'].map((key) => (
            <button
              key={key}
              type='button'
              onClick={() => {
                setActiveModifiers([])
                void sendCtrlShortcut(key)
              }}
              disabled={state !== 'connected'}
              data-key-feedback={`Ctrl+${key.toUpperCase()}`}
              className='inline-flex h-7 min-w-0 touch-manipulation items-center justify-center rounded border border-sky-500/50 bg-sky-500/10 px-1 text-[10px] font-medium text-sky-100 transition hover:bg-sky-500/20 disabled:opacity-40 md:h-9 md:w-auto md:shrink-0 md:rounded-md md:px-2.5 md:text-xs'
            >
              Ctrl+{key.toUpperCase()}
            </button>
          ))}
          {functionKeysOpen &&
            (
              [
                VIRTUAL_KEYS.home,
                VIRTUAL_KEYS.end,
                VIRTUAL_KEYS.pageUp,
                VIRTUAL_KEYS.pageDown,
                VIRTUAL_KEYS.insert,
                VIRTUAL_KEYS.f1,
                VIRTUAL_KEYS.f2,
                VIRTUAL_KEYS.f3,
                VIRTUAL_KEYS.f4,
                VIRTUAL_KEYS.f5,
                VIRTUAL_KEYS.f6,
                VIRTUAL_KEYS.f7,
                VIRTUAL_KEYS.f8,
                VIRTUAL_KEYS.f9,
                VIRTUAL_KEYS.f10,
                VIRTUAL_KEYS.f11,
                VIRTUAL_KEYS.f12,
              ] as VirtualKey[]
            ).map((virtualKey) => (
              <button
                key={virtualKey.key}
                type='button'
                onClick={() => sendVirtualKey(virtualKey)}
                disabled={state !== 'connected'}
                data-key-feedback={virtualKey.label}
                className='inline-flex h-7 min-w-0 touch-manipulation items-center justify-center rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] font-medium text-amber-100 transition hover:bg-amber-500/20 disabled:opacity-40 md:h-9 md:w-auto md:shrink-0 md:rounded-md md:px-3 md:text-xs'
              >
                {virtualKey.label}
              </button>
            ))}
          <div className='col-span-2 col-start-9 flex justify-end gap-0.5 sm:col-start-11 md:ms-auto md:gap-1'>
            <button
              type='button'
              onClick={() => setTrackpadOpen((open) => !open)}
              disabled={state !== 'connected'}
              className={`inline-flex h-7 min-w-0 touch-manipulation items-center justify-center rounded border px-1 text-[10px] transition disabled:opacity-40 md:h-9 md:w-auto md:shrink-0 md:rounded-md md:px-2.5 md:text-xs ${
                trackpadOpen
                  ? 'border-sky-300 bg-sky-500 text-white'
                  : 'border-slate-500 bg-slate-800 text-slate-100 hover:bg-slate-700'
              }`}
              title='Toggle VNC trackpad'
              data-key-feedback='Trackpad'
            >
              <Mouse className='size-3.5 md:size-4' />
            </button>
            <button
              type='button'
              onPointerDown={beginLauncherDrag}
              onPointerMove={moveLauncher}
              onPointerUp={endLauncherDrag}
              onPointerCancel={endLauncherDrag}
              onClick={() => {
                const drag = launcherDragRef.current
                if (drag?.moved) {
                  launcherDragRef.current = null
                  return
                }
                launcherDragRef.current = null
                setKeyboardOpen(false)
              }}
              className='inline-flex h-7 min-w-0 touch-none items-center justify-center rounded border border-slate-500 bg-slate-800 px-1 text-slate-100 transition hover:bg-slate-700 md:h-9 md:w-auto md:shrink-0 md:rounded-md md:px-3'
              aria-label='Hide virtual keyboard bar'
              title='Drag to move keyboard bar; tap to hide'
              data-key-feedback='⌨'
            >
              <Keyboard className='size-4' />
            </button>
          </div>
        </nav>
      )}
      {keyFeedback && (
        <div
          className='pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-xl border border-white/20 bg-slate-950/95 px-4 py-2 text-lg font-semibold text-white shadow-2xl backdrop-blur-sm'
          style={{ left: `${keyFeedback.x}px`, top: `${keyFeedback.y}px` }}
          aria-hidden='true'
        >
          {keyFeedback.label}
        </div>
      )}
      <Dialog
        open={passwordOpen}
        onOpenChange={(open) => {
          if (!changingPassword) setPasswordOpen(open)
        }}
      >
        <DialogContent className='w-[calc(100vw-2rem)] max-w-sm'>
          <DialogHeader>
            <DialogTitle>Change server password</DialogTitle>
            <DialogDescription>
              Set a new password for {server?.name || 'this VM'}.
            </DialogDescription>
          </DialogHeader>
          <form
            className='space-y-3'
            onSubmit={(event) => {
              event.preventDefault()
              void changePassword()
            }}
          >
            <Input
              type='password'
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder='New password'
              autoComplete='new-password'
              autoFocus
              disabled={changingPassword}
              aria-label='New password'
            />
            {passwordError && (
              <p className='text-sm text-destructive'>{passwordError}</p>
            )}
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                onClick={() => setPasswordOpen(false)}
                disabled={changingPassword}
              >
                Cancel
              </Button>
              <Button type='submit' disabled={!newPassword || changingPassword}>
                {changingPassword && <Loader2 className='animate-spin' />}
                Change password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={ctrlAltDelOpen}
        onOpenChange={setCtrlAltDelOpen}
        title='Send CtrlAltDel?'
        desc='This can interrupt or restart the operating system in the VM.'
        cancelBtnText='Cancel'
        confirmText='Send CtrlAltDel'
        handleConfirm={sendCtrlAltDel}
      />
    </main>
  )
}
