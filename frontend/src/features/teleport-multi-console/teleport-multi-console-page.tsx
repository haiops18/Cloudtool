import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { MonitorPlay, Search, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { CloudDataTable } from '@/components/cloud-data-table'
import { SearchableSelect } from '@/components/searchable-select'
import { CloudPageShell } from '../cloud/page-shell'
import { TeleportMultiConsoleDialog } from './multi-console-page'
import { TerminalScriptDialog } from './terminal-script-dialog'

type Link = { id: string; name: string; url: string }
type Node = { name: string; ip: string; labels: string }
type Row = Node & {
  id: string
  searchIp: string
  order: number
  found: boolean
  error?: string
}

export function TeleportMultiConsolePage() {
  const [linkId, setLinkId] = useState('')
  const [ipText, setIpText] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [targets, setTargets] = useState<Row[]>([])
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [scriptOpen, setScriptOpen] = useState(false)
  const links = useQuery({
    queryKey: ['teleport-links'],
    queryFn: async ({ signal }) => (await apiClient.get<Link[]>('/teleport-links', { signal })).data,
  })
  const ips = useMemo(
    () => [
      ...new Set(
        ipText
          .split(/[\s,;]+/)
          .map((item) => item.trim())
          .filter(Boolean)
      ),
    ],
    [ipText]
  )
  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        accessorKey: 'order',
        header: '#',
        cell: ({ row }) => (
          <span className='text-muted-foreground'>{row.original.order}</span>
        ),
      },
      {
        accessorKey: 'searchIp',
        header: 'Search IP',
        cell: ({ row }) => (
          <span className='font-mono'>{row.original.searchIp}</span>
        ),
      },
      {
        accessorKey: 'ip',
        header: 'Teleport IP',
        cell: ({ row }) => <span className='font-mono'>{row.original.ip}</span>,
      },
      {
        accessorKey: 'name',
        header: 'Teleport node name',
        cell: ({ row }) => (
          <span className='font-medium'>{row.original.name}</span>
        ),
      },
      {
        accessorKey: 'found',
        header: 'Teleport status',
        cell: ({ row }) =>
          row.original.found ? (
            <span className='font-medium text-emerald-600 dark:text-emerald-400'>
              Found
            </span>
          ) : (
            <span className='font-medium text-destructive'>
              {row.original.error || 'Not found on Teleport'}
            </span>
          ),
      },
      {
        accessorKey: 'labels',
        header: 'Labels',
        cell: ({ row }) => (
          <span className='block max-w-md truncate text-muted-foreground'>
            {row.original.labels || '-'}
          </span>
        ),
      },
    ],
    []
  )
  const search = async () => {
    if (!linkId || !ips.length) return
    setLoading(true)
    try {
      const result: Row[][] = Array.from({ length: ips.length }, () => [])
      let cursor = 0
      const searchOne = async () => {
        while (cursor < ips.length) {
          const index = cursor++
          const searchIp = ips[index]
          try {
            const response = await apiClient.get<{ nodes: Node[] }>(
              `/teleport-links/${linkId}/tsh/nodes`,
              { params: { ip: searchIp } }
            )
            result[index] = response.data.nodes.length
              ? response.data.nodes.map((node) => ({
                  ...node,
                  searchIp,
                  order: index + 1,
                  id: `${searchIp}:${node.name}:${node.ip}`,
                  found: true,
                }))
              : [
                  {
                    id: `${searchIp}:not-found`,
                    searchIp,
                    order: index + 1,
                    ip: '—',
                    name: 'Not found',
                    labels: '',
                    found: false,
                  },
                ]
          } catch {
            result[index] = [
              {
                id: `${searchIp}:error`,
                searchIp,
                order: index + 1,
                ip: '—',
                name: 'Unavailable',
                labels: '',
                found: false,
                error: 'Could not search Teleport',
              },
            ]
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(5, ips.length) }, searchOne)
      )
      setRows(result.flat())
    } catch {
      toast.error('Could not search the selected Teleport link.')
    } finally {
      setLoading(false)
    }
  }
  return (
    <CloudPageShell
      title='Teleport Multi Console'
      description='Find Teleport nodes by IP, select targets, then open a separate multi-console workspace.'
    >
      <Card className='gap-0 py-0'>
        <CardContent className='space-y-3 p-3'>
          <div className='flex flex-col gap-3 sm:flex-row sm:items-end'>
            <div className='w-full space-y-1.5 sm:max-w-md'>
              <Label>Teleport link</Label>
              <SearchableSelect
                loading={links.isLoading}
                onValueChange={setLinkId}
                options={(links.data ?? []).map((link) => ({
                  label: link.name,
                  value: link.id,
                  description: link.url,
                }))}
                placeholder='Select Teleport link'
                searchPlaceholder='Search Teleport links...'
                value={linkId}
              />
            </div>
            <Button
              className='sm:shrink-0'
              disabled={!linkId || !ips.length || loading}
              onClick={() => void search()}
              type='button'
            >
              {loading ? <Terminal className='animate-pulse' /> : <Search />}{' '}
              Search nodes
            </Button>
          </div>
          <div className='space-y-1.5'>
            <Label>Private IPs</Label>
            <Textarea
              onChange={(event) => setIpText(event.target.value)}
              placeholder={'10.20.20.54\n10.20.20.55'}
              rows={2}
              value={ipText}
            />
          </div>
        </CardContent>
      </Card>
      <Card className='mt-3 gap-0 overflow-hidden border py-0 shadow-sm'>
        <CardContent className='p-3 sm:p-4'>
          <CloudDataTable
            columns={columns}
            data={rows}
            enableSelection
            entityName='Teleport node'
            exportFileName='teleport-nodes'
            getRowId={(row) => row.id}
            isRowSelectable={(row) => row.found}
            loading={loading}
            searchPlaceholder='Search node, IP or labels...'
            toolbar={(selected) => (
              <div className='flex gap-2'>
                <Button
                  disabled={!selected.length}
                  onClick={() => {
                    setTargets(selected)
                    setWorkspaceOpen(true)
                  }}
                  size='sm'
                  type='button'
                >
                  <MonitorPlay /> Open console ({selected.length})
                </Button>
                <Button
                  disabled={!selected.length}
                  onClick={() => {
                    setTargets(selected)
                    setScriptOpen(true)
                  }}
                  size='sm'
                  type='button'
                  variant='outline'
                >
                  <Terminal /> Terminal script
                </Button>
              </div>
            )}
          />
        </CardContent>
      </Card>
      <TeleportMultiConsoleDialog
        linkId={linkId}
        onOpenChange={setWorkspaceOpen}
        open={workspaceOpen}
        targets={targets}
      />
      <TerminalScriptDialog
        linkId={linkId}
        onOpenChange={setScriptOpen}
        open={scriptOpen}
        targets={targets}
      />
    </CloudPageShell>
  )
}
