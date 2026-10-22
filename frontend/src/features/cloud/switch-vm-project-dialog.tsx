import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, Loader2 } from 'lucide-react'
import { useCloudStore, type CloudProject } from '@/stores/cloud-store'
import { apiClient } from '@/lib/api-client'
import { ConfirmDialog } from '@/components/confirm-dialog'

export function SwitchVmProjectDialog({
  project,
  serverName,
  onClose,
  onComplete,
}: {
  project: CloudProject
  serverName: string
  onClose: () => void
  onComplete: () => void
}) {
  const queryClient = useQueryClient()
  const currentProject = useCloudStore((state) => state.project)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const switching = useRef(false)
  const confirm = async () => {
    if (switching.current) return
    switching.current = true
    setPending(true)
    setError('')
    try {
      // Persist the session project before reloading: CloudGate restores it on startup.
      await apiClient.post(
        '/cloud-authorizations/project',
        {
          project_id: project.id,
          project_name: project.name || project.display_name || project.id,
        },
        { headers: { 'X-Project-Id': project.id } }
      )
      await queryClient.cancelQueries({ queryKey: ['cloud'] })
      queryClient.removeQueries({ queryKey: ['cloud'] })
      useCloudStore.getState().setProject(project)
      onComplete()
    } catch (failure) {
      const detail = (failure as { response?: { data?: { detail?: unknown } } })
        .response?.data?.detail
      setError(
        typeof detail === 'string'
          ? detail
          : 'Unable to switch project. Please try again.'
      )
      switching.current = false
      setPending(false)
    }
  }
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open && !switching.current) onClose()
      }}
      title='Switch to this VM’s project?'
      desc={
        <>
          The entire application will switch to the project of{' '}
          <strong>{serverName}</strong> and reload after confirmation.
        </>
      }
      confirmText={
        <>
          {pending ? <Loader2 className='animate-spin' /> : <ArrowRightLeft />}
          {pending ? 'Switching project…' : 'Switch project and reload'}
        </>
      }
      isLoading={pending}
      handleConfirm={() => void confirm()}
    >
      <div className='space-y-3 rounded-lg border bg-muted/30 p-3 text-sm'>
        {currentProject && (
          <div>
            <p className='text-xs text-muted-foreground'>Current project</p>
            <p className='font-medium break-words'>
              {currentProject.display_name || currentProject.name}
            </p>
            <p className='font-mono text-xs break-all text-muted-foreground'>
              {currentProject.id}
            </p>
          </div>
        )}
        <div>
          <p className='text-xs text-muted-foreground'>Destination project</p>
          <p className='font-medium break-words'>
            {project.display_name || project.name || project.id}
          </p>
          <p className='font-mono text-xs break-all'>{project.id}</p>
        </div>
      </div>
      {error && (
        <p role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      )}
    </ConfirmDialog>
  )
}
