import { useMemo, useState } from 'react'
import { isAxiosError } from 'axios'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Check, Eye, MoreHorizontal, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { useCloudStore } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { CloudDataTable } from '@/components/cloud-data-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SearchableSelect } from '@/components/searchable-select'
import { SegmentedTabs } from '@/components/segmented-tabs'
import { SortableHeader } from '@/components/sortable-header'
import { CloudPageShell } from './page-shell'
import {
  orientPeering,
  referenceName,
  type PeeringReference,
  type VpcPeering,
} from './vpc-peering'

type PeeringAction = 'accept' | 'reject' | 'delete'
type Vpc = { id: string; name?: string; display_name?: string; cidr?: string }
type PeerProject = {
  id: string
  name: string
  display_name?: string
  organization?: string
}
const emptyDraft = { requester_vpc: '', accepter_vpc: '', description: '' }
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function errorMessage(error: unknown) {
  if (isAxiosError(error)) {
    const data = error.response?.data
    const detail = data?.detail || data?.error?.message
    if (typeof detail === 'string') return detail
    if (detail) return JSON.stringify(detail)
  }
  return error instanceof Error
    ? error.message
    : 'Operation failed. Please try again.'
}

function Endpoint({
  project,
  vpc,
  current = false,
}: {
  project: PeeringReference
  vpc: PeeringReference
  current?: boolean
}) {
  return (
    <div className='space-y-1 py-1 break-words whitespace-normal'>
      <div className='flex items-center gap-2 font-medium'>
        {typeof project === 'string'
          ? 'Name unavailable'
          : project.name || project.display_name || 'Name unavailable'}
        {current && <Badge variant='outline'>Current</Badge>}
      </div>
      <div className='text-xs text-muted-foreground'>
        {typeof project === 'object'
          ? project.slug || 'Slug unavailable'
          : 'Slug unavailable'}
      </div>
      <div className='text-sm'>
        {typeof vpc === 'object'
          ? vpc.display_name || vpc.name || 'Name unavailable'
          : 'Name unavailable'}
      </div>
    </div>
  )
}

function Status({ value }: { value: string }) {
  return (
    <Badge
      variant={
        value === 'active'
          ? 'default'
          : value === 'rejected' || value === 'failed'
            ? 'destructive'
            : 'secondary'
      }
    >
      {value}
    </Badge>
  )
}

export function VpcPeeringsPage() {
  const project = useCloudStore((state) => state.project)
  if (!project) return null
  // Remount local dialogs and selections when the current project changes.
  return <ProjectPeerings key={project.id} project={project} />
}

