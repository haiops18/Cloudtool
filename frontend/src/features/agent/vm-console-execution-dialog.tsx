import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { CheckCircle2, CircleStop, KeyRound, RefreshCw, ScrollText, Send } from 'lucide-react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { apiClient } from '@/lib/api-client'
import { consoleWebSocketUrl, keyboardKeysym } from '@/features/cloud/multi-console-utils'

type Server = { id: string; name: string; zone_display_name?: string }
type VmAction = { server: string; command: string; summary: string }
type Evidence = { source: string; count: number; note?: string | null }
type AgentResult = { answer?: string; vm_action?: VmAction | null; error?: { message?: string }; conversation_id?: string; evidence?: Evidence[]; csrf_token?: string | null }
type VmChatMessage = { id: string; role: 'user' | 'assistant'; text: string }
type OperationLog = { at: string; operation: string; content: string }
type Props = { open: boolean; onOpenChange: (value: boolean) => void; agentBaseUrl: string; agentHeaders?: Record<string, string>; initialCommand?: string; action?: VmAction; conversationId?: string; onCsrfToken: (value?: string | null) => void; onNextAction: (action: VmAction) => void; onChatExchange: (exchange: { userText: string; answer: string; conversationId?: string; evidence?: Evidence[] }) => void }
const bypassStorageKey = 'cloudtool.agent.vm-console-bypass'
const agentPasswordStorageKey = 'cloudtool.agent.vm-console-password'
const commandBlock = /```(?:bash|sh|shell|console)?\s*\n([\s\S]*?)```/i

function backendWebSocketUrl(path: string) { const base = new URL(apiClient.defaults.baseURL ?? '/api/v1', window.location.origin); const url = new URL(`${base.pathname.replace(/\/$/, '')}${path}`, base.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; return url.toString() }
function newPassword() { const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; const lower = 'abcdefghijkmnopqrstuvwxyz'; const digits = '23456789'; const chars = `${upper}${lower}${digits}`; const value = [upper[Math.floor(Math.random() * upper.length)], lower[Math.floor(Math.random() * lower.length)], digits[Math.floor(Math.random() * digits.length)], Math.random() < 0.5 ? '@' : '#', ...Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)])]; return value.sort(() => Math.random() - 0.5).join('') }
function validServerPassword(value: string) { return value.length > 8 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value) && /[@#]/.test(value) }
function matchesActionServer(server: Server, requested: string) { const target = requested.trim().toLowerCase(); return server.id.toLowerCase() === target || server.name.trim().toLowerCase() === target }
function commandFromAnswer(answer = '') { const value = answer.match(commandBlock)?.[1]?.trim(); return value && value.length <= 4000 ? value : undefined }
const symbolKeys: Record<string, [string, boolean]> = { ' ': ['Space', false], '-': ['Minus', false], _: ['Minus', true], '=': ['Equal', false], '+': ['Equal', true], '[': ['BracketLeft', false], '{': ['BracketLeft', true], ']': ['BracketRight', false], '}': ['BracketRight', true], '\\': ['Backslash', false], '|': ['Backslash', true], ';': ['Semicolon', false], ':': ['Semicolon', true], "'": ['Quote', false], '"': ['Quote', true], ',': ['Comma', false], '<': ['Comma', true], '.': ['Period', false], '>': ['Period', true], '/': ['Slash', false], '?': ['Slash', true], '`': ['Backquote', false], '~': ['Backquote', true], '!': ['Digit1', true], '@': ['Digit2', true], '#': ['Digit3', true], $: ['Digit4', true], '%': ['Digit5', true], '^': ['Digit6', true], '&': ['Digit7', true], '*': ['Digit8', true], '(': ['Digit9', true], ')': ['Digit0', true] }
function physicalKey(character: string): { code?: string; shift: boolean } { if (character === '\n') return { code: 'Enter', shift: false }; if (/^[a-z]$/i.test(character)) return { code: `Key${character.toUpperCase()}`, shift: character !== character.toLowerCase() }; if (/^[0-9]$/.test(character)) return { code: `Digit${character}`, shift: false }; const symbol = symbolKeys[character]; return symbol ? { code: symbol[0], shift: symbol[1] } : { shift: false } }
async function typeConsoleText(rfb: RFB, value: string) { rfb.focus({ preventScroll: true }); for (const char of Array.from(`${value}\n`)) { const keysym = keyboardKeysym(char === '\n' ? 'Enter' : char); if (keysym === undefined) continue; const descriptor = physicalKey(char); if (descriptor.shift) rfb.sendKey(keyboardKeysym('Shift')!, 'ShiftLeft', true); rfb.sendKey(keysym, descriptor.code, true); await new Promise<void>((resolve) => window.setTimeout(resolve, 24)); rfb.sendKey(keysym, descriptor.code, false); if (descriptor.shift) rfb.sendKey(keyboardKeysym('Shift')!, 'ShiftLeft', false); await new Promise<void>((resolve) => window.setTimeout(resolve, 24)) } }
const pause = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))

