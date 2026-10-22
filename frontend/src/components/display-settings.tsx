import { useEffect, useState } from 'react'
import '@/styles/display-scale.css'
import { LayoutPanelLeft, PanelLeft, RotateCcw, Settings } from 'lucide-react'
import { useLayout, type Collapsible } from '@/context/layout-provider'
import { useTheme } from '@/context/theme-provider'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { useSidebar } from '@/components/ui/sidebar'

function OptionGroup({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className='space-y-2'>
      <p className='text-sm font-semibold text-muted-foreground'>{title}</p>
      <div className='grid grid-cols-3 gap-2'>{children}</div>
    </div>
  )
}

const DISPLAY_SCALE_STORAGE_KEY = 'cloudtool-display-scale'
const MIN_DISPLAY_SCALE = 0.4
const MAX_DISPLAY_SCALE = 1.5

function initialDisplayScale() {
  if (typeof window === 'undefined') return 1
  const saved = Number(window.localStorage.getItem(DISPLAY_SCALE_STORAGE_KEY))
  return Number.isFinite(saved) &&
    saved >= MIN_DISPLAY_SCALE &&
    saved <= MAX_DISPLAY_SCALE
    ? saved
    : 1
}

export function DisplaySettings() {
  const { open, setOpen } = useSidebar()
  const { theme, setTheme, resetTheme } = useTheme()
  const { variant, setVariant, collapsible, setCollapsible, resetLayout } =
    useLayout()
  const [displayScale, setDisplayScale] = useState(initialDisplayScale)
  useEffect(() => {
    const updateViewportBounds = () => {
      const root = document.documentElement
      const logicalHeight = window.innerHeight / displayScale
      const logicalWidth = window.innerWidth / displayScale
      root.style.setProperty(
        '--interface-viewport-height',
        `${logicalHeight}px`
      )
      root.style.setProperty('--interface-viewport-width', `${logicalWidth}px`)
      root.style.setProperty(
        '--interface-table-max-height',
        `${Math.min(window.innerHeight * 0.62, 640) / displayScale}px`
      )
      root.style.setProperty(
        '--interface-dialog-max-height',
        `${(window.innerHeight * 0.84) / displayScale}px`
      )
      root.style.setProperty(
        '--interface-dialog-top',
        `${(window.innerHeight * 0.08) / displayScale}px`
      )
      root.style.setProperty('--interface-page-inset', `${16 / displayScale}px`)
    }
    const timer = window.setTimeout(() => {
      const root = document.documentElement
      root.style.zoom = String(displayScale)
      root.style.setProperty('--interface-scale', String(displayScale))
      root.dataset.interfaceScaled = displayScale === 1 ? 'false' : 'true'
      updateViewportBounds()
      window.localStorage.setItem(
        DISPLAY_SCALE_STORAGE_KEY,
        String(displayScale)
      )
      // Radix poppers listen for resize to remeasure their collision boundary.
      // Trigger it after zoom changes so menus stay attached to their trigger.
      window.requestAnimationFrame(() =>
        window.dispatchEvent(new Event('resize'))
      )
    }, 1_000)
    window.addEventListener('resize', updateViewportBounds)
    window.visualViewport?.addEventListener('resize', updateViewportBounds)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', updateViewportBounds)
      window.visualViewport?.removeEventListener('resize', updateViewportBounds)
    }
  }, [displayScale])
  const reset = () => {
    setOpen(true)
    resetTheme()
    resetLayout()
    setDisplayScale(1)
  }
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          size='icon'
          variant='ghost'
          className='rounded-full'
          aria-label='Open display settings'
        >
          <Settings />
        </Button>
      </SheetTrigger>
      <SheetContent className='flex flex-col'>
        <SheetHeader>
          <SheetTitle>Display settings</SheetTitle>
          <SheetDescription>
            Adjust theme, sidebar style and navigation behavior.
          </SheetDescription>
        </SheetHeader>
        <div className='space-y-6 overflow-y-auto px-4'>
          <OptionGroup title='Theme'>
            {(['system', 'light', 'dark'] as const).map((value) => (
              <Button
                key={value}
                variant={theme === value ? 'default' : 'outline'}
                onClick={() => setTheme(value)}
                className='capitalize'
              >
                {value}
              </Button>
            ))}
          </OptionGroup>
          <div className='space-y-3'>
            <div className='flex items-center justify-between'>
              <p className='text-sm font-semibold text-muted-foreground'>
                Interface scale
              </p>
              <span className='rounded-md border bg-muted px-2 py-0.5 text-sm font-medium'>
                {Math.round(displayScale * 100)}%
              </span>
            </div>
            <input
              type='range'
              min={MIN_DISPLAY_SCALE * 100}
              max={MAX_DISPLAY_SCALE * 100}
              step='1'
              value={Math.round(displayScale * 100)}
              onChange={(event) =>
                setDisplayScale(Number(event.target.value) / 100)
              }
              className='w-full accent-primary'
              aria-label='Interface scale'
            />
            <div className='flex justify-between text-xs text-muted-foreground'>
              <span>40%</span>
              <span>100%</span>
              <span>150%</span>
            </div>
          </div>
          <OptionGroup title='Sidebar style'>
            {(['inset', 'floating', 'sidebar'] as const).map((value) => (
              <Button
                key={value}
                variant={variant === value ? 'default' : 'outline'}
                onClick={() => setVariant(value)}
                className='capitalize'
              >
                <PanelLeft />
                {value}
              </Button>
            ))}
          </OptionGroup>
          <OptionGroup title='Navigation layout'>
            <Button
              variant={open ? 'default' : 'outline'}
              onClick={() => setOpen(true)}
            >
              <LayoutPanelLeft />
              Default
            </Button>
            {(['icon', 'offcanvas'] as Collapsible[]).map((value) => (
              <Button
                key={value}
                variant={!open && collapsible === value ? 'default' : 'outline'}
                onClick={() => {
                  setCollapsible(value)
                  setOpen(false)
                }}
                className='capitalize'
              >
                <LayoutPanelLeft />
                {value === 'icon' ? 'Compact' : 'Full'}
              </Button>
            ))}
          </OptionGroup>
        </div>
        <SheetFooter>
          <Button variant='destructive' onClick={reset}>
            <RotateCcw />
            Reset display settings
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
