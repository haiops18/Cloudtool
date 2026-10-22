export type CodexExecutionItem = {
  item_id: string
  kind: 'command' | 'message' | 'plan' | 'summary' | 'tool' | 'files' | 'search' | 'image'
  status: 'running' | 'complete' | 'failed' | 'stopped'
  title?: string
  command?: string
  cwd?: string
  text?: string
  output?: string
  exit_code?: number
  phase?: string
}

export type CodexExecutionEvent = Partial<CodexExecutionItem> & {
  item_id: string
  kind: CodexExecutionItem['kind']
  field?: 'text' | 'output'
  delta?: string
}

export function updateCodexExecution(items: CodexExecutionItem[], event: CodexExecutionEvent): CodexExecutionItem[] {
  const index = items.findIndex((item) => item.item_id === event.item_id)
  const { delta, field, ...snapshot } = event
  const previous = items[index]
  const next: CodexExecutionItem = { ...previous, ...snapshot, status: snapshot.status ?? previous?.status ?? 'running' }
  if (typeof delta === 'string' && (field === 'text' || field === 'output'))
    next[field] = `${previous?.[field] ?? ''}${delta}`.slice(-64000)
  for (const key of ['text', 'output'] as const)
    if (next[key]) next[key] = next[key].slice(-64000)
  if (index === -1) return [...items, next].slice(-100)
  return items.map((item, itemIndex) => itemIndex === index ? next : item)
}
