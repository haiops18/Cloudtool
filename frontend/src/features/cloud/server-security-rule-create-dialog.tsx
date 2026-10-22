import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api-client'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { CloudDataTable } from '@/components/cloud-data-table'
import { SearchableSelect } from '@/components/searchable-select'
import type { SecurityGroupOption } from './server-security-groups-dialog'

type ServerSecurityRuleDraft = {
  security_group_id: string
  direction: 'ingress' | 'egress' | 'both'
  protocol: string
  port_range: string
  remote_ip_prefix: string
  description: string
  delete_at: string
}

type ServerSecurityRulePreview = {
  key: string
  security_group_id: string
  direction: 'ingress' | 'egress'
  protocol: string
  port_range_min: number | null
  port_range_max: number | null
  remote_ip_prefix: string
  description: string
  delete_at: string | null
  status?: 'created' | 'failed'
  error?: unknown
}

const emptyServerSecurityRuleDraft = (): ServerSecurityRuleDraft => ({
  security_group_id: '',
  direction: 'ingress',
  protocol: 'tcp',
  port_range: '',
  remote_ip_prefix: '',
  description: '',
  delete_at: '',
})

const serverSecurityRuleProtocols = [
  'tcp',
  'udp',
  'any',
  'icmp',
  'igmp',
  'ip',
  'ipv6-icmp',
  'gre',
  'esp',
  'ah',
  'ospf',
  'sctp',
  'vrrp',
  'rsvp',
  'dccp',
  'egp',
  'hopopt',
  'ipip',
  'ipv6-encap',
  'ipv6-frag',
  'ipv6-nontx',
  'ipv6-opts',
  'ipv6-route',
  'pgm',
  'udplite',
]

function splitSecurityRuleValues(value: string) {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseSecurityRulePortRange(value: string) {
  if (value.toLowerCase() === 'any')
    return { port_range_min: null, port_range_max: null }
  const parts = value.split('-').map((item) => item.trim())
  if (parts.length > 2 || !parts.every((item) => /^\d+$/.test(item)))
    throw new Error(`Invalid port value: ${value}`)
  const minimum = Number(parts[0])
  const maximum = Number(parts[1] ?? parts[0])
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 1 ||
    maximum > 65_535 ||
    minimum > maximum
  )
    throw new Error(`Invalid port range: ${value}`)
  return { port_range_min: minimum, port_range_max: maximum }
}

function securityRuleErrorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    for (const key of ['upstream_detail', 'detail', 'message']) {
      if (record[key] != null) return securityRuleErrorText(record[key])
    }
    return JSON.stringify(error)
  }
  return 'The Cloud API did not return an error detail.'
}

function securityRulePortText(
  portMin?: number | null,
  portMax?: number | null
) {
  if (portMin == null && portMax == null) return 'Any'
  if (portMin === portMax) return String(portMin)
  return `${portMin ?? 'Any'}–${portMax ?? 'Any'}`
}

