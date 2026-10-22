import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export type ServerNetworkAddress = {
  id?: string
  ip_address: string
  subnet?: {
    id?: string
    name?: string
    display_name?: string
    cidr?: string
    region?: string
  } | null
  vip_ips: string[]
}

export type ServerNetworkDetailsData = {
  private_ips: ServerNetworkAddress[]
  elastic_ips: ServerNetworkAddress[]
}

export function ServerNetworkDetails({
  networks,
  errors = [],
}: {
  networks: ServerNetworkDetailsData
  errors?: string[]
}) {
  const rows = [
    ...networks.private_ips.map((address) => ({ ...address, type: 'Private' })),
    ...networks.elastic_ips.map((address) => ({ ...address, type: 'Elastic' })),
  ]

  return (
    <section className='min-w-0 rounded-lg border p-4 lg:col-span-2'>
      <div className='mb-3 flex items-center justify-between'>
        <h3 className='text-sm font-semibold'>Network</h3>
        <span className='text-xs text-muted-foreground'>
          {networks.private_ips.length + networks.elastic_ips.length} IPs
        </span>
      </div>
      {errors.map((error) => (
        <p
          key={error}
          role='status'
          className='mb-3 text-xs text-amber-600 dark:text-amber-400'
        >
          {error}
        </p>
      ))}
      <div className='overflow-hidden rounded-md border'>
        <Table className='text-xs' aria-label='Server network addresses'>
          <TableHeader>
            <TableRow>
              <TableHead className='h-8'>Type</TableHead>
              <TableHead className='h-8'>IP address</TableHead>
              <TableHead className='h-8'>Subnet</TableHead>
              <TableHead className='h-8'>CIDR</TableHead>
              <TableHead className='h-8'>VIP IPs</TableHead>
              <TableHead className='h-8'>Subnet ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((address, index) => (
                <TableRow
                  key={`${address.type}-${address.id || address.ip_address}-${index}`}
                >
                  <TableCell>
                    <span
                      className={
                        address.type === 'Private'
                          ? 'rounded bg-muted px-1.5 py-0.5 font-medium'
                          : 'rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary'
                      }
                    >
                      {address.type}
                    </span>
                  </TableCell>
                  <TableCell className='font-mono font-medium'>
                    {address.ip_address || 'Unavailable'}
                  </TableCell>
                  <TableCell>
                    {address.subnet?.display_name ||
                      address.subnet?.name ||
                      '—'}
                  </TableCell>
                  <TableCell className='font-mono'>
                    {address.subnet?.cidr || '—'}
                  </TableCell>
                  <TableCell className='font-mono'>
                    {address.vip_ips.join(', ') || '—'}
                  </TableCell>
                  <TableCell className='font-mono text-muted-foreground'>
                    {address.subnet?.id || '—'}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className='text-center text-muted-foreground'
                >
                  No IP returned.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
