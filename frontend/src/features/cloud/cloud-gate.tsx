import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  History,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient, setCsrfToken } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SegmentedTabs } from '@/components/segmented-tabs'

type SavedAuthorization = {
  id: string
  name: string
  last_project_name?: string | null
  last_project_id?: string | null
}

type LoginHistory = {
  id: string
  authorization_id: string | null
  name: string
  project_name: string | null
  logged_in_at: string
  kind: 'saved' | 'session'
}

const loginDateFormat = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'Asia/Bangkok',
})

export function CloudGate({ children }: { children: React.ReactNode }) {
  const token = useCloudStore((state) => state.token)
  const [restoring, setRestoring] = useState(!token)
  const [restoreError, setRestoreError] = useState(false)
  useQuery({
    queryKey: ['web-session-heartbeat'],
    queryFn: async ({ signal }) => {
      const { data } = await apiClient.get('/auth/me', { signal })
      setCsrfToken(data.csrf_token)
      return true
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  })
  const [authorization, setAuthorization] = useState('')
  const [scheme, setScheme] = useState<'token' | 'bearer' | 'custom'>('token')
  const [loading, setLoading] = useState(false)
  const [saved, setSaved] = useState<SavedAuthorization[]>([])
  const [selectedSavedId, setSelectedSavedId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'saved' | 'paste' | 'history'>(
    'saved'
  )
  const [history, setHistory] = useState<LoginHistory[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [addSavedOpen, setAddSavedOpen] = useState(false)
  const [savedAuthorization, setSavedAuthorization] = useState('')
  const [savedScheme, setSavedScheme] = useState<'token' | 'bearer' | 'custom'>(
    'token'
  )
  const [savedName, setSavedName] = useState('')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<SavedAuthorization | null>(null)
  const [editName, setEditName] = useState('')
  const [deleteItem, setDeleteItem] = useState<SavedAuthorization | null>(null)

  const loadSaved = async () => {
    const { data } = await apiClient.get('/cloud-authorizations')
    setSaved(data.items ?? [])
    if (data.has_session_authorization) {
      useCloudStore.getState().setToken('__server_session__')
      if (data.active_project_id)
        useCloudStore.getState().setProject({
          id: data.active_project_id,
          name: data.active_project_name || data.active_project_id,
        })
    }
  }
  useEffect(() => {
    if (!token) {
      void Promise.resolve()
        .then(loadSaved)
        .catch(() => setRestoreError(true))
        .finally(() => setRestoring(false))
    }
  }, [token])
  const loadHistory = async (offset = 0) => {
    setHistoryLoading(true)
    setHistoryError(false)
    try {
      const { data } = await apiClient.get('/cloud-authorizations/history', {
        params: { offset, limit: 50 },
      })
      setHistory((previous) =>
        offset ? [...previous, ...data.items] : data.items
      )
      setHistoryHasMore(data.has_more)
    } catch {
      setHistoryError(true)
    } finally {
      setHistoryLoading(false)
    }
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q
      ? saved.filter((item) =>
          `${item.name} ${item.last_project_name ?? ''}`
            .toLowerCase()
            .includes(q)
        )
      : saved
  }, [saved, search])
  const selectedSaved =
    saved.find((item) => item.id === selectedSavedId) ?? null
  const activate = async (item: SavedAuthorization) => {
    setLoading(true)
    try {
      const { data } = await apiClient.post(
        `/cloud-authorizations/${item.id}/activate`
      )
      useCloudStore.getState().setToken('__server_session__')
      if (data.last_project_id)
        useCloudStore.getState().setProject({
          id: data.last_project_id,
          name: data.last_project_name || data.last_project_id,
        })
      setActiveTab('saved')
      toast.success(`Using ${item.name}.`)
    } catch {
      toast.error('Unable to activate this Cloud Authorization.')
    } finally {
      setLoading(false)
    }
  }
  const connect = async () => {
    setLoading(true)
    try {
      await apiClient.post('/cloud-authorizations/activate', {
        authorization,
        scheme,
        save: false,
      })
      useCloudStore.getState().setToken('__server_session__')
      setAuthorization('')
      toast.success('Cloud Authorization connected for this session.')
    } catch {
      toast.error(
        'Unable to connect Cloud Authorization. Check the value and try again.'
      )
    } finally {
      setLoading(false)
    }
  }
  const createSaved = async () => {
    setLoading(true)
    try {
      await apiClient.post('/cloud-authorizations/activate', {
        authorization: savedAuthorization,
        scheme: savedScheme,
        save: true,
        name: savedName.trim() || undefined,
      })
      setSavedAuthorization('')
      setSavedName('')
      setAddSavedOpen(false)
      await loadSaved()
      toast.success('Saved Cloud Authorization created.')
    } catch {
      toast.error(
        'Unable to save Cloud Authorization. Check the value and try again.'
      )
    } finally {
      setLoading(false)
    }
  }
  if (token) return children
  if (restoreError)
    return (
      <div className='flex min-h-40 items-center justify-center gap-3 text-sm text-muted-foreground'>
        Unable to restore session.
        <Button
          variant='outline'
          onClick={() => {
            setRestoreError(false)
            setRestoring(true)
            void loadSaved()
              .catch(() => setRestoreError(true))
              .finally(() => setRestoring(false))
          }}
        >
          Retry
        </Button>
      </div>
    )
  if (restoring)
    return (
      <div className='flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground'>
        <Loader2 className='size-4 animate-spin' /> Restoring session...
      </div>
    )

  return (
    <>
      <div className='flex h-[var(--interface-viewport-height,100svh)] items-center justify-center overflow-hidden bg-muted/30 p-4'>
        <div className='flex max-h-full w-full max-w-xl flex-col'>
          <Card className='flex max-h-[calc(var(--interface-viewport-height,100svh)-2rem)] w-full max-w-none flex-col gap-0 overflow-hidden border-border/80 py-0 shadow-lg'>
            <CardHeader className='shrink-0 grid-rows-1 border-b bg-muted/25 px-4 py-3'>
              <div className='flex items-center gap-2.5'>
                <div className='grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm'>
                  <KeyRound className='size-4' />
                </div>
                <CardTitle className='min-w-0 flex-1 self-center'>
                  Connect Cloud Authorization
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className='flex min-h-0 flex-col gap-3 overflow-y-auto p-4'>
              <SegmentedTabs
                value={activeTab}
                onValueChange={(value) => {
                  setActiveTab(value as 'saved' | 'paste' | 'history')
                  if (value === 'history') void loadHistory()
                }}
                tabs={[
                  {
                    value: 'saved',
                    label: `Saved (${saved.length})`,
                  },
                  { value: 'paste', label: 'Paste token' },
                  { value: 'history', label: 'Login history' },
                ]}
                className='h-10 shrink-0 text-sm'
              />
              {activeTab === 'history' && (
                <div className='flex min-h-0 flex-col rounded-lg border bg-muted/20 p-3'>
                  <div className='mb-3 flex shrink-0 items-center gap-2'>
                    <History className='size-4 text-muted-foreground' />
                    <div>
                      <p className='font-semibold'>Cloud login history</p>
                      <p className='text-xs text-muted-foreground'>
                        Most recent first · Timezone GMT+7
                      </p>
                    </div>
                  </div>
                  <div className='min-h-0 space-y-1.5 overflow-y-auto overscroll-contain pr-1'>
                    {history.map((item, index) => (
                      <div
                        key={item.id}
                        className='flex items-center gap-3 rounded-md border bg-background px-3 py-2'
                      >
                        <span className='w-6 shrink-0 text-center text-xs text-muted-foreground tabular-nums'>
                          {index + 1}
                        </span>
                        <div className='min-w-0 flex-1'>
                          <p className='truncate text-sm font-medium'>
                            {item.name}
                          </p>
                          {item.project_name && (
                            <p className='truncate text-xs text-muted-foreground'>
                              {item.project_name}
                            </p>
                          )}
                          <time
                            dateTime={item.logged_in_at}
                            className='text-xs text-muted-foreground tabular-nums'
                          >
                            {loginDateFormat.format(
                              new Date(item.logged_in_at)
                            )}
                          </time>
                        </div>
                        {item.authorization_id &&
                        saved.some(
                          (savedItem) => savedItem.id === item.authorization_id
                        ) ? (
                          <Button
                            size='sm'
                            variant='outline'
                            onClick={() => {
                              setSelectedSavedId(item.authorization_id)
                              setSearch('')
                              setActiveTab('saved')
                            }}
                          >
                            Select
                          </Button>
                        ) : (
                          <span className='shrink-0 text-xs text-muted-foreground'>
                            {item.kind === 'session'
                              ? 'Session only'
                              : 'Deleted'}
                          </span>
                        )}
                      </div>
                    ))}
                    {!historyLoading &&
                      !historyError &&
                      history.length === 0 && (
                        <p className='rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground'>
                          No Cloud login history yet.
                        </p>
                      )}
                    {historyError && (
                      <div className='space-y-2 py-3 text-center text-sm'>
                        <p className='text-muted-foreground'>
                          Unable to load login history.
                        </p>
                        <Button
                          size='sm'
                          variant='outline'
                          onClick={() => void loadHistory(history.length)}
                        >
                          Try again
                        </Button>
                      </div>
                    )}
                    {historyLoading && (
                      <div className='flex justify-center py-4'>
                        <Loader2
                          className='size-5 animate-spin'
                          aria-label='Loading login history'
                        />
                      </div>
                    )}
                    {!historyLoading && !historyError && historyHasMore && (
                      <Button
                        className='w-full'
                        variant='ghost'
                        size='sm'
                        onClick={() => void loadHistory(history.length)}
                      >
                        Load older logins
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {activeTab === 'paste' && (
                <>
                  <div className='space-y-2'>
                    <p className='text-sm font-medium'>Authorization type</p>
                    <div className='inline-flex rounded-lg border bg-muted/40 p-1'>
                      {(['token', 'bearer', 'custom'] as const).map((item) => (
                        <Button
                          key={item}
                          type='button'
                          size='sm'
                          variant={scheme === item ? 'secondary' : 'ghost'}
                          className='h-7 px-3 text-xs'
                          onClick={() => setScheme(item)}
                        >
                          {item === 'token'
                            ? 'Token (PAT)'
                            : item === 'bearer'
                              ? 'Bearer'
                              : 'Custom'}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className='space-y-2'>
                    <p className='text-sm font-medium'>Cloud Authorization</p>
                    <Input
                      type='password'
                      autoComplete='off'
                      value={authorization}
                      onChange={(event) => setAuthorization(event.target.value)}
                      placeholder={
                        scheme === 'custom'
                          ? 'Complete Authorization header value'
                          : 'Paste token value'
                      }
                    />
                    <p className='text-xs text-muted-foreground'>
                      The token is never displayed again.{' '}
                      {scheme === 'custom'
                        ? 'Custom is sent exactly as entered.'
                        : `${scheme === 'token' ? 'Token' : 'Bearer'} is added automatically.`}
                    </p>
                  </div>
                </>
              )}

              {activeTab === 'saved' && (
                <div className='flex min-h-0 flex-col rounded-lg border bg-muted/20 p-3'>
                  <div className='mb-3 shrink-0'>
                    <p className='font-semibold'>Saved Cloud Authorizations</p>
                  </div>
                  {addSavedOpen && (
                    <div className='mb-3 shrink-0 space-y-3 rounded-md border bg-muted/20 p-3'>
                      <div className='flex gap-1'>
                        {(['token', 'bearer', 'custom'] as const).map(
                          (item) => (
                            <Button
                              key={item}
                              type='button'
                              size='sm'
                              variant={
                                savedScheme === item ? 'secondary' : 'ghost'
                              }
                              onClick={() => setSavedScheme(item)}
                            >
                              {item === 'token'
                                ? 'Token (PAT)'
                                : item === 'bearer'
                                  ? 'Bearer'
                                  : 'Custom'}
                            </Button>
                          )
                        )}
                      </div>
                      <Input
                        type='password'
                        autoComplete='off'
                        value={savedAuthorization}
                        onChange={(event) =>
                          setSavedAuthorization(event.target.value)
                        }
                        placeholder='Cloud Authorization value'
                      />
                      <Input
                        value={savedName}
                        onChange={(event) => setSavedName(event.target.value)}
                        placeholder='Saved name — optional'
                      />
                      <div className='flex justify-end'>
                        <Button
                          size='sm'
                          disabled={!savedAuthorization.trim() || loading}
                          onClick={() => void createSaved()}
                        >
                          {loading && <Loader2 className='animate-spin' />} Save
                          authorization
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className='mb-2 flex shrink-0 gap-2'>
                    <div className='relative min-w-0 flex-1'>
                      <Search className='pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                      <Input
                        className='pl-9'
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder='Search saved authorizations or projects'
                      />
                    </div>
                    <Button
                      size='icon'
                      variant={addSavedOpen ? 'secondary' : 'default'}
                      aria-label={
                        addSavedOpen
                          ? 'Close add authorization'
                          : 'Add saved authorization'
                      }
                      onClick={() => setAddSavedOpen((value) => !value)}
                    >
                      {addSavedOpen ? <X /> : <Plus />}
                    </Button>
                  </div>
                  <div className='min-h-0 space-y-1.5 overflow-y-auto overscroll-contain pr-1'>
                    {visible.length === 0 ? (
                      <p className='rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground'>
                        No saved Cloud Authorization found.
                      </p>
                    ) : (
                      visible.map((item) => (
                        <div
                          key={item.id}
                          className={`flex min-h-12 cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 transition-colors ${selectedSavedId === item.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}
                          role='button'
                          tabIndex={0}
                          onClick={() => setSelectedSavedId(item.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              setSelectedSavedId(item.id)
                            }
                          }}
                        >
                          <div className='grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary'>
                            <KeyRound className='size-4' />
                          </div>
                          <div className='min-w-0 flex-1'>
                            {editing?.id === item.id ? (
                              <Input
                                autoFocus
                                value={editName}
                                onChange={(event) =>
                                  setEditName(event.target.value)
                                }
                              />
                            ) : (
                              <p className='truncate text-sm font-medium'>
                                {item.name}
                              </p>
                            )}
                            <p className='truncate text-xs text-muted-foreground'>
                              {item.last_project_name || 'No recent project'}
                            </p>
                          </div>
                          {editing?.id === item.id ? (
                            <>
                              <Button
                                size='sm'
                                disabled={!editName.trim() || loading}
                                onClick={async () => {
                                  try {
                                    await apiClient.patch(
                                      `/cloud-authorizations/${item.id}`,
                                      { name: editName.trim() }
                                    )
                                    setEditing(null)
                                    await loadSaved()
                                    toast.success('Saved name updated.')
                                  } catch {
                                    toast.error('Unable to update saved name.')
                                  }
                                }}
                              >
                                Save
                              </Button>
                              <Button
                                size='icon'
                                className='size-7'
                                variant='ghost'
                                onClick={() => setEditing(null)}
                              >
                                <X />
                              </Button>
                            </>
                          ) : (
                            <>
                              <div className='ml-auto'>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      size='icon'
                                      className='size-8'
                                      variant='ghost'
                                      aria-label={`Actions for ${item.name}`}
                                    >
                                      <MoreHorizontal />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align='end'>
                                    <DropdownMenuItem
                                      onClick={() => {
                                        setEditing(item)
                                        setEditName(item.name)
                                      }}
                                    >
                                      <Pencil /> Rename
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      className='text-destructive focus:text-destructive'
                                      onClick={() => setDeleteItem(item)}
                                    >
                                      <Trash2 /> Delete
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            </>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
              <div className='flex shrink-0 items-center justify-between gap-3 border-t pt-3'>
                <Button
                  variant='ghost'
                  onClick={() => {
                    useAuthStore.getState().auth.reset()
                    window.location.assign('/sign-in')
                  }}
                >
                  Back to login
                </Button>
                {activeTab !== 'history' && (
                  <Button
                    disabled={
                      loading ||
                      (activeTab === 'paste'
                        ? !authorization.trim()
                        : !selectedSaved)
                    }
                    onClick={() =>
                      void (activeTab === 'paste'
                        ? connect()
                        : selectedSaved && activate(selectedSaved))
                    }
                  >
                    {loading ? (
                      <Loader2 className='animate-spin' />
                    ) : (
                      <ShieldCheck />
                    )}{' '}
                    Connect Cloud
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
      <ConfirmDialog
        open={Boolean(deleteItem)}
        onOpenChange={(open) => !open && setDeleteItem(null)}
        title={`Delete ${deleteItem?.name ?? 'saved authorization'}?`}
        desc='The encrypted saved value will be permanently removed. This does not affect any current Cloud session.'
        confirmText='Delete'
        destructive
        handleConfirm={async () => {
          if (!deleteItem) return
          try {
            await apiClient.delete(`/cloud-authorizations/${deleteItem.id}`)
            setDeleteItem(null)
            await loadSaved()
            toast.success('Saved Cloud Authorization deleted.')
          } catch {
            toast.error('Unable to delete saved Cloud Authorization.')
          }
        }}
      />
    </>
  )
}
