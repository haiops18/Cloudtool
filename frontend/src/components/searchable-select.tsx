import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

export interface SearchableOption {
  label: string
  value: string
  description?: string
}

interface SearchableSelectProps {
  ariaLabel?: string
  value: string
  onValueChange: (value: string) => void
  options?: SearchableOption[]
  placeholder?: string
  searchPlaceholder?: string
  searchValue?: string
  onSearchChange?: (value: string) => void
  emptyText?: string
  loading?: boolean
  disabled?: boolean
  className?: string
  inline?: boolean
}

export function SearchableSelect({
  ariaLabel,
  value,
  onValueChange,
  options = [],
  placeholder = 'Select an option',
  searchPlaceholder = 'Search...',
  searchValue,
  onSearchChange,
  emptyText = 'No option found.',
  loading,
  disabled,
  className,
  inline = false,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [internalSearch, setInternalSearch] = useState('')
  const selected = options.find((option) => option.value === value)
  const query = onSearchChange ? (searchValue ?? '') : internalSearch
  const visibleOptions = useMemo(() => {
    if (onSearchChange || !query.trim()) return options
    const needle = query.trim().toLowerCase()
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        option.value.toLowerCase().includes(needle) ||
        option.description?.toLowerCase().includes(needle)
    )
  }, [onSearchChange, options, query])
  const changeSearch = (next: string) => {
    if (onSearchChange) onSearchChange(next)
    else setInternalSearch(next)
  }
  const selectOption = (nextValue: string) => {
    onValueChange(nextValue)
    setOpen(false)
  }

  const panel = (
    <div
      className={cn(
        'overflow-hidden rounded-md bg-popover text-popover-foreground',
        inline && 'flex min-h-0 flex-1 flex-col'
      )}
    >
      <div className='flex h-10 items-center gap-2 border-b px-3'>
        <Search className='size-4 shrink-0 opacity-50' />
        <Input
          value={query}
          onChange={(event) => changeSearch(event.target.value)}
          placeholder={searchPlaceholder}
          disabled={disabled}
          autoFocus
          className='h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent'
        />
      </div>
      <div
        className={cn(
          'max-h-[50vh] min-h-0 overflow-y-auto overscroll-contain p-1',
          inline && 'max-h-none flex-1'
        )}
      >
        {loading ? (
          <div className='flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground'>
            <Loader2 className='size-4 animate-spin' /> Loading...
          </div>
        ) : visibleOptions.length ? (
          visibleOptions.map((option) => (
            <button
              key={option.value}
              type='button'
              aria-current={value === option.value ? 'true' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm outline-none hover:bg-accent focus:bg-accent',
                value === option.value &&
                  'bg-primary/10 font-medium text-primary ring-1 ring-primary/25 ring-inset hover:bg-primary/15 focus:bg-primary/15'
              )}
              onClick={() => selectOption(option.value)}
            >
              <Check
                className={cn(
                  'size-4 shrink-0',
                  value === option.value ? 'opacity-100' : 'opacity-0'
                )}
              />
              <span className='min-w-0'>
                <span className='block truncate'>{option.label}</span>
                {option.description && (
                  <span className='block truncate text-xs text-muted-foreground'>
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          ))
        ) : (
          <div className='py-6 text-center text-sm text-muted-foreground'>
            {emptyText}
          </div>
        )}
      </div>
    </div>
  )

  if (inline) {
    return (
      <div
        className={cn(
          'overflow-hidden rounded-md border bg-popover',
          'flex min-h-0 flex-col',
          disabled && 'pointer-events-none opacity-50',
          className
        )}
      >
        {panel}
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            'w-full justify-between font-normal',
            !selected && 'text-muted-foreground',
            className
          )}
        >
          <span className='truncate'>
            {loading ? 'Loading...' : (selected?.label ?? placeholder)}
          </span>
          {loading ? (
            <Loader2 className='ms-2 size-4 animate-spin opacity-50' />
          ) : (
            <ChevronsUpDown className='ms-2 size-4 opacity-50' />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className='w-(--radix-popover-trigger-width) p-0'
        align='start'
      >
        {panel}
      </PopoverContent>
    </Popover>
  )
}
