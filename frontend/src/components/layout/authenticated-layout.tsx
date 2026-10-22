import { Outlet, useLocation } from '@tanstack/react-router'
import { FolderClosed } from 'lucide-react'
import { useCloudStore } from '@/stores/cloud-store'
import { getCookie } from '@/lib/cookies'
import { cn } from '@/lib/utils'
import { LayoutProvider } from '@/context/layout-provider'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { FrontendMemoryManager } from '@/components/frontend-memory-manager'
import { AppSidebar } from '@/components/layout/app-sidebar'
import { SkipToMain } from '@/components/skip-to-main'
import { CloudGate } from '@/features/cloud/cloud-gate'

type AuthenticatedLayoutProps = {
  children?: React.ReactNode
}

export function AuthenticatedLayout({ children }: AuthenticatedLayoutProps) {
  const defaultOpen = getCookie('sidebar_state') !== 'false'
  const project = useCloudStore((state) => state.project)
  const pageKey = useLocation({ select: (location) => `${location.pathname}#${location.hash}` })
  return (
    <>
      <FrontendMemoryManager />
      <CloudGate>
        <LayoutProvider>
          <SidebarProvider defaultOpen={defaultOpen}>
            <SkipToMain />
            <AppSidebar />
            <SidebarInset
              className={cn(
                '@container/content h-[var(--interface-viewport-height)] min-w-0 overflow-hidden md:peer-data-[variant=inset]:h-[calc(var(--interface-viewport-height)-1rem)]',
                'has-data-[layout=fixed]:h-[var(--interface-viewport-height)]',
                'peer-data-[variant=inset]:has-data-[layout=fixed]:h-[calc(var(--interface-viewport-height)-(var(--spacing)*4))]'
              )}
            >
              {project ? (
                (children ?? <Outlet key={pageKey} />)
              ) : (
                <div className='grid min-h-[var(--interface-viewport-height)] place-items-center p-6'>
                  <div className='max-w-md text-center'>
                    <div className='mx-auto mb-4 grid size-12 place-items-center rounded-xl bg-primary/10 text-primary'>
                      <FolderClosed />
                    </div>
                    <h1 className='text-xl font-semibold'>Select a project</h1>
                    <p className='mt-2 text-sm text-muted-foreground'>
                      Choose a project from the dialog to load project-scoped
                      operations.
                    </p>
                  </div>
                </div>
              )}
            </SidebarInset>
          </SidebarProvider>
        </LayoutProvider>
      </CloudGate>
    </>
  )
}
