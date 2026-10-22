import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'

interface QuotaItem {
  name?: string
  used?: number | string | null
  limit?: number | string | null
}

export function SecurityGroupRuleQuota({
  projectId,
  planned,
  plannedLabel = 'Planned',
  compact = false,
}: {
  projectId: string
  planned: number
  plannedLabel?: string
  compact?: boolean
}) {
  const quota = useQuery({
    queryKey: ['cloud', projectId, 'quotas'],
    enabled: Boolean(projectId),
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<{ items: QuotaItem[] }>('/cloud/quotas', {
          headers: { 'X-Project-Id': projectId }, signal,
        })
      ).data,
    staleTime: 30_000,
    refetchOnMount: 'always',
  })
  const item = quota.data?.items.find((row) =>
    ['securitygrouprules', 'securitygrouprule'].includes(
      (row.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    )
  )
  const used = item?.used == null ? NaN : Number(item.used)
  const limit =
    item?.limit === undefined
      ? NaN
      : item.limit === null
        ? -1
        : Number(item.limit)
  const known = Boolean(
    item &&
    Number.isFinite(used) &&
    used >= 0 &&
    Number.isFinite(limit) &&
    !quota.isError
  )
  const unlimited = known && limit < 0
  const remaining = known && !unlimited ? Math.max(0, limit - used) : null
  const insufficient =
    remaining !== null && (planned > remaining || remaining === 0)
  const pending = quota.isPending
  const Icon = pending
    ? Loader2
    : insufficient || !known
      ? AlertTriangle
      : CheckCircle2
  if (compact) {
    return (
      <div
        role={insufficient ? 'alert' : 'status'}
        className={`flex flex-wrap items-center gap-2 text-xs ${insufficient ? 'text-destructive' : !known && !pending ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
      >
        <Icon
          className={`size-3.5 shrink-0 ${pending ? 'animate-spin' : ''}`}
        />
        <span className='tabular-nums'>
          {pending
            ? 'Checking quota...'
            : !known
              ? 'Rule quota unavailable'
              : `Rules: ${used}/${unlimited ? 'Unlimited' : limit} · Remaining: ${unlimited ? 'Unlimited' : remaining}`}
        </span>
        {planned > 0 && (
          <span className='tabular-nums'>
            {plannedLabel}: {planned}
          </span>
        )}
        {insufficient && (
          <span>
            {planned > (remaining ?? 0)
              ? `Missing ${planned - (remaining ?? 0)} rule(s)`
              : 'No quota remaining'}
          </span>
        )}
        <Button
          type='button'
          variant='ghost'
          size='icon'
          className='size-6 shrink-0'
          aria-label='Refresh rule quota'
          title='Refresh quota'
          disabled={quota.isFetching}
          onClick={() => void quota.refetch()}
        >
          <RefreshCw
            className={`size-3 ${quota.isFetching ? 'animate-spin' : ''}`}
          />
        </Button>
      </div>
    )
  }
  return (
    <div
      role={insufficient ? 'alert' : 'status'}
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border px-3 py-2 text-xs ${insufficient ? 'border-destructive/40 bg-destructive/10 text-destructive' : pending ? 'border-border bg-background text-muted-foreground' : !known ? 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400' : 'border-border bg-background text-foreground'}`}
    >
      <span className='flex items-center gap-1.5 font-medium'>
        <ShieldCheck className='size-4' /> Security Group Rules
      </span>
      {known && (
        <span className='tabular-nums'>
          Used: {used} / {unlimited ? 'Unlimited' : limit} · Remaining:{' '}
          {unlimited ? 'Unlimited' : remaining}
        </span>
      )}
      <span className='tabular-nums'>
        {plannedLabel}: {planned}
      </span>
      <span
        className={`flex items-center gap-1.5 ${known && !insufficient ? 'text-emerald-700 dark:text-emerald-400' : ''}`}
      >
        <Icon className={`size-3.5 ${pending ? 'animate-spin' : ''}`} />
        {pending
          ? 'Checking quota...'
          : !known
            ? 'Quota unavailable; capacity could not be checked.'
            : insufficient
              ? planned > (remaining ?? 0)
                ? `Insufficient quota: ${planned - (remaining ?? 0)} more rule(s) needed.`
                : 'No rule quota remaining.'
              : 'Enough quota'}
      </span>
      <Button
        type='button'
        variant='ghost'
        size='icon'
        className='ml-auto size-7 shrink-0'
        aria-label='Refresh rule quota'
        title='Refresh quota'
        disabled={quota.isFetching}
        onClick={() => void quota.refetch()}
      >
        <RefreshCw
          className={`size-3.5 ${quota.isFetching ? 'animate-spin' : ''}`}
        />
      </Button>
    </div>
  )
}
