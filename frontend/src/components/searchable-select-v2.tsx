import * as React from 'react'
import { Check, ChevronsUpDown, Loader } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

type SearchableSelectV2Props = {
  onValueChange?: (value: string) => void
  defaultValue?: string
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  isPending?: boolean
  items?: {
    label: string
    value: string
    keywords?: string[]
    description?: string
  }[]
  disabled?: boolean
  className?: string
  contentClassName?: string
  listClassName?: string
  isControlled?: boolean
  multiple?: boolean
  values?: string[]
  onValuesChange?: (values: string[]) => void
  onOpenChange?: (open: boolean) => void
  allItemsLabel?: string
  ariaLabel?: string
}

/**
 * Searchable combobox matching TemplateWeb's Settings > Account language picker.
 * This stays separate from the legacy SearchableSelect during the gradual migration.
 */
export function SearchableSelectV2({
  defaultValue,
  onValueChange,
  isPending = false,
  items = [],
  placeholder = 'Select',
  searchPlaceholder = 'Search...',
  emptyMessage = 'No matching option found.',
  disabled = false,
  className = '',
  contentClassName,
  listClassName,
  isControlled = false,
  multiple = false,
  values = [],
  onValuesChange,
  onOpenChange,
  allItemsLabel = 'All',
  ariaLabel,
}: SearchableSelectV2Props) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue)
  const value = isControlled ? defaultValue : uncontrolledValue
  const selectedItem = items.find((item) => item.value === value)
  const selectedValues = React.useMemo(() => new Set(values), [values])
  const visibleItems = React.useMemo(() => {
    if (!multiple) return items
    const search = query.trim().toLocaleLowerCase()
    const selected: typeof items = []
    const remaining: typeof items = []
    for (const item of items) {
      if (
        !`${item.label} ${item.value} ${(item.keywords ?? []).join(' ')}`
          .toLocaleLowerCase()
          .includes(search)
      )
        continue
      if (selectedValues.has(item.value)) selected.push(item)
      else remaining.push(item)
    }
    return [...selected, ...remaining]
  }, [items, multiple, query, selectedValues])

  const selectItem = (nextValue: string) => {
    if (multiple) {
      onValuesChange?.(
        values.includes(nextValue)
          ? values.filter((value) => value !== nextValue)
          : [...values, nextValue]
      )
      return
    }
    if (!isControlled) setUncontrolledValue(nextValue)
    onValueChange?.(nextValue)
    handleOpenChange(false)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    onOpenChange?.(nextOpen)
    if (!nextOpen) setQuery('')
  }

  return (
    <Popover modal open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-label={ariaLabel}
          aria-expanded={open}
          disabled={disabled || isPending}
          className={cn(
            'w-full justify-between font-normal',
            !selectedItem && !multiple && 'text-muted-foreground',
            className
          )}
        >
          <span className='min-w-0 truncate'>
            {multiple
              ? values.length === 0
                ? allItemsLabel
                : values.length === 1
                  ? (items.find((item) => item.value === values[0])?.label ??
                    values[0])
                  : `${values.length} selected`
              : (selectedItem?.label ?? placeholder)}
          </span>
          {isPending ? (
            <Loader className='size-4 animate-spin opacity-60' />
          ) : (
            <ChevronsUpDown className='size-4 opacity-50' />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className={cn('w-(--radix-popover-trigger-width) p-0', contentClassName)}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          requestAnimationFrame(() => {
            content.querySelector<HTMLInputElement>('[cmdk-input]')?.focus()
          })
        }}
      >
        <Command shouldFilter={!multiple}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className={listClassName}>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {multiple &&
                allItemsLabel
                  .toLocaleLowerCase()
                  .includes(query.trim().toLocaleLowerCase()) && (
                  <CommandItem
                    value={allItemsLabel}
                    onSelect={() => onValuesChange?.([])}
                  >
                    <Check
                      className={cn(
                        'size-4',
                        values.length === 0 ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    {allItemsLabel}
                  </CommandItem>
                )}
              {visibleItems.map((item) => (
                <CommandItem
                  key={item.value}
                  value={multiple ? `${item.label} ${item.value}` : item.label}
                  keywords={item.keywords}
                  aria-label={item.description ? item.label : undefined}
                  aria-description={item.description}
                  onSelect={() => selectItem(item.value)}
                >
                  <Check
                    className={cn(
                      'size-4',
                      (
                        multiple
                          ? selectedValues.has(item.value)
                          : item.value === value
                      )
                        ? 'opacity-100'
                        : 'opacity-0'
                    )}
                  />
                  {item.description ? (
                    <span className='min-w-0 flex-1'>
                      <span className='block truncate' title={item.label}>
                        {item.label}
                      </span>
                      {item.description && (
                        <span className='mt-0.5 block text-xs leading-4 break-words whitespace-pre-line text-muted-foreground'>
                          {item.description}
                        </span>
                      )}
                    </span>
                  ) : (
                    item.label
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {multiple && (
          <div className='flex justify-between gap-2 border-t p-2'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              disabled={values.length === 0}
              onClick={() => {
                onValuesChange?.([])
                setQuery('')
              }}
            >
              Clear all
            </Button>
            <Button
              type='button'
              size='sm'
              onClick={() => handleOpenChange(false)}
            >
              Apply
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
