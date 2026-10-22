import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/confirm-dialog'

type TeleportLink = {
  id: string
  name: string
  url: string
  verify_tls: boolean
  tsh_path: string
}

type TshVersion = { path: string; version: string }

type LinkForm = Omit<TeleportLink, 'id'>

const emptyLink: LinkForm = {
  name: '',
  url: '',
  verify_tls: true,
  tsh_path: '',
}

function errorMessage(error: unknown, fallback: string) {
  const response = (error as { response?: { data?: unknown } }).response?.data
  if (response && typeof response === 'object') {
    const payload = response as {
      detail?: unknown
      message?: unknown
      error?: { message?: unknown }
    }
    const message = [
      payload.detail,
      payload.message,
      payload.error?.message,
    ].find(
      (value): value is string =>
        typeof value === 'string' && Boolean(value.trim())
    )
    if (message) return message
  }
  return error instanceof Error && error.message ? error.message : fallback
}

export function TeleportLoginDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [credentials, setCredentials] = useState({
    username: '',
    password: '',
    otp: '',
  })
  const [signingIn, setSigningIn] = useState(false)
  const [signingInTsh, setSigningInTsh] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingLink, setEditingLink] = useState<TeleportLink | undefined>()
  const [linkForm, setLinkForm] = useState<LinkForm>(emptyLink)
  const [savingLink, setSavingLink] = useState(false)
  const [deletingLink, setDeletingLink] = useState<TeleportLink | undefined>()
  const [deleting, setDeleting] = useState(false)

  const links = useQuery({
    queryKey: ['teleport-links'],
    enabled: open,
    queryFn: async () =>
      (await apiClient.get<TeleportLink[]>('/teleport-links')).data,
  })
  const tshVersions = useQuery({
    queryKey: ['teleport-tsh-versions'],
    enabled: editorOpen,
    queryFn: async () =>
      (await apiClient.get<TshVersion[]>('/teleport-links/tsh/versions')).data,
  })
  const selectedLink = links.data?.find((link) => link.id === selectedId)
  const session = useQuery({
    queryKey: ['teleport-links', selectedId, 'session'],
    enabled: open && Boolean(selectedId),
    queryFn: async () =>
      (
        await apiClient.get<{ active: boolean }>(
          `/teleport-links/${selectedId}/session`
        )
      ).data,
  })
  const tshSession = useQuery({
    queryKey: ['teleport-links', selectedId, 'tsh-session'],
    enabled: open && Boolean(selectedId),
    retry: false,
    queryFn: async () =>
      (
        await apiClient.get<{ active: boolean }>(
          `/teleport-links/${selectedId}/tsh/session`
        )
      ).data,
  })
  const filteredLinks = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    if (!needle) return links.data ?? []
    return (links.data ?? []).filter((link) =>
      `${link.name} ${link.url}`.toLocaleLowerCase().includes(needle)
    )
  }, [links.data, search])

  useEffect(() => {
    const available = links.data ?? []
    if (selectedId && available.some((link) => link.id === selectedId)) return
    setSelectedId(available[0]?.id ?? '')
  }, [links.data, selectedId])

  const refreshLinks = async () => {
    await queryClient.invalidateQueries({ queryKey: ['teleport-links'] })
  }
  const openCreate = () => {
    setEditingLink(undefined)
    setLinkForm(emptyLink)
    setEditorOpen(true)
  }
  const openEdit = (link: TeleportLink) => {
    setEditingLink(link)
    setLinkForm({
      name: link.name,
      url: link.url,
      verify_tls: link.verify_tls,
      tsh_path: link.tsh_path ?? '',
    })
    setEditorOpen(true)
  }
  const saveLink = async () => {
    if (!linkForm.name.trim() || !linkForm.url.trim()) {
      toast.error('Endpoint name and HTTPS URL are required.')
      return
    }
    setSavingLink(true)
    try {
      const payload = {
        ...linkForm,
        name: linkForm.name.trim(),
        url: linkForm.url.trim(),
      }
      const response = editingLink
        ? await apiClient.patch<TeleportLink>(
            `/teleport-links/${editingLink.id}`,
            payload
          )
        : await apiClient.post<TeleportLink>('/teleport-links', payload)
      await refreshLinks()
      setSelectedId(response.data.id)
      setEditorOpen(false)
      toast.success(
        editingLink ? 'Teleport endpoint updated.' : 'Teleport endpoint added.'
      )
    } catch (error) {
      toast.error(errorMessage(error, 'Could not save the Teleport endpoint.'))
    } finally {
      setSavingLink(false)
    }
  }
  const deleteLink = async () => {
    if (!deletingLink) return
    setDeleting(true)
    try {
      await apiClient.delete(`/teleport-links/${deletingLink.id}`)
      if (selectedId === deletingLink.id) setSelectedId('')
      setDeletingLink(undefined)
      await refreshLinks()
      toast.success('Teleport endpoint deleted.')
    } catch (error) {
      toast.error(
        errorMessage(error, 'Could not delete the Teleport endpoint.')
      )
    } finally {
      setDeleting(false)
    }
  }
  const signIn = async () => {
    if (
      !selectedId ||
      !credentials.username ||
      !credentials.password ||
      credentials.otp.length < 6
    )
      return
    setSigningIn(true)
    try {
      await apiClient.post(`/teleport-links/${selectedId}/check`, {
        ...credentials,
        server_ips: {},
      })
      setCredentials({ username: '', password: '', otp: '' })
      await queryClient.invalidateQueries({
        queryKey: ['teleport-links', selectedId, 'session'],
      })
      toast.success('Teleport session is active.')
    } catch (error) {
      toast.error(errorMessage(error, 'Could not authenticate with Teleport.'))
    } finally {
      setSigningIn(false)
    }
  }
  const signInTsh = async () => {
    if (
      !selectedId ||
      !credentials.username ||
      !credentials.password ||
      credentials.otp.length < 6
    )
      return
    setSigningInTsh(true)
    try {
      await apiClient.post(
        `/teleport-links/${selectedId}/tsh/login`,
        credentials
      )
      setCredentials({ username: '', password: '', otp: '' })
      await queryClient.invalidateQueries({
        queryKey: ['teleport-links', selectedId, 'tsh-session'],
      })
      await queryClient.invalidateQueries({
        queryKey: ['teleport-links', 'tsh-sessions'],
      })
      toast.success('tsh login succeeded. The backend is ready for tsh ssh.')
    } catch (error) {
      toast.error(errorMessage(error, 'Could not log in with tsh.'))
    } finally {
      setSigningInTsh(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className='grid h-[min(42rem,90svh)] w-[calc(100vw-2rem)] max-w-6xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:!max-w-6xl'>
          <DialogHeader>
            <DialogTitle>Login Teleport</DialogTitle>
            <DialogDescription>
              Manage your Teleport endpoints and create a session. Credentials
              and OTP are never saved.
            </DialogDescription>
          </DialogHeader>
          <div className='grid min-h-0 gap-4 md:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.2fr)]'>
            <section className='flex min-h-0 flex-col rounded-lg border'>
              <div className='flex items-center gap-2 border-b p-3'>
                <div className='relative min-w-0 flex-1'>
                  <Search className='absolute start-2.5 top-2.5 size-4 text-muted-foreground' />
                  <Input
                    className='ps-8'
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder='Search endpoints...'
                    value={search}
                  />
                </div>
                <Button
                  aria-label='Add Teleport endpoint'
                  onClick={openCreate}
                  size='icon'
                  title='Add endpoint'
                  type='button'
                >
                  <Plus />
                </Button>
              </div>
              <div className='min-h-0 flex-1 overflow-y-auto p-2'>
                {links.isLoading ? (
                  <div className='flex h-28 items-center justify-center text-sm text-muted-foreground'>
                    <Loader2 className='mr-2 size-4 animate-spin' /> Loading
                    endpoints...
                  </div>
                ) : filteredLinks.length ? (
                  filteredLinks.map((link) => (
                    <div
                      className={cn(
                        'group flex items-center gap-1 rounded-md p-1',
                        selectedId === link.id && 'bg-accent'
                      )}
                      key={link.id}
                    >
                      <button
                        className='min-w-0 flex-1 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring'
                        onClick={() => {
                          setSelectedId(link.id)
                          setCredentials({
                            username: '',
                            password: '',
                            otp: '',
                          })
                        }}
                        type='button'
                      >
                        <p className='truncate text-sm font-medium'>
                          {link.name}
                        </p>
                        <p className='truncate text-xs text-muted-foreground'>
                          {link.url}
                        </p>
                      </button>
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            aria-label={`Actions for ${link.name}`}
                            className='size-8 opacity-70 group-hover:opacity-100'
                            size='icon'
                            type='button'
                            variant='ghost'
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end'>
                          <DropdownMenuItem onClick={() => openEdit(link)}>
                            <Pencil /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant='destructive'
                            onClick={() => setDeletingLink(link)}
                          >
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))
                ) : (
                  <div className='flex h-28 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground'>
                    <span>
                      {search
                        ? 'No endpoints match your search.'
                        : 'No Teleport endpoints yet.'}
                    </span>
                    {!search && (
                      <Button onClick={openCreate} size='sm' type='button'>
                        <Plus /> Add endpoint
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </section>
            <section className='min-h-0 rounded-lg border p-4'>
              {selectedLink ? (
                <div className='flex h-full flex-col gap-4'>
                  <div className='flex items-start justify-between gap-3 border-b pb-3'>
                    <div className='min-w-0'>
                      <h3 className='truncate font-semibold'>
                        {selectedLink.name}
                      </h3>
                      <p className='truncate text-sm text-muted-foreground'>
                        {selectedLink.url}
                      </p>
                    </div>
                    {session.isLoading || tshSession.isLoading ? (
                      <Loader2 className='size-4 animate-spin text-muted-foreground' />
                    ) : (
                      <div className='flex shrink-0 flex-col items-end gap-1 text-xs'>
                        {session.data?.active ? (
                          <span className='inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400'>
                            <CheckCircle2 className='size-4' /> Web active
                          </span>
                        ) : (
                          <span className='inline-flex items-center gap-1 text-muted-foreground'>
                            <ShieldCheck className='size-4' /> Web sign in
                            required
                          </span>
                        )}
                        {tshSession.data?.active && (
                          <span className='inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400'>
                            <CheckCircle2 className='size-4' /> tsh ready
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className='grid gap-3'>
                    <div className='space-y-1.5'>
                      <Label htmlFor='teleport-username'>Username</Label>
                      <Input
                        autoComplete='username'
                        id='teleport-username'
                        onChange={(event) =>
                          setCredentials((current) => ({
                            ...current,
                            username: event.target.value,
                          }))
                        }
                        value={credentials.username}
                      />
                    </div>
                    <div className='space-y-1.5'>
                      <Label htmlFor='teleport-password'>Password</Label>
                      <Input
                        autoComplete='current-password'
                        id='teleport-password'
                        onChange={(event) =>
                          setCredentials((current) => ({
                            ...current,
                            password: event.target.value,
                          }))
                        }
                        type='password'
                        value={credentials.password}
                      />
                    </div>
                    <div className='space-y-1.5'>
                      <Label htmlFor='teleport-otp'>
                        Google Authenticator code
                      </Label>
                      <Input
                        id='teleport-otp'
                        inputMode='numeric'
                        maxLength={12}
                        onChange={(event) =>
                          setCredentials((current) => ({
                            ...current,
                            otp: event.target.value.replace(/\D/g, ''),
                          }))
                        }
                        placeholder='6-digit code'
                        value={credentials.otp}
                      />
                    </div>
                  </div>
                  <div className='mt-auto grid gap-2 sm:grid-cols-2'>
                    <Button
                      disabled={
                        !credentials.username ||
                        !credentials.password ||
                        credentials.otp.length < 6 ||
                        signingIn ||
                        signingInTsh
                      }
                      onClick={() => void signIn()}
                      type='button'
                      variant='outline'
                    >
                      {signingIn && <Loader2 className='animate-spin' />}{' '}
                      {session.data?.active
                        ? 'Sign in web again'
                        : 'Sign in web'}
                    </Button>
                    <Button
                      disabled={
                        !credentials.username ||
                        !credentials.password ||
                        credentials.otp.length < 6 ||
                        signingIn ||
                        signingInTsh
                      }
                      onClick={() => void signInTsh()}
                      type='button'
                    >
                      {signingInTsh && <Loader2 className='animate-spin' />}{' '}
                      Login tsh
                    </Button>
                  </div>
                </div>
              ) : (
                <div className='flex h-full items-center justify-center text-center text-sm text-muted-foreground'>
                  Select an endpoint to sign in, or add a new endpoint.
                </div>
              )}
            </section>
          </div>
          <DialogFooter>
            <Button
              onClick={() => onOpenChange(false)}
              type='button'
              variant='outline'
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className='sm:!max-w-sm'>
          <DialogHeader>
            <DialogTitle>
              {editingLink ? 'Edit Teleport endpoint' : 'Add Teleport endpoint'}
            </DialogTitle>
            <DialogDescription>
              Only HTTPS endpoints are accepted.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4'>
            <div className='space-y-1.5'>
              <Label htmlFor='teleport-link-name'>Endpoint name</Label>
              <Input
                id='teleport-link-name'
                onChange={(event) =>
                  setLinkForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder='Production Teleport'
                value={linkForm.name}
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='teleport-link-url'>HTTPS URL</Label>
              <Input
                id='teleport-link-url'
                onChange={(event) =>
                  setLinkForm((current) => ({
                    ...current,
                    url: event.target.value,
                  }))
                }
                placeholder='https://teleport.example'
                value={linkForm.url}
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='teleport-link-tsh'>tsh version</Label>
              <select
                className='h-9 w-full rounded-md border bg-background px-2 text-sm'
                disabled={tshVersions.isLoading}
                id='teleport-link-tsh'
                onChange={(event) =>
                  setLinkForm((current) => ({
                    ...current,
                    tsh_path: event.target.value,
                  }))
                }
                value={linkForm.tsh_path}
              >
                <option value=''>Default tsh version</option>
                {(tshVersions.data ?? []).map((item) => (
                  <option key={item.path} value={item.path}>
                    tsh {item.version} — {item.path}
                  </option>
                ))}
              </select>
              <p className='text-xs text-muted-foreground'>
                Only tsh versions installed on the backend host can be selected.
              </p>
            </div>
            <label className='flex items-start gap-2 text-sm'>
              <Checkbox
                checked={linkForm.verify_tls}
                onCheckedChange={(value) =>
                  setLinkForm((current) => ({
                    ...current,
                    verify_tls: value === true,
                  }))
                }
              />{' '}
              <span>
                Verify TLS certificate{' '}
                <span className='text-xs text-muted-foreground'>
                  (turn off only for a test or self-signed endpoint)
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button
              disabled={savingLink}
              onClick={() => setEditorOpen(false)}
              type='button'
              variant='outline'
            >
              Cancel
            </Button>
            <Button
              disabled={savingLink}
              onClick={() => void saveLink()}
              type='button'
            >
              {savingLink && <Loader2 className='animate-spin' />}
              {editingLink ? 'Save changes' : 'Add endpoint'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        cancelBtnText='Cancel'
        confirmText='Delete endpoint'
        desc={`Delete ${deletingLink?.name ?? 'this Teleport endpoint'}? Its stored session will also be removed.`}
        destructive
        handleConfirm={() => void deleteLink()}
        isLoading={deleting}
        onOpenChange={(next) =>
          !next && !deleting && setDeletingLink(undefined)
        }
        open={Boolean(deletingLink)}
        title='Delete Teleport endpoint?'
      />
    </>
  )
}
