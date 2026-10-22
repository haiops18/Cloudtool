import { useEffect, useRef } from 'react'
import { CheckCircle2, CircleAlert, Loader2, Terminal } from 'lucide-react'
import type { CodexExecutionItem } from './codex-execution-state'

const labels: Record<CodexExecutionItem['kind'], string> = {
  command: 'Command', message: 'Codex', plan: 'Plan', summary: 'Thinking summary',
  tool: 'Tool call', files: 'File changes', search: 'Web search', image: 'Viewing image',
}

function CommandOutput({ output }: { output: string }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [output])
  return <pre className='mt-2 max-h-64 overflow-auto border-t border-white/10 pt-2 text-xs whitespace-pre-wrap break-words text-slate-300' ref={ref}>{output}</pre>
}

export function CodexExecution({ items, running }: { items: CodexExecutionItem[]; running: boolean }) {
  return (
    <details aria-label='Codex execution' className='w-full min-w-0 rounded-xl border bg-background text-sm' open={running}>
      <summary className='cursor-pointer p-3 font-medium'>
        <span className='inline-flex items-center gap-2'>
          {running ? <Loader2 className='size-4 animate-spin text-primary' /> : <Terminal className='size-4' />}
          {running ? 'Codex is working' : 'Codex execution'}
        </span>
      </summary>
      <div aria-live='polite' className='space-y-3 border-t p-3'>
        {!items.length ? <p className='text-xs text-muted-foreground'>Waiting for Codex output…</p> : null}
        {items.map((item) => (
          <div className='min-w-0' key={item.item_id}>
            <div className='mb-1 flex items-center gap-2 text-xs text-muted-foreground'>
              {item.status === 'running' && running ? <Loader2 className='size-3.5 shrink-0 animate-spin' />
                : item.status === 'complete' ? <CheckCircle2 className='size-3.5 shrink-0 text-primary' />
                  : <CircleAlert className='size-3.5 shrink-0' />}
              <span className='break-words'>{item.title || labels[item.kind]}</span>
              <span className='ml-auto shrink-0'>{item.status === 'running' && !running ? 'stopped' : item.status}{item.exit_code !== undefined ? ` · exit ${item.exit_code}` : ''}</span>
            </div>
            {item.kind === 'command' ? (
              <div className='rounded-lg bg-slate-950 p-3 font-mono text-slate-100'>
                {item.cwd ? <p className='mb-2 text-[11px] break-all text-slate-400'>{item.cwd}</p> : null}
                <pre className='text-xs whitespace-pre-wrap break-words'>{item.command ? `$ ${item.command}` : 'Receiving command…'}</pre>
                {item.output ? <CommandOutput output={item.output} /> : null}
              </div>
            ) : item.text ? <p className='text-xs leading-5 whitespace-pre-wrap break-words'>{item.text}</p> : null}
          </div>
        ))}
      </div>
    </details>
  )
}
