import { useQueryClient } from '@tanstack/react-query'
import { CircleHelp, RefreshCw } from 'lucide-react'
import { useCloudStore } from '@/stores/cloud-store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { DisplaySettings } from '@/components/display-settings'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown-teleport'
import { ReleasePageCacheButton } from '@/components/release-page-cache-button'
import { ThemeSwitch } from '@/components/theme-switch'

export function CloudPageShell({
  title,
  description,
  children,
  actions,
  help,
  tableHelp = false,
  headless = false,
}: {
  title: string
  description: string
  children: React.ReactNode
  actions?: React.ReactNode
  help?: React.ReactNode
  tableHelp?: boolean
  headless?: boolean
}) {
  const queryClient = useQueryClient()
  const project = useCloudStore((state) => state.project)
  if (headless) return <>{children}</>
  return (
    <>
      <Header fixed>
        <h1 className='truncate text-base font-semibold'>{title}</h1>
        <div className='ms-auto flex items-center gap-2'>
          {actions && (
            <>
              <div
                data-slot='page-actions'
                className='flex min-w-0 items-center gap-1.5 [&>button]:h-8 [&>button]:gap-1.5 [&>button]:px-2.5 [&>button]:text-xs [&>button_svg]:size-3.5 [&>div>button]:h-8 [&>div>button]:gap-1.5 [&>div>button]:px-2.5 [&>div>button]:text-xs [&>div>button_svg]:size-3.5'
              >
                {actions}
              </div>
              <div
                aria-hidden='true'
                className='mx-0.5 h-5 w-px shrink-0 bg-border'
              />
            </>
          )}
          <Button
            variant='ghost'
            size='icon'
            className='scale-95 rounded-full'
            aria-label='Refresh page data'
            title='Refresh page data'
            onClick={() =>
              queryClient.invalidateQueries({
                queryKey: ['cloud', project?.id],
              })
            }
          >
            <RefreshCw className='size-[1.2rem]' />
            <span className='sr-only'>Refresh page data</span>
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button
                variant='ghost'
                size='icon'
                className='rounded-full'
                aria-label={`Help for ${title}`}
              >
                <CircleHelp />
              </Button>
            </DialogTrigger>
            <DialogContent className='sm:max-w-xl'>
              <DialogHeader>
                <DialogTitle>{title} help</DialogTitle>
                <DialogDescription>{description}</DialogDescription>
              </DialogHeader>
              <div className='space-y-4 text-sm'>
                {help}
                {tableHelp && (
                  <div className='rounded-lg border bg-muted/30 p-4'>
                    <p className='font-medium'>Data table usage</p>
                    <ul className='mt-2 list-disc space-y-1 ps-5 text-muted-foreground'>
                      <li>Use quick search to filter across visible data.</li>
                      <li>
                        Advanced search accepts comma-separated or
                        line-separated lists and searches one selected column.
                      </li>
                      <li>
                        Select rows to open the floating bulk-actions toolbar.
                      </li>
                      <li>Export filtered or selected results to Excel.</li>
                    </ul>
                  </div>
                )}
              </div>
            </DialogContent>
          </Dialog>
          <ReleasePageCacheButton />
          <ThemeSwitch />
          <DisplaySettings />
          <ProfileDropdown />
        </div>
      </Header>
      <Main
        fixed
        className='py-4'
      >
        <div className='flex min-h-0 flex-1 flex-col pb-2 [&>[data-slot=card]:has(.cloud-data-table-fill)]:min-h-0 [&>[data-slot=card]:has(.cloud-data-table-fill)]:flex-1 [&>[data-slot=card]:has(.cloud-data-table-fill)>[data-slot=card-content]]:flex [&>[data-slot=card]:has(.cloud-data-table-fill)>[data-slot=card-content]]:min-h-0 [&>[data-slot=card]:has(.cloud-data-table-fill)>[data-slot=card-content]]:flex-1 [&>[data-slot=card]:has(.cloud-data-table-fill)>[data-slot=card-content]]:flex-col'>
          {children}
        </div>
      </Main>
    </>
  )
}
