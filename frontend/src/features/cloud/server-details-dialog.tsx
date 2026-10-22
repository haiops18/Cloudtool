import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eye } from 'lucide-react'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  ServerNetworkDetails,
  type ServerNetworkDetailsData,
} from './server-network-details'
import type { Page } from './types'

type ZoneLookup = { id: string; name?: string; display_name?: string }

function conciseServerDetailLines(value: unknown) {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return values
    .map((item) => {
      if (typeof item !== 'object' || !item) return String(item)
      const record = item as Record<string, unknown>
      return String(
        record.ip_address ??
          record.display_name ??
          record.name ??
          record.id ??
          ''
      )
    })
    .filter(Boolean)
}

function conciseServerVolumeLines(value: unknown) {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return values
    .map((item) => {
      const outer =
        typeof item === 'object' && item
          ? (item as Record<string, unknown>)
          : {}
      const volume =
        typeof outer.volume === 'object' && outer.volume
          ? (outer.volume as Record<string, unknown>)
          : outer
      const mountAs = String(outer.mount_as ?? volume.mount_as ?? 'data')
      const type = String(
        volume.disk_type ?? volume.volume_type ?? volume.type ?? 'volume'
      ).toUpperCase()
      const size = volume.size ? ` · ${volume.size} GB` : ''
      const speed = volume.speed ? ` · ${volume.speed}` : ''
      return `${mountAs} · ${type}${size}${speed}`
    })
    .filter(Boolean)
}

function conciseServerVolumeDetails(value: unknown) {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return values
    .map((item) => {
      const outer =
        typeof item === 'object' && item
          ? (item as Record<string, unknown>)
          : {}
      const volume =
        typeof outer.volume === 'object' && outer.volume
          ? (outer.volume as Record<string, unknown>)
          : outer
      const mountAs = String(outer.mount_as ?? volume.mount_as ?? 'data')
      return {
        mountAs,
        type: String(
          volume.disk_type ?? volume.volume_type ?? volume.type ?? 'volume'
        ).toUpperCase(),
        size: volume.size ? String(volume.size) : '',
        speed: volume.speed ? String(volume.speed) : '',
        isRoot: mountAs.toLowerCase() === 'root',
      }
    })
    .sort((left, right) => Number(right.isRoot) - Number(left.isRoot))
}

function compactServerDetailValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value))
    return (
      value.map(compactServerDetailValue).filter(Boolean).join(' · ') || '—'
    )
  const record = value as Record<string, unknown>
  const label = record.display_name ?? record.name ?? record.ip_address
  if (label) return String(label)
  const scalarEntries = Object.entries(record)
    .filter(
      ([, item]) => typeof item !== 'object' && item != null && item !== ''
    )
    .slice(0, 6)
    .map(([key, item]) => `${key}: ${String(item)}`)
  if (scalarEntries.length) return scalarEntries.join(' · ')
  return record.id ? String(record.id) : '—'
}

function serverDetailReferenceValue(
  record: Record<string, unknown>,
  key: string
) {
  const mapped = record.mapped_references as Record<string, unknown> | undefined
  return compactServerDetailValue(mapped?.[key] ?? record[key])
}

