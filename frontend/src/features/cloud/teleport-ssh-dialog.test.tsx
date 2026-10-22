import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { apiClient } from '@/lib/api-client'
import { TeleportSshDialog } from './teleport-ssh-dialog'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} }
    }
    focus() {}
    write() {}
    writeln() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

const originalAdapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
  vi.unstubAllGlobals()
})

it('refresh reconnects the same VM and SSH user with a new ticket and closes the previous socket', async () => {
  const sockets: { close: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal(
    'WebSocket',
    class {
      static OPEN = 1
      readyState = 1
      close = vi.fn()
      send = vi.fn()
      constructor() {
        sockets.push(this)
      }
    }
  )
  const requests: string[] = []
  let tickets = 0
  apiClient.defaults.adapter = async (config) => {
    requests.push(config.url!)
    let data: unknown
    if (config.url === '/teleport-links')
      data = [{ id: 'link', name: 'Teleport', url: 'https://teleport.example' }]
    else if (config.url === '/teleport-links/link/tsh/nodes') {
      expect(config.params.ip).toBe('10.129.0.2')
      data = { nodes: [{ name: 'vm-node', ip: '10.129.0.2', labels: '' }] }
    } else if (config.url === '/teleport-links/link/tsh/terminal-ticket') {
      expect(JSON.parse(config.data)).toEqual({ host: 'vm-node', login: 'app' })
      tickets += 1
      data = { ticket: `ticket-${tickets}`, resolved_host: 'vm-node' }
    } else throw new Error(`Unexpected API: ${config.url}`)
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const view = (open: boolean) => (
    <QueryClientProvider client={client}>
      <TeleportSshDialog
        open={open}
        onOpenChange={() => {}}
        server={{
          id: 'vm',
          name: 'VM',
          server_type: 'vm',
          private_ip: [{ id: 'ip', ip_address: '10.129.0.2' }],
        }}
      />
    </QueryClientProvider>
  )
  const screen = await render(view(true))
  const refresh = screen.getByRole('button', {
    name: 'Refresh VM connection',
    exact: true,
  })
  await expect.element(refresh).toBeDisabled()
  const search = screen.getByRole('button', { name: 'Search', exact: true })
  await expect.element(search).toBeEnabled()
  await userEvent.click(search)
  await userEvent.fill(screen.getByLabelText('SSH user for vm-node'), 'app')
  await userEvent.click(
    screen.getByRole('button', { name: 'SSH', exact: true })
  )
  await vi.waitFor(() => expect(sockets).toHaveLength(1))
  await expect.element(refresh).toBeEnabled()
  await userEvent.click(refresh)
  await vi.waitFor(() => expect(sockets).toHaveLength(2))
  expect(tickets).toBe(2)
  expect(sockets[0].close).toHaveBeenCalledOnce()
  expect(requests.some((url) => url.includes('/session/refresh'))).toBe(false)
  await screen.rerender(view(false))
  await vi.waitFor(() => expect(sockets[1].close).toHaveBeenCalledOnce())
  await screen.unmount()
  client.clear()
})
