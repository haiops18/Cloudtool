import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentBaseUrl: string
  headers: Record<string, string> | undefined
}

function socketUrl(agentBaseUrl: string, ticket: string) {
  const url = new URL(`${agentBaseUrl.replace(/\/$/, '')}/terminal/ws`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('ticket', ticket)
  return url.toString()
}

export function CodexTerminalDialog({ open, onOpenChange, agentBaseUrl, headers }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('Preparing secure Codex terminal…')

  useEffect(() => {
    if (!open || !container.current) return
    if (!headers) {
      setStatus('Select a project and wait for CloudTool authentication before opening the terminal.')
      return
    }
    const terminalHost = container.current
    let socket: WebSocket | undefined
    let terminal: Terminal | undefined
    let observer: ResizeObserver | undefined
    let input: { dispose: () => void } | undefined
    let disposed = false
    void (async () => {
      try {
        // Authorize first.  If terminal rendering fails afterwards, the UI
        // reports the actual error instead of silently remaining "Preparing".
        setStatus('Authorizing terminal session…')
        const response = await fetch(`${agentBaseUrl}/terminal/ticket`, { method: 'POST', credentials: 'include', headers })
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message || 'Could not authorize the Codex terminal')
        const { ticket } = await response.json() as { ticket: string }
        if (disposed) return
        terminal = new Terminal({
          cursorBlink: true,
          fontFamily: 'Cascadia Mono, Consolas, monospace',
          fontSize: 13,
          theme: { background: '#09090b' },
        })
        terminal.open(terminalHost)
        const resize = () => {
          if (!terminal) return
          const cols = Math.max(20, Math.floor(terminalHost.clientWidth / 8))
          const rows = Math.max(8, Math.floor(terminalHost.clientHeight / 18))
          if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows)
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
        }
        observer = new ResizeObserver(resize)
        observer.observe(terminalHost)
        input = terminal.onData((data) => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
        })
        resize()
        socket = new WebSocket(socketUrl(agentBaseUrl, ticket))
        socket.onopen = () => { setStatus('Connected'); resize(); terminal?.focus() }
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data) as { type: string; data?: string; message?: string; state?: string }
          if (message.type === 'output' && message.data) terminal?.write(message.data)
          if (message.type === 'status') setStatus(message.state === 'ready' ? 'Connected' : message.message || 'Starting local Codex CLI…')
          if (message.type === 'error') terminal?.writeln(`\r\n\x1b[31m${message.message || 'Terminal error'}\x1b[0m`)
        }
        socket.onclose = (event) => {
          if (!disposed) {
            setStatus(event.reason || 'Terminal disconnected')
            terminal?.writeln('\r\n\x1b[33m[Codex terminal disconnected]\x1b[0m')
          }
        }
        socket.onerror = () => setStatus('Terminal connection failed')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not start Codex terminal'
        setStatus(message)
        terminal?.writeln(`\x1b[31m${message}\x1b[0m`)
      }
    })()
    return () => {
      disposed = true
      observer?.disconnect()
      input?.dispose()
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'close' }))
      socket?.close()
      terminal?.dispose()
    }
  }, [agentBaseUrl, headers, open])

  return <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent className='grid h-[88svh] w-[calc(100vw-2rem)] max-w-[90rem] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 sm:!max-w-[90rem]'>
      <DialogHeader className='border-b px-6 py-4'><DialogTitle>Direct Codex CLI terminal</DialogTitle><DialogDescription className='flex items-center gap-1.5'><AlertTriangle className='size-3.5 text-amber-600' />Admin-only interactive local Codex session. Its permissions and approvals are controlled by Codex itself.</DialogDescription></DialogHeader>
      <div className='min-h-0 bg-zinc-950 p-2'><div className='sr-only' aria-live='polite'>{status}</div><div className='h-full w-full' ref={container} />{status !== 'Connected' ? <div className='pointer-events-none absolute bottom-5 right-6 flex items-center gap-2 rounded bg-background/90 px-2 py-1 text-xs text-muted-foreground'><Loader2 className='size-3 animate-spin' />{status}</div> : null}</div>
    </DialogContent>
  </Dialog>
}
