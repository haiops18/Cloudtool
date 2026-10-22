import { useMemo } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { CloudDataTable } from '@/components/cloud-data-table'
import { SortableHeader } from '@/components/sortable-header'
import { resizeErrorMessage } from './resize-error-message'

export interface PasswordResult {
  server_id: string
  name?: string
  status: string
  password?: string
  error?: string
  error_detail?: unknown
}

const statusLabels: Record<string, string> = {
  queued: 'Queued',
  processing: 'Processing',
  accepted: 'Accepted',
  completed: 'Success',
  failed: 'Error',
  unconfirmed: 'Unconfirmed',
}

const columns: ColumnDef<PasswordResult>[] = [
  {
    accessorKey: 'name',
    header: ({ column }) => <SortableHeader column={column} title='Server' />,
    cell: ({ row }) => (
      <p
        className='max-w-80 truncate font-medium text-foreground'
        title={row.original.name}
      >
        {row.original.name || '-'}
      </p>
    ),
  },
  {
    accessorKey: 'status',
    header: ({ column }) => <SortableHeader column={column} title='Result' />,
    cell: ({ row }) => {
      const status = row.original.status
      const success = ['accepted', 'completed'].includes(status)
      const failed = status === 'failed'
      const pending = ['processing', 'unconfirmed'].includes(status)
      const Icon =
        status === 'processing'
          ? Loader2
          : success
            ? CheckCircle2
            : failed
              ? XCircle
              : Clock
      return (
        <Badge
          variant='outline'
          className={
            success
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : failed
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : pending
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'bg-muted/30 text-muted-foreground'
          }
        >
          <Icon
            className={
              status === 'processing' ? 'size-3 animate-spin' : 'size-3'
            }
          />
          {statusLabels[status] || status}
        </Badge>
      )
    },
  },
  {
    accessorKey: 'password',
    header: 'New password',
    cell: ({ row }) => (
      <code className='text-xs text-foreground'>
        {row.original.password || '-'}
      </code>
    ),
  },
  {
    id: 'detail',
    header: 'Detail',
    accessorFn: (row) =>
      resizeErrorMessage(row.error_detail ?? row.error, true),
    cell: ({ row }) => {
      const result = row.original
      const message = resizeErrorMessage(
        result.error_detail ?? result.error,
        true
      )
      return (
        <p
          className={`max-w-xl text-xs leading-5 break-words whitespace-pre-wrap ${result.status === 'failed' ? 'text-destructive' : result.status === 'unconfirmed' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
        >
          {message ||
            (result.status === 'completed'
              ? 'Password changed successfully.'
              : result.status === 'accepted'
                ? 'Cloud API accepted the password change.'
                : result.status === 'processing'
                  ? 'Waiting for Cloud API...'
                  : result.status === 'queued'
                    ? 'Waiting to submit.'
                    : '-')}
        </p>
      )
    },
  },
]

export function ServerPasswordResultsTable({
  rows,
}: {
  rows: PasswordResult[]
}) {
  const hasPasswords = rows.some((row) => Boolean(row.password))
  const visibleColumns = useMemo(
    () =>
      hasPasswords
        ? columns
        : columns.filter(
            (column) =>
              !('accessorKey' in column && column.accessorKey === 'password')
          ),
    [hasPasswords]
  )
  return (
    <CloudDataTable
      data={rows}
      columns={visibleColumns}
      getRowId={(row) => row.server_id}
      enableSelection={false}
      entityName='result'
      exportFileName='change-password-results'
      searchPlaceholder='Search server, result or detail...'
    />
  )
}
