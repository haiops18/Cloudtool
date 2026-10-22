import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface SegmentedTab<T extends string> {
  value: T
  label: ReactNode
}

export function SegmentedTabs<T extends string>({
  value,
  onValueChange,
  tabs,
  className,
}: {
  value: T
  onValueChange: (value: T) => void
  tabs: SegmentedTab<T>[]
  className?: string
}) {
  return (
    <div
      role='tablist'
      className={cn(
        'grid h-9 shrink-0 items-center gap-1 rounded-lg border border-border/70 bg-muted/40 p-0.75',
        className
      )}
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
    >
      {tabs.map((tab) => {
        const active = tab.value === value
        return (
          <Button
            key={tab.value}
            type='button'
            role='tab'
            aria-selected={active}
            variant='ghost'
            className={cn(
              'h-full min-w-0 gap-1.5 rounded-md border px-2.5 py-0 text-xs leading-none transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:ring-2 sm:text-[13px]',
              active
                ? 'border-primary bg-primary font-semibold text-primary-foreground shadow-sm hover:bg-primary hover:text-primary-foreground dark:hover:bg-primary'
                : 'border-transparent font-medium text-muted-foreground hover:border-border hover:bg-primary/10 hover:text-foreground dark:hover:bg-primary/10'
            )}
            onClick={() => onValueChange(tab.value)}
          >
            {tab.label}
          </Button>
        )
      })}
    </div>
  )
}
