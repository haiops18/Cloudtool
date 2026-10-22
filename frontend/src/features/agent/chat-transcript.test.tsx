import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ChatTranscript } from './chat-transcript'

afterEach(() => vi.restoreAllMocks())

it('shows the pending image and actual command output before an answer arrives', async () => {
  const screen = await render(
    <ChatTranscript
      execution={[
        { item_id: 'command', kind: 'command', command: 'rg --files', cwd: '/workspace', output: 'report.csv', status: 'running' },
      ]}
      agentBaseUrl='/agent'
      isAdmin={false}
      isSending
      messages={[{
        id: 'user', role: 'user', text: 'Check this image',
        attachments: [{
          path: 'pending:upload', name: 'image.svg', media_type: 'image/svg+xml', size: 10,
          data_url: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz4=',
        }],
      }]}
      onReviewCommand={() => undefined}
    />
  )
  await expect.element(screen.getByRole('img', { name: 'image.svg' })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: 'Download image.svg' })).toBeVisible()
  await expect.element(screen.getByText('$ rg --files')).toBeVisible()
  await expect.element(screen.getByText('report.csv')).toBeVisible()
  await expect.element(screen.getByText('Request accepted')).not.toBeInTheDocument()
  await screen.unmount()
})

it('downloads a saved user attachment through the authenticated workspace endpoint', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ media_type: 'text/plain', content_base64: 'aGVsbG8=' })))
    .mockResolvedValueOnce(new Response('hello'))
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
  const screen = await render(
    <ChatTranscript
      agentBaseUrl='/agent'
      headers={{ 'X-Project-Id': 'project' }}
      isAdmin={false}
      isSending={false}
      messages={[{
        id: 'user', role: 'user', text: 'Read this file',
        attachments: [{ path: 'uploads/notes.txt', name: 'notes.txt', media_type: 'text/plain', size: 5 }],
      }]}
      onReviewCommand={() => undefined}
    />
  )
  await screen.getByRole('button', { name: 'Download notes.txt' }).click()
  await vi.waitFor(() => expect(click).toHaveBeenCalledOnce())
  expect(fetchMock).toHaveBeenNthCalledWith(1, '/agent/project-context/file?path=uploads%2Fnotes.txt', {
    credentials: 'include', headers: { 'X-Project-Id': 'project' },
  })
  expect(fetchMock).toHaveBeenNthCalledWith(2, 'data:text/plain;base64,aGVsbG8=')
  await screen.unmount()
})