export function ServerSecurityRuleCreateDialog({
  open,
  onClose,
  projectId,
  projectName,
  serverName,
  groups: attachedSecurityGroups,
  initialGroupId,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  projectName: string
  serverName: string
  groups: SecurityGroupOption[]
  initialGroupId: string
}) {
  const queryClient = useQueryClient()
  const [securityRuleDraft, setSecurityRuleDraft] =
    useState<ServerSecurityRuleDraft>(() => ({
      ...emptyServerSecurityRuleDraft(),
      security_group_id: initialGroupId,
    }))
  const [securityRulePreviews, setSecurityRulePreviews] = useState<
    ServerSecurityRulePreview[]
  >([])
  const [securityRuleCreateItems, setSecurityRuleCreateItems] = useState<
    ServerSecurityRulePreview[]
  >([])
  const refreshServerSecurityRules = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['cloud', projectId, 'server-security-group-rules'],
      }),
      queryClient.invalidateQueries({
        queryKey: ['cloud', projectId, 'security-groups'],
      }),
    ])
  const addSecurityRulePreviews = () => {
    const draft = securityRuleDraft
    if (!draft.security_group_id) {
      toast.error('Select a security group.')
      return
    }
    const cidrs = splitSecurityRuleValues(draft.remote_ip_prefix)
    const ports = splitSecurityRuleValues(draft.port_range)
    if (!cidrs.length) {
      toast.error('Enter at least one remote IP or CIDR.')
      return
    }
    try {
      const deleteAt = draft.delete_at.trim() || null
      if (deleteAt && Number.isNaN(new Date(deleteAt).getTime()))
        throw new Error('Enter a valid deletion date and time.')
      const portRanges = ports.length
        ? ports.map(parseSecurityRulePortRange)
        : [{ port_range_min: null, port_range_max: null }]
      const directions =
        draft.direction === 'both'
          ? (['ingress', 'egress'] as const)
          : [draft.direction]
      const additions = directions.flatMap((direction) =>
        cidrs.flatMap((remote_ip_prefix, cidrIndex) =>
          portRanges.map((portRange, portIndex) => ({
            key: `${Date.now()}-${direction}-${cidrIndex}-${portIndex}-${Math.random()}`,
            security_group_id: draft.security_group_id,
            direction,
            protocol: draft.protocol,
            ...portRange,
            remote_ip_prefix,
            description: draft.description.trim(),
            delete_at: deleteAt,
          }))
        )
      )
      setSecurityRulePreviews((current) => {
        const next = [...current, ...additions]
        if (next.length > 500) {
          toast.error('A maximum of 500 rules can be reviewed at once.')
          return current
        }
        return next
      })
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not prepare rule review.'
      )
    }
  }
  const createSecurityRule = useMutation({
    mutationFn: async (items: ServerSecurityRulePreview[]) => {
      const grouped = items.reduce((groups, item) => {
        const rows = groups.get(item.security_group_id) ?? []
        rows.push(item)
        groups.set(item.security_group_id, rows)
        return groups
      }, new Map<string, ServerSecurityRulePreview[]>())
      const results = await Promise.all(
        Array.from(grouped, async ([groupId, groupItems]) => {
          try {
            if (!attachedSecurityGroups.some((group) => group.id === groupId))
              throw new Error(
                'The security group is no longer attached to this VM.'
              )
            const { data } = await apiClient.post<{
              items?: Array<{ status?: string; error?: unknown }>
            }>(
              `/cloud/security-groups/${groupId}/rules`,
              {
                items: groupItems.map(
                  ({
                    key: _key,
                    security_group_id: _group,
                    status: _status,
                    error: _error,
                    ...item
                  }) => item
                ),
              },
              { headers: { 'X-Project-Id': projectId } }
            )
            return groupItems.map((item, index) => ({
              key: item.key,
              status: data.items?.[index]?.status,
              error:
                data.items?.[index]?.error ??
                (data.items?.[index]
                  ? undefined
                  : 'The Cloud API did not return a result for this rule.'),
            }))
          } catch (error) {
            const detail = (
              error as { response?: { data?: { detail?: unknown } } }
            ).response?.data?.detail
            return groupItems.map((item) => ({
              key: item.key,
              status: 'failed',
              error: detail ?? (error instanceof Error ? error.message : error),
            }))
          }
        })
      )
      return results.flat()
    },
    onSuccess: async (results) => {
      const resultByKey = new Map(results.map((item) => [item.key, item]))
      const created = results.filter((item) => item.status === 'created').length
      setSecurityRulePreviews((current) =>
        current.map((item) => {
          const result = resultByKey.get(item.key)
          if (!result) return item
          return {
            ...item,
            status: result.status === 'created' ? 'created' : 'failed',
            error: result.error,
          }
        })
      )
      setSecurityRuleCreateItems([])
      await refreshServerSecurityRules()
      const failed = results.length - created
      toast[failed ? 'warning' : 'success'](
        failed
          ? `${created}/${results.length} rule(s) created. Review upstream errors below.`
          : `${created} firewall rule(s) created.`
      )
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not create firewall rule.'
      ),
  })
  const securityRulePreviewColumns = useMemo<
    ColumnDef<ServerSecurityRulePreview>[]
  >(
    () => [
      {
        id: 'security_group',
        accessorFn: (rule) => {
          const group = attachedSecurityGroups.find(
            (item) => item.id === rule.security_group_id
          )
          return group?.display_name || group?.name || rule.security_group_id
        },
        header: 'Security group',
      },
      {
        accessorKey: 'direction',
        header: 'Direction',
        cell: ({ getValue }) => (
          <Badge variant={getValue() === 'ingress' ? 'default' : 'secondary'}>
            {getValue() === 'ingress' ? 'Inbound' : 'Outbound'}
          </Badge>
        ),
      },
      {
        accessorKey: 'protocol',
        header: 'Protocol',
        cell: ({ getValue }) => (
          <span className='font-mono uppercase'>{getValue() as string}</span>
        ),
      },
      {
        id: 'port',
        accessorFn: (rule) =>
          securityRulePortText(rule.port_range_min, rule.port_range_max),
        header: 'Port',
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'remote_ip_prefix',
        header: 'Remote IP / CIDR',
        cell: ({ getValue }) => (
          <span className='font-mono text-xs'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'description',
        header: 'Description',
        cell: ({ getValue }) => {
          const description = String(getValue() ?? '')
          return description ? (
            <span
              className='block max-w-48 truncate text-xs'
              title={description}
            >
              {description}
            </span>
          ) : (
            '—'
          )
        },
      },
      {
        accessorKey: 'delete_at',
        header: 'Delete at',
        cell: ({ row }) =>
          row.original.delete_at
            ? new Date(row.original.delete_at).toLocaleString()
            : '—',
      },
      {
        id: 'result',
        accessorFn: (rule) => rule.status ?? 'Ready',
        header: 'Result',
        cell: ({ row }) =>
          row.original.status === 'created' ? (
            <Badge variant='secondary'>Created</Badge>
          ) : row.original.status === 'failed' ? (
            <span
              className='block max-w-56 truncate text-xs text-destructive'
              title={securityRuleErrorText(row.original.error)}
            >
              {securityRuleErrorText(row.original.error)}
            </span>
          ) : (
            <Badge variant='outline'>Ready</Badge>
          ),
      },
    ],
    [attachedSecurityGroups]
  )
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !createSecurityRule.isPending) onClose()
        }}
      >
        <DialogContent className='flex h-[var(--interface-dialog-max-height,84svh)] flex-col overflow-hidden sm:!w-[78vw] sm:!max-w-6xl'>
          <DialogHeader>
            <DialogTitle>Add security group rule</DialogTitle>
            <DialogDescription>
              Create a firewall rule for a security group attached to{' '}
              {serverName} · {projectName}.
            </DialogDescription>
          </DialogHeader>
          <div className='min-h-0 flex-1 space-y-4 overflow-auto pr-1'>
            <div className='grid gap-4 lg:grid-cols-[minmax(18rem,1fr)_auto_minmax(10rem,0.45fr)] lg:items-end'>
              <div className='space-y-2'>
                <Label>Security group</Label>
                <SearchableSelect
                  value={securityRuleDraft.security_group_id}
                  onValueChange={(security_group_id) =>
                    setSecurityRuleDraft((current) => ({
                      ...current,
                      security_group_id,
                    }))
                  }
                  placeholder='Select security group'
                  options={attachedSecurityGroups.map((group) => ({
                    value: group.id,
                    label: group.display_name || group.name,
                    description: group.description || group.id,
                  }))}
                />
              </div>
              <div className='space-y-2'>
                <Label>Direction</Label>
                <div className='inline-flex h-9 rounded-md border bg-muted/40 p-0.5'>
                  {(
                    [
                      { value: 'ingress', label: 'Inbound' },
                      { value: 'egress', label: 'Outbound' },
                      { value: 'both', label: 'Both' },
                    ] as const
                  ).map((option) => (
                    <Button
                      key={option.value}
                      type='button'
                      size='sm'
                      variant={
                        securityRuleDraft.direction === option.value
                          ? 'secondary'
                          : 'ghost'
                      }
                      className='h-8 px-3 text-xs'
                      onClick={() =>
                        setSecurityRuleDraft((current) => ({
                          ...current,
                          direction: option.value,
                        }))
                      }
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className='space-y-2'>
                <Label htmlFor='server-sg-rule-protocol'>Protocol</Label>
                <select
                  id='server-sg-rule-protocol'
                  className='h-9 w-full rounded-md border bg-background px-3 text-sm'
                  value={securityRuleDraft.protocol}
                  onChange={(event) =>
                    setSecurityRuleDraft((current) => ({
                      ...current,
                      protocol: event.target.value,
                    }))
                  }
                >
                  {serverSecurityRuleProtocols.map((protocol) => (
                    <option key={protocol} value={protocol}>
                      {protocol.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className='mt-4 space-y-2'>
              <Label htmlFor='server-sg-rule-port-range'>Port / range</Label>
              <Input
                id='server-sg-rule-port-range'
                placeholder='Any, 22, 80-443 (separate multiple values with commas)'
                value={securityRuleDraft.port_range}
                onChange={(event) =>
                  setSecurityRuleDraft((current) => ({
                    ...current,
                    port_range: event.target.value,
                  }))
                }
              />
            </div>
            <div className='mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]'>
              <div className='space-y-2'>
                <Label htmlFor='server-sg-rule-remote-ip'>
                  Remote IP / CIDR
                </Label>
                <Textarea
                  id='server-sg-rule-remote-ip'
                  className='min-h-24'
                  placeholder='0.0.0.0/0, 10.0.0.0/24'
                  value={securityRuleDraft.remote_ip_prefix}
                  onChange={(event) =>
                    setSecurityRuleDraft((current) => ({
                      ...current,
                      remote_ip_prefix: event.target.value,
                    }))
                  }
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='server-sg-rule-description'>Description</Label>
                <Textarea
                  id='server-sg-rule-description'
                  className='min-h-24'
                  placeholder='Optional rule description'
                  value={securityRuleDraft.description}
                  onChange={(event) =>
                    setSecurityRuleDraft((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                />
              </div>
            </div>
            <div className='mt-4 flex items-end justify-between gap-4'>
              <div className='max-w-sm min-w-0 flex-1 space-y-2'>
                <Label htmlFor='server-sg-rule-delete-at'>
                  Delete at (optional)
                </Label>
                <Input
                  id='server-sg-rule-delete-at'
                  type='datetime-local'
                  step='1'
                  value={securityRuleDraft.delete_at}
                  onChange={(event) =>
                    setSecurityRuleDraft((current) => ({
                      ...current,
                      delete_at: event.target.value,
                    }))
                  }
                />
              </div>
              <Button
                className='shrink-0'
                variant='outline'
                disabled={createSecurityRule.isPending}
                onClick={addSecurityRulePreviews}
              >
                <Plus /> Add to review
              </Button>
            </div>
            <p className='text-xs text-muted-foreground'>
              Leave empty to create rules without a deletion schedule.
            </p>
            <section className='rounded-lg border bg-muted/10 p-3'>
              <CloudDataTable
                data={securityRulePreviews}
                columns={securityRulePreviewColumns}
                getRowId={(rule) => rule.key}
                entityName='rule to create'
                emptyText='Add ports and CIDRs to generate a review list.'
                searchPlaceholder='Search reviewed rules...'
                isRowSelectable={(rule) => rule.status !== 'created'}
                toolbar={(selected) => {
                  const pending = selected.filter(
                    (rule) => rule.status !== 'created'
                  )
                  return (
                    <div className='flex shrink-0 flex-nowrap gap-2 whitespace-nowrap'>
                      <Button
                        size='sm'
                        disabled={!pending.length}
                        onClick={() => setSecurityRuleCreateItems(pending)}
                      >
                        <Plus /> Create {pending.length} selected rule(s)
                      </Button>
                      <Button
                        variant='destructive'
                        size='sm'
                        disabled={!selected.length}
                        onClick={() => {
                          const keys = new Set(selected.map((rule) => rule.key))
                          setSecurityRulePreviews((current) =>
                            current.filter((rule) => !keys.has(rule.key))
                          )
                        }}
                      >
                        <Trash2 /> Remove {selected.length} selected rule(s)
                      </Button>
                    </div>
                  )
                }}
              />
            </section>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(securityRuleCreateItems.length)}
        onOpenChange={(open) =>
          !open &&
          !createSecurityRule.isPending &&
          setSecurityRuleCreateItems([])
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create selected firewall rules?</AlertDialogTitle>
            <AlertDialogDescription>
              {securityRuleCreateItems.length} reviewed rule(s) will be sent to
              the Cloud API. Check the CIDR and port ranges before continuing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={createSecurityRule.isPending}>
              Cancel
            </AlertDialogCancel>
            <Button
              disabled={createSecurityRule.isPending}
              onClick={() => createSecurityRule.mutate(securityRuleCreateItems)}
            >
              {createSecurityRule.isPending && (
                <Loader2 className='animate-spin' />
              )}
              Create rules
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
