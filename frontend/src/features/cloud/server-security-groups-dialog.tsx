import { useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Loader2, Plus, RefreshCw, ShieldCheck } from 'lucide-react'
import { apiClient } from '@/lib/api-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { CloudDataTable } from '@/components/cloud-data-table'
import { SearchableSelect } from '@/components/searchable-select'
import { SortableHeader } from '@/components/sortable-header'
import { ServerSecurityRuleCreateDialog } from './server-security-rule-create-dialog'

export type SecurityGroupOption = {
  id: string
  name: string
  display_name?: string
  description?: string
}
export type ServerSecurityRule = {
  id: string
  direction: 'ingress' | 'egress'
  protocol: string
  port_range_min?: number | null
  port_range_max?: number | null
  remote_ip_prefix?: string
  ethertype?: string
  description?: string
  delete_at?: string | null
  security_group?:
    string | { id?: string; name?: string; display_name?: string }
}
type Direction = 'all' | 'ingress' | 'egress'
const groupId = (value: ServerSecurityRule['security_group']) =>
  typeof value === 'string' ? value : (value?.id ?? '')

export function ServerSecurityGroupsContent({
  serverId,
  serverName,
  projectName,
  groups,
  rules,
  group,
  direction,
  onGroupChange,
  onDirectionChange,
  loading,
  rulesLoading,
  error,
  onRefresh,
  refreshing,
  actions,
  toolbar,
}: {
  serverId: string
  serverName: string
  projectName?: string
  groups: SecurityGroupOption[]
  rules: ServerSecurityRule[]
  group: string
  direction: Direction
  onGroupChange: (value: string) => void
  onDirectionChange: (value: Direction) => void
  loading: boolean
  rulesLoading: boolean
  error: boolean
  onRefresh: () => void
  refreshing?: boolean
  actions?: ReactNode
  toolbar?: (selected: ServerSecurityRule[]) => ReactNode
}) {
  const columns = useMemo<ColumnDef<ServerSecurityRule>[]>(
    () => [
      {
        accessorKey: 'direction',
        header: ({ column }) => (
          <SortableHeader column={column} title='Direction' />
        ),
        cell: ({ getValue }) => (
          <Badge variant={getValue() === 'ingress' ? 'default' : 'secondary'}>
            {getValue() === 'ingress' ? 'Inbound' : 'Outbound'}
          </Badge>
        ),
      },
      {
        id: 'security_group',
        header: 'Security group',
        accessorFn: (rule) => {
          const id = groupId(rule.security_group)
          const match = groups.find((item) => item.id === id)
          return match?.display_name || match?.name || id
        },
      },
      {
        accessorKey: 'protocol',
        header: ({ column }) => (
          <SortableHeader column={column} title='Protocol' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono uppercase'>
            {String(getValue() || 'Any')}
          </span>
        ),
      },
      {
        id: 'ports',
        header: ({ column }) => <SortableHeader column={column} title='Port' />,
        accessorFn: (rule) =>
          rule.port_range_min == null && rule.port_range_max == null
            ? 'Any'
            : rule.port_range_min === rule.port_range_max
              ? String(rule.port_range_min)
              : `${rule.port_range_min ?? 'Any'}–${rule.port_range_max ?? 'Any'}`,
      },
      {
        accessorKey: 'remote_ip_prefix',
        header: ({ column }) => (
          <SortableHeader column={column} title='Remote IP / CIDR' />
        ),
        cell: ({ getValue }) => (
          <span className='font-mono'>{String(getValue() || 'Any')}</span>
        ),
      },
      { accessorKey: 'ethertype', header: 'IP version' },
      {
        id: 'delete_at',
        accessorFn: (rule) => rule.delete_at || '',
        header: ({ column }) => (
          <SortableHeader column={column} title='Delete at' />
        ),
        cell: ({ row }) =>
          row.original.delete_at
            ? new Date(row.original.delete_at).toLocaleString()
            : '—',
      },
      {
        accessorKey: 'description',
        header: 'Description',
        cell: ({ getValue }) => (
          <span
            className='block max-w-80 truncate'
            title={String(getValue() ?? '')}
          >
            {String(getValue() || '—')}
          </span>
        ),
      },
    ],
    [groups]
  )
  return (
    <DialogContent className='flex h-[var(--interface-dialog-max-height,84svh)] flex-col overflow-hidden sm:!max-w-6xl'>
      <DialogHeader className='shrink-0'>
        <DialogTitle className='flex items-center gap-2'>
          <ShieldCheck className='text-primary' />
          Security group rules
        </DialogTitle>
        <DialogDescription>
          Review firewall rules attached to {serverName}
          {projectName ? ` · ${projectName}` : ''}.
        </DialogDescription>
      </DialogHeader>
      <div className='flex shrink-0 flex-wrap items-end gap-3 border-y py-3'>
        <div className='min-w-0 flex-1 basis-56 space-y-2'>
          <Label>Security group</Label>
          <SearchableSelect
            value={group}
            onValueChange={onGroupChange}
            loading={loading}
            placeholder='Select security group'
            searchPlaceholder='Search attached security groups...'
            options={[
              {
                value: '__all__',
                label: 'All attached security groups',
                description: `${groups.length} attached group(s)`,
              },
              ...groups.map((item) => ({
                value: item.id,
                label: item.display_name || item.name,
                description: item.description || item.id,
              })),
            ]}
          />
        </div>
        <div className='inline-flex h-9 items-center rounded-md border bg-muted/40 p-0.5'>
          {(
            [
              { value: 'all', label: 'All' },
              { value: 'ingress', label: 'Inbound' },
              { value: 'egress', label: 'Outbound' },
            ] as const
          ).map((tab) => (
            <Button
              key={tab.value}
              size='sm'
              variant={direction === tab.value ? 'secondary' : 'ghost'}
              className='h-8 px-3 text-xs'
              onClick={() => onDirectionChange(tab.value)}
            >
              {tab.label}
            </Button>
          ))}
        </div>
        <Button
          size='icon'
          variant='outline'
          aria-label='Refresh security group rules'
          title='Refresh security group rules'
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={refreshing ? 'animate-spin' : ''} />
        </Button>
        {actions}
      </div>
      <div className='flex min-h-0 flex-1 flex-col'>
        {loading ? (
          <div className='flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground'>
            <Loader2 className='size-4 animate-spin' />
            Loading security groups...
          </div>
        ) : error ? (
          <div
            role='alert'
            className='flex min-h-32 flex-col items-center justify-center gap-3 text-sm'
          >
            <p className='text-destructive'>
              Security groups or rules could not be loaded.
            </p>
            <Button variant='outline' size='sm' onClick={onRefresh}>
              Try again
            </Button>
          </div>
        ) : !groups.length ? (
          <div className='flex min-h-32 items-center justify-center text-sm text-muted-foreground'>
            No security groups attached
          </div>
        ) : (
          <CloudDataTable
            data={rules}
            columns={columns}
            getRowId={(rule) => `${groupId(rule.security_group)}:${rule.id}`}
            loading={rulesLoading}
            entityName='firewall rule'
            exportFileName={`server-security-group-rules-${serverId}`}
            searchPlaceholder='Search IP, CIDR, protocol, port or description...'
            fillHeight
            enableSelection={Boolean(toolbar)}
            toolbar={toolbar}
          />
        )}
      </div>
    </DialogContent>
  )
}

