import { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import {
  Bot,
  CircleHelp,
  FileText,
  ImageIcon,
  Loader2,
  MessageSquareText,
  Paperclip,
  Plus,
  Search,
  Save,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { DisplaySettings } from '@/components/display-settings'
import { ProfileDropdown } from '@/components/profile-dropdown-teleport'
import { ReleasePageCacheButton } from '@/components/release-page-cache-button'
import { ThemeSwitch } from '@/components/theme-switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { setCsrfToken } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'
import { useCloudStore } from '@/stores/cloud-store'

type Evidence = { source: string; count: number }
type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  evidence?: Evidence[]
}
type UploadAttachment = {
  id: string
  name: string
  media_type: string
  content_base64: string
}
type ChatSession = {
  id: string
  title: string
  conversationId?: string
  messages: Message[]
  updatedAt: number
}
type StoredConversation = {
  id: string
  title: string
  updated_at: string
  messages: Array<Message & { created_at: string }>
}
type CodexSettings = {
  provider: 'codex_cli' | 'openai' | 'evidence_only'
  command: string
  model: string
  reasoning_effort: 'low' | 'medium' | 'high' | 'xhigh'
  workdir: string
  timeout_seconds: number
  available: boolean
  version?: string | null
  error?: string | null
  csrf_token?: string | null
}

const agentBaseUrl =
  import.meta.env.VITE_AGENT_API_BASE_URL ?? '/agent-api/api/v1'

function messageId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

export function ProjectAnalysisPage() {
  const project = useCloudStore((state) => state.project)
  const cloudToken = useCloudStore((state) => state.token)
  const csrfToken = useAuthStore((state) => state.auth.user?.csrf_token)
  const role = useAuthStore((state) => state.auth.user?.role)
  const isAdmin = role === 'admin' || (typeof role === 'object' && role.name === 'admin')
  const [draft, setDraft] = useState('')
  const [sessions, setSessions] = useState<ChatSession[]>(() => [{
    id: messageId(), title: 'New analysis', messages: [], updatedAt: Date.now(),
  }])
  const [activeSessionId, setActiveSessionId] = useState<string>()
  const [conversationSearch, setConversationSearch] = useState('')
  const [attachments, setAttachments] = useState<UploadAttachment[]>([])
  const [chatModel, setChatModel] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<'low' | 'medium' | 'high' | 'xhigh'>('medium')
  const [isSending, setIsSending] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<CodexSettings>()
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsTesting, setSettingsTesting] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0]
  const visibleSessions = useMemo(
    () => sessions.filter((session) => session.title.toLowerCase().includes(conversationSearch.trim().toLowerCase())),
    [conversationSearch, sessions]
  )

  useEffect(() => {
    const session = { id: messageId(), title: 'New analysis', messages: [], updatedAt: Date.now() }
    setSessions([session])
    setActiveSessionId(session.id)
    setAttachments([])
  }, [project?.id])

  useEffect(() => {
    if (!project || !cloudToken) return
    let alive = true
    axios.get<StoredConversation[]>(`${agentBaseUrl}/conversations`, { headers: requestHeaders(), withCredentials: true })
      .then(({ data }) => {
        if (!alive || !data.length) return
        const restored = data.map((conversation) => ({ id: conversation.id, conversationId: conversation.id, title: conversation.title, messages: conversation.messages, updatedAt: new Date(conversation.updated_at).getTime() }))
        setSessions(restored)
        setActiveSessionId(restored[0].id)
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [cloudToken, project?.id])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [activeSession?.messages, isSending])

  const createConversation = () => {
    const session = { id: messageId(), title: 'New analysis', messages: [], updatedAt: Date.now() }
    setSessions((items) => [session, ...items])
    setActiveSessionId(session.id)
    setDraft('')
    setAttachments([])
  }

  const updateActiveSession = (change: (session: ChatSession) => ChatSession) => {
    if (!activeSession) return
    setSessions((items) => items.map((session) => session.id === activeSession.id ? change(session) : session))
  }

  const chooseFiles = async (files: FileList | null) => {
    if (!files) return
    const selected = Array.from(files).slice(0, 3 - attachments.length)
    const allowed = new Set(['text/plain', 'text/yaml', 'application/x-yaml', 'application/json', 'image/png', 'image/jpeg', 'image/webp'])
    const accepted = selected.filter((file) => allowed.has(file.type) && file.size <= 2 * 1024 * 1024)
    if (accepted.length !== selected.length) toast.error('Only text, YAML, JSON, PNG, JPEG, and WebP files up to 2 MB are allowed.')
    const loaded = await Promise.all(accepted.map(async (file) => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      return { id: messageId(), name: file.name, media_type: file.type, content_base64: dataUrl.split(',')[1] }
    }))
    setAttachments((items) => [...items, ...loaded])
  }

  const requestHeaders = () => ({
    'X-Cloud-Token': cloudToken ?? '',
    'X-Project-Id': project?.id ?? '',
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
  })

  const loadSettings = async () => {
    if (!project || !cloudToken) return
    setSettingsLoading(true)
    try {
      const { data } = await axios.get<CodexSettings>(`${agentBaseUrl}/settings/codex`, {
        headers: requestHeaders(),
        withCredentials: true,
      })
      if (data.csrf_token) setCsrfToken(data.csrf_token)
      setSettings(data)
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

  const saveSettings = async () => {
    if (!settings) return
    setSettingsSaving(true)
    try {
      const { data } = await axios.put<CodexSettings>(
        `${agentBaseUrl}/settings/codex`,
        {
          provider: settings.provider,
          command: settings.command,
          model: settings.model,
          reasoning_effort: settings.reasoning_effort,
          workdir: settings.workdir,
          timeout_seconds: Number(settings.timeout_seconds),
        },
        { headers: requestHeaders(), withCredentials: true }
      )
      setSettings(data)
      if (data.csrf_token) setCsrfToken(data.csrf_token)
      toast.success(data.available ? 'Codex CLI settings saved.' : 'Settings saved, but Codex CLI is unavailable.')
    } catch {
      toast.error('Unable to save Codex CLI settings.')
    } finally {
      setSettingsSaving(false)
    }
  }

  const testSettings = async () => {
    setSettingsTesting(true)
    try {
      const { data } = await axios.post<CodexSettings>(`${agentBaseUrl}/settings/codex/test`, {}, { headers: requestHeaders(), withCredentials: true })
      if (data.csrf_token) setCsrfToken(data.csrf_token)
      setSettings(data)
      toast[data.available ? 'success' : 'error'](data.available ? 'Codex CLI connection succeeded.' : data.error || 'Codex CLI is unavailable.')
    } catch {
      toast.error('Codex CLI connection test failed.')
    } finally {
      setSettingsTesting(false)
    }
  }

  const send = async () => {
    const text = draft.trim()
    if ((!text && !attachments.length) || isSending || !project || !cloudToken || !activeSession) return

    const outgoing = attachments
    const displayText = text || `Attached ${outgoing.length} file(s) for analysis.`
    updateActiveSession((session) => ({
      ...session,
      title: session.messages.length ? session.title : displayText.slice(0, 48),
      messages: [...session.messages, { id: messageId(), role: 'user', text: displayText }],
      updatedAt: Date.now(),
    }))
    setDraft('')
    setAttachments([])
    setIsSending(true)

    try {
      const { data } = await axios.post<{
        answer: string
        conversation_id: string
        csrf_token?: string
        evidence: Evidence[]
      }>(
        `${agentBaseUrl}/chat`,
        { message: text || 'Analyse the attached files in the current project context.', conversation_id: activeSession.conversationId, attachments: outgoing, ...(chatModel ? { model: chatModel } : {}), reasoning_effort: reasoningEffort },
        {
          headers: requestHeaders(),
          // Evidence collection can take 30s and local Codex may use its full
          // configured timeout. Keep the browser request aligned with that path.
          timeout: 180_000,
          withCredentials: true,
        }
      )

      if (data.csrf_token) setCsrfToken(data.csrf_token)
      updateActiveSession((session) => ({
        ...session,
        conversationId: data.conversation_id,
        messages: [...session.messages, { id: messageId(), role: 'assistant', text: data.answer, evidence: data.evidence }],
        updatedAt: Date.now(),
      }))
    } catch {
      toast.error('AI analysis is unavailable. No cloud action was performed.')
    } finally {
      setIsSending(false)
    }
  }

  return (
    <>
      <Header fixed>
        <div className='min-w-0'>
          <h1 className='truncate text-base font-semibold'>AI assistant</h1>
          <p className='hidden text-xs text-muted-foreground sm:block'>
            Read-only project analysis
          </p>
        </div>
        <Badge className='ms-1 hidden sm:inline-flex' variant='secondary'>
          <ShieldCheck className='mr-1 size-3.5' /> Read-only
        </Badge>
        <div className='ml-auto flex items-center gap-1.5'>
          {isAdmin && (
            <Button onClick={openSettings} size='sm' variant='outline'>
              <Settings2 className='mr-2 size-4' /> Settings
            </Button>
          )}
          <Dialog>
            <DialogTrigger asChild>
              <Button aria-label='AI assistant help' className='rounded-full' size='icon' variant='ghost'>
                <CircleHelp className='size-[1.2rem]' />
              </Button>
            </DialogTrigger>
            <DialogContent className='sm:!max-w-xl'>
              <DialogHeader>
                <DialogTitle>AI assistant help</DialogTitle>
                <DialogDescription>Read-only analysis for the currently selected cloud project.</DialogDescription>
              </DialogHeader>
              <div className='space-y-3 text-sm text-muted-foreground'>
                <p>Ask about server power state, IP/subnet mapping, security groups, inventory, or Cloud API history.</p>
                <p>Images and text/YAML/JSON attachments are sent only to the isolated agent-service for the current request.</p>
                <p>AI assistant cannot create, modify, delete, or open a cloud console.</p>
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
        {!project || !cloudToken ? (
          <div className='grid flex-1 place-items-center rounded-lg border bg-card'>
            <div className='max-w-md p-6 text-center text-sm text-muted-foreground'>
              <div className='mx-auto mb-4 grid size-12 place-items-center rounded-full border bg-muted'>
                <MessageSquareText className='size-5' />
              </div>
              Select a cloud project first. The assistant only reads resources
              from the current project.
            </div>
          </div>
        ) : (
          <section className='flex min-h-0 flex-1 overflow-hidden rounded-lg border bg-card shadow-xs'>
            <aside className='hidden w-72 shrink-0 flex-col border-r bg-muted/20 md:flex'>
              <div className='p-4'>
                <div className='flex items-center gap-2'>
                  <span className='grid size-8 place-items-center rounded-md bg-primary text-primary-foreground'>
                    <Bot className='size-4' />
                  </span>
                  <div className='min-w-0'>
                    <p className='truncate text-sm font-semibold'>Project analysis</p>
                    <p className='text-xs text-muted-foreground'>Codex CLI</p>
                  </div>
                  <Button className='ml-auto' onClick={createConversation} size='icon' title='New conversation' variant='ghost'>
                    <Plus className='size-4' />
                  </Button>
                </div>
                <label className='mt-4 flex h-9 items-center gap-2 rounded-md border bg-background px-2 focus-within:ring-1 focus-within:ring-ring'>
                  <Search className='size-4 text-muted-foreground' />
                  <input className='min-w-0 flex-1 bg-transparent text-sm outline-none' onChange={(event) => setConversationSearch(event.target.value)} placeholder='Search conversations' value={conversationSearch} />
                </label>
              </div>
              <Separator />
              <div className='min-h-0 flex-1 overflow-y-auto p-2'>
                {visibleSessions.map((session) => {
                  const lastMessage = session.messages[session.messages.length - 1]
                  return <button
                    className={`group mb-1 flex w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent ${session.id === activeSession?.id ? 'bg-muted' : ''}`}
                    key={session.id}
                    onClick={() => setActiveSessionId(session.id)}
                    type='button'
                  >
                    <MessageSquareText className='mt-0.5 mr-2 size-4 shrink-0 text-muted-foreground' />
                    <span className='min-w-0 flex-1'>
                      <span className='block truncate font-medium'>{session.title}</span>
                      <span className='block truncate text-xs text-muted-foreground'>{lastMessage?.text || 'No messages yet'}</span>
                    </span>
                  </button>
                })}
              </div>
              <div className='border-t p-4 text-xs text-muted-foreground'>
                <p className='truncate font-medium text-foreground'>{project.display_name || project.name}</p>
                <p className='mt-1'>Read-only: cloud actions and console access are disabled.</p>
              </div>
            </aside>
            <div className='flex min-w-0 flex-1 flex-col'>
              <div className='flex shrink-0 items-center gap-3 border-b bg-card p-4'>
                <span className='grid size-10 place-items-center rounded-full bg-primary text-primary-foreground'>
                  <Bot className='size-5' />
                </span>
                <div className='min-w-0'>
                  <p className='text-sm font-semibold'>CloudTool AI assistant</p>
                  <p className='truncate text-xs text-muted-foreground'>
                    Analysing {project.display_name || project.name}
                  </p>
                </div>
                <Badge className='ml-auto hidden sm:inline-flex' variant='secondary'>
                  <Sparkles className='mr-1 size-3.5' /> Read-only
                </Badge>
                <Input aria-label='Model override' className='hidden h-8 w-40 text-xs lg:block' onChange={(event) => setChatModel(event.target.value)} placeholder='CLI default model' value={chatModel} />
                <select aria-label='Reasoning effort' className='hidden h-8 rounded-md border bg-background px-2 text-xs lg:block' onChange={(event) => setReasoningEffort(event.target.value as typeof reasoningEffort)} value={reasoningEffort}>
                  <option value='low'>Reasoning: Low</option>
                  <option value='medium'>Reasoning: Medium</option>
                  <option value='high'>Reasoning: High</option>
                  <option value='xhigh'>Reasoning: XHigh</option>
                </select>
              </div>
              <div className='min-h-0 flex-1 overflow-y-auto bg-muted/10 px-4 py-5 sm:px-6'>
                {!activeSession?.messages.length && !isSending && (
                  <div className='mx-auto flex h-full max-w-lg flex-col items-center justify-center text-center'>
                    <span className='mb-4 grid size-14 place-items-center rounded-full border bg-background shadow-xs'>
                      <MessageSquareText className='size-6 text-muted-foreground' />
                    </span>
                    <h2 className='text-lg font-semibold'>How can I help?</h2>
                    <p className='mt-2 text-sm leading-6 text-muted-foreground'>
                      Ask about server state, private or elastic IP mapping, subnets,
                      security groups, inventory, or Cloud API history.
                    </p>
                  </div>
                )}
                <div className='mx-auto flex max-w-4xl flex-col gap-4'>
                  {activeSession?.messages.map((message) => (
                    <div
                      className={
                        message.role === 'user'
                          ? 'chat-box max-w-[80%] self-end rounded-[16px_16px_0_16px] bg-primary px-3 py-2 text-sm text-primary-foreground shadow-sm'
                          : 'chat-box max-w-[90%] self-start rounded-[16px_16px_16px_0] bg-background px-3 py-2 text-sm shadow-sm ring-1 ring-border'
                      }
                      key={message.id}
                    >
                      <div className='whitespace-pre-wrap leading-6'>{message.text}</div>
                      {!!message.evidence?.length && (
                        <div className='mt-3 flex flex-wrap gap-1.5 border-t border-current/10 pt-2'>
                          {message.evidence.map((entry) => (
                            <Badge className='bg-muted/70 text-foreground' key={entry.source} variant='secondary'>
                              {entry.source.replace(/_/g, ' ')} · {entry.count}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {isSending && (
                    <div className='flex max-w-xs items-center gap-2 self-start rounded-[16px_16px_16px_0] bg-background px-3 py-2 text-sm text-muted-foreground shadow-sm ring-1 ring-border'>
                      <Loader2 className='size-4 animate-spin' /> Analysing project evidence…
                    </div>
                  )}
                  <div ref={endRef} />
                </div>
              </div>
              <form
                className='flex shrink-0 gap-2 border-t bg-card p-3 sm:p-4'
                onSubmit={(event) => {
                  event.preventDefault()
                  void send()
                }}
              >
                <input
                  accept='.txt,.yaml,.yml,.json,image/png,image/jpeg,image/webp'
                  className='hidden'
                  multiple
                  onChange={(event) => { void chooseFiles(event.target.files); event.currentTarget.value = '' }}
                  ref={fileInputRef}
                  type='file'
                />
                <div className='flex min-h-11 flex-1 items-end rounded-md border border-input bg-background px-3 py-1 focus-within:ring-1 focus-within:ring-ring'>
                  <Button className='mb-0.5 mr-2 shrink-0' disabled={attachments.length >= 3 || isSending} onClick={() => fileInputRef.current?.click()} size='icon' title='Attach image or text file' type='button' variant='ghost'>
                    <Paperclip className='size-4' />
                  </Button>
                  <Textarea
                    className='min-h-8 max-h-36 resize-y border-0 bg-transparent px-0 py-1 shadow-none focus-visible:ring-0'
                    disabled={isSending}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        void send()
                      }
                    }}
                    placeholder='Type your analysis question…'
                    value={draft}
                  />
                </div>
                <Button aria-label='Send analysis' disabled={(!draft.trim() && !attachments.length) || isSending} size='icon' type='submit'>
                  <Send className='size-4' />
                </Button>
              </form>
              {!!attachments.length && <div className='flex shrink-0 flex-wrap gap-2 border-t bg-card px-4 py-2'>
                {attachments.map((attachment) => <Badge className='gap-1.5 py-1' key={attachment.id} variant='secondary'>
                  {attachment.media_type.startsWith('image/') ? <ImageIcon className='size-3.5' /> : <FileText className='size-3.5' />}
                  <span className='max-w-44 truncate'>{attachment.name}</span>
                  <button aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))} type='button'><X className='size-3.5' /></button>
                </Badge>)}
              </div>}
            </div>
          </section>
        )}
      </Main>
      <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
        <DialogContent className='sm:!max-w-2xl'>
          <DialogHeader>
            <DialogTitle>Codex CLI settings</DialogTitle>
            <DialogDescription>
              Runs locally on the agent-service host. Chat remains read-only and uses
              Codex CLI only when the provider is set to Codex CLI.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => { event.preventDefault(); void saveSettings() }}>
            {settingsLoading || !settings ? (
              <div className='flex min-h-48 items-center justify-center text-sm text-muted-foreground'>
                <Loader2 className='mr-2 size-4 animate-spin' /> Loading settings…
              </div>
            ) : (
              <div className='grid gap-4 py-1 sm:grid-cols-2'>
              <div className='space-y-2 sm:col-span-2'>
                <Label htmlFor='codex-provider'>Provider</Label>
                <select
                  className='flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
                  id='codex-provider'
                  onChange={(event) => setSettings({ ...settings, provider: event.target.value as CodexSettings['provider'] })}
                  value={settings.provider}
                >
                  <option value='codex_cli'>Codex CLI (local)</option>
                  <option value='openai'>OpenAI API fallback</option>
                  <option value='evidence_only'>Evidence only</option>
                </select>
              </div>
              <div className='space-y-2'>
                <Label htmlFor='codex-command'>Codex CLI executable path</Label>
                <Input id='codex-command' onChange={(event) => setSettings({ ...settings, command: event.target.value })} value={settings.command} />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='codex-model'>Model override (optional)</Label>
                <Input id='codex-model' onChange={(event) => setSettings({ ...settings, model: event.target.value })} placeholder='Use CLI default' value={settings.model} />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='codex-reasoning'>Default reasoning effort</Label>
                <select className='flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm' id='codex-reasoning' onChange={(event) => setSettings({ ...settings, reasoning_effort: event.target.value as CodexSettings['reasoning_effort'] })} value={settings.reasoning_effort}>
                  <option value='low'>Low</option><option value='medium'>Medium</option><option value='high'>High</option><option value='xhigh'>Extra high</option>
                </select>
              </div>
              <div className='space-y-2 sm:col-span-2'>
                <Label htmlFor='codex-workdir'>Read-only working directory</Label>
                <Input id='codex-workdir' onChange={(event) => setSettings({ ...settings, workdir: event.target.value })} value={settings.workdir} />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='codex-timeout'>Timeout (seconds)</Label>
                <Input id='codex-timeout' max={600} min={30} onChange={(event) => setSettings({ ...settings, timeout_seconds: Number(event.target.value) || 30 })} type='number' value={settings.timeout_seconds} />
              </div>
              <div className='rounded-md border bg-muted/30 p-3 text-sm'>
                <p className={settings.available ? 'font-medium text-emerald-600' : 'font-medium text-destructive'}>
                  {settings.available ? 'Codex CLI available' : 'Codex CLI unavailable'}
                </p>
                <p className='mt-1 break-all text-xs text-muted-foreground'>
                  {settings.version || settings.error || 'Save settings to check the local CLI.'}
                </p>
              </div>
              </div>
            )}
            <DialogFooter className='mt-6'>
              <Button disabled={settingsLoading || settingsTesting} onClick={() => void testSettings()} type='button' variant='outline'>
                {settingsTesting && <Loader2 className='mr-2 size-4 animate-spin' />} Test connection
              </Button>
              <Button onClick={() => setSettingsOpen(false)} type='button' variant='outline'>Cancel</Button>
              <Button disabled={!settings || settingsLoading || settingsSaving} type='submit'>
                {settingsSaving ? <Loader2 className='mr-2 size-4 animate-spin' /> : <Save className='mr-2 size-4' />}
                Save settings
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
