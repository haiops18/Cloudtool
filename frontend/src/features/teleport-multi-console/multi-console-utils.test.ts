import { describe, expect, it, vi } from 'vitest'
import {
  consoleWebSocketUrl,
  dispatchNoVncKey,
  keyboardKeysym,
  renderServerCommand,
} from './multi-console-utils'

describe('multi-console utilities', () => {
  it('turns a noVNC console URL into its secure websocket URL', () => {
    expect(
      consoleWebSocketUrl(
        'https://vnc.example.test/vn-central-1/vnc_lite.html?path=vn-central-1%2Fwebsockify%3Ftoken%3Done-time-token'
      )
    ).toBe(
      'wss://vnc.example.test/vn-central-1/websockify?token=one-time-token'
    )
  })

  it('uses an insecure websocket only for an HTTP development console', () => {
    expect(
      consoleWebSocketUrl(
        'http://127.0.0.1/mock?v=1&path=websockify%3Ftoken%3Ddev'
      )
    ).toBe('ws://127.0.0.1/websockify?token=dev')
  })

  it('maps printable and interactive Linux terminal keys', () => {
    expect(keyboardKeysym('a')).toBe(97)
    expect(keyboardKeysym('Escape')).toBe(0xff1b)
    expect(keyboardKeysym('ArrowUp')).toBe(0xff52)
    expect(keyboardKeysym('Control')).toBe(0xffe3)
  })

  it('rejects console URLs without a noVNC path', () => {
    expect(() =>
      consoleWebSocketUrl('https://vnc.example.test/console')
    ).toThrow('noVNC path')
  })

  it('fans a native noVNC key event out to every connected console', () => {
    const first = vi.fn()
    const second = vi.fn()
    const targets = new Map([
      ['server-1', first],
      ['server-2', second],
    ])
    dispatchNoVncKey(true, 'server-1', targets, 97, 'KeyA', true)
    expect(first).toHaveBeenCalledWith(97, 'KeyA', true)
    expect(second).toHaveBeenCalledWith(97, 'KeyA', true)
  })

  it('sends a native key only to its focused console when broadcast is off', () => {
    const first = vi.fn()
    const second = vi.fn()
    const targets = new Map([
      ['server-1', first],
      ['server-2', second],
    ])
    dispatchNoVncKey(false, 'server-2', targets, 0xff1b, 'Escape', false)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith(0xff1b, 'Escape', false)
  })

  it('renders server-specific CLI variables without changing unknown variables', () => {
    const command = renderServerCommand(
      'hostnamectl set-hostname {{ server.name }} && echo {{server.private_ip_1}} {{custom.value}}',
      {
        id: 'server-1',
        name: 'web-01',
        private_ip: [{ ip_address: '10.0.0.10' }],
      }
    )
    expect(command).toBe(
      'hostnamectl set-hostname web-01 && echo 10.0.0.10 {{custom.value}}'
    )
  })

  it('supports one-based list access for private and elastic IP variables', () => {
    const server = {
      id: 'server-1',
      name: 'web-01',
      private_ip: [
        { ip_address: '10.60.160.9' },
        { ip_address: '10.60.160.209' },
      ],
      elastic_ip: [
        { ip_address: '203.0.113.10' },
        { ip_address: '203.0.113.11' },
      ],
    }

    expect(
      renderServerCommand(
        '{{server.private_ip_1}} {{server.private_ip_2}} {{server.private_ip[1]}} {{server.private_ip[2]}}',
        server
      )
    ).toBe('10.60.160.9 10.60.160.209 10.60.160.9 10.60.160.209')
    expect(
      renderServerCommand(
        '{{server.elastic_ip_1}} {{server.elastic_ip_2}} {{server.elastic_ip[1]}} {{server.elastic_ip[2]}}',
        server
      )
    ).toBe('203.0.113.10 203.0.113.11 203.0.113.10 203.0.113.11')
  })

  it('renders an empty value for a valid IP index that a server does not have', () => {
    expect(
      renderServerCommand('{{server.private_ip[3]}}', {
        id: 'server-1',
        name: 'web-01',
        private_ip: [{ ip_address: '10.60.160.9' }],
      })
    ).toBe('')
  })

  it('inserts custom variables from the spreadsheet without extra quotes', () => {
    expect(
      renderServerCommand(
        'printf %s {{custom.note_file}}',
        { id: 'server-1', name: 'web-01' },
        { note_file: "note; rm -rf / and owner's file" }
      )
    ).toBe("printf %s note; rm -rf / and owner's file")
  })

  it('renders shared variables verbatim for every server', () => {
    expect(
      renderServerCommand(
        'curl https://repo.example/library-{{shared.library_version}}.tar.gz',
        { id: 'server-1', name: 'web-01' },
        {},
        { library_version: '1.2.3' }
      )
    ).toBe('curl https://repo.example/library-1.2.3.tar.gz')
  })

  it('supports server variables and incremental indexes inside shared values', () => {
    const server = { id: 'server-2', name: 'worker-east' }
    expect(
      renderServerCommand(
        'echo {{shared.node_name}} {{shared.worker_name}}',
        server,
        {},
        {
          node_name: '{{server.name}}',
          worker_name: 'worker_[in]',
        },
        1
      )
    ).toBe('echo worker-east worker_02')
  })

  it('supports custom sequence start, step, and digit padding', () => {
    const server = { id: 'server-3', name: 'worker' }
    expect(
      renderServerCommand(
        'echo {{shared.worker}} {{shared.shortcut}}',
        server,
        {},
        {
          worker: 'worker_[in:start=10,step=5,pad=3]',
          shortcut: 'node_[in:20]',
        },
        2
      )
    ).toBe('echo worker_020 node_22')
  })
})