export function ServerDetailsDialog({
  server: viewServer,
  projectId,
  crossProject = false,
  onOpenChange,
}: {
  server?: { id: string; name: string }
  projectId: string
  crossProject?: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [serverRawJsonOpen, setServerRawJsonOpen] = useState(false)
  const serverDetail = useQuery({
    queryKey: [
      'cloud',
      projectId,
      'server-detail',
      viewServer?.id,
      crossProject,
    ],
    enabled: Boolean(viewServer),
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      if (crossProject) {
        return (
          await apiClient.get<{ item: Record<string, unknown> }>(
            `/cloud/all-server-inventory/servers/${encodeURIComponent(projectId)}/${encodeURIComponent(viewServer!.id)}`,
            {
              params: { include_network_details: true },
              timeout: 90_000,
              signal,
            }
          )
        ).data.item
      }
      return (
        await apiClient.get<Record<string, unknown>>(
          `/cloud/servers/${encodeURIComponent(viewServer!.id)}`,
          { params: { include_network_details: true }, timeout: 60_000, signal }
        )
      ).data
    },
  })
  const serverDetailZones = useQuery({
    queryKey: ['cloud', projectId, 'server-detail-zones'],
    enabled: Boolean(viewServer) && !crossProject,
    staleTime: 60_000,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Page<ZoneLookup>>('/cloud/zones', {
          params: { page_size: 200 }, signal,
        })
      ).data,
  })
  const serverDetailRecord =
    serverDetail.data ??
    (viewServer as unknown as Record<string, unknown>) ??
    {}
  const serverDetailZoneById = new Map(
    (serverDetailZones.data?.items ?? []).map((zone) => [
      zone.id,
      zone.display_name ?? zone.name ?? zone.id,
    ])
  )
  const serverDetailZoneSource =
    serverDetailRecord.zone_id ??
    serverDetailRecord.zone ??
    serverDetailRecord.zone_name
  const serverDetailZoneId =
    typeof serverDetailZoneSource === 'object' && serverDetailZoneSource
      ? String((serverDetailZoneSource as Record<string, unknown>).id ?? '')
      : String(serverDetailZoneSource ?? '')
  const detailElasticIps = conciseServerDetailLines(
    serverDetailRecord.elastic_ip ?? serverDetailRecord.elastic_ips
  )
  const detailPrivateIps = conciseServerDetailLines(
    serverDetailRecord.private_ip ?? serverDetailRecord.private_ips
  )
  const detailSecurityGroups = conciseServerDetailLines(
    serverDetailRecord.security_groups
  )
  const detailVolumeSource =
    serverDetailRecord.volume_details ??
    serverDetailRecord.volumes ??
    serverDetailRecord.attached_volumes
  const detailVolumes = conciseServerVolumeDetails(detailVolumeSource)
  const detailVolumeSummary = conciseServerVolumeLines(detailVolumeSource)
  const serverDetailUserData = String(
    serverDetailRecord.user_data ??
      serverDetailRecord.userData ??
      serverDetailRecord.userdata ??
      ''
  )
  const serverDetailMappedReferences = serverDetailRecord.mapped_references as
    Record<string, unknown> | undefined
  const serverDetailBasics = [
    ['Server name', serverDetailRecord.name ?? viewServer?.name],
    ['Server ID', serverDetailRecord.id ?? viewServer?.id],
    [
      'Flavor',
      serverDetailRecord.flavor_name ??
        (serverDetailRecord.specs as Record<string, unknown> | undefined)
          ?.flavor_name ??
        serverDetailReferenceValue(serverDetailRecord, 'flavor'),
    ],
    ['Power state', serverDetailRecord.power_state],
    ['Status', serverDetailRecord.status],
    ['Server type', serverDetailRecord.server_type],
    [
      'Placement group',
      serverDetailReferenceValue(serverDetailRecord, 'placement_group'),
    ],
    [
      'Bandwidth',
      serverDetailRecord.bandwidth
        ? `${serverDetailRecord.bandwidth} Mbps`
        : undefined,
    ],
    [
      'Zone',
      serverDetailZoneById.get(serverDetailZoneId) ??
        compactServerDetailValue(
          serverDetailMappedReferences?.zone ??
            serverDetailRecord.zone_name ??
            serverDetailRecord.zone
        ),
    ],
    [
      'Image',
      serverDetailRecord.image_name ??
        serverDetailReferenceValue(serverDetailRecord, 'image'),
    ],
    [
      'Key pair',
      serverDetailReferenceValue(
        serverDetailRecord,
        serverDetailRecord.key_pair !== undefined ? 'key_pair' : 'keypair'
      ),
    ],
    ['Created', serverDetailRecord.created_at],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '')
  const serverDetailExtraEntries = Object.entries(serverDetailRecord).filter(
    ([key]) =>
      ![
        'id',
        'name',
        'power_state',
        'status',
        'server_type',
        'placement_group',
        'bandwidth',
        'zone',
        'zone_name',
        'flavor',
        'flavor_name',
        'specs',
        'image',
        'image_name',
        'key_pair',
        'keypair',
        'created_at',
        'user_data',
        'userData',
        'elastic_ip',
        'elastic_ips',
        'private_ip',
        'private_ips',
        'security_groups',
        'volume_details',
        'volumes',
        'attached_volumes',
        'mapped_references',
        'network_details',
        'network_detail_errors',
        'userdata',
      ].includes(key)
  )
  return (
    <>
      <Dialog
        open={Boolean(viewServer)}
        onOpenChange={(open) => !open && onOpenChange(false)}
      >
        <DialogContent className='max-h-[90vh] overflow-hidden sm:!max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Server details</DialogTitle>
            <DialogDescription>
              Complete information returned by the Cloud API for{' '}
              {viewServer?.name}.
            </DialogDescription>
          </DialogHeader>
          <div className='max-h-[65vh] overflow-auto rounded-md border'>
            {serverDetail.isLoading ? (
              <p className='p-6 text-sm text-muted-foreground'>
                Loading server details...
              </p>
            ) : serverDetail.isError ? (
              <p className='p-6 text-sm text-destructive'>
                Server details could not be loaded.
              </p>
            ) : (
              <div className='space-y-4 pb-1'>
                <section className='rounded-lg border bg-muted/15 p-4'>
                  <h3 className='mb-3 text-sm font-semibold'>Overview</h3>
                  <div className='grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4'>
                    {serverDetailBasics.map(([label, value]) => {
                      const fullWidth = [
                        'Server name',
                        'Server ID',
                        'Flavor',
                        'Image',
                        'Key pair',
                      ].includes(String(label))
                      return (
                        <div
                          key={String(label)}
                          className={
                            fullWidth
                              ? 'min-w-0 sm:col-span-2 lg:col-span-4'
                              : 'min-w-0'
                          }
                        >
                          <p className='text-xs text-muted-foreground'>
                            {String(label)}
                          </p>
                          <p
                            className={
                              fullWidth && label === 'Server ID'
                                ? 'font-mono text-xs font-medium break-all'
                                : fullWidth
                                  ? 'text-sm font-medium break-words'
                                  : 'truncate text-sm font-medium'
                            }
                          >
                            {String(value)}
                          </p>
                        </div>
                      )
                    })}
                  </div>
                </section>

                <div className='grid gap-4 lg:grid-cols-2'>
                  <ServerNetworkDetails
                    networks={
                      (serverDetailRecord.network_details as
                        ServerNetworkDetailsData | undefined) ?? {
                        private_ips: detailPrivateIps.map((ip) => ({
                          ip_address: ip,
                          vip_ips: [],
                        })),
                        elastic_ips: detailElasticIps.map((ip) => ({
                          ip_address: ip,
                          vip_ips: [],
                        })),
                      }
                    }
                    errors={
                      serverDetailRecord.network_detail_errors as
                        string[] | undefined
                    }
                  />

                  <section className='rounded-lg border p-4'>
                    <h3 className='mb-3 text-sm font-semibold'>
                      Security groups
                    </h3>
                    {detailSecurityGroups.length ? (
                      <div className='space-y-1.5 text-sm'>
                        {detailSecurityGroups.map((group) => (
                          <p key={group} className='truncate'>
                            {group}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className='text-sm text-muted-foreground'>
                        No security group returned.
                      </p>
                    )}
                  </section>
                </div>

                <section className='rounded-lg border p-4'>
                  <div className='mb-3 flex items-center justify-between'>
                    <h3 className='text-sm font-semibold'>Volumes</h3>
                    <span
                      className='text-xs text-muted-foreground'
                      title={detailVolumeSummary.join('; ')}
                    >
                      {detailVolumes.length} volume(s)
                    </span>
                  </div>
                  {detailVolumes.length ? (
                    <div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-3'>
                      {detailVolumes.map((volume, index) => (
                        <p
                          key={`${volume.mountAs}-${volume.type}-${index}`}
                          className={
                            volume.isRoot
                              ? 'rounded-md border border-primary/30 bg-primary/10 px-2.5 py-2 text-xs'
                              : 'rounded-md bg-muted/50 px-2.5 py-2 text-xs'
                          }
                        >
                          <span className='font-medium'>
                            {volume.isRoot ? 'ROOT' : volume.mountAs}
                          </span>{' '}
                          · {volume.type}
                          {volume.size ? (
                            <>
                              {' '}
                              · <strong>{volume.size} GB</strong>
                            </>
                          ) : null}
                          {volume.speed ? ` · ${volume.speed}` : ''}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className='text-sm text-muted-foreground'>
                      No attached volume returned.
                    </p>
                  )}
                </section>

                {serverDetailExtraEntries.length ? (
                  <section className='rounded-lg border p-4'>
                    <h3 className='mb-3 text-sm font-semibold'>
                      Other information
                    </h3>
                    <div className='grid gap-x-6 gap-y-3 sm:grid-cols-2'>
                      {serverDetailExtraEntries.map(([key, value]) => (
                        <div key={key} className='min-w-0'>
                          <p className='font-mono text-xs text-muted-foreground'>
                            {key}
                          </p>
                          <p className='text-sm break-words'>
                            {compactServerDetailValue(value)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}

                <section className='rounded-lg border p-4'>
                  <div className='mb-3 flex items-center justify-between gap-3'>
                    <h3 className='text-sm font-semibold'>User data</h3>
                    <span className='text-xs text-muted-foreground'>
                      {serverDetailUserData.length.toLocaleString()} characters
                    </span>
                  </div>
                  {serverDetailUserData ? (
                    <Textarea
                      readOnly
                      value={serverDetailUserData}
                      className='h-48 min-h-32 resize-y bg-muted/30 font-mono text-xs leading-5'
                      aria-label='Server user data'
                    />
                  ) : (
                    <p className='text-sm text-muted-foreground'>
                      No user data returned for this VM.
                    </p>
                  )}
                </section>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setServerRawJsonOpen(true)}
            >
              <Eye />
              Raw JSON
            </Button>
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={serverRawJsonOpen} onOpenChange={setServerRawJsonOpen}>
        <DialogContent className='flex max-h-[90vh] flex-col overflow-hidden sm:!max-w-5xl'>
          <DialogHeader>
            <DialogTitle>Raw server JSON</DialogTitle>
            <DialogDescription>
              Complete Cloud API response for {viewServer?.name ?? 'the server'}
              .
            </DialogDescription>
          </DialogHeader>
          <pre className='min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-4 font-mono text-xs whitespace-pre-wrap'>
            {JSON.stringify(serverDetailRecord, null, 2)}
          </pre>
          <DialogFooter>
            <Button onClick={() => setServerRawJsonOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
