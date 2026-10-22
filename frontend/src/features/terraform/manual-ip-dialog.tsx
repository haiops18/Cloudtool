import { useRef, useState } from 'react'
import { isAxiosError } from 'axios'
import { useMutation } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { type IpAllocation, type ManualIpResult } from './manual-ip-allocations'
import type { TerraformServerDraft } from './types'

function AllocationCell({
  allocation,
  requested,
}: {
  allocation?: IpAllocation
  requested: boolean
}) {
  if (allocation?.status === 'completed')
    return (
      <div className='space-y-1'>
        <p className='font-mono'>{allocation.ip_address}</p>
        <Badge variant='secondary'>Created & linked</Badge>
      </div>
    )
  if (allocation?.status === 'failed')
    return (
      <p className='max-w-64 text-xs text-destructive'>
        {allocation.error || 'Failed'}
      </p>
    )
  return (
    <span className='text-muted-foreground'>
      {requested ? 'Ready to create' : 'Unchanged'}
    </span>
  )
}

export function ManualIpDialog({
  servers,
  projectId,
  onApply,
  onClose,
}: {
  servers: TerraformServerDraft[]
  projectId: string
  onApply: (results: ManualIpResult[]) => void
  onClose: () => void
}) {
  const [results, setResults] = useState<Map<string, ManualIpResult>>(new Map())
  const [maxAttempts, setMaxAttempts] = useState(5)
  const [requestError, setRequestError] = useState('')
  const [hasUnresolvedRequest, setHasUnresolvedRequest] = useState(false)
  const requestRef = useRef<{
    request_id: string
    max_attempts: number
    items: Array<{
      server_draft_id: string
      server_name: string
      subnet_id: string
      region_id: string
      zone_id: string
      create_private: boolean
      create_elastic: boolean
    }>
  } | null>(null)
  const pending = servers
    .map((server) => ({
      server_draft_id: server.id,
      server_name: server.name,
      subnet_id: server.subnet_id,
      region_id: server.region_id,
      zone_id: server.zone_id,
      create_private:
        server.private_ip_mode === 'manual' &&
        results.get(server.id)?.private?.status !== 'completed',
      create_elastic:
        server.elastic_ip_mode === 'manual' &&
        results.get(server.id)?.elastic?.status !== 'completed',
    }))
    .filter((item) => item.create_private || item.create_elastic)
  const create = useMutation({
    mutationFn: async () => {
      requestRef.current ??= {
        request_id: crypto.randomUUID(),
        items: pending,
        max_attempts: maxAttempts,
      }
      setHasUnresolvedRequest(true)
      return (
        await apiClient.post<{ items: ManualIpResult[] }>(
          '/cloud/ip-allocations/create-manual',
          requestRef.current,
          {
            headers: { 'X-Project-Id': projectId },
            timeout: 300_000,
          }
        )
      ).data.items
    },
    retry: false,
    onSuccess: (items) => {
      setResults((previous) => {
        const next = new Map(previous)
        for (const item of items)
          next.set(item.server_draft_id, {
            ...next.get(item.server_draft_id),
            ...item,
            private: item.private || next.get(item.server_draft_id)?.private,
            elastic: item.elastic || next.get(item.server_draft_id)?.elastic,
          })
        return next
      })
      onApply(items)
      requestRef.current = null
      setHasUnresolvedRequest(false)
      setRequestError('')
      const count = items.reduce(
        (sum, item) =>
          sum +
          Number(item.private?.status === 'completed') +
          Number(item.elastic?.status === 'completed'),
        0
      )
      if (count)
        toast.success(
          `${count} IP(s) created and linked to the selected drafts.`
        )
    },
    onError: (error) => {
      // Validation/access failures are definite failures before allocation.
      if (
        isAxiosError(error) &&
        error.response &&
        [400, 401, 403, 422, 503].includes(error.response.status)
      ) {
        requestRef.current = null
        setHasUnresolvedRequest(false)
      }
      const detail = isAxiosError(error)
        ? (error.response?.data?.detail ?? error.response?.data)
        : undefined
      const displayed = detail?.upstream_detail || detail
      const message = displayed
        ? typeof displayed === 'string'
          ? displayed
          : JSON.stringify(displayed)
        : error instanceof Error
          ? error.message
          : 'IP creation failed'
      setRequestError(message)
      toast.error(message)
    },
  })
  return (
    <Dialog
      open
      onOpenChange={(open) =>
        !open && !create.isPending && !requestRef.current && onClose()
      }
    >
      <DialogContent className='sm:max-w-4xl'>
        <DialogHeader>
          <DialogTitle>Manual create · Private & Elastic IPs</DialogTitle>
          <DialogDescription>
            Create IP resources for {servers.length} selected VM drafts. New
            private addresses are randomly chosen from unused subnet addresses;
            Cloud allocates Elastic IPs from the region pool.
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-wrap items-center gap-3 rounded-md border bg-muted/20 p-3'>
          <Label htmlFor='manual-ip-attempts'>
            Private IP conflict attempts
          </Label>
          <Input
            id='manual-ip-attempts'
            className='h-8 w-20'
            type='number'
            min={1}
            max={20}
            disabled={create.isPending || hasUnresolvedRequest}
            value={maxAttempts}
            onChange={(event) =>
              setMaxAttempts(
                Math.max(1, Math.min(20, Number(event.target.value) || 1))
              )
            }
          />
          <p className='basis-full text-xs text-muted-foreground'>
            Existing IPs are never reused. Successful allocations are linked
            immediately and switch the draft to Select existing. Retry creates
            only the failed IP types; this does not create any VM.
          </p>
        </div>
        {requestError && (
          <p role='alert' className='text-sm text-destructive'>
            {requestError} · Retry request to recover its results.
          </p>
        )}
        <div className='max-h-[48vh] overflow-auto rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>VM</TableHead>
                <TableHead>Subnet / Region</TableHead>
                <TableHead>Private IP</TableHead>
                <TableHead>Elastic IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.map((server) => (
                <TableRow key={server.id}>
                  <TableCell className='font-medium'>{server.name}</TableCell>
                  <TableCell>
                    <p>{server.subnet_display_name}</p>
                    <p className='text-xs text-muted-foreground'>
                      {server.zone_name}
                    </p>
                  </TableCell>
                  <TableCell>
                    <AllocationCell
                      allocation={results.get(server.id)?.private}
                      requested={server.private_ip_mode === 'manual'}
                    />
                  </TableCell>
                  <TableCell>
                    <AllocationCell
                      allocation={results.get(server.id)?.elastic}
                      requested={server.elastic_ip_mode === 'manual'}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            disabled={create.isPending || hasUnresolvedRequest}
            onClick={onClose}
          >
            {results.size ? 'Done' : 'Cancel'}
          </Button>
          <Button
            disabled={create.isPending || !pending.length}
            onClick={() => create.mutate()}
          >
            {create.isPending && <Loader2 className='animate-spin' />}
            {create.isPending
              ? 'Creating IPs...'
              : hasUnresolvedRequest
                ? 'Retry request'
                : results.size
                  ? 'Retry failed IPs'
                  : 'Create IPs'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
