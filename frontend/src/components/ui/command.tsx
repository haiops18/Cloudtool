import * as React from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'

function Command(props: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      {...props}
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
        props.className
      )}
    />
  )
}

function CommandInput(
  props: React.ComponentProps<typeof CommandPrimitive.Input>
) {
  return (
    <div className='flex h-9 items-center gap-2 border-b px-3'>
      <Search className='size-4 shrink-0 opacity-50' />
      <CommandPrimitive.Input
        {...props}
        className={cn(
          'flex h-10 w-full bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground',
          props.className
        )}
      />
    </div>
  )
}

function CommandList(
  props: React.ComponentProps<typeof CommandPrimitive.List>
) {
  return (
    <CommandPrimitive.List
      {...props}
      className={cn(
        'max-h-72 overflow-x-hidden overflow-y-auto',
        props.className
      )}
    />
  )
}

function CommandEmpty(
  props: React.ComponentProps<typeof CommandPrimitive.Empty>
) {
  return (
    <CommandPrimitive.Empty className='py-6 text-center text-sm' {...props} />
  )
}

function CommandGroup(
  props: React.ComponentProps<typeof CommandPrimitive.Group>
) {
  return (
    <CommandPrimitive.Group
      {...props}
      className={cn('overflow-hidden p-1 text-foreground', props.className)}
    />
  )
}

function CommandItem(
  props: React.ComponentProps<typeof CommandPrimitive.Item>
) {
  return (
    <CommandPrimitive.Item
      {...props}
      className={cn(
        'relative flex cursor-default items-center gap-2 rounded-sm px-2 py-2 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
        props.className
      )}
    />
  )
}

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
}
