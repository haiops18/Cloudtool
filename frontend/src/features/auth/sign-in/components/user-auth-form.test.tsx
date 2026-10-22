import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, type RenderResult } from 'vitest-browser-react'
import { type Locator, userEvent } from 'vitest/browser'
import { UserAuthForm } from './user-auth-form'

const FORM_MESSAGES = {
  emailEmpty: 'Please enter your username or email.',
  passwordEmpty: 'Please enter your password.',
} as const

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setUser: vi.fn(),
  setSession: vi.fn(),
  reset: vi.fn(),
  clearCloud: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
  setCsrfToken: vi.fn(),
}))

const apiUser = {
  id: 'user-1',
  email: 'a@b.com',
  full_name: 'API User',
  is_active: true,
  role: { name: 'Viewer', permissions: [] },
  csrf_token: 'csrf-value',
}

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    auth: {
      setUser: mocks.setUser,
      setSession: mocks.setSession,
      reset: mocks.reset,
    },
  }),
}))

vi.mock('@/stores/cloud-store', () => {
  const state = { clear: mocks.clearCloud }
  const useCloudStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state }
  )
  return { useCloudStore }
})

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  }
})

vi.mock('@/lib/api-client', () => ({
  apiClient: { post: mocks.post, get: mocks.get },
  setCsrfToken: mocks.setCsrfToken,
}))

describe('UserAuthForm', () => {
  describe('Rendering without redirectTo', () => {
    let screen: RenderResult
    let emailInput: Locator
    let passwordInput: Locator
    let signInButton: Locator

    beforeEach(async () => {
      vi.clearAllMocks()
      mocks.post.mockResolvedValue({ data: apiUser })
      screen = await render(<UserAuthForm />)
      emailInput = screen.getByRole('textbox', { name: /username or email/i })
      passwordInput = screen.getByLabelText(/^Password$/i)
      signInButton = screen.getByRole('button', { name: /^Sign in$/i })
    })

    it('renders local credentials and submit button', async () => {
      await expect.element(emailInput).toBeInTheDocument()
      await expect.element(passwordInput).toBeInTheDocument()
      await expect.element(signInButton).toBeInTheDocument()
    })

    it('shows validation messages when submitting empty form', async () => {
      await userEvent.click(signInButton)
      await expect
        .element(screen.getByText(FORM_MESSAGES.emailEmpty))
        .toBeInTheDocument()
      await expect
        .element(screen.getByText(FORM_MESSAGES.passwordEmpty))
        .toBeInTheDocument()
    })

    it('authenticates locally before Cloud Authorization is requested', async () => {
      await userEvent.fill(emailInput, 'a@b.com')
      await userEvent.fill(passwordInput, '12345678')
      await userEvent.click(signInButton)

      await vi.waitFor(() => expect(mocks.setUser).toHaveBeenCalledOnce())
      expect(mocks.setUser).toHaveBeenCalledWith(apiUser)
      expect(mocks.setCsrfToken).toHaveBeenCalledWith('csrf-value')
      await vi.waitFor(() =>
        expect(mocks.navigate).toHaveBeenCalledWith({ to: '/', replace: true })
      )
    })
  })

  it('navigates to redirectTo when provided', async () => {
    vi.clearAllMocks()
    mocks.post.mockResolvedValue({ data: apiUser })
    const screen = await render(<UserAuthForm redirectTo='/settings' />)
    await userEvent.fill(
      screen.getByRole('textbox', { name: /username or email/i }),
      'a@b.com'
    )
    await userEvent.fill(screen.getByLabelText(/^Password$/i), '12345678')
    await userEvent.click(screen.getByRole('button', { name: /Sign in/i }))

    await vi.waitFor(() => expect(mocks.setUser).toHaveBeenCalledOnce())
    expect(mocks.setCsrfToken).toHaveBeenCalledWith('csrf-value')
    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: '/settings',
        replace: true,
      })
    )
  })
})
