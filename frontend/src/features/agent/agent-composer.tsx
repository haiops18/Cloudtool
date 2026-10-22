import { useEffect, useRef, useState } from 'react'
import { AtSign, Check, FileText, Folder, Lightbulb, MoreVertical, Paperclip, Pencil, Plus, Send, Sparkles, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type ComposerAttachment = {
  id: string
  name: string
  media_type: string
  content_base64: string
}
type WorkspaceFile = {
  path: string
  name: string
  size: number
  media_type: string
  kind?: 'file' | 'folder'
}

type PromptSuggestion = {
  id: string
  title: string
  prompt: string
}
type AgentSkill = { id: string; title: string; description: string; instructions: string }

type Props = {
  value: string
  resetKey: number
  attachments: ComposerAttachment[]
  disabled: boolean
  sending: boolean
  agentBaseUrl: string
  headers?: Record<string, string>
  onChange: (value: string) => void
  onFiles: (files: File[]) => void
  onRemove: (id: string) => void
  onSend: () => void
  onStop: () => void
  model: string
  reasoning: string
  permission: 'confirm' | 'bypass'
  models: Array<{
    id: string
    display_name: string
    reasoning_efforts: string[]
  }>
  onModelChange: (model: string) => void
  onReasoningChange: (reasoning: string) => void
  onPermissionChange: (permission: 'confirm' | 'bypass') => void
  selectedSkillIds: string[]
  onSelectedSkillIdsChange: (ids: string[]) => void
}

function imageSource(item: ComposerAttachment) {
  return item.media_type.startsWith('image/')
    ? `data:${item.media_type};base64,${item.content_base64}`
    : undefined
}

function readableSize(size: number) {
  return size < 1024 * 1024
    ? `${Math.max(1, Math.ceil(size / 1024))} KB`
    : `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function AgentComposer({
  value,
  resetKey,
  attachments,
  disabled,
  sending,
  agentBaseUrl,
  headers,
  onChange,
  onFiles,
  onRemove,
  onSend,
  onStop,
  model,
  reasoning,
  permission,
  models,
  onModelChange,
  onReasoningChange,
  onPermissionChange,
  selectedSkillIds,
  onSelectedSkillIdsChange,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionButtons = useRef<Array<HTMLButtonElement | null>>([])
  const mentionCheckTimer = useRef<number | undefined>(undefined)
  const [isDropping, setIsDropping] = useState(false)
  const [mentionQuery, setMentionQuery] = useState<string>()
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([])
  const [inputValue, setInputValue] = useState(value)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<PromptSuggestion[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const [suggestionSearch, setSuggestionSearch] = useState('')
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<string>()
  const [editingSuggestionId, setEditingSuggestionId] = useState<string>()
  const [editorReturnSelectionId, setEditorReturnSelectionId] = useState<string>()
  const [suggestionTitle, setSuggestionTitle] = useState('')
  const [suggestionPrompt, setSuggestionPrompt] = useState('')
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillSearch, setSkillSearch] = useState('')
  const [selectedSkillPreviewId, setSelectedSkillPreviewId] = useState<string>()
  const [skillTitle, setSkillTitle] = useState('')
  const [skillDescription, setSkillDescription] = useState('')
  const [skillInstructions, setSkillInstructions] = useState('')
  const [editingSkillId, setEditingSkillId] = useState<string>()

  useEffect(() => { setInputValue(value); setMentionQuery(undefined) }, [resetKey, value])

  const loadSuggestions = async () => {
    setSuggestionsLoading(true)
    try {
      const response = await fetch(`${agentBaseUrl}/prompt-suggestions`, { credentials: 'include', headers })
      if (!response.ok) throw new Error('Unable to load prompt suggestions')
      const data = await response.json() as PromptSuggestion[]
      setSuggestions(data)
      setSelectedSuggestionId((current) => current && data.some((item) => item.id === current) ? current : data[0]?.id)
    } catch {
      toast.error('Unable to load prompt suggestions.')
    } finally {
      setSuggestionsLoading(false)
    }
  }

  useEffect(() => {
    if (suggestionsOpen) void loadSuggestions()
  }, [suggestionsOpen])

  useEffect(() => {
    if (!skillsOpen) return
    setSkillsLoading(true)
    void fetch(`${agentBaseUrl}/skills`, { credentials: 'include', headers })
      .then(async (response) => response.ok ? response.json() as Promise<AgentSkill[]> : Promise.reject())
      .then((items) => { setSkills(items); setSelectedSkillPreviewId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id) }).catch(() => toast.error('Unable to load agent skills.'))
      .finally(() => setSkillsLoading(false))
  }, [agentBaseUrl, headers, skillsOpen])

  const saveSkill = () => {
    if (!skillTitle.trim() || !skillInstructions.trim()) return
    const url = editingSkillId ? `${agentBaseUrl}/skills/${encodeURIComponent(editingSkillId)}` : `${agentBaseUrl}/skills`
    void fetch(url, { method: editingSkillId ? 'PATCH' : 'POST', credentials: 'include', headers, body: JSON.stringify({ title: skillTitle, description: skillDescription, instructions: skillInstructions }) })
      .then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<AgentSkill> })
      .then((skill) => { setSkills((items) => editingSkillId ? items.map((item) => item.id === skill.id ? skill : item) : [skill, ...items]); setSelectedSkillPreviewId(skill.id); setSkillTitle(''); setSkillDescription(''); setSkillInstructions(''); setEditingSkillId(undefined); toast.success(editingSkillId ? 'Skill updated.' : 'Skill added.') })
      .catch(() => toast.error('Unable to save agent skill.'))
  }

  const removeSkill = (skill: AgentSkill) => void fetch(`${agentBaseUrl}/skills/${encodeURIComponent(skill.id)}`, { method: 'DELETE', credentials: 'include', headers })
    .then((response) => { if (!response.ok) throw new Error(); setSkills((items) => { const next = items.filter((item) => item.id !== skill.id); setSelectedSkillPreviewId((current) => current === skill.id ? next[0]?.id : current); return next }); onSelectedSkillIdsChange(selectedSkillIds.filter((id) => id !== skill.id)) })
    .catch(() => toast.error('Unable to delete agent skill.'))

  const resetSkillEditor = () => {
    setEditingSkillId(undefined)
    setSelectedSkillPreviewId(undefined)
    setSkillTitle('')
    setSkillDescription('')
    setSkillInstructions('')
  }

  const editSkill = (skill: AgentSkill) => {
    setSelectedSkillPreviewId(undefined)
    setEditingSkillId(skill.id)
    setSkillTitle(skill.title)
    setSkillDescription(skill.description)
    setSkillInstructions(skill.instructions)
  }

  const visibleSkills = skills.filter((skill) =>
    `${skill.title}\n${skill.description}\n${skill.instructions}`.toLocaleLowerCase().includes(skillSearch.trim().toLocaleLowerCase())
  )
  const selectedSkillPreview = skills.find((skill) => skill.id === selectedSkillPreviewId)

  const toggleSkill = (skillId: string, checked: boolean) => {
    if (checked && !selectedSkillIds.includes(skillId) && selectedSkillIds.length >= 12) {
      toast.error('Select at most 12 skills per conversation.')
      return
    }
    onSelectedSkillIdsChange(checked ? [...selectedSkillIds, skillId] : selectedSkillIds.filter((id) => id !== skillId))
  }

  useEffect(() => {
    if (mentionQuery === undefined || !headers) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void fetch(
        `${agentBaseUrl}/project-context/files?query=${encodeURIComponent(mentionQuery)}`,
        { credentials: 'include', headers, signal: controller.signal }
      )
        .then((response) =>
          response.ok
            ? (response.json() as Promise<{ files: WorkspaceFile[] }>)
            : { files: [] }
        )
        .then((data) => setWorkspaceFiles(data.files.slice(0, 8)))
        .catch(() => undefined)
    // Wait for a pause in typing before querying workspace files.  This keeps
    // the composer responsive on slower local Agent Service instances.
    }, 300)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [agentBaseUrl, headers, mentionQuery])

  useEffect(() => () => {
    if (mentionCheckTimer.current) window.clearTimeout(mentionCheckTimer.current)
  }, [])

  const updateDraft = (next: string) => {
    setInputValue(next)
    onChange(next)
    // Do not run regex parsing or mutate the mention UI on each keystroke.
    // A quiet 600ms window keeps normal text input smooth on large chats.
    if (mentionCheckTimer.current) window.clearTimeout(mentionCheckTimer.current)
    mentionCheckTimer.current = window.setTimeout(() => {
      const match = next.match(/(?:^|\s)@([^\s@]*)$/)
      setMentionQuery(match ? match[1] : undefined)
    }, 600)
  }

  const selectMention = (path: string) => {
    const next = inputValue.replace(/@[^\s@]*$/, `@${path} `)
    setInputValue(next)
    onChange(next)
    setMentionQuery(undefined)
    window.setTimeout(() => textareaRef.current?.focus(), 0)
  }

  const focusMention = (index: number) => {
    if (!workspaceFiles.length) return
    const next = ((index % workspaceFiles.length) + workspaceFiles.length) % workspaceFiles.length
    mentionButtons.current[next]?.focus()
  }

  const addFiles = (files: File[]) => {
    if (files.length) onFiles(files)
    setIsDropping(false)
  }

  const resetSuggestionEditor = () => {
    setEditingSuggestionId(undefined)
    setSuggestionTitle('')
    setSuggestionPrompt('')
  }

  const cancelSuggestionEditor = () => {
    const returnTo = editorReturnSelectionId ?? suggestions[0]?.id
    resetSuggestionEditor()
    setEditorReturnSelectionId(undefined)
    setSelectedSuggestionId(returnTo)
  }

  const saveSuggestion = () => {
    const title = suggestionTitle.trim()
    const prompt = suggestionPrompt.trim()
    if (!title || !prompt) return
    void (async () => {
      try {
        const response = editingSuggestionId
          ? await fetch(`${agentBaseUrl}/prompt-suggestions/${encodeURIComponent(editingSuggestionId)}`, { method: 'PATCH', credentials: 'include', headers, body: JSON.stringify({ title, prompt }) })
          : await fetch(`${agentBaseUrl}/prompt-suggestions`, { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ title, prompt }) })
        if (!response.ok) throw new Error('Unable to save prompt suggestion')
        const saved = await response.json() as PromptSuggestion
        setSuggestions((items) => editingSuggestionId
          ? items.map((item) => item.id === editingSuggestionId ? saved : item)
          : [saved, ...items]
        )
        setSelectedSuggestionId(saved.id)
        resetSuggestionEditor()
        setEditorReturnSelectionId(undefined)
        toast.success(editingSuggestionId ? 'Suggestion updated.' : 'Suggestion added.')
      } catch {
        toast.error('Unable to save prompt suggestion.')
      }
    })()
  }

  const editSuggestion = (suggestion: PromptSuggestion) => {
    setEditorReturnSelectionId(suggestion.id)
    setSelectedSuggestionId(suggestion.id)
    setEditingSuggestionId(suggestion.id)
    setSuggestionTitle(suggestion.title)
    setSuggestionPrompt(suggestion.prompt)
  }

  const deleteSuggestion = (suggestion: PromptSuggestion) => {
    void (async () => {
      try {
        const response = await fetch(`${agentBaseUrl}/prompt-suggestions/${encodeURIComponent(suggestion.id)}`, { method: 'DELETE', credentials: 'include', headers })
        if (!response.ok) throw new Error('Unable to delete prompt suggestion')
        setSuggestions((items) => {
          const next = items.filter((item) => item.id !== suggestion.id)
          setSelectedSuggestionId(next[0]?.id)
          return next
        })
        resetSuggestionEditor()
        toast.success('Suggestion deleted.')
      } catch {
        toast.error('Unable to delete prompt suggestion.')
      }
    })()
  }

  const insertSuggestion = (suggestion: PromptSuggestion) => {
    const separator = inputValue.trim() ? (inputValue.endsWith('\n') ? '\n' : '\n\n') : ''
    updateDraft(`${inputValue}${separator}${suggestion.prompt}`)
    setSuggestionsOpen(false)
    window.setTimeout(() => textareaRef.current?.focus(), 0)
  }

  const visibleSuggestions = suggestions.filter((suggestion) =>
    `${suggestion.title}\n${suggestion.prompt}`
      .toLocaleLowerCase()
      .includes(suggestionSearch.trim().toLocaleLowerCase())
  )
  const selectedSuggestion = suggestions.find(
    (item) => item.id === selectedSuggestionId
  )
  const editorOpen = Boolean(editingSuggestionId) || !selectedSuggestion

  return (
    <>
      <Dialog onOpenChange={setSkillsOpen} open={skillsOpen}>
        <DialogContent className='max-h-[min(42rem,calc(100vh-2rem))] sm:max-w-2xl'>
          <DialogHeader><DialogTitle>Agent skills</DialogTitle><DialogDescription>Select reusable instructions for this conversation. Skills are stored in Agent Service and are applied on the next message.</DialogDescription></DialogHeader>
          <div className='grid gap-4 md:grid-cols-[minmax(0,0.65fr)_minmax(0,1.35fr)]'>
            <div className='min-h-0 space-y-2 rounded-md border p-2'>
              <div className='flex gap-2'>
                <input aria-label='Search skills' className='h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30' onChange={(event) => setSkillSearch(event.target.value)} placeholder='Search skills...' value={skillSearch} />
                <Button onClick={resetSkillEditor} size='sm' type='button'><Plus className='mr-1 size-3.5' />Add</Button>
              </div>
              <div className='max-h-64 space-y-1.5 overflow-y-auto pr-1'>
              {visibleSkills.map((skill) => <div className={`group flex items-start gap-2 rounded-lg border p-2.5 transition-colors ${selectedSkillIds.includes(skill.id) ? 'border-primary bg-primary/10 shadow-xs' : 'bg-card hover:border-primary/30 hover:bg-muted/30'}`} key={skill.id}>
                <Checkbox aria-label={`Select ${skill.title}`} checked={selectedSkillIds.includes(skill.id)} className='mt-0.5' onCheckedChange={(checked) => toggleSkill(skill.id, checked === true)} />
                <button className='min-w-0 flex-1 text-left' onClick={() => { setEditingSkillId(undefined); setSelectedSkillPreviewId(skill.id) }} type='button'><p className='truncate text-sm font-medium'>{skill.title}</p><p className='mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground'>{skill.description || skill.instructions}</p></button>
                <DropdownMenu><DropdownMenuTrigger asChild><Button aria-label={`Actions for ${skill.title}`} className='shrink-0' size='icon' type='button' variant='ghost'><MoreVertical className='size-4' /></Button></DropdownMenuTrigger><DropdownMenuContent align='end'><DropdownMenuItem onClick={() => editSkill(skill)}><Pencil className='mr-2 size-4' />Edit</DropdownMenuItem><DropdownMenuItem className='text-destructive focus:text-destructive' onClick={() => removeSkill(skill)}><Trash2 className='mr-2 size-4' />Delete</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
              </div>)}
              {skillsLoading ? <p className='p-4 text-center text-sm text-muted-foreground'>Loading skills...</p> : null}
              {!skillsLoading && !visibleSkills.length ? <p className='rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground'>{skills.length ? 'No matching skills.' : 'No skills yet. Add your first one.'}</p> : null}
              </div>
            </div>
            {editingSkillId || !selectedSkillPreview ? <div className='space-y-2 rounded-md border p-3'>
              <p className='text-sm font-medium'>{editingSkillId ? 'Edit skill' : 'Add skill'}</p>
              <input className='h-9 w-full rounded-md border bg-background px-2 text-sm' maxLength={100} onChange={(event) => setSkillTitle(event.target.value)} placeholder='Skill name' value={skillTitle} />
              <input className='h-9 w-full rounded-md border bg-background px-2 text-sm' maxLength={300} onChange={(event) => setSkillDescription(event.target.value)} placeholder='Short description' value={skillDescription} />
              <textarea className='min-h-36 w-full rounded-md border bg-background p-2 text-sm' maxLength={12000} onChange={(event) => setSkillInstructions(event.target.value)} placeholder='Instructions for Codex…' value={skillInstructions} />
              <div className='flex gap-2'><Button disabled={!skillTitle.trim() || !skillInstructions.trim()} onClick={saveSkill} size='sm' type='button'><Plus className='mr-1 size-4' />{editingSkillId ? 'Save skill' : 'Add skill'}</Button>{editingSkillId ? <Button onClick={() => { setEditingSkillId(undefined); setSkillTitle(''); setSkillDescription(''); setSkillInstructions('') }} size='sm' type='button' variant='outline'>Cancel</Button> : null}</div>
            </div> : <div className='flex min-h-0 flex-col rounded-lg border bg-muted/20 p-4'>
              <p className='text-base font-semibold'>{selectedSkillPreview.title}</p>
              {selectedSkillPreview.description ? <p className='mt-1 text-xs text-muted-foreground'>{selectedSkillPreview.description}</p> : null}
              <p className='mt-4 text-xs font-medium tracking-wide text-muted-foreground uppercase'>Instruction</p>
              <div className='mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-sm leading-6'>{selectedSkillPreview.instructions}</div>
            </div>}
          </div>
          <DialogFooter><Button onClick={() => setSkillsOpen(false)} type='button'>Done{selectedSkillIds.length ? ` (${selectedSkillIds.length} selected)` : ''}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={(open) => {
        setSuggestionsOpen(open)
        if (!open) resetSuggestionEditor()
      }} open={suggestionsOpen}>
        <DialogContent className='flex max-h-[min(42rem,calc(100vh-2rem))] flex-col sm:max-w-xl'>
          <DialogHeader>
            <DialogTitle>Prompt suggestions</DialogTitle>
            <DialogDescription>
              Reusable instructions are saved to your CloudTool account and available on every device.
            </DialogDescription>
          </DialogHeader>
          <div className='grid min-h-0 gap-3 md:grid-cols-[minmax(0,0.65fr)_minmax(0,1.35fr)]'>
            <div className='flex min-h-0 flex-col gap-2 overflow-hidden'>
              <div className='flex gap-2'>
                <input aria-label='Search suggestions' className='h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30' onChange={(event) => setSuggestionSearch(event.target.value)} placeholder='Search suggestions…' value={suggestionSearch} />
                <Button onClick={() => { setEditorReturnSelectionId(selectedSuggestionId); resetSuggestionEditor(); setSelectedSuggestionId(undefined) }} size='sm' type='button'><Plus className='mr-1 size-3.5' />Add</Button>
              </div>
              <div className='min-h-0 space-y-1.5 overflow-y-auto pr-1'>
              {visibleSuggestions.map((suggestion) => (
                <div className={`group rounded-lg border p-2.5 transition-colors ${suggestion.id === selectedSuggestionId && !editingSuggestionId ? 'border-primary bg-primary/10 shadow-xs' : 'bg-card hover:border-primary/30 hover:bg-muted/30'}`} key={suggestion.id}>
                  <div className='flex items-start gap-2'>
                    <button className='min-w-0 flex-1 text-left' onClick={() => { resetSuggestionEditor(); setSelectedSuggestionId(suggestion.id) }} type='button'>
                      <p className='truncate text-sm font-medium'>{suggestion.title}</p>
                      <p className='mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground'>{suggestion.prompt}</p>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button aria-label={`Actions for ${suggestion.title}`} className='shrink-0' size='icon' type='button' variant='ghost'><MoreVertical className='size-4' /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align='end'>
                        <DropdownMenuItem onClick={() => editSuggestion(suggestion)}><Pencil className='mr-2 size-4' />Edit</DropdownMenuItem>
                        <DropdownMenuItem className='text-destructive focus:text-destructive' onClick={() => deleteSuggestion(suggestion)}><Trash2 className='mr-2 size-4' />Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
              {suggestionsLoading ? <p className='p-5 text-center text-sm text-muted-foreground'>Loading suggestions…</p> : null}
              {!suggestionsLoading && !visibleSuggestions.length ? <p className='rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground'>{suggestions.length ? 'No matching suggestions.' : 'No suggestions yet. Add your first one.'}</p> : null}
              </div>
            </div>
            {editorOpen ? <div className='rounded-lg border bg-muted/20 p-3'>
              <p className='text-sm font-semibold'>{editingSuggestionId ? 'Edit suggestion' : 'New suggestion'}</p>
              <label className='mt-3 block text-xs font-medium text-muted-foreground' htmlFor='suggestion-title'>Name</label>
              <input className='mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30' id='suggestion-title' maxLength={80} onChange={(event) => setSuggestionTitle(event.target.value)} placeholder='e.g. Security review' value={suggestionTitle} />
              <label className='mt-3 block text-xs font-medium text-muted-foreground' htmlFor='suggestion-prompt'>Instruction</label>
              <textarea className='mt-1 min-h-36 w-full resize-y rounded-md border bg-background p-2 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring/30' id='suggestion-prompt' maxLength={4000} onChange={(event) => setSuggestionPrompt(event.target.value)} placeholder='Write the instruction Codex should receive…' value={suggestionPrompt} />
              <div className='mt-3 flex justify-end gap-2'>
                <Button disabled={!suggestionTitle.trim() || !suggestionPrompt.trim()} onClick={saveSuggestion} size='sm' type='button'>
                  <Check className='mr-1.5 size-3.5' />{editingSuggestionId ? 'Save changes' : 'Add suggestion'}
                </Button>
              </div>
            </div> : selectedSuggestion ? (
              <div className='flex min-h-0 flex-col rounded-lg border bg-muted/20 p-4'>
                <div className='flex items-start gap-2'>
                  <div className='min-w-0 flex-1'>
                    <p className='text-base font-semibold'>{selectedSuggestion.title}</p>
                    <p className='mt-1 text-xs text-muted-foreground'>Preview · only Use inserts this text into the current draft.</p>
                  </div>
                </div>
                <div className='mt-4 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-sm leading-6'>{selectedSuggestion.prompt}</div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            {editorOpen ? <Button onClick={cancelSuggestionEditor} type='button' variant='outline'>Cancel</Button> : null}
            <Button onClick={() => setSuggestionsOpen(false)} type='button' variant='outline'>Close</Button>
            {selectedSuggestion && !editorOpen ? <Button disabled={disabled} onClick={() => insertSuggestion(selectedSuggestion)} type='button'><Lightbulb className='mr-2 size-4' />Use in chat</Button> : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <form
      className='border-t bg-card p-3 sm:p-4'
      onSubmit={(event) => {
        event.preventDefault()
        onSend()
      }}
    >
      {attachments.length ? (
        <div className='mb-3 flex flex-wrap gap-2'>
          {attachments.map((item) => (
            <div
              className='group relative flex max-w-56 items-center gap-2 rounded-lg border bg-muted/30 p-1.5 pr-7'
              key={item.id}
            >
              {imageSource(item) ? (
                <img
                  alt={item.name}
                  className='size-12 rounded object-cover'
                  src={imageSource(item)}
                />
              ) : (
                <div className='grid size-12 place-items-center rounded bg-background'>
                  <FileText className='size-5 text-muted-foreground' />
                </div>
              )}
              <div className='min-w-0'>
                <p className='truncate text-xs font-medium'>{item.name}</p>
                <p className='text-[11px] text-muted-foreground'>
                  {item.media_type.startsWith('image/') ? 'Image' : 'File'} ·
                  ready for Codex
                </p>
              </div>
              <button
                aria-label={`Remove ${item.name}`}
                className='absolute top-1 right-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground'
                onClick={() => onRemove(item.id)}
                type='button'
              >
                <X className='size-3.5' />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <input
        accept='*/*'
        className='hidden'
        multiple
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []))
          event.currentTarget.value = ''
        }}
        ref={fileInput}
        type='file'
      />
      <div
        className={`relative rounded-xl border bg-background shadow-xs transition-colors ${isDropping ? 'border-primary bg-primary/5' : 'border-input'} focus-within:ring-2 focus-within:ring-ring/30`}
        onDragEnter={(event) => {
          event.preventDefault()
          setIsDropping(true)
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setIsDropping(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          addFiles(Array.from(event.dataTransfer.files))
        }}
      >
        {mentionQuery !== undefined ? (
          <div className='absolute bottom-full left-3 z-20 mb-2 w-[min(34rem,calc(100vw-3rem))] overflow-hidden rounded-lg border bg-popover p-1 shadow-lg'>
            <p className='px-2 py-1.5 text-xs text-muted-foreground'>
              Workspace files · select to mention
            </p>
            {workspaceFiles.length ? (
              workspaceFiles.map((file, index) => (
                <button
                  aria-label={`Mention ${file.path}`}
                  className='flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none'
                  key={file.path}
                  onClick={() => selectMention(file.path)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      focusMention(index + 1)
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      focusMention(index - 1)
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setMentionQuery(undefined)
                      textareaRef.current?.focus()
                    } else if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      selectMention(file.path)
                    }
                  }}
                  ref={(element) => {
                    mentionButtons.current[index] = element
                  }}
                  type='button'
                >
                  {file.kind === 'folder' ? <Folder className='size-4 shrink-0 text-muted-foreground' /> : <FileText className='size-4 shrink-0 text-muted-foreground' />}
                  <span className='min-w-0 flex-1 truncate font-mono text-xs'>
                    {file.path}
                  </span>
                  <span className='text-xs text-muted-foreground'>
                    {file.kind === 'folder' ? 'Folder' : readableSize(file.size)}
                  </span>
                </button>
              ))
            ) : (
              <p className='px-2 py-2 text-xs text-muted-foreground'>
                No workspace files or folders found.
              </p>
            )}
          </div>
        ) : null}
        <textarea
          aria-label='Chat message'
          className='min-h-24 w-full resize-none bg-transparent px-3 pt-3 text-sm leading-6 outline-none placeholder:text-muted-foreground'
          disabled={disabled}
          ref={textareaRef}
          onChange={(event) => updateDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              mentionQuery !== undefined &&
              workspaceFiles.length &&
              event.key === 'ArrowDown'
            ) {
              event.preventDefault()
              focusMention(0)
              return
            }
            if (
              mentionQuery !== undefined &&
              workspaceFiles.length &&
              event.key === 'ArrowUp'
            ) {
              event.preventDefault()
              focusMention(workspaceFiles.length - 1)
              return
            }
            if (mentionQuery !== undefined && event.key === 'Escape') {
              event.preventDefault()
              setMentionQuery(undefined)
              return
            }
            if (
              event.key === 'Enter' &&
              (event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing
            ) {
              // Insert deliberately so Ctrl/Cmd+Enter never bubbles into the
              // form submit path on browsers or keyboard layouts.
              event.preventDefault()
              const element = event.currentTarget
              const start = element.selectionStart
              const end = element.selectionEnd
              const next = `${inputValue.slice(0, start)}\n${inputValue.slice(end)}`
              updateDraft(next)
              window.requestAnimationFrame(() => {
                element.setSelectionRange(start + 1, start + 1)
              })
              return
            }
            if (
              event.key === 'Enter' &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              onSend()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length) {
              event.preventDefault()
              addFiles(files)
            }
          }}
          placeholder='Ask about this project… Use @ to mention a workspace file.'
          value={inputValue}
        />
        <div className='flex flex-wrap items-center gap-2 px-2 pb-2'>
          <div className='flex items-center gap-1'>
            <Button
              disabled={disabled || attachments.length >= 5}
              onClick={() => fileInput.current?.click()}
              size='icon'
              title='Attach files or images'
              type='button'
              variant='ghost'
            >
              <Plus className='size-4' />
            </Button>
            <Button
              disabled={disabled || attachments.length >= 5}
              onClick={() => fileInput.current?.click()}
              size='icon'
              title='Attach file'
              type='button'
              variant='ghost'
            >
              <Paperclip className='size-4' />
            </Button>
            <span className='hidden items-center gap-1 px-1 text-[11px] text-muted-foreground sm:inline-flex'>
              <AtSign className='size-3' /> Mention file
            </span>
          </div>
          <div className='ml-auto flex min-w-0 items-center gap-2'>
            <Button aria-label='Manage agent skills' disabled={disabled} onClick={() => setSkillsOpen(true)} size='icon' title='Agent skills' type='button' variant='ghost'>
              <Sparkles className='size-4' />
            </Button>
            <Button
              aria-label='Manage prompt suggestions'
              disabled={disabled}
              onClick={() => setSuggestionsOpen(true)}
              size='icon'
              title='Prompt suggestions'
              type='button'
              variant='ghost'
            >
              <Lightbulb className='size-4' />
            </Button>
            <select
              aria-label='AI API permission policy'
              className={`h-8 rounded-md border px-2 text-xs font-medium outline-none ${permission === 'bypass' ? 'border-amber-400/60 bg-amber-400/15 text-amber-700 dark:text-amber-300' : 'border-transparent bg-muted/60 text-muted-foreground'}`}
              disabled={disabled}
              onChange={(event) =>
                onPermissionChange(event.target.value as 'confirm' | 'bypass')
              }
              value={permission}
            >
              <option value='confirm'>Ask first</option>
              <option value='bypass'>Full access</option>
            </select>
            <select
              aria-label='Codex model'
              className='h-8 max-w-40 rounded-md border-0 bg-muted/60 px-2 text-xs outline-none'
              disabled={disabled || !models.length}
              onChange={(event) => onModelChange(event.target.value)}
              value={model}
            >
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.display_name}
                </option>
              ))}
            </select>
            <select
              aria-label='Reasoning effort'
              className='h-8 rounded-md border-0 bg-muted/60 px-2 text-xs outline-none'
              disabled={disabled || !models.length}
              onChange={(event) => onReasoningChange(event.target.value)}
              value={reasoning}
            >
              {(
                models.find((item) => item.id === model)?.reasoning_efforts ??
                []
              ).map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
            {sending ? (
              <Button
                className='ml-3'
                onClick={onStop}
                size='icon'
                title='Stop analysis'
                type='button'
                variant='destructive'
              >
                <X className='size-4' />
              </Button>
            ) : (
              <Button
                className='ml-3'
                disabled={disabled || (!inputValue.trim() && !attachments.length)}
                size='icon'
                title='Send message (Enter)'
                type='submit'
              >
                <Send className='size-4' />
              </Button>
            )}
          </div>
        </div>
      </div>
      <p className='mt-2 text-center text-[11px] text-muted-foreground'>
        {isDropping
          ? 'Drop files to attach'
          : 'Enter to send · Ctrl + Enter for a new line · Paste images directly from your clipboard'}
      </p>
      </form>
    </>
  )
}
