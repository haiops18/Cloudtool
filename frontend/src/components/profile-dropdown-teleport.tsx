import { LogIn } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/auth-store'
import useDialogState from '@/hooks/use-dialog-state'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SignOutDialog } from '@/components/sign-out-dialog'
import { TeleportLoginDialog } from '@/components/teleport-login-dialog'
import { apiClient } from '@/lib/api-client'

type TshSession = {
  id: string
  endpoint_name: string
  endpoint_url: string
  username: string
  cluster?: string | null
  valid_until?: string | null
  valid_for?: string | null
}

/** Profile menu used by all application header bars. */
export function ProfileDropdown() {
  const [signOutOpen, setSignOutOpen] = useDialogState()
  const [teleportOpen, setTeleportOpen] = useDialogState()
  const user = useAuthStore((state) => state.auth.user)
  const tshSessions = useQuery({
    queryKey: ['teleport-links', 'tsh-sessions'],
    retry: false,
    queryFn: async () =>
      (await apiClient.get<TshSession[]>('/teleport-links/tsh/sessions')).data,
  })
  const name = user?.full_name ?? 'Platform user'
  const initials = name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant='ghost' className='relative h-8 w-8 rounded-full'>
            <Avatar className='h-8 w-8'>
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className='w-56' align='end' forceMount>
          <DropdownMenuLabel className='font-normal'>
            <div className='flex flex-col gap-1.5'>
              <p className='text-sm leading-none font-medium'>{name}</p>
              <p className='text-xs leading-none text-muted-foreground'>
                {user?.email ?? ''}
              </p>
              {tshSessions.data?.length ? (
                <div className='mt-2 border-t pt-2'>
                  <p className='mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase'>
                    Teleport tsh sessions
                  </p>
                  <div className='space-y-1.5'>
                    {tshSessions.data.map((session) => (
                      <div key={session.id} className='min-w-0'>
                        <p className='truncate text-xs'>
                          <span className='font-medium'>{session.username}</span>
                          <span className='text-muted-foreground'> · {session.endpoint_name}</span>
                        </p>
                        {session.valid_until && (
                          <p className='truncate text-[11px] text-muted-foreground'>
                            Expires {session.valid_until}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setTeleportOpen(true)}>
            <LogIn />
            Login Teleport
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant='destructive'
            onClick={() => setSignOutOpen(true)}
          >
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SignOutDialog open={!!signOutOpen} onOpenChange={setSignOutOpen} />
      <TeleportLoginDialog
        open={!!teleportOpen}
        onOpenChange={setTeleportOpen}
      />
    </>
  )
}
