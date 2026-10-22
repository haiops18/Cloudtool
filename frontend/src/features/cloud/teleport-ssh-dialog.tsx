import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ChevronDown, ChevronUp, Download, Loader2, PlugZap, RefreshCw, Search, SquareTerminal, Terminal, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SearchableSelect } from '@/components/searchable-select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ServerRow } from './types'

type TeleportLink = { id: string; name: string; url: string }
type TerminalTicket = { ticket: string; resolved_host?: string }
type TeleportNode = { name: string; ip: string; labels: string }

function apiError(error: unknown) {
  const data = (error as { response?: { data?: unknown } }).response?.data
  if (data && typeof data === 'object') {
    const value = data as { detail?: unknown; message?: unknown; error?: { message?: unknown } }
    const message = [value.detail, value.message, value.error?.message]
      .find((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    if (message) return message
  }
  return error instanceof Error ? error.message : 'Could not open the Teleport terminal.'
}

function terminalSocketUrl(ticket: string) {
  const base = new URL(apiClient.defaults.baseURL ?? '/api/v1', window.location.origin)
  const url = new URL(`${base.pathname.replace(/\/$/, '')}/teleport-links/tsh/terminal/ws`, base.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('ticket', ticket)
  return url.toString()
}

export function TeleportSshDialog({ open, onOpenChange, server }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  server?: ServerRow
}) {
  const terminalHost = useRef<HTMLDivElement>(null)
  const fitTerminal = useRef<(() => void) | undefined>(undefined)
  const [linkId, setLinkId] = useState('')
  const [ip, setIp] = useState('')
  const [searchIp, setSearchIp] = useState('')
  const [login, setLogin] = useState('root')
  const [ticket, setTicket] = useState<TerminalTicket>()
  const [connecting, setConnecting] = useState(false)
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const [searchPanelOpen, setSearchPanelOpen] = useState(true)
  const [activeNode, setActiveNode] = useState<TeleportNode>()
  const [filePanelOpen, setFilePanelOpen] = useState(false)
  const [remotePath, setRemotePath] = useState('/tmp/')
  const [transferFile, setTransferFile] = useState<File>()
  const [transferring, setTransferring] = useState(false)
  const [status, setStatus] = useState('Choose a Teleport link, then connect.')
  const links = useQuery({
    queryKey: ['teleport-links'],
    enabled: open,
    queryFn: async ({ signal }) => (await apiClient.get<TeleportLink[]>('/teleport-links', { signal })).data,
  })
  const nodes = useQuery({
    queryKey: ['teleport-links', linkId, 'tsh-nodes', searchIp],
    enabled: open && Boolean(linkId) && Boolean(searchIp),
    queryFn: async ({ signal }) => (await apiClient.get<{ nodes: TeleportNode[] }>(`/teleport-links/${linkId}/tsh/nodes`, { params: { ip: searchIp }, signal })).data.nodes,
  })
  const privateIps = useMemo(
    () => (server?.private_ip ?? []).map((item) => item.ip_address).filter(Boolean),
    [server]
  )

  useEffect(() => {
    if (!open) return
    setIp(privateIps.find((value) => value.startsWith('10.129.')) ?? privateIps[0] ?? '')
    setSearchIp('')
    setSearchPanelOpen(true)
    setTicket(undefined)
    setActiveNode(undefined)
    setStatus('Choose a Teleport link, then connect.')
  }, [open, privateIps, server?.id])
  useEffect(() => {
    if (linkId && links.data?.some((link) => link.id === linkId)) return
    setLinkId(links.data?.[0]?.id ?? '')
  }, [linkId, links.data])
  useEffect(() => { setSearchIp('') }, [linkId])

  useEffect(() => {
    if (!open || !ticket || !terminalHost.current) return
    const host = terminalHost.current
    let socket: WebSocket | undefined
    let terminal: Xterm | undefined
    let resizeObserver: ResizeObserver | undefined
    let input: { dispose: () => void } | undefined
    let disposed = false
    terminal = new Xterm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: 'Cascadia Mono, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 10_000,
      // ConPTY may emit bare LF in addition to CRLF. Converting it prevents
      // the next line from starting in the previous cursor column.
      convertEol: true,
      theme: { background: '#09090b', foreground: '#e4e4e7', cursor: '#fafafa', selectionBackground: '#3f3f46' },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    const resize = () => {
      if (!terminal) return
      fit.fit()
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
      }
    }
    fitTerminal.current = resize
    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host)
    input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
    })
    socket = new WebSocket(terminalSocketUrl(ticket.ticket))
    socket.onopen = () => { setStatus('Connecting to tsh…'); resize(); terminal?.focus() }
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as { type: string; data?: string; message?: string; state?: string }
      if (message.type === 'output' && message.data) terminal?.write(message.data)
      if (message.type === 'status') setStatus(message.message || (message.state === 'ready' ? 'Connected' : 'Connecting to tsh…'))
      if (message.type === 'error') {
        const messageText = message.message || 'Terminal error'
        terminal?.writeln(`\r\n\x1b[31m${messageText}\x1b[0m`)
        setStatus(messageText)
      }
    }
    socket.onclose = (event) => {
      if (!disposed) {
        setStatus(event.reason || 'Terminal disconnected')
        terminal?.writeln('\r\n\x1b[33m[Teleport terminal disconnected]\x1b[0m')
      }
    }
    socket.onerror = () => setStatus('Terminal connection failed')
    return () => {
      disposed = true
      resizeObserver?.disconnect()
      input?.dispose()
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'close' }))
      socket?.close()
      terminal?.dispose()
      fitTerminal.current = undefined
    }
  }, [open, ticket])

  useEffect(() => {
    // CSS grid completes its row recalculation after this render. Resize xterm
    // on the next frame so hiding the search panel adds real terminal rows,
    // rather than merely moving the old buffer upward.
    const frame = requestAnimationFrame(() => fitTerminal.current?.())
    return () => cancelAnimationFrame(frame)
  }, [searchPanelOpen])

  const connect = async (node: TeleportNode) => {
    if (!linkId || !login || connecting) return
    setConnecting(true)
    setSearchPanelOpen(false)
    setTicket(undefined)
    setStatus('Authorizing terminal session…')
    try {
      const { data } = await apiClient.post<TerminalTicket>(`/teleport-links/${linkId}/tsh/terminal-ticket`, { host: node.name, login })
      setActiveNode(node)
      setTicket(data)
      setStatus(`Connecting to ${data.resolved_host ?? node.name} (${node.ip})…`)
    } catch (error) {
      const message = apiError(error)
      setStatus(message)
      setSearchPanelOpen(true)
      toast.error(message)
    } finally {
      setConnecting(false)
    }
  }

  const disconnect = () => {
    setTicket(undefined)
    setStatus('Disconnected. Connect again to start a new terminal.')
  }

  const requestClose = () => setCloseConfirmOpen(true)

  const uploadFile = async () => {
    if (!activeNode || !transferFile || !remotePath.trim()) return
    setTransferring(true)
    try {
      const form = new FormData()
      form.set('host', activeNode.name); form.set('login', login); form.set('remote_path', remotePath.trim()); form.set('file', transferFile)
      await apiClient.post(`/teleport-links/${linkId}/tsh/files/upload`, form)
      toast.success('File uploaded.')
    } catch (error) { toast.error(apiError(error)) } finally { setTransferring(false) }
  }

  const downloadFile = async () => {
    if (!activeNode || !remotePath.trim()) return
    setTransferring(true)
    try {
      const response = await apiClient.post(`/teleport-links/${linkId}/tsh/files/download`, { host: activeNode.name, login, remote_path: remotePath.trim() }, { responseType: 'blob' })
      const href = URL.createObjectURL(response.data as Blob); const anchor = document.createElement('a'); anchor.href = href; anchor.download = remotePath.trim().split('/').filter(Boolean).pop() || 'teleport-download'; anchor.click(); URL.revokeObjectURL(href)
    } catch (error) { toast.error(apiError(error)) } finally { setTransferring(false) }
  }

  const linkOptions = (links.data ?? []).map((link) => ({ label: link.name, value: link.id, description: link.url }))

  return <>
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) requestClose(); else onOpenChange(true) }}>
    <DialogContent showCloseButton={false} className={`!top-[2.5svh] grid !h-[min(60rem,95svh)] !max-h-[95svh] !w-[calc(100vw-1rem)] !max-w-[108rem] ${searchPanelOpen ? 'grid-rows-[auto_auto_minmax(0,1fr)]' : 'grid-rows-[auto_minmax(0,1fr)]'} overflow-hidden p-0 sm:!w-[98vw] sm:!max-w-[108rem]`}>
      <DialogHeader className='relative border-b px-5 py-4 pr-24 sm:px-6 sm:pr-28'>
        <DialogTitle className='flex items-center gap-2'><SquareTerminal /> Open in Teleport</DialogTitle>
        <DialogDescription className='flex flex-wrap items-center gap-x-3 gap-y-1'><span>Interactive SSH terminal for <span className='font-semibold text-foreground'>{server?.name ?? 'the selected server'}</span>.</span><span className='text-xs'>Click inside before typing · Ctrl+C, Ctrl+Z, Tab, arrows, vi and nano keys go directly to the VM.</span></DialogDescription>
        <Button aria-label='Refresh VM connection' title='Reconnect to this VM' className='absolute right-24 top-3.5' disabled={!ticket || !activeNode || connecting || transferring} onClick={() => { if (activeNode) void connect(activeNode) }} size='icon' type='button' variant='ghost'>{connecting ? <Loader2 className='animate-spin' /> : <RefreshCw />}</Button>
        <Button aria-label='Transfer files' className='absolute right-[8.5rem] top-3.5' disabled={!activeNode} onClick={() => setFilePanelOpen((value) => !value)} size='icon' type='button' variant='ghost'><Upload /></Button>
        <Button aria-label={searchPanelOpen ? 'Hide Teleport search' : 'Show Teleport search'} className='absolute right-14 top-3.5' onClick={() => setSearchPanelOpen((value) => !value)} size='icon' type='button' variant='ghost'>{searchPanelOpen ? <ChevronUp /> : <ChevronDown />}</Button>
        <Button aria-label='Close Teleport terminal' className='absolute right-4 top-3.5' onClick={requestClose} size='icon' type='button' variant='ghost'><X /></Button>
      </DialogHeader>
      {searchPanelOpen && <div className='grid gap-2 border-b px-4 py-2 sm:grid-cols-[minmax(13rem,.75fr)_minmax(15rem,1fr)_auto] sm:px-5'>
        <div className='space-y-1'><Label className='text-xs' htmlFor='teleport-terminal-link'>Teleport link</Label><SearchableSelect className='h-8 text-sm' disabled={Boolean(ticket)} emptyText='No Teleport link found.' loading={links.isLoading} onValueChange={setLinkId} options={linkOptions} placeholder='Select link' searchPlaceholder='Search links...' value={linkId} /></div>
        <div className='space-y-1'><Label className='text-xs' htmlFor='teleport-terminal-ip'>VM private IP</Label><Input className='h-8 font-mono text-sm' disabled={Boolean(ticket)} id='teleport-terminal-ip' list='teleport-private-ip-suggestions' onChange={(event) => setIp(event.target.value)} value={ip} /><datalist id='teleport-private-ip-suggestions'>{privateIps.map((value) => <option key={value} value={value} />)}</datalist></div>
        <div className='flex items-end'>{ticket ? <Button className='h-8 bg-destructive px-3 text-destructive-foreground hover:bg-destructive/90' onClick={disconnect} size='sm' type='button'><PlugZap /> Disconnect</Button> : <Button className='h-8 px-3' disabled={!linkId || !ip || nodes.isFetching} onClick={() => { if (searchIp === ip) void nodes.refetch(); else setSearchIp(ip) }} size='sm' type='button'>{nodes.isFetching ? <Loader2 className='animate-spin' /> : <Search />} Search</Button>}</div>
        {searchIp && <div className='space-y-1.5 sm:col-span-3'><div className='flex items-center gap-2 text-xs text-muted-foreground'><span>Results</span><span className='font-mono font-medium text-foreground'>{searchIp}</span></div>{nodes.isError ? <p className='rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive'>{apiError(nodes.error)}</p> : nodes.isSuccess && !nodes.data.length ? <p className='rounded border border-dashed px-2 py-1.5 text-xs text-muted-foreground'>This IP is not visible in the selected Teleport session.</p> : <div className='grid gap-1'>{(nodes.data ?? []).map((node) => <div className='grid gap-1.5 rounded border bg-muted/20 px-2 py-1.5 sm:grid-cols-[minmax(10rem,.6fr)_minmax(0,1fr)_8rem_auto] sm:items-center' key={`${node.name}-${node.ip}`}><div className='flex min-w-0 items-center gap-2'><span className='font-mono text-xs font-medium'>{node.ip}</span><span className='truncate text-xs text-muted-foreground'>{node.name}</span></div><div className='truncate text-xs text-muted-foreground'>{node.labels || 'No labels'}</div><Input aria-label={`SSH user for ${node.name}`} className='h-7 text-xs' disabled={Boolean(ticket)} list='teleport-ssh-user-suggestions' onChange={(event) => setLogin(event.target.value)} value={login} /><Button className='h-7 px-2' disabled={Boolean(ticket) || connecting || !login} onClick={() => void connect(node)} size='sm' type='button'>{connecting ? <Loader2 className='animate-spin' /> : <Terminal />} SSH</Button></div>)}</div>}<datalist id='teleport-ssh-user-suggestions'><option value='root' /><option value='app' /><option value='vt_admin' /></datalist></div>}
      </div>
      }
      <div className='relative min-h-0 bg-zinc-950 p-2 sm:p-3'><div className='h-full w-full' ref={terminalHost} /><div className='pointer-events-none absolute bottom-3 right-4 rounded bg-zinc-900/90 px-2 py-1 font-mono text-[11px] text-zinc-300'>{status}</div></div>
    </DialogContent>
    </Dialog>
    <Dialog open={filePanelOpen} onOpenChange={setFilePanelOpen}>
      <DialogContent className='w-[calc(100vw-2rem)] max-w-xl sm:!max-w-xl'>
        <DialogHeader><DialogTitle>Transfer files</DialogTitle><DialogDescription>{activeNode ? <><span className='font-mono text-foreground'>{activeNode.ip}</span> · {activeNode.name} · SSH user <span className='font-medium text-foreground'>{login}</span></> : 'Connect to a Teleport node first.'}</DialogDescription></DialogHeader>
        <Tabs defaultValue='upload'>
          <TabsList className='grid w-full grid-cols-2'><TabsTrigger value='upload'><Upload /> Upload to VM</TabsTrigger><TabsTrigger value='download'><Download /> Download from VM</TabsTrigger></TabsList>
          <TabsContent className='space-y-4 pt-3' value='upload'><div className='space-y-1.5'><Label>Select local file</Label><Input onChange={(event) => setTransferFile(event.target.files?.[0])} type='file' /></div><div className='space-y-1.5'><Label>Remote destination folder</Label><Input className='font-mono' onChange={(event) => setRemotePath(event.target.value)} placeholder='/tmp' value={remotePath} /><p className='text-xs text-muted-foreground'>The original file name is added automatically. Enter only the folder path.</p></div><div className='flex justify-end'><Button disabled={!activeNode || !transferFile || !remotePath.trim() || transferring} onClick={() => void uploadFile()} type='button'>{transferring ? <Loader2 className='animate-spin' /> : <Upload />} Upload file</Button></div></TabsContent>
          <TabsContent className='space-y-4 pt-3' value='download'><div className='space-y-1.5'><Label>Remote file path</Label><Input className='font-mono' onChange={(event) => setRemotePath(event.target.value)} placeholder='/var/log/application.log' value={remotePath} /><p className='text-xs text-muted-foreground'>Enter the exact file path on the selected VM.</p></div><div className='flex justify-end'><Button disabled={!activeNode || !remotePath.trim() || transferring} onClick={() => void downloadFile()} type='button'>{transferring ? <Loader2 className='animate-spin' /> : <Download />} Download file</Button></div></TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
    <ConfirmDialog cancelBtnText='Keep terminal' confirmText='Close terminal' desc={ticket ? 'The active Teleport SSH session will be terminated.' : 'Close the Open in Teleport window?'} handleConfirm={() => { setTicket(undefined); setCloseConfirmOpen(false); onOpenChange(false) }} open={closeConfirmOpen} onOpenChange={setCloseConfirmOpen} title='Close Teleport terminal?' />
  </>
}