function ProjectPeerings({
  project,
}: {
  project: { id: string; name: string; display_name?: string }
}) {
  const queryClient = useQueryClient()
  const canWrite = useAuthStore(
    (state) => state.auth.user?.cloud_api_access === 'full'
  )
  const [createOpen, setCreateOpen] = useState(false)
  const [draft, setDraft] = useState(emptyDraft)
  const [peerMode, setPeerMode] = useState<'id' | 'project'>('id')
  const [peerProjectId, setPeerProjectId] = useState('')
  const [detail, setDetail] = useState<VpcPeering>()
  const [confirmation, setConfirmation] = useState<{
    row: VpcPeering
    action: PeeringAction
  }>()
  const headers = { 'X-Project-Id': project.id }
  const queryKey = ['cloud', project.id, 'vpc-peerings']
  const peerings = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<VpcPeering[]>('/cloud/vpc-peerings', {
          headers: { 'X-Project-Id': project.id }, signal,
        })
      ).data,
    refetchInterval: (query) =>
      query.state.data?.some((row) => row.status === 'pending')
        ? 15_000
        : false,
  })
  const vpcs = useQuery({
    queryKey: ['cloud', project.id, 'vpc-peerings', 'vpcs'],
    enabled: createOpen,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Vpc[]>('/cloud/vpc-peerings/vpcs', {
          headers: { 'X-Project-Id': project.id }, signal,
        })
      ).data,
  })
  const peerProjects = useQuery({
    queryKey: ['cloud', project.id, 'vpc-peerings', 'projects'],
    enabled: createOpen && peerMode === 'project',
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<PeerProject[]>('/cloud/vpc-peerings/projects', {
          headers: { 'X-Project-Id': project.id }, signal,
        })
      ).data,
  })
  const peerVpcs = useQuery({
    queryKey: ['cloud', project.id, 'vpc-peerings', 'peer-vpcs', peerProjectId],
    enabled: createOpen && peerMode === 'project' && Boolean(peerProjectId),
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Vpc[]>('/cloud/vpc-peerings/vpcs', {
          headers: { 'X-Project-Id': project.id },
          params: { project_id: peerProjectId }, signal,
        })
      ).data,
  })
  const create = useMutation({
    mutationFn: () =>
      apiClient.post(
        '/cloud/vpc-peerings',
        {
          requester_vpc: draft.requester_vpc,
          accepter_vpc: draft.accepter_vpc.trim(),
          description: draft.description.trim(),
        },
        { headers }
      ),
    onSuccess: () => {
      setCreateOpen(false)
      setDraft(emptyDraft)
      toast.success('VPC peering request created.')
      void queryClient.invalidateQueries({ queryKey })
    },
    onError: (error) => toast.error(errorMessage(error)),
  })
  const operation = useMutation({
    mutationFn: async ({
      row,
      action,
    }: {
      row: VpcPeering
      action: PeeringAction
    }) => {
      const path = `/cloud/vpc-peerings/${row.id}`
      if (action === 'delete') await apiClient.delete(path, { headers })
      else await apiClient.post(`${path}/${action}`, undefined, { headers })
    },
    onSuccess: (_, { action }) => {
      setConfirmation(undefined)
      toast.success(
        action === 'delete'
          ? 'VPC peering deleted.'
          : `VPC peering ${action} request accepted.`
      )
      void queryClient.invalidateQueries({ queryKey })
    },
    onError: (error) => {
      toast.error(errorMessage(error))
      void queryClient.invalidateQueries({ queryKey })
    },
  })
  const columns = useMemo<ColumnDef<VpcPeering>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (row) => row.display_name || row.name || '',
        header: ({ column }) => (
          <SortableHeader column={column} title='VPC peering' />
        ),
        meta: { className: 'w-[12%] whitespace-normal' },
        cell: ({ row }) => {
          const name =
            row.original.display_name || row.original.name || 'Name unavailable'
          return (
            <Button
              variant='link'
              className='h-auto w-full justify-start p-0 text-left text-xs break-words whitespace-normal'
              title={name}
              onClick={() => setDetail(row.original)}
            >
              <span className='line-clamp-2 break-all'>{name}</span>
            </Button>
          )
        },
      },
      ...(
        ['sourceProject', 'sourceVpc', 'peerProject', 'peerVpc'] as const
      ).map((field): ColumnDef<VpcPeering> => {
        const isProject = field.endsWith('Project')
        const titles = {
          sourceProject: 'Current project',
          sourceVpc: 'Current VPC',
          peerProject: 'Peer project',
          peerVpc: 'Peer VPC',
        }
        const value = (row: VpcPeering) => {
          const view = orientPeering(row, project.id)
          if (!view) return undefined
          const reference = view[field]
          if (field === 'sourceProject' && typeof reference === 'object')
            return { ...reference, name: reference.name || project.name }
          return reference
        }
        return {
          id: field,
          accessorFn: (row) => {
            const reference = value(row)
            if (!reference || typeof reference === 'string') return ''
            return isProject
              ? [reference.name || reference.display_name, reference.slug]
                  .filter(Boolean)
                  .join(' ')
              : reference.display_name || reference.name || ''
          },
          header: ({ column }) => (
            <SortableHeader column={column} title={titles[field]} />
          ),
          meta: {
            className: isProject
              ? 'w-[17%] whitespace-normal'
              : 'w-[18%] whitespace-normal',
          },
          cell: ({ row }) => {
            const reference = value(row.original)
            const name =
              reference && typeof reference !== 'string'
                ? isProject
                  ? reference.name || reference.display_name
                  : reference.display_name || reference.name
                : undefined
            const slug =
              reference && typeof reference !== 'string'
                ? reference.slug
                : undefined
            return (
              <div className='space-y-1 py-2 break-words whitespace-normal'>
                <p className={isProject ? 'font-semibold' : 'font-medium'}>
                  {name || 'Name unavailable'}
                </p>
                {isProject && (
                  <p className='text-xs text-muted-foreground'>
                    {slug || 'Slug unavailable'}
                  </p>
                )}
              </div>
            )
          },
        }
      }),
      {
        id: 'actions',
        header: '',
        meta: { className: 'w-12 !static !shadow-none' },
        enableSorting: false,
        cell: ({ row }) => {
          const item = row.original
          const writable =
            canWrite &&
            Boolean(orientPeering(item, project.id)) &&
            !operation.isPending
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon'
                  aria-label={`Actions for ${item.display_name || item.name || item.id}`}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end'>
                <DropdownMenuItem onClick={() => setDetail(item)}>
                  <Eye /> View details
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!writable || item.status !== 'pending'}
                  onClick={() =>
                    setConfirmation({ row: item, action: 'accept' })
                  }
                >
                  <Check /> Accept peering
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!writable || item.status !== 'pending'}
                  onClick={() =>
                    setConfirmation({ row: item, action: 'reject' })
                  }
                >
                  <X /> Reject peering
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!writable}
                  className='text-destructive'
                  onClick={() =>
                    setConfirmation({ row: item, action: 'delete' })
                  }
                >
                  <Trash2 /> Delete peering
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
      },
      {
        accessorKey: 'created_at',
        header: ({ column }) => (
          <SortableHeader column={column} title='Created' />
        ),
        meta: { className: 'w-28' },
        cell: ({ row }) => {
          if (!row.original.created_at) return '—'
          const date = new Date(row.original.created_at)
          if (Number.isNaN(date.getTime())) return '—'
          return (
            <div
              className='space-y-0.5 text-xs tabular-nums'
              title={date.toLocaleString('vi-VN', { timeZone: 'Asia/Bangkok' })}
            >
              <p>
                {date.toLocaleDateString('vi-VN', {
                  timeZone: 'Asia/Bangkok',
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                })}
              </p>
              <p className='text-muted-foreground'>
                {date.toLocaleTimeString('vi-VN', {
                  timeZone: 'Asia/Bangkok',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
          )
        },
      },
      {
        accessorKey: 'status',
        header: ({ column }) => (
          <SortableHeader column={column} title='Status' />
        ),
        meta: { className: 'w-28' },
        cell: ({ row }) => <Status value={row.original.status} />,
      },
    ],
    [project, canWrite, operation.isPending]
  )
  const confirmedView =
    confirmation && orientPeering(confirmation.row, project.id)
  const detailView = detail && orientPeering(detail, project.id)
  const sourceOptions = (vpcs.data || []).map((vpc) => ({
    value: vpc.id,
    label: vpc.display_name || vpc.name || vpc.id,
    description: [vpc.cidr, vpc.id].filter(Boolean).join(' · '),
  }))

  return (
    <CloudPageShell
      title='VPC peering'
      description='Manage VPC peering connections for the current project.'
      tableHelp
      actions={
        <Button
          disabled={!canWrite}
          onClick={() => {
            setDraft(emptyDraft)
            setPeerMode('id')
            setPeerProjectId('')
            setCreateOpen(true)
          }}
        >
          <Plus /> Create peering
        </Button>
      }
      help={
        <p>
          The current project always appears on the left, even when it received
          the request. Project names and slugs identify each side, with their
          VPCs in separate columns. Only pending connections can be accepted or
          rejected.
        </p>
      }
    >
      {peerings.isError && (
        <div
          role='alert'
          className='mb-3 rounded-md border border-destructive/30 p-3 text-sm text-destructive'
        >
          {errorMessage(peerings.error)}{' '}
          <Button
            variant='outline'
            size='sm'
            onClick={() => void peerings.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      <Card className='[&_table]:!w-full [&_table]:table-fixed [&_th_button]:max-w-full [&_th_button]:whitespace-normal'>
        <CardContent className='pt-4'>
          <CloudDataTable
            data={peerings.data || []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={peerings.isLoading}
            searchPlaceholder='Search project names, slugs or VPCs...'
            emptyText='No VPC peering connections found.'
            entityName='connections'
            exportFileName={`vpc-peerings-${project.id}`}
            fillHeight
          />
        </CardContent>
      </Card>
      <Dialog
        open={createOpen}
        onOpenChange={(open) => !create.isPending && setCreateOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create VPC peering</DialogTitle>
            <DialogDescription>
              Send a peering request from {project.display_name || project.name}{' '}
              to another VPC.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label>Source VPC · current project</Label>
              <SearchableSelect
                value={draft.requester_vpc}
                ariaLabel='Source VPC'
                onValueChange={(value) =>
                  setDraft((prev) => ({ ...prev, requester_vpc: value }))
                }
                options={sourceOptions}
                loading={vpcs.isLoading}
                placeholder='Select source VPC'
              />
            </div>
            {vpcs.isError && (
              <p role='alert' className='text-sm text-destructive'>
                {errorMessage(vpcs.error)}{' '}
                <Button variant='link' onClick={() => void vpcs.refetch()}>
                  Retry
                </Button>
              </p>
            )}
            <div className='space-y-3 rounded-lg border bg-muted/20 p-4'>
              <Label>Peer VPC</Label>
              <SegmentedTabs<'id' | 'project'>
                value={peerMode}
                onValueChange={(mode) => {
                  setPeerMode(mode)
                  setPeerProjectId('')
                  setDraft((prev) => ({ ...prev, accepter_vpc: '' }))
                }}
                tabs={[
                  { value: 'id', label: 'Paste VPC ID' },
                  { value: 'project', label: 'Choose project & VPC' },
                ]}
              />
              {peerMode === 'id' ? (
                <div className='space-y-2'>
                  <Label htmlFor='peer-vpc-id'>Peer VPC ID</Label>
                  <Input
                    id='peer-vpc-id'
                    placeholder='Paste peer VPC UUID'
                    value={draft.accepter_vpc}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        accepter_vpc: event.target.value,
                      }))
                    }
                  />
                  <p className='text-xs text-muted-foreground'>
                    Use the VPC ID supplied by the peer project.
                  </p>
                </div>
              ) : (
                <div className='space-y-3'>
                  <div className='space-y-2'>
                    <Label>1. Peer project</Label>
                    <SearchableSelect
                      value={peerProjectId}
                      ariaLabel='Peer project'
                      onValueChange={(value) => {
                        setPeerProjectId(value)
                        setDraft((prev) => ({ ...prev, accepter_vpc: '' }))
                      }}
                      options={(peerProjects.data || []).map((item) => ({
                        value: item.id,
                        label: `${item.display_name || item.name}${item.id === project.id ? ' (current project)' : ''}`,
                        description: item.organization,
                      }))}
                      loading={peerProjects.isLoading}
                      disabled={peerProjects.isError}
                      placeholder='Select a project you manage'
                      searchPlaceholder='Search project name...'
                      emptyText='No accessible projects found.'
                    />
                    {peerProjects.isError && (
                      <p role='alert' className='text-xs text-destructive'>
                        {errorMessage(peerProjects.error)}{' '}
                        <Button
                          variant='link'
                          size='sm'
                          onClick={() => void peerProjects.refetch()}
                        >
                          Retry
                        </Button>
                      </p>
                    )}
                  </div>
                  <div className='space-y-2'>
                    <Label>2. Peer VPC</Label>
                    <SearchableSelect
                      value={draft.accepter_vpc}
                      ariaLabel='Peer VPC'
                      onValueChange={(value) =>
                        setDraft((prev) => ({ ...prev, accepter_vpc: value }))
                      }
                      options={(peerVpcs.data || [])
                        .filter((item) => item.id !== draft.requester_vpc)
                        .map((item) => ({
                          value: item.id,
                          label: item.display_name || item.name || item.id,
                          description: item.cidr,
                        }))}
                      loading={Boolean(peerProjectId) && peerVpcs.isLoading}
                      disabled={
                        !peerProjectId || peerVpcs.isError || peerVpcs.isLoading
                      }
                      placeholder={
                        !peerProjectId
                          ? 'Select a project first'
                          : peerVpcs.isLoading
                            ? 'Loading VPCs...'
                            : 'Select peer VPC'
                      }
                      searchPlaceholder='Search VPC name or CIDR...'
                      emptyText='No eligible VPCs in this project.'
                    />
                    {peerVpcs.isError && peerProjectId && (
                      <p role='alert' className='text-xs text-destructive'>
                        {errorMessage(peerVpcs.error)}{' '}
                        <Button
                          variant='link'
                          size='sm'
                          onClick={() => void peerVpcs.refetch()}
                        >
                          Retry
                        </Button>
                      </p>
                    )}
                  </div>
                  <p className='text-xs text-muted-foreground'>
                    The source stays in {project.display_name || project.name}.
                    Selecting a peer project does not switch your current
                    project.
                  </p>
                </div>
              )}
            </div>
            {draft.requester_vpc &&
              draft.requester_vpc === draft.accepter_vpc.trim() && (
                <p className='text-sm text-destructive'>
                  Source and peer VPC must be different.
                </p>
              )}
            <div className='space-y-2'>
              <Label htmlFor='peering-description'>Description</Label>
              <Textarea
                id='peering-description'
                maxLength={1000}
                value={draft.description}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    description: event.target.value,
                  }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              disabled={create.isPending}
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                !canWrite ||
                create.isPending ||
                (peerMode === 'project' &&
                  (!peerProjectId ||
                    peerVpcs.isError ||
                    peerVpcs.isLoading ||
                    !peerVpcs.data?.some(
                      (item) => item.id === draft.accepter_vpc
                    ))) ||
                !draft.requester_vpc ||
                !uuidPattern.test(draft.accepter_vpc.trim()) ||
                draft.requester_vpc === draft.accepter_vpc.trim()
              }
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Creating...' : 'Create peering'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(detail)}
        onOpenChange={(open) => !open && setDetail(undefined)}
      >
        <DialogContent className='sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>VPC peering details</DialogTitle>
            <DialogDescription>
              {detail?.display_name || detail?.name || detail?.id}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className='space-y-4'>
              {detailView ? (
                <div className='grid gap-4 rounded-md border p-4 sm:grid-cols-2'>
                  <div>
                    <Label>Current project / VPC</Label>
                    <Endpoint
                      project={{
                        id: project.id,
                        name: project.name,
                        slug:
                          typeof detailView.sourceProject === 'object'
                            ? detailView.sourceProject.slug
                            : undefined,
                      }}
                      vpc={detailView.sourceVpc}
                      current
                    />
                  </div>
                  <div>
                    <Label>Peer project / VPC</Label>
                    <Endpoint
                      project={detailView.peerProject}
                      vpc={detailView.peerVpc}
                    />
                  </div>
                </div>
              ) : (
                <p>Neither endpoint belongs to the current project.</p>
              )}
              <div className='flex gap-2'>
                <Status value={detail.status} />
                {detailView && (
                  <Badge variant='outline'>{detailView.direction}</Badge>
                )}
              </div>
              <p className='text-sm break-all'>Connection ID: {detail.id}</p>
              <p className='text-sm whitespace-pre-wrap'>
                {detail.description || 'No description.'}
              </p>
              <p className='text-xs text-muted-foreground'>
                Created:{' '}
                {detail.created_at
                  ? new Date(detail.created_at).toLocaleString()
                  : '—'}{' '}
                · Updated:{' '}
                {detail.updated_at
                  ? new Date(detail.updated_at).toLocaleString()
                  : '—'}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(confirmation)}
        onOpenChange={(open) =>
          !operation.isPending && !open && setConfirmation(undefined)
        }
        title={`${confirmation?.action === 'accept' ? 'Accept' : confirmation?.action === 'reject' ? 'Reject' : 'Delete'} VPC peering?`}
        destructive={confirmation?.action !== 'accept'}
        isLoading={operation.isPending}
        disabled={!canWrite}
        confirmText={
          confirmation?.action === 'accept'
            ? 'Accept peering'
            : confirmation?.action === 'reject'
              ? 'Reject peering'
              : 'Delete peering'
        }
        desc={
          <div className='space-y-2'>
            <p>
              {project.display_name || project.name} /{' '}
              {confirmedView && referenceName(confirmedView.sourceVpc)} →{' '}
              {confirmedView && referenceName(confirmedView.peerProject)} /{' '}
              {confirmedView && referenceName(confirmedView.peerVpc)}
            </p>
            <p className='text-xs break-all'>{confirmation?.row.id}</p>
            {confirmation?.action === 'delete' && (
              <p>
                Deleting this connection removes peering between these VPCs and
                may interrupt traffic.
              </p>
            )}
          </div>
        }
        handleConfirm={() => {
          if (confirmation) operation.mutate(confirmation)
        }}
      />
    </CloudPageShell>
  )
}
