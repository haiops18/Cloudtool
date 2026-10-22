import type { Column } from '@tanstack/react-table'
import { ArrowUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function SortableHeader<T>({
  column,
  title,
}: {
  column: Column<T>
  title: string
}) {
  return (
    <Button
      variant='ghost'
      className='-ms-3 h-8'
      onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
    >
      {title}
      <ArrowUpDown className='ms-2 size-4' />
    </Button>
  )
}
