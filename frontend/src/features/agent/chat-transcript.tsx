import { memo, useEffect, useRef } from 'react'
import { Download, FileOutput, MonitorCog } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  MessageAttachments,
  type WorkspaceAttachment,
} from './attachment-history'
import { CodexExecution } from './codex-execution'
import type { CodexExecutionItem } from './codex-execution-state'

type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  evidence?: unknown[]
  attachments?: WorkspaceAttachment[]
  execution?: CodexExecutionItem[]
}
function commandFromMarkdown(value: string) {
  const match = value.match(/```(?:bash|sh|shell|console)?\s*\n([\s\S]*?)```/i)
  return match?.[1]?.trim()
}

function GeneratedArtifacts({
  artifacts,
  agentBaseUrl,
  headers,
}: {
  artifacts: WorkspaceAttachment[]
  agentBaseUrl: string
  headers?: Record<string, string>
}) {
  const download = async (artifact: WorkspaceAttachment) => {
    if (!headers) return
    const response = await fetch(
      `${agentBaseUrl}/project-context/download?path=${encodeURIComponent(artifact.path)}`,
      { credentials: 'include', headers }
    )
    if (!response.ok) throw new Error('Unable to download generated file')
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = url
    link.download = artifact.name
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  if (!artifacts.length) return null
  return (
    <section className='mt-4 rounded-xl border border-primary/25 bg-primary/[0.04] p-3'>
      <div className='mb-2 flex items-center gap-2 text-sm font-semibold text-primary'>
        <FileOutput className='size-4' /> Generated files
      </div>
      <div className='grid gap-2 sm:grid-cols-2'>
        {artifacts.map((artifact) => (
          <div className='flex min-w-0 items-center gap-2 rounded-lg border bg-background p-2.5' key={artifact.path}>
            <FileOutput className='size-4 shrink-0 text-primary' />
            <button className='min-w-0 flex-1 text-left hover:underline' onClick={() => void download(artifact).catch(() => toast.error('Unable to download generated file'))} type='button'>
              <p className='truncate text-sm font-medium' title={artifact.name}>{artifact.name}</p>
              <p className='truncate text-xs text-muted-foreground' title={artifact.path}>{artifact.path} · {Math.max(1, Math.ceil(artifact.size / 1024))} KB</p>
            </button>
            <Button aria-label={`Download ${artifact.name}`} onClick={() => void download(artifact).catch(() => toast.error('Unable to download generated file'))} size='icon' type='button' variant='outline'>
              <Download className='size-4' />
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}

export const ChatTranscript = memo(function ChatTranscript({
  messages,
  agentBaseUrl,
  headers,
  isAdmin,
  isSending,
  onReviewCommand,
  execution = [],
}: {
  messages: Message[]
  agentBaseUrl: string
  headers?: Record<string, string>
  isAdmin: boolean
  isSending: boolean
  onReviewCommand: (command: string) => void
  execution?: CodexExecutionItem[]
}) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, isSending, execution])
  return (
    <div className='agent-transcript min-h-0 flex-1 overflow-y-auto bg-muted/10 p-4 sm:p-6'>
      <div className='flex w-full max-w-none flex-col gap-4'>
        {messages.map((item) => (
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
                {item.execution?.length ? <div className='mb-3'><CodexExecution items={item.execution} running={false} /></div> : null}
                <div className='leading-6 break-words [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3'>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {item.text}
                  </ReactMarkdown>
                </div>
                <GeneratedArtifacts agentBaseUrl={agentBaseUrl} artifacts={item.attachments ?? []} headers={headers} />
                {isAdmin && commandFromMarkdown(item.text) ? (
                  <Button
                    className='mt-3'
                    onClick={() =>
                      onReviewCommand(commandFromMarkdown(item.text) ?? '')
                    }
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
              <>
                <div className='leading-6 whitespace-pre-wrap'>{item.text}</div>
                <MessageAttachments
                  agentBaseUrl={agentBaseUrl}
                  attachments={item.attachments ?? []}
                  headers={headers}
                />
              </>
            )}
          </div>
        ))}
        {isSending || execution.length ? (
          <div className='w-full max-w-3xl self-start'><CodexExecution items={execution} running={isSending} /></div>
        ) : null}
        <div ref={endRef} />
      </div>
    </div>
  )
})
