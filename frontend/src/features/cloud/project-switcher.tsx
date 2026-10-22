import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  Building2,
  ChevronsUpDown,
  FolderClosed,
  UserRound,
} from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { useCloudStore, type CloudProject } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { SearchableSelect } from '@/components/searchable-select'
import { SegmentedTabs } from '@/components/segmented-tabs'
import type { Page } from './types'

interface Organization {
  id: string
  name: string
  display_name: string
}

const identityDescription = (item: {
  id: string
  name: string
  display_name?: string
}) => `Display name: ${item.display_name || '—'} · ID: ${item.id}`

export function ProjectSwitcher() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const auth = useAuthStore((state) => state.auth)
  const token = useCloudStore((state) => state.token)
  const project = useCloudStore((state) => state.project)
  const setProject = useCloudStore((state) => state.setProject)
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<'personal' | 'organization'>('personal')
  const [organizationId, setOrganizationId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [projectSearch, setProjectSearch] = useState('')
  const [debouncedProjectSearch, setDebouncedProjectSearch] = useState('')
  const dialogOpen = open || Boolean(token && !project)

  // Keep the project restored from the cloud-authorization session visible in
  // the picker.  This is intentionally local UI state only: reopening the
  // dialog never changes the active cloud project by itself.
  useEffect(() => {
    if (dialogOpen && project?.id) setProjectId(project.id)
  }, [dialogOpen, project?.id])

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedProjectSearch(projectSearch.trim()),
      350
    )
    return () => window.clearTimeout(timeout)
  }, [projectSearch])

  const organizations = useQuery({
    queryKey: ['cloud', 'organizations'],
    enabled: Boolean(token) && dialogOpen && scope === 'organization',
    queryFn: async ({ signal }) =>
      (await apiClient.get<Page<Organization>>('/cloud/organizations', { signal })).data,
  })
  const projects = useQuery({
    queryKey: [
      'cloud',
      'projects',
      scope,
      organizationId,
      debouncedProjectSearch,
    ],
    enabled:
      Boolean(token) &&
      dialogOpen &&
      (scope === 'personal' || Boolean(organizationId)),
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<Page<CloudProject>>('/cloud/projects', {
          params: {
            organization_id: organizationId || undefined,
            q: debouncedProjectSearch || undefined,
            // The picker searches server-side, so only preload a small page.
            page_size: 50,
            picker: true,
          }, signal,
        })
      ).data,
  })

  const close = () => {
    if (project) setOpen(false)
  }
  const changeScope = (next: typeof scope) => {
    setScope(next)
    setOrganizationId('')
    setProjectId('')
    setProjectSearch('')
    setDebouncedProjectSearch('')
  }
  const chooseProject = () => {
    const selected = projects.data?.items.find((item) => item.id === projectId)
    if (!selected) return
    setProject(selected)
    void apiClient.post('/cloud-authorizations/project', {
      project_id: selected.id,
      project_name: selected.name || selected.display_name || selected.id,
    })
    setOpen(false)
  }
  const backToLogin = async () => {
    try {
      await apiClient.post('/auth/logout')
    } finally {
      auth.reset()
      useCloudStore.getState().clear()
    }
    await navigate({ to: '/sign-in', replace: true })
  }

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size='lg'
            tooltip='Change project'
            onClick={() => setOpen(true)}
          >
            <div className='flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground'>
              <FolderClosed className='size-4' />
            </div>
            <div
              className='grid min-w-0 flex-1 text-start text-sm leading-tight'
              title={
                project
                  ? `Name: ${project.name}\nDisplay name: ${project.display_name || '—'}\nID: ${project.id}`
                  : undefined
              }
            >
              <span className='truncate font-semibold' data-field='name'>
                {project?.name ?? 'Select project'}
              </span>
              <span
                className='truncate text-xs'
                data-field='display-name-and-id'
              >
                {project
                  ? `${project.display_name || '—'} · ${project.id}`
                  : 'Cloud context'}
              </span>
            </div>
            <ChevronsUpDown className='ms-auto size-4' />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>

      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
      >
        <DialogContent
          className='flex h-[min(84svh,44rem)] max-h-[calc(100svh-2rem)] flex-col !overflow-hidden sm:!w-[48vw] sm:!max-w-[48vw]'
          onEscapeKeyDown={(event) => !project && event.preventDefault()}
          onInteractOutside={(event) => !project && event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Select cloud project</DialogTitle>
            <DialogDescription>
              Switch context without re-entering your private token. All screens
              update automatically after you confirm.
            </DialogDescription>
          </DialogHeader>
          <div className='flex min-h-0 flex-1 flex-col py-2'>
            <div className='shrink-0 space-y-5'>
              <SegmentedTabs
                value={scope}
                onValueChange={changeScope}
                tabs={[
                  {
                    value: 'personal',
                    label: (
                      <>
                        <UserRound />
                        Personal
                      </>
                    ),
                  },
                  {
                    value: 'organization',
                    label: (
                      <>
                        <Building2 />
                        Organization
                      </>
                    ),
                  },
                ]}
              />
              {scope === 'organization' && (
                <div className='space-y-2'>
                  <p className='text-sm font-medium'>Organization</p>
                  <SearchableSelect
                    value={organizationId}
                    onValueChange={(value) => {
                      setOrganizationId(value)
                      setProjectId('')
                      setProjectSearch('')
                      setDebouncedProjectSearch('')
                    }}
                    loading={organizations.isLoading}
                    placeholder='Select organization'
                    searchPlaceholder='Search organizations...'
                    options={organizations.data?.items.map((item) => ({
                      value: item.id,
                      label: item.name || item.display_name || item.id,
                      description: identityDescription(item),
                    }))}
                  />
                </div>
              )}
            </div>
            <div className='mt-5 flex min-h-0 flex-1 flex-col space-y-2'>
              <p className='text-sm font-medium'>Project</p>
              <SearchableSelect
                inline
                value={projectId}
                onValueChange={setProjectId}
                loading={projects.isLoading}
                disabled={scope === 'organization' && !organizationId}
                placeholder='Select project'
                searchPlaceholder='Search projects...'
                searchValue={projectSearch}
                onSearchChange={setProjectSearch}
                emptyText='No project found.'
                className='min-h-0 flex-1'
                options={projects.data?.items.map((item) => ({
                  value: item.id,
                  label: item.name || item.display_name || item.id,
                  description: identityDescription(item),
                }))}
              />
            </div>
            {(projects.isError || organizations.isError) && (
              <p className='mt-3 shrink-0 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive'>
                Cloud data could not be loaded. Check the private token or try
                again.
              </p>
            )}
          </div>
          <DialogFooter className='shrink-0 border-t pt-4'>
            <Button variant='ghost' onClick={() => void backToLogin()}>
              Back to login
            </Button>
            <Button
              variant='outline'
              className='mr-auto'
              onClick={async () => {
                try {
                  await apiClient.post('/cloud-authorizations/clear')
                } catch {
                  // Clearing the local context below prevents any stale cloud
                  // data from remaining visible if this request was interrupted.
                }
                await queryClient.cancelQueries({
                  predicate: (query) => {
                    const key = String(query.queryKey[0] ?? '')
                    return [
                      'cloud',
                      'server-create',
                      'server-create-temp-draft',
                      'server-create-quota-review',
                    ].includes(key)
                  },
                })
                queryClient.removeQueries({
                  predicate: (query) => {
                    const key = String(query.queryKey[0] ?? '')
                    return [
                      'cloud',
                      'server-create',
                      'server-create-temp-draft',
                      'server-create-quota-review',
                    ].includes(key)
                  },
                })
                useCloudStore.getState().clear()
                setScope('personal')
                setOrganizationId('')
                setProjectId('')
                setProjectSearch('')
                setDebouncedProjectSearch('')
                setOpen(false)
              }}
            >
              Change Cloud Authorization
            </Button>
            {project && (
              <Button variant='outline' onClick={() => setOpen(false)}>
                Cancel
              </Button>
            )}
            <Button disabled={!projectId} onClick={chooseProject}>
              Use this project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
