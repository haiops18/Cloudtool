import { expect, it } from 'vitest'
import { updateCodexExecution, type CodexExecutionItem } from './codex-execution-state'

it('streams interleaved output into the correct command and uses the final snapshot without duplicating output', () => {
  let items: CodexExecutionItem[] = []
  items = updateCodexExecution(items, { item_id: 'one', kind: 'command', command: 'rg --files', status: 'running' })
  items = updateCodexExecution(items, { item_id: 'two', kind: 'command', command: 'pwd', status: 'running' })
  items = updateCodexExecution(items, { item_id: 'one', kind: 'command', field: 'output', delta: 'notes' })
  items = updateCodexExecution(items, { item_id: 'two', kind: 'command', field: 'output', delta: '/workspace' })
  items = updateCodexExecution(items, { item_id: 'one', kind: 'command', field: 'output', delta: '.txt\n' })
  expect(items[0].output).toBe('notes.txt\n')
  items = updateCodexExecution(items, { item_id: 'one', kind: 'command', status: 'complete', output: 'notes.txt\n', exit_code: 0 })
  expect(items).toHaveLength(2)
  expect(items[0]).toMatchObject({ command: 'rg --files', output: 'notes.txt\n', status: 'complete', exit_code: 0 })
  expect(items[1]).toMatchObject({ output: '/workspace', status: 'running' })
})

it('handles deltas received before an item snapshot and bounds large output', () => {
  let items = updateCodexExecution([], { item_id: 'cmd', kind: 'command', field: 'output', delta: 'a'.repeat(64000) })
  items = updateCodexExecution(items, { item_id: 'cmd', kind: 'command', field: 'output', delta: 'latest output' })
  items = updateCodexExecution(items, { item_id: 'cmd', kind: 'command', command: 'cat large.txt', status: 'complete' })
  expect(items[0].output).toHaveLength(64000)
  expect(items[0].output?.endsWith('latest output')).toBe(true)
  expect(items[0].command).toBe('cat large.txt')
})
