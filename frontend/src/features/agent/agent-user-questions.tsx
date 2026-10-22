import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export type AgentQuestionRequest = {
  id: string
  questions: Array<{
    id: string
    header: string
    question: string
    isOther?: boolean
    options?: Array<{ label: string; description: string }> | null
  }>
}

export function AgentQuestionForm({ request, onAnswer }: {
  request: AgentQuestionRequest
  onAnswer: (answers: Record<string, string[]>, cancel: boolean) => Promise<void>
}) {
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [text, setText] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const answers = Object.fromEntries(request.questions.map((question) => {
    const choice = choices[question.id]
    const value = choice?.startsWith('option:')
      ? question.options?.[Number(choice.slice(7))]?.label ?? ''
      : (text[question.id] ?? '').trim()
    return [question.id, [value]]
  }))
  const complete = request.questions.every((question) => answers[question.id][0])
  async function submit(cancel: boolean) {
    setBusy(true)
    try { await onAnswer(cancel ? {} : answers, cancel) }
    finally { setBusy(false) }
  }
  return (
    <form className='mx-4 mb-3 max-h-[50vh] space-y-4 overflow-y-auto rounded-lg border bg-muted/30 p-4'
      aria-label='Agent questions' onSubmit={(event) => { event.preventDefault(); if (complete && !busy) void submit(false) }}>
      <div className='text-sm font-medium'>Codex cần thêm thông tin</div>
      {request.questions.map((question) => (
        <fieldset key={question.id} disabled={busy} className='min-w-0 space-y-2'>
          <legend className='mb-2 text-sm font-medium'>{question.question}</legend>
          {question.options?.map((option, index) => (
            <label key={index} className='flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm has-[:checked]:border-primary'>
              <input type='radio' name={`${request.id}-${question.id}`} className='mt-1 shrink-0'
                checked={choices[question.id] === `option:${index}`}
                onChange={() => setChoices((current) => ({ ...current, [question.id]: `option:${index}` }))} />
              <span className='min-w-0 break-words [overflow-wrap:anywhere]'><span className='font-medium'>{option.label}</span>
                {option.description && <span className='mt-0.5 block text-xs text-muted-foreground'>{option.description}</span>}
              </span>
            </label>
          ))}
          {(!question.options?.length || question.isOther) && (
            <div className='space-y-2'>
              {!!question.options?.length && <label className='flex items-center gap-2 text-sm'>
                <input type='radio' name={`${request.id}-${question.id}`} checked={choices[question.id] === 'other'}
                  onChange={() => setChoices((current) => ({ ...current, [question.id]: 'other' }))} />Lựa chọn khác
              </label>}
              {(!question.options?.length || choices[question.id] === 'other') && <Input aria-label={`Trả lời: ${question.header}`}
                maxLength={4000} placeholder='Nhập câu trả lời…' value={text[question.id] ?? ''}
                onChange={(event) => setText((current) => ({ ...current, [question.id]: event.target.value }))} />}
            </div>
          )}
        </fieldset>
      ))}
      <div className='flex justify-end gap-2'>
        <Button type='button' variant='outline' disabled={busy} onClick={() => void submit(true)}>Hủy câu hỏi</Button>
        <Button type='submit' disabled={!complete || busy}>{busy && <Loader2 className='mr-2 size-4 animate-spin' />}Gửi câu trả lời</Button>
      </div>
    </form>
  )
}

export function AgentUserQuestions({ agentBaseUrl, headers, conversationId, sending }: {
  agentBaseUrl: string
  headers?: Record<string, string> | null
  conversationId?: string
  sending: boolean
}) {
  const [items, setItems] = useState<AgentQuestionRequest[]>([])
  useEffect(() => {
    if (!conversationId || !headers) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      let pending = false
      try {
        const response = await fetch(`${agentBaseUrl}/conversations/${encodeURIComponent(conversationId!)}/questions`, {
          credentials: 'include', headers: headers!, signal: controller.signal,
        })
        if (!response.ok) throw new Error('Unable to load agent questions')
        const data = await response.json() as { items: AgentQuestionRequest[] }
        if (controller.signal.aborted) return
        setItems(data.items)
        pending = data.items.length > 0
      } catch { /* A failed poll never resolves or answers a question. */ }
      if (!controller.signal.aborted && (sending || pending)) timer = setTimeout(() => void poll(), 2000)
    }
    void poll()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [agentBaseUrl, headers, conversationId, sending])

  if (!items.length || !headers) return null
  const request = items[0]
  return <AgentQuestionForm key={request.id} request={request} onAnswer={async (answers, cancel) => {
    try {
      const response = await fetch(`${agentBaseUrl}/questions/${encodeURIComponent(request.id)}/answer`, {
        method: 'POST', credentials: 'include', headers, body: JSON.stringify({ answers, cancel }),
      })
      if (!response.ok) {
        if ([404, 409].includes(response.status)) setItems((current) => current.filter((item) => item.id !== request.id))
        throw new Error('Không thể gửi câu trả lời. Câu hỏi có thể đã hết hạn; hãy kiểm tra phiên chat.')
      }
      setItems((current) => current.filter((item) => item.id !== request.id))
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Không thể gửi câu trả lời') }
  }} />
}
