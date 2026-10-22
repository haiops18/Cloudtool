import { AxiosError } from 'axios'
import { afterEach, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { apiClient } from '@/lib/api-client'
import { TerminalScriptDialog } from './terminal-script-dialog'

const originalAdapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
})

it('runs password scripts across VMs and distinguishes silent success, command failure and API errors', async () => {
  const targets = ['ok', 'denied', 'unavailable'].map((name) => ({
    id: name,
    name,
    ip: `10.0.0.${name === 'ok' ? 1 : name === 'denied' ? 2 : 3}`,
    labels: '',
  }))
  const requested: string[] = []
  const script = "printf '%s\n' 'admin:sample-password' | chpasswd"
  apiClient.defaults.adapter = async (config) => {
    expect(config.url).toBe('/teleport-links/link/tsh/ssh')
    const payload = JSON.parse(config.data)
    expect(payload.command).toBe(script)
    expect(payload.login).toBe('app')
    expect(payload).not.toHaveProperty('run_as_root')
    expect(payload).not.toHaveProperty('input_mode')
    requested.push(payload.host)
    const response = {
      data:
        payload.host === 'ok'
          ? { output: '', exit_code: 0 }
          : payload.host === 'denied'
            ? { output: 'chpasswd: Permission denied', exit_code: 1 }
            : { error: { message: 'Teleport session expired' } },
      status: payload.host === 'unavailable' ? 502 : 200,
      statusText: 'OK',
      headers: {},
      config,
    }
    if (response.status === 502)
      throw new AxiosError(
        'Request failed with status code 502',
        'ERR_BAD_RESPONSE',
        config,
        undefined,
        response
      )
    return response
  }
  const screen = await render(
    <TerminalScriptDialog
      open
      onOpenChange={() => {}}
      targets={targets}
      linkId='link'
    />
  )
  await userEvent.fill(
    screen.getByLabelText('CLI command', { exact: true }),
    script
  )
  await userEvent.fill(
    screen.getByLabelText('SSH user', { exact: true }),
    'app'
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Run all', exact: true })
  )
  const success = screen.getByRole('row').filter({ hasText: '10.0.0.1' })
  const denied = screen.getByRole('row').filter({ hasText: '10.0.0.2' })
  const unavailable = screen.getByRole('row').filter({ hasText: '10.0.0.3' })
  await expect.element(success).toHaveTextContent('success')
  await expect.element(success).toHaveTextContent('Completed successfully')
  await expect.element(denied).toHaveTextContent('failed')
  await expect.element(denied).toHaveTextContent('Exit code 1')
  await expect.element(denied).toHaveTextContent('chpasswd: Permission denied')
  await expect
    .element(unavailable)
    .toHaveTextContent('Teleport session expired')
  expect(requested.sort()).toEqual(['denied', 'ok', 'unavailable'])
})

it('sends interactive password input and sleep tokens without interpreting them as shell commands in the browser', async () => {
  const script =
    'passwd admin  \n{{sleep.1s}}  \nsample-secret  \n{{sleep.1s}} sample-secret'
  let received: unknown
  apiClient.defaults.adapter = async (config) => {
    received = JSON.parse(config.data)
    return {
      data: { output: 'Password updated', exit_code: 0 },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  }
  const screen = await render(
    <TerminalScriptDialog
      open
      onOpenChange={() => {}}
      targets={[{ id: 'vm', name: 'vm', ip: '10.0.0.1', labels: '' }]}
      linkId='link'
    />
  )
  await userEvent.fill(
    screen.getByLabelText('CLI command', { exact: true }),
    script
  )
  await expect
    .element(screen.getByLabelText('Execution mode', { exact: true }))
    .not.toBeInTheDocument()
  await expect
    .element(screen.getByText('Run as root (sudo -n)', { exact: true }))
    .not.toBeInTheDocument()
  const editor = screen
    .getByLabelText('CLI command', { exact: true })
    .element() as HTMLTextAreaElement
  editor.setSelectionRange(0, script.length)
  await userEvent.click(
    screen.getByRole('button', { name: 'Run selection', exact: true })
  )
  await expect
    .element(screen.getByText('Password updated', { exact: true }))
    .toBeVisible()
  expect(received).toEqual({
    host: 'vm',
    login: 'root',
    command: script,
  })
})