export function VmConsoleExecutionDialog({ open, onOpenChange, agentBaseUrl, agentHeaders, initialCommand, action, conversationId, onCsrfToken, onNextAction, onChatExchange }: Props) {
  const canvasHost = useRef<HTMLDivElement>(null)
  const rfb = useRef<RFB | null>(null)
  const rootPassword = useRef('')
  const loggedIn = useRef(false)
  const configuredAction = useRef('')
  const openedServer = useRef('')
  const approvalShown = useRef('')
  const loginPromptShown = useRef(false)
  const autoRunAction = useRef('')
  const chatAbort = useRef<AbortController | null>(null)
  const chatRequestId = useRef<string | undefined>(undefined)
  const actionKey = action ? `${action.server}\u0000${action.command}` : ''
  const [servers, setServers] = useState<Server[]>([])
  const [serverId, setServerId] = useState('')
  const [command, setCommand] = useState('uname -a')
  const [consoleUrl, setConsoleUrl] = useState<string>()
  const [websocketUrl, setWebsocketUrl] = useState<string>()
  const [vncReady, setVncReady] = useState(false)
  const [state, setState] = useState<'idle' | 'opening' | 'waiting_approval' | 'resetting_password' | 'logging_in' | 'running' | 'connected' | 'error'>('idle')
  const [, setDetail] = useState('Waiting for an AI-proposed VM action.')
  const [events, setEvents] = useState<string[]>([])
  const [analysis, setAnalysis] = useState('')
  const [confirmKind, setConfirmKind] = useState<'login' | 'command' | 'manual_password'>()
  const [loginReady, setLoginReady] = useState(false)
  const [bypassApproval, setBypassApproval] = useState(() => window.localStorage.getItem(bypassStorageKey) === 'true')
  const [manualPassword, setManualPassword] = useState('')
  const [agentPassword, setAgentPassword] = useState(() => window.localStorage.getItem(agentPasswordStorageKey) || 'Admin@123')
  const [agentDraft, setAgentDraft] = useState('')
  const [agentChatLoading, setAgentChatLoading] = useState(false)
  const [chatMessages, setChatMessages] = useState<VmChatMessage[]>([])
  const [operationLogs, setOperationLogs] = useState<OperationLog[]>([])
  const [logOpen, setLogOpen] = useState(false)

  const record = (operation: string, content?: string) => { const detail = content ? `${operation}: ${content}` : operation; setDetail(detail); setEvents((items) => [...items, detail].slice(-14)); setOperationLogs((items) => [...items, { at: new Date().toISOString(), operation, content: content ?? operation }].slice(-200)) }
  const selected = servers.find((server) => server.id === serverId)
  const refreshCsrf = async () => { if (!agentHeaders) throw new Error('CloudTool authentication is not ready.'); const response = await fetch(`${agentBaseUrl}/csrf/refresh`, { method: 'POST', credentials: 'include', headers: agentHeaders }); const data = await response.json().catch(() => null) as { csrf_token?: string; error?: { message?: string } } | null; if (!response.ok || !data?.csrf_token) throw new Error(data?.error?.message || 'Could not refresh CloudTool CSRF token.'); onCsrfToken(data.csrf_token) }
  const screenshotAttachment = () => { const canvas = canvasHost.current?.querySelector('canvas'); if (!canvas) return []; return [{ name: 'vm-console.png', media_type: 'image/png', content_base64: canvas.toDataURL('image/png').split(',', 2)[1] }] }
  const askAgent = async (message: string, includeScreen = true, signal?: AbortSignal, requestId?: string) => {
    if (!agentHeaders) throw new Error('CloudTool authentication is not ready.')
    const response = await fetch(`${agentBaseUrl}/chat`, { method: 'POST', credentials: 'include', headers: agentHeaders, signal, body: JSON.stringify({ message, conversation_id: conversationId, request_id: requestId, attachments: includeScreen ? screenshotAttachment() : [] }) })
    const result = await response.json() as AgentResult
    if (!response.ok) throw new Error(result.error?.message || 'AI request failed')
    onCsrfToken(result.csrf_token)
    return result
  }
  const openConsole = async () => { if (!serverId) return; setState('opening'); record('Requesting a one-time VNC console session…'); try { await refreshCsrf(); const { data } = await apiClient.post<{ url: string; websocket_path?: string }>(`/cloud/servers/${serverId}/console`); setConsoleUrl(data.url); setWebsocketUrl(data.websocket_path ? backendWebSocketUrl(data.websocket_path) : undefined) } catch (error) { setState('error'); record(error instanceof Error ? error.message : 'Cloud API could not open the VNC console.') } }
  const changePassword = async (password: string, source: 'agent' | 'user') => {
    if (!serverId || !password) throw new Error('Select a VM and enter a password first.')
    setState('resetting_password'); record('Cloud API change password', `POST /cloud/servers/change-password · server=${serverId} · source=${source} · password=[redacted]`)
    await refreshCsrf()
    const { data } = await apiClient.post<{ items?: Array<{ server_id: string; status: string; error?: string }> }>('/cloud/servers/change-password', { server_ids: [serverId], password })
    const result = data.items?.find((item) => item.server_id === serverId) ?? data.items?.[0]
    if (!result || result.status === 'failed') throw new Error(result?.error || 'CloudTool did not confirm the password reset.')
    rootPassword.current = password; loggedIn.current = false; setLoginReady(false); setState('connected')
    const delay = result.status === 'accepted' ? 8000 : 3500
    record('Cloud API change password', `server=${serverId} · result=${result.status} · wait=${Math.round(delay / 1000)}s`)
    await pause(delay)
    record('Password reset', 'Wait completed; VNC is ready for login.')
  }
  const verifyLogin = async () => {
    const result = await askAgent(`Inspect this VNC screenshot for VM ${selected?.name || serverId}. Is there an authenticated root shell ready for CLI commands? Answer in Vietnamese with observed screen facts only. End with exactly LOGIN_STATUS: SUCCESS only when an authenticated root shell is visibly confirmed; otherwise end with LOGIN_STATUS: NOT_CONFIRMED.`, true)
    const answer = result.answer?.trim() || 'No login analysis returned.'
    setAnalysis(answer)
    if (!/LOGIN_STATUS:\s*SUCCESS/i.test(answer)) throw new Error('AI could not confirm a successful root login. Retry login or log in manually in the VNC console.')
    loggedIn.current = true; setLoginReady(true); setState('connected'); record('AI verified the visible VM session and will now accept approved CLI commands.')
  }
  const loginWithTemporaryPassword = async () => {
    if (!rfb.current || !rootPassword.current) throw new Error('No temporary root password is available. Reset the password first.')
    setState('logging_in'); record('VNC login', 'Waiting for login prompt.'); await pause(2200)
    await typeConsoleText(rfb.current, 'root'); record('VNC login', 'username=root sent; waiting for password prompt.'); await pause(1100)
    await typeConsoleText(rfb.current, rootPassword.current); record('VNC login', 'password sent [redacted]; waiting for VM response.'); await pause(2200)
    await verifyLogin()
  }
  const executeApprovedAction = async () => {
    if (!rfb.current || !serverId || !command.trim()) return
    try {
      setConfirmKind(undefined)
      if (!loggedIn.current) throw new Error('Log in to the VM before running a CLI command.')
      setState('running'); record('CLI command', 'clear'); await typeConsoleText(rfb.current, 'clear'); await pause(500)
      record('CLI command', command); await typeConsoleText(rfb.current, command); await pause(2000); record('VNC capture', 'Capturing the visible command result for AI analysis.')
      const result = await askAgent(`Analyze the VNC result after this approved root command on VM ${selected?.name || serverId}: ${command}. State only visible facts, likely causes, and safe next checks. If another smallest-safe command is needed, return it with the CloudTool VM action protocol for this same VM.`, true)
      setAnalysis(result.answer || 'No analysis returned.'); setState('connected'); record('AI completed analysis of the visible command result.')
      const next = result.vm_action ?? (commandFromAnswer(result.answer) ? { server: selected?.name || serverId, command: commandFromAnswer(result.answer)!, summary: 'Lệnh kiểm tra tiếp theo do AI đề xuất' } : undefined)
      if (next) { record(`AI proposed a follow-up command: ${next.summary}`); onNextAction(next) }
    } catch (error) { setState('error'); record(error instanceof Error ? error.message : 'VM execution failed.') }
  }
  const executeAgentLogin = async () => { try { if (!validServerPassword(agentPassword)) throw new Error('Agent password must be more than 8 characters and contain upper, lower, number, and @ or #.'); setConfirmKind(undefined); await changePassword(agentPassword, 'agent'); await loginWithTemporaryPassword() } catch (error) { setState('error'); record(error instanceof Error ? error.message : 'Agent login failed.') } }
  const retryAgentLogin = async () => { try { await loginWithTemporaryPassword() } catch (error) { setState('error'); record(error instanceof Error ? error.message : 'Login retry failed.') } }
  const reloginVm = async () => { try { loggedIn.current = false; setLoginReady(false); if (!rootPassword.current) { if (!validServerPassword(agentPassword)) throw new Error('Agent password must be more than 8 characters and contain upper, lower, number, and @ or #.'); record('VM re-login', 'No password exists for this session; changing it through CloudTool first.'); await changePassword(agentPassword, 'agent') } else record('VM re-login', 'Using the password already changed in this session.'); await loginWithTemporaryPassword() } catch (error) { setState('error'); record('VM re-login', error instanceof Error ? error.message : 'Re-login failed.') } }
  const submitAgentChat = async () => {
    const question = agentDraft.trim(); if (!question || !selected) return
    const vmContext = `VM console state: VM=${selected.name} (${serverId}); VNC=${consoleUrl ? 'connected' : 'not connected'}; root session=${loggedIn.current ? 'confirmed by user/agent' : 'not confirmed'}; pending command=${command || 'none'}; recent activity=${events.slice(-5).join(' | ') || 'none'}.`
    const userText = question
    const request = new AbortController()
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
    chatAbort.current = request
    chatRequestId.current = requestId
    setChatMessages((items) => [...items, { id: `${Date.now()}-user`, role: 'user', text: userText }])
    setAgentChatLoading(true); setAgentDraft('')
    try {
      const result = await askAgent(`You are assisting an already-open VNC console. ${vmContext}\nThe user asks: ${question}\nUse the attached screen when useful. Continue the existing diagnostic objective; do not reset passwords or log in, because the browser owns that lifecycle. If a CLI command is needed, propose exactly one smallest-safe command through the CloudTool VM action protocol using server ${selected.name}. Do not request or expose a password.`, true, request.signal, requestId)
      const answer = result.answer || 'No response returned.'
      setAnalysis(answer); setChatMessages((items) => [...items, { id: `${Date.now()}-assistant`, role: 'assistant', text: answer }])
      onChatExchange({ userText, answer, conversationId: result.conversation_id, evidence: result.evidence })
      const next = result.vm_action ?? (commandFromAnswer(result.answer) ? { server: selected.name, command: commandFromAnswer(result.answer)!, summary: 'Lệnh được đề xuất từ cuộc trò chuyện VM' } : undefined)
      if (next) { record(`AI proposed a command from VM chat: ${next.summary}`); onNextAction(next) }
    } catch (error) { if ((error as DOMException).name !== 'AbortError') { toast.error(error instanceof Error ? error.message : 'VM agent chat failed.'); setChatMessages((items) => [...items, { id: `${Date.now()}-error`, role: 'assistant', text: 'Yêu cầu không hoàn tất. Bạn có thể gửi một tin nhắn mới.' }]) } } finally { if (chatAbort.current === request) { chatAbort.current = null; chatRequestId.current = undefined }; setAgentChatLoading(false) }
  }
  const stopAgentChat = () => { const requestId = chatRequestId.current; chatAbort.current?.abort(); chatAbort.current = null; chatRequestId.current = undefined; if (requestId && agentHeaders) void fetch(`${agentBaseUrl}/requests/${encodeURIComponent(requestId)}/cancel`, { method: 'POST', credentials: 'include', headers: agentHeaders }); setAgentChatLoading(false); record('VM agent chat was stopped by the user.') }
  const confirmManualPassword = async () => { try { setConfirmKind(undefined); await changePassword(manualPassword, 'user'); setManualPassword(''); toast.success('Password changed. Log in manually on the VNC console, then confirm the session below.') } catch (error) { setState('error'); record(error instanceof Error ? error.message : 'Password reset failed.') } }

  useEffect(() => { if (!open) return; void apiClient.get<{ items: Server[] }>('/cloud/servers', { params: { page_size: 200 } }).then(({ data }) => setServers(data.items ?? [])).catch(() => toast.error('Could not load project servers.')) }, [open])
  useEffect(() => { if (!open || !action) { if (open && initialCommand) setCommand(initialCommand); return }; const target = servers.find((server) => matchesActionServer(server, action.server)); if (!target) { if (servers.length) { setState('error'); record(`The requested VM “${action.server}” is not in this project. No console was opened.`) }; return }; if (configuredAction.current !== actionKey) { configuredAction.current = actionKey; setCommand(action.command); setAnalysis(''); record(`AI requests: ${action.summary}`); if (serverId && serverId !== target.id) { loggedIn.current = false; setLoginReady(false); loginPromptShown.current = false; rootPassword.current = ''; setConsoleUrl(undefined); setWebsocketUrl(undefined) }; setServerId(target.id) } }, [action, actionKey, initialCommand, open, serverId, servers])
  useEffect(() => { if (!open || !action || !serverId || consoleUrl || openedServer.current === serverId) return; openedServer.current = serverId; void openConsole() }, [action, consoleUrl, open, serverId])
  useEffect(() => { if (!open || !consoleUrl || !canvasHost.current) return; setVncReady(false); const client = new RFB(canvasHost.current, websocketUrl ?? consoleWebSocketUrl(consoleUrl), { shared: true }); client.scaleViewport = true; client.viewOnly = false; client.focusOnClick = true; client.addEventListener('connect', () => { setVncReady(true); setState('connected'); record('VNC console connected. No password or CLI input has been sent.') }); client.addEventListener('disconnect', () => { setVncReady(false); setState('error'); record('VNC console disconnected.') }); client.addEventListener('securityfailure', () => { setVncReady(false); setState('error'); record('VNC gateway rejected the console session.') }); rfb.current = client; return () => { setVncReady(false); rfb.current = null; client.disconnect() } }, [open, consoleUrl, websocketUrl])
  useEffect(() => { if (!open || !action || !vncReady) return; if (!loginReady) { if (!loginPromptShown.current) { loginPromptShown.current = true; setConfirmKind('login') }; return }; if (bypassApproval && autoRunAction.current !== actionKey) { autoRunAction.current = actionKey; void executeApprovedAction(); return }; if (!bypassApproval && approvalShown.current !== actionKey) { approvalShown.current = actionKey; setState('waiting_approval'); setConfirmKind('command') } }, [action, actionKey, bypassApproval, loginReady, open, vncReady])
  const updateBypass = (value: boolean) => { setBypassApproval(value); window.localStorage.setItem(bypassStorageKey, String(value)) }

  return <>
    <Dialog onOpenChange={(value) => { if (!value) { chatAbort.current?.abort(); setConfirmKind(undefined); rootPassword.current = ''; loggedIn.current = false; openedServer.current = ''; setConsoleUrl(undefined); setWebsocketUrl(undefined) }; onOpenChange(value) }} open={open}><DialogContent className='grid h-[92svh] w-[calc(100vw-2rem)] max-w-[112rem] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:!max-w-[112rem]'>
      <DialogHeader><DialogTitle>AI-assisted VM console execution</DialogTitle><DialogDescription>Use agent-controlled or manual login, then approve each CLI action while watching the live VNC console.</DialogDescription></DialogHeader>
      <div className='grid min-h-0 gap-5 lg:grid-cols-[minmax(24rem,0.85fr)_minmax(0,1.15fr)]'><section className='flex min-h-0 flex-col gap-4 overflow-auto rounded-lg border bg-muted/10 p-4'>
        <div className='order-first flex flex-wrap items-center gap-2 rounded-md border bg-background p-3'><select aria-label='Target VM' className='h-9 min-w-40 flex-1 rounded-md border bg-background px-2 text-sm' onChange={(event) => { loggedIn.current = false; setLoginReady(false); rootPassword.current = ''; setServerId(event.target.value); setConsoleUrl(undefined); setAnalysis(''); setState('idle') }} value={serverId}><option value='' disabled>Select a VM</option>{servers.map((server) => <option key={server.id} value={server.id}>{server.name} · {server.zone_display_name || server.id.slice(0, 8)}</option>)}</select><label className='flex items-center gap-2 text-xs'><Checkbox checked={bypassApproval} disabled={!loginReady} onCheckedChange={(value) => updateBypass(value === true)} /><span>Bypass confirmation</span></label><Badge variant={vncReady ? 'secondary' : state === 'error' ? 'destructive' : 'outline'}>{vncReady ? (loginReady ? 'connected · logged in' : 'connected') : state.replace(/_/g, ' ')}</Badge><Button aria-label='Open execution log' onClick={() => setLogOpen(true)} size='icon' title='Execution log' type='button' variant='ghost'><ScrollText className='size-4' /></Button></div>
        <details className='order-4 rounded-md border bg-background p-3'><summary className='cursor-pointer text-sm font-medium'>Manual login & advanced controls</summary><div className='mt-3 space-y-3'><div className='space-y-1'><Label>Agent default root password</Label><Input autoComplete='new-password' onChange={(event) => { const value = event.target.value; setAgentPassword(value); window.localStorage.setItem(agentPasswordStorageKey, value) }} type='password' value={agentPassword} /><p className='text-xs text-muted-foreground'>Default: Admin@123. Requires upper, lower, number, and @ or #.</p></div><div className='space-y-1'><Label>Manual root password</Label><div className='flex gap-2'><Input autoComplete='new-password' onChange={(event) => setManualPassword(event.target.value)} placeholder='New root password' type='password' value={manualPassword} /><Button onClick={() => setManualPassword(newPassword())} size='icon' title='Generate password' type='button' variant='outline'><KeyRound className='size-4' /></Button></div></div><div className='flex flex-wrap gap-2'><Button disabled={!serverId || !manualPassword} onClick={() => setConfirmKind('manual_password')} size='sm' type='button' variant='outline'>Change password</Button><Button disabled={!serverId || !vncReady} onClick={() => { loggedIn.current = true; setLoginReady(true); setState('connected'); record('User confirmed they are logged in. AI will keep this VNC session.'); if (action && !bypassApproval) { approvalShown.current = actionKey; setConfirmKind('command') } }} size='sm' type='button' variant='outline'>I am logged in</Button><Button disabled={!serverId || !vncReady || ['resetting_password', 'logging_in', 'running'].includes(state)} onClick={() => void reloginVm()} size='sm' type='button' variant='outline'>Re-login VM</Button><Button disabled={!rootPassword.current || state === 'running'} onClick={() => void retryAgentLogin()} size='sm' type='button' variant='outline'>Retry agent login</Button><Button disabled={!serverId || state === 'opening'} onClick={() => void openConsole()} size='sm' type='button' variant='outline'><RefreshCw className='mr-2 size-4' />Open console</Button></div></div></details>
        <div className='order-1 rounded-md border bg-background p-3 space-y-2'><Label>Chat with VM agent</Label>{chatMessages.length ? <div className='max-h-64 space-y-2 overflow-auto rounded border bg-muted/20 p-2 text-xs'>{chatMessages.map((message) => <div className={message.role === 'user' ? 'ml-6 rounded bg-primary p-2 text-primary-foreground' : 'mr-6 rounded bg-background p-2'} key={message.id}>{message.text}</div>)}</div> : <p className='text-xs text-muted-foreground'>Same conversation as the main chat. Every message includes the current VM state and latest VNC screen.</p>}<div className='flex gap-2'><Textarea className='min-h-12 text-sm' disabled={!serverId} onChange={(event) => setAgentDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitAgentChat() } }} placeholder='Ask what to inspect or ask the agent to run a command…' value={agentDraft} />{agentChatLoading ? <Button onClick={stopAgentChat} size='icon' title='Stop VM agent chat' type='button' variant='destructive'><CircleStop className='size-4' /></Button> : <Button disabled={!agentDraft.trim() || !serverId} onClick={() => void submitAgentChat()} size='icon' title='Ask VM agent' type='button'><Send className='size-4' /></Button>}</div></div>
        {events.length ? <div className='order-2 rounded-md border bg-background p-3'><p className='mb-2 text-xs font-medium uppercase text-muted-foreground'>Execution timeline</p><ol className='max-h-56 space-y-1 overflow-y-auto pr-2 text-xs text-muted-foreground'>{events.map((event, index) => <li key={`${index}-${event}`}>{index + 1}. {event}</li>)}</ol></div> : null}
        {analysis ? <div className='order-3 rounded-md border bg-background p-3 text-sm whitespace-pre-wrap'><p className='mb-2 flex items-center gap-2 font-medium'><CheckCircle2 className='size-4 text-emerald-600' />AI analysis</p>{analysis}</div> : null}
      </section><section className='relative min-h-0 overflow-hidden rounded-lg border bg-zinc-950'><div className='absolute left-3 top-3 z-10 rounded bg-background/90 px-2 py-1 text-xs text-muted-foreground'>Live VNC console · click console to focus</div><div className='h-full w-full pt-8' ref={canvasHost} /></section></div>
    </DialogContent></Dialog>
    <Dialog onOpenChange={setLogOpen} open={logOpen}><DialogContent className='grid max-h-[85svh] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:!max-w-5xl'><DialogHeader><DialogTitle>VM agent execution log</DialogTitle><DialogDescription>Current VNC session activity. CLI commands are recorded in full; credential values are redacted.</DialogDescription></DialogHeader><div className='min-h-0 overflow-auto rounded-md border bg-muted/20'><table className='w-full text-left text-xs'><thead className='sticky top-0 bg-background'><tr><th className='w-40 p-3 font-medium'>Time</th><th className='w-52 p-3 font-medium'>Function</th><th className='p-3 font-medium'>Content</th></tr></thead><tbody>{operationLogs.length ? operationLogs.map((entry, index) => <tr className='border-t align-top' key={`${entry.at}-${index}`}><td className='whitespace-nowrap p-3 text-muted-foreground'>{new Date(entry.at).toLocaleTimeString()}</td><td className='p-3 font-medium'>{entry.operation}</td><td className='p-3 font-mono break-all'>{entry.content}</td></tr>) : <tr><td className='p-6 text-muted-foreground' colSpan={3}>No VM operations have been recorded in this session.</td></tr>}</tbody></table></div></DialogContent></Dialog>
    <AlertDialog onOpenChange={(value) => { if (!value) { setConfirmKind(undefined); if (state === 'waiting_approval') setState('connected') } }} open={Boolean(confirmKind)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirmKind === 'manual_password' ? 'Change this VM password?' : confirmKind === 'login' ? 'Log in to the VM first' : 'Approve AI CLI command?'}</AlertDialogTitle><AlertDialogDescription>{confirmKind === 'manual_password' ? `This changes the root password for ${selected?.name || 'the selected VM'}. You will enter it yourself in the visible VNC console.` : confirmKind === 'login' ? `Before running diagnostics on ${selected?.name || action?.server}, choose whether this VNC session is already logged in, you will log in manually, or the agent should reset the password and log in.` : `Codex requests this command on ${selected?.name || action?.server}: ${command}`}</AlertDialogDescription></AlertDialogHeader>{confirmKind === 'command' ? <div className='rounded-md bg-muted p-3 font-mono text-xs break-all'>{command}</div> : null}<AlertDialogFooter>{confirmKind === 'login' ? <><AlertDialogCancel onClick={() => { setConfirmKind(undefined); setState('connected') }}>I will log in manually</AlertDialogCancel><Button onClick={() => { loggedIn.current = true; setLoginReady(true); setConfirmKind(undefined); setState('connected'); record('User confirmed an existing VNC login session.') }} type='button' variant='outline'>I am already logged in</Button><AlertDialogAction onClick={() => void executeAgentLogin()}>Let agent log in</AlertDialogAction></> : <><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => void (confirmKind === 'manual_password' ? confirmManualPassword() : executeApprovedAction())}>{confirmKind === 'manual_password' ? 'Change password' : 'Confirm and run'}</AlertDialogAction></>}</AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>
}