export function InventoryServerSecurityGroupsDialog({
  server,
  onClose,
}: {
  server: {
    server_id: string
    server_name: string
    project_id: string
    project_name: string
    project_display_name?: string
  }
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [createGroupId, setCreateGroupId] = useState<string | null>(null)
  const [group, setGroup] = useState('')
  const [direction, setDirection] = useState<Direction>('all')
  const detail = useQuery({
    queryKey: [
      'cloud',
      server.project_id,
      'server-security-groups',
      server.server_id,
    ],
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Record<string, unknown>>(
          `/cloud/servers/${server.server_id}`,
          { headers: { 'X-Project-Id': server.project_id }, signal }
        )
      ).data,
  })
  const securityGroups = useQuery({
    queryKey: ['cloud', server.project_id, 'security-groups'],
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<SecurityGroupOption[]>('/cloud/security-groups', {
          headers: { 'X-Project-Id': server.project_id },
          signal,
        })
      ).data,
  })
  const groups = useMemo(() => {
    const attached = detail.data?.security_groups
    const values = Array.isArray(attached)
      ? attached
      : attached
        ? [attached]
        : []
    const resolved = new Map<string, SecurityGroupOption>()
    for (const value of values) {
      const item =
        value && typeof value === 'object'
          ? (value as Record<string, unknown>)
          : {}
      const id = typeof value === 'string' ? value : String(item.id ?? '')
      const name = String(item.display_name ?? item.name ?? id)
      const match = securityGroups.data?.find(
        (candidate) =>
          candidate.id === id ||
          candidate.name === name ||
          candidate.display_name === name
      )
      if (match) resolved.set(match.id, match)
      else if (id) resolved.set(id, { id, name })
    }
    return [...resolved.values()]
  }, [detail.data, securityGroups.data])
  const selectedGroup =
    group === '__all__' || groups.some((item) => item.id === group)
      ? group
      : (groups[0]?.id ?? '')
  const rules = useQuery({
    queryKey: [
      'cloud',
      server.project_id,
      'server-security-group-rules',
      server.server_id,
      selectedGroup,
      direction,
      groups.map((item) => item.id),
    ],
    enabled: detail.isSuccess && securityGroups.isSuccess && groups.length > 0,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const ids =
        selectedGroup === '__all__'
          ? groups.map((item) => item.id)
          : [selectedGroup]
      const results: ServerSecurityRule[] = []
      // Limit concurrent requests when a VM has many attached groups.
      for (let offset = 0; offset < ids.length; offset += 4) {
        const batch = await Promise.all(
          ids.slice(offset, offset + 4).map(async (id) => {
            const { data } = await apiClient.get<ServerSecurityRule[]>(
              `/cloud/security-groups/${id}/rules`,
              {
                headers: { 'X-Project-Id': server.project_id },
                signal,
                params: { direction },
              }
            )
            return data.map((rule) => ({
              ...rule,
              security_group: rule.security_group ?? id,
            }))
          })
        )
        results.push(...batch.flat())
      }
      return results
    },
  })
  const refresh = async () => {
    await Promise.all([detail.refetch(), securityGroups.refetch()])
    await queryClient.invalidateQueries({
      queryKey: [
        'cloud',
        server.project_id,
        'server-security-group-rules',
        server.server_id,
      ],
    })
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <ServerSecurityGroupsContent
          serverId={server.server_id}
          serverName={server.server_name}
          projectName={server.project_display_name || server.project_name}
          groups={groups}
          rules={rules.data ?? []}
          group={selectedGroup}
          direction={direction}
          onGroupChange={setGroup}
          onDirectionChange={setDirection}
          loading={detail.isLoading || securityGroups.isLoading}
          rulesLoading={rules.isLoading}
          error={detail.isError || securityGroups.isError || rules.isError}
          onRefresh={() => void refresh()}
          refreshing={
            detail.isFetching || securityGroups.isFetching || rules.isFetching
          }
          actions={
            <Button
              size='sm'
              disabled={
                !groups.length ||
                detail.isLoading ||
                securityGroups.isLoading ||
                detail.isError ||
                securityGroups.isError
              }
              onClick={() =>
                setCreateGroupId(
                  selectedGroup === '__all__' ? groups[0].id : selectedGroup
                )
              }
            >
              <Plus /> Add rule
            </Button>
          }
        />
      </Dialog>
      {createGroupId && (
        <ServerSecurityRuleCreateDialog
          open
          onClose={() => setCreateGroupId(null)}
          projectId={server.project_id}
          projectName={server.project_display_name || server.project_name}
          serverName={server.server_name}
          groups={groups}
          initialGroupId={createGroupId}
        />
      )}
    </>
  )
}
