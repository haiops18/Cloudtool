import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, ChevronsUpDown, Cloud, Loader2, RefreshCw } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import type { CloudCurrentUser } from '@/features/cloud/types'

type QuotaItem = {
  service_name?: string
  name?: string
  limit?: number | null
  used?: number | null
}

const quotaNumber = (value: unknown) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const initialsFor = (value: string) =>
  value
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

export function NavUser() {
  const { isMobile } = useSidebar()
  const platformUser = useAuthStore((state) => state.auth.user)
  const token = useCloudStore((state) => state.token)
  const project = useCloudStore((state) => state.project)
  const [quotaOpen, setQuotaOpen] = useState(false)
  const [quotaSearch, setQuotaSearch] = useState('')
  const cloudUser = useQuery({
    queryKey: ['cloud', project?.id, 'current-user'],
    enabled: Boolean(token && project),
    queryFn: async () =>
      (await apiClient.get<CloudCurrentUser>('/cloud/current-user')).data,
    staleTime: 5 * 60 * 1000,
  })
  const projectQuotas = useQuery({
    queryKey: ['cloud', project?.id, 'quotas'],
    enabled: quotaOpen && Boolean(token && project),
    queryFn: async () =>
      (await apiClient.get<{ items: QuotaItem[]; total: number }>('/cloud/quotas'))
        .data,
    staleTime: 30_000,
  })

  const platformName = platformUser?.full_name ?? 'Platform user'
  const cloudName =
    cloudUser.data?.username ||
    (cloudUser.isError ? 'Identity unavailable' : 'Cloud user')
  const cloudEmail = cloudUser.data?.email || 'Cloud API identity'
  const initials =
    initialsFor(cloudUser.data?.display_name || cloudName) || 'CU'
  const filteredQuotas = (projectQuotas.data?.items ?? []).filter((quota) => {
    const query = quotaSearch.trim().toLocaleLowerCase()
    return !query || `${quota.name ?? ''} ${quota.service_name ?? ''}`
      .toLocaleLowerCase()
      .includes(query)
  })

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size='lg'
                className='data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground'
              >
                <Avatar className='h-8 w-8 rounded-lg'>
                  <AvatarFallback className='rounded-lg'>
                    {cloudUser.isLoading ? (
                      <Loader2 className='size-4 animate-spin' />
                    ) : (
                      initials
                    )}
                  </AvatarFallback>
                </Avatar>
                <div className='grid min-w-0 flex-1 text-start text-sm leading-tight'>
                  <span className='truncate font-semibold'>{cloudName}</span>
                  <span className='truncate text-xs'>{cloudEmail}</span>
                </div>
                <ChevronsUpDown className='ms-auto size-4' />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className='w-(--radix-dropdown-menu-trigger-width) min-w-80 rounded-lg'
              side={isMobile ? 'bottom' : 'right'}
              align='end'
              sideOffset={4}
            >
              <DropdownMenuLabel className='font-normal'>
                <div className='space-y-2'>
                  <div className='flex items-center justify-between gap-2'>
                    <span className='flex items-center gap-1.5 text-xs font-medium'>
                      <Cloud className='size-3.5' />
                      Cloud API identity
                    </span>
                    <Badge
                      variant={cloudUser.isError ? 'destructive' : 'outline'}
                    >
                      {cloudUser.isLoading
                        ? 'Loading'
                        : cloudUser.isError
                          ? 'Unavailable'
                          : 'Connected'}
                    </Badge>
                  </div>
                  {cloudUser.data ? (
                    <div className='grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 text-xs'>
                      <span className='text-muted-foreground'>Username</span>
                      <span
                        className='truncate font-medium'
                        title={cloudUser.data.username}
                      >
                        {cloudUser.data.username}
                      </span>
                      <span className='text-muted-foreground'>
                        Display name
                      </span>
                      <span
                        className='truncate'
                        title={cloudUser.data.display_name}
                      >
                        {cloudUser.data.display_name || '—'}
                      </span>
                      <span className='text-muted-foreground'>Full name</span>
                      <span className='truncate'>
                        {[cloudUser.data.first_name, cloudUser.data.last_name]
                          .filter(Boolean)
                          .join(' ') || '—'}
                      </span>
                      <span className='text-muted-foreground'>Email</span>
                      <span className='truncate' title={cloudUser.data.email}>
                        {cloudUser.data.email || '—'}
                      </span>
                      <span className='text-muted-foreground'>User ID</span>
                      <span
                        className='truncate font-mono'
                        title={cloudUser.data.id}
                      >
                        {cloudUser.data.id}
                      </span>
                      <span className='text-muted-foreground'>Projects</span>
                      <span>
                        {cloudUser.data.remaining_projects} remaining /{' '}
                        {cloudUser.data.max_projects} max
                      </span>
                      <span className='text-muted-foreground'>Locale</span>
                      <span>
                        {cloudUser.data.locale || '—'} ·{' '}
                        {cloudUser.data.time_zone || '—'}
                      </span>
                      <span className='text-muted-foreground'>
                        Billing bypass
                      </span>
                      <span>
                        {cloudUser.data.bypass_billing ? 'Enabled' : 'Disabled'}
                      </span>
                      <span className='text-muted-foreground'>Project</span>
                      <span className='truncate' title={project?.name}>
                        {project?.name || '—'}
                      </span>
                    </div>
                  ) : (
                    <p className='text-xs text-muted-foreground'>
                      {cloudUser.isError
                        ? 'Check the Authorization value and selected project.'
                        : 'Loading the Cloud identity…'}
                    </p>
                  )}
                </div>
              </DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  cloudUser.refetch()
                }}
              >
                <RefreshCw />
                Refresh Cloud identity
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!token || !project}
                onSelect={(event) => {
                  event.preventDefault()
                  setQuotaOpen(true)
                }}
              >
                <BarChart3 />
                View project quota
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className='font-normal'>
                <p className='text-xs text-muted-foreground'>
                  CloudTool account
                </p>
                <p className='mt-1 truncate text-sm font-medium'>
                  {platformName}
                </p>
                <p className='truncate text-xs text-muted-foreground'>
                  {platformUser?.email ?? ''}
                </p>
              </DropdownMenuLabel>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <Dialog open={quotaOpen} onOpenChange={setQuotaOpen}>
        <DialogContent className='max-h-[85vh] overflow-hidden sm:max-w-3xl'>
          <DialogHeader>
            <DialogTitle>Project quota</DialogTitle>
            <DialogDescription>
              {project?.name || project?.id || 'Active project'} · used capacity and remaining limit.
            </DialogDescription>
            <Input
              value={quotaSearch}
              onChange={(event) => setQuotaSearch(event.target.value)}
              placeholder='Search quota or cloud service...'
              className='mt-2 h-8 text-xs'
            />
          </DialogHeader>
          <div className='max-h-[62vh] overflow-auto pr-1'>
            {projectQuotas.isLoading ? (
              <div className='flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground'>
                <Loader2 className='size-4 animate-spin' /> Loading project quota…
              </div>
            ) : projectQuotas.isError ? (
              <p className='rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive'>
                Unable to load quota from Cloud API. Please try again.
              </p>
            ) : (
              <div className='min-w-[42rem] space-y-1.5'>
                <div className='grid grid-cols-[2.5rem_minmax(15rem,1fr)_11rem_8rem_7rem] gap-3 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
                  <span>#</span>
                  <span>Quota</span>
                  <span>Usage</span>
                  <span className='text-right'>Used / limit</span>
                  <span className='text-right'>Remaining</span>
                </div>
                {filteredQuotas.map((quota, index) => {
                  const used = quotaNumber(quota.used)
                  const rawLimit = quota.limit == null ? null : quotaNumber(quota.limit)
                  const limited = rawLimit != null && rawLimit >= 0
                  const percent = limited && rawLimit > 0
                    ? Math.min(100, Math.round((used / rawLimit) * 100))
                    : 0
                  const tone = percent >= 100
                    ? 'bg-destructive'
                    : percent >= 80
                      ? 'bg-amber-500'
                      : 'bg-emerald-500'
                  return (
                    <div key={`${quota.service_name}-${quota.name}-${index}`} className='grid grid-cols-[2.5rem_minmax(15rem,1fr)_11rem_8rem_7rem] items-center gap-3 rounded-md border px-3 py-2 text-xs'>
                      <span className='tabular-nums text-muted-foreground'>{index + 1}</span>
                      <div className='min-w-0 truncate' title={`${quota.service_name || 'Cloud service'} · ${quota.name || 'Unnamed quota'}`}>
                        <span className='font-medium'>{quota.name || 'Unnamed quota'}</span>
                        <span className='text-muted-foreground'> · {quota.service_name || 'Cloud service'}</span>
                      </div>
                      {limited ? (
                        <div className='flex items-center gap-2'>
                          <div className='h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted'>
                            <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${percent}%` }} />
                          </div>
                          <span className={percent >= 100 ? 'w-8 text-right font-medium text-destructive' : 'w-8 text-right text-muted-foreground'}>{percent}%</span>
                        </div>
                      ) : (
                        <span className='text-muted-foreground'>Unlimited</span>
                      )}
                      <span className='text-right tabular-nums'>
                        <span className={percent >= 100 ? 'font-medium text-destructive' : ''}>{used}</span>
                        <span className='text-muted-foreground'> / {limited ? rawLimit : '—'}</span>
                      </span>
                      <span className='text-right tabular-nums text-muted-foreground'>
                        {limited ? `${Math.max(0, rawLimit - used)} left` : 'No limit'}
                      </span>
                    </div>
                  )
                })}
                {!filteredQuotas.length && (
                  <p className='py-8 text-center text-sm text-muted-foreground'>No quota rows returned for this project.</p>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
