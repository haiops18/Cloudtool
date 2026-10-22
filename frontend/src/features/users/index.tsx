import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CloudDataTable } from '@/components/cloud-data-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SearchableSelect } from '@/components/searchable-select'
import { SortableHeader } from '@/components/sortable-header'
import { CloudPageShell } from '@/features/cloud/page-shell'

type UserRole = 'admin' | 'operator' | 'viewer'
type CloudAccess = 'read' | 'full'

interface LocalUser {
  id: string
  email: string
  username: string
  full_name: string
  role: UserRole
  is_active: boolean
  permissions: string[]
  cloud_api_access: CloudAccess
  created_at?: string
}

interface UserPage {
  items: LocalUser[]
  total: number
}

interface UserForm {
  username: string
  email: string
  full_name: string
  password: string
  role: UserRole
  is_active: boolean
  permissions: string[]
  cloud_api_access: CloudAccess
}

const featureOptions = [
  ['servers', 'Servers'],
  ['private_ips', 'Private IPs'],
  ['security_groups', 'Security Groups'],
  ['audit_logs', 'Audit and API logs'],
  ['password_profiles', 'Password profiles'],
  ['user_management', 'Local user management'],
] as const

const operatorPermissions = featureOptions
  .map(([value]) => value)
  .filter((value) => value !== 'user_management')

const emptyForm = (): UserForm => ({
  username: '',
  email: '',
  full_name: '',
  password: '',
  role: 'operator',
  is_active: true,
  permissions: operatorPermissions,
  cloud_api_access: 'full',
})

function roleDefaults(role: UserRole) {
  if (role === 'admin')
    return {
      permissions: featureOptions.map(([value]) => value),
      cloud_api_access: 'full' as const,
    }
  if (role === 'operator')
    return {
      permissions: operatorPermissions,
      cloud_api_access: 'full' as const,
    }
  return {
    permissions: ['servers', 'private_ips', 'audit_logs'],
    cloud_api_access: 'read' as const,
  }
}

export function LocalUsersPage() {
  const queryClient = useQueryClient()
  const currentUser = useAuthStore((state) => state.auth.user)
  const currentRole =
    typeof currentUser?.role === 'string'
      ? currentUser.role
      : currentUser?.role.name
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<LocalUser>()
  const [deleting, setDeleting] = useState<LocalUser>()
  const [form, setForm] = useState<UserForm>(emptyForm)

  const users = useQuery({
    queryKey: ['local-users'],
    enabled: currentRole === 'admin',
    queryFn: async ({ signal }) =>
      (await apiClient.get<UserPage>('/users', { params: { page_size: 200 }, signal }))
        .data,
  })

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        ...form,
        password: form.password || undefined,
      }
      return editing
        ? apiClient.patch(`/users/${editing.id}`, payload)
        : apiClient.post('/users', payload)
    },
    onSuccess: async () => {
      setEditorOpen(false)
      setEditing(undefined)
      setForm(emptyForm())
      await queryClient.invalidateQueries({ queryKey: ['local-users'] })
      toast.success(
        editing ? 'User updated successfully.' : 'User created successfully.'
      )
    },
    onError: () =>
      toast.error('The user could not be saved. Check the entered data.'),
  })

  const remove = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/users/${id}`),
    onSuccess: async () => {
      setDeleting(undefined)
      await queryClient.invalidateQueries({ queryKey: ['local-users'] })
      toast.success('User deleted successfully.')
    },
    onError: () =>
      toast.error(
        'The user could not be deleted. Keep at least one active administrator.'
      ),
  })

  const openCreate = () => {
    setEditing(undefined)
    setForm(emptyForm())
    setEditorOpen(true)
  }

  const openEdit = (user: LocalUser) => {
    setEditing(user)
    setForm({
      username: user.username,
      email: user.email,
      full_name: user.full_name,
      password: '',
      role: user.role,
      is_active: user.is_active,
      permissions: user.permissions.filter((permission) => permission !== 'attach_private_ips'),
      cloud_api_access: user.cloud_api_access,
    })
    setEditorOpen(true)
  }

  const columns = useMemo<ColumnDef<LocalUser>[]>(
    () => [
      {
        accessorKey: 'full_name',
        header: ({ column }) => <SortableHeader column={column} title='User' />,
        cell: ({ row }) => (
          <div>
            <p className='font-medium'>{row.original.full_name}</p>
            <p className='text-xs text-muted-foreground'>
              {row.original.username} · {row.original.email}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'role',
        header: ({ column }) => <SortableHeader column={column} title='Role' />,
        cell: ({ getValue }) => (
          <span className='capitalize'>{getValue() as string}</span>
        ),
      },
      {
        accessorKey: 'cloud_api_access',
        header: ({ column }) => (
          <SortableHeader column={column} title='Cloud API access' />
        ),
        cell: ({ getValue }) =>
          getValue() === 'full' ? 'Full API access' : 'GET requests only',
      },
      {
        id: 'permissions',
        accessorFn: (row) => row.permissions.join(', '),
        header: ({ column }) => (
          <SortableHeader column={column} title='Functions' />
        ),
        cell: ({ row }) => `${row.original.permissions.length} enabled`,
      },
      {
        accessorKey: 'is_active',
        header: ({ column }) => (
          <SortableHeader column={column} title='Status' />
        ),
        cell: ({ getValue }) =>
          (getValue() as boolean) ? 'Active' : 'Disabled',
      },
      {
        id: 'actions',
        enableHiding: false,
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant='ghost' size='icon' aria-label='User actions'>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end'>
              <DropdownMenuItem onClick={() => openEdit(row.original)}>
                <Pencil /> Edit user
              </DropdownMenuItem>
              <DropdownMenuItem
                variant='destructive'
                disabled={row.original.id === currentUser?.id}
                onClick={() => setDeleting(row.original)}
              >
                <Trash2 /> Delete user
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [currentUser?.id]
  )

  if (currentRole !== 'admin')
    return (
      <CloudPageShell
        title='Local users'
        description='Manage local CloudTool accounts.'
      >
        <Card>
          <CardContent className='py-16 text-center text-sm text-muted-foreground'>
            Administrator permission is required to manage local users.
          </CardContent>
        </Card>
      </CloudPageShell>
    )

  return (
    <CloudPageShell
      title='Local users'
      description='Manage CloudTool accounts, function permissions and Cloud API access.'
      tableHelp
      help={
        <p className='text-muted-foreground'>
          Function permissions control visible modules and backend access. Cloud
          API access limits an account to GET requests or allows all supported
          methods.
        </p>
      }
      actions={
        <Button onClick={openCreate}>
          <Plus /> Add user
        </Button>
      }
    >
      <Card>
        <CardContent>
          <CloudDataTable
            data={users.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={users.isLoading}
            entityName='user'
            exportFileName='local-users'
            searchPlaceholder='Search name, email, role or permission...'
            toolbar={(selected) => (
              <span className='px-2 text-sm text-muted-foreground'>
                {selected.length} user(s) selected
              </span>
            )}
          />
        </CardContent>
      </Card>

      <Dialog
        open={editorOpen}
        onOpenChange={(open) => !save.isPending && setEditorOpen(open)}
      >
        <DialogContent className='sm:!max-w-3xl'>
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Edit local user' : 'Add local user'}
            </DialogTitle>
            <DialogDescription>
              Configure account details, allowed functions and Cloud API method
              access.
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-4 sm:grid-cols-2'>
            <div className='space-y-2'>
              <Label htmlFor='local-user-username'>Username</Label>
              <Input
                id='local-user-username'
                autoComplete='username'
                value={form.username}
                onChange={(event) =>
                  setForm({ ...form, username: event.target.value })
                }
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='local-user-name'>Full name</Label>
              <Input
                id='local-user-name'
                value={form.full_name}
                onChange={(event) =>
                  setForm({ ...form, full_name: event.target.value })
                }
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='local-user-email'>Email</Label>
              <Input
                id='local-user-email'
                type='email'
                value={form.email}
                onChange={(event) =>
                  setForm({ ...form, email: event.target.value })
                }
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='local-user-password'>
                Password {editing && '(leave blank to keep current)'}
              </Label>
              <Input
                id='local-user-password'
                type='password'
                value={form.password}
                placeholder='At least 8 characters'
                onChange={(event) =>
                  setForm({ ...form, password: event.target.value })
                }
              />
            </div>
            <div className='space-y-2'>
              <Label>Role</Label>
              <SearchableSelect
                value={form.role}
                onValueChange={(value) => {
                  const role = value as UserRole
                  setForm({ ...form, role, ...roleDefaults(role) })
                }}
                options={[
                  { value: 'admin', label: 'Administrator' },
                  { value: 'operator', label: 'Operator' },
                  { value: 'viewer', label: 'Viewer' },
                ]}
              />
            </div>
            <div className='space-y-2 sm:col-span-2'>
              <Label>Cloud API access</Label>
              <SearchableSelect
                value={form.cloud_api_access}
                onValueChange={(value) =>
                  setForm({ ...form, cloud_api_access: value as CloudAccess })
                }
                disabled={form.role === 'viewer' || form.role === 'admin'}
                options={[
                  { value: 'read', label: 'Read only (GET requests)' },
                  { value: 'full', label: 'Full API access' },
                ]}
              />
            </div>
          </div>
          <div className='space-y-3 rounded-lg border p-4'>
            <div>
              <p className='text-sm font-medium'>Function permissions</p>
              <p className='text-xs text-muted-foreground'>
                These permissions are enforced by the backend, not only hidden
                in the menu.
              </p>
            </div>
            <div className='grid gap-3 sm:grid-cols-2'>
              {featureOptions.map(([value, label]) => (
                <label key={value} className='flex items-center gap-2 text-sm'>
                  <Checkbox
                    checked={form.permissions.includes(value)}
                    disabled={
                      form.role === 'admin' || value === 'user_management'
                    }
                    onCheckedChange={(checked) =>
                      setForm({
                        ...form,
                        permissions: checked
                          ? [...form.permissions, value]
                          : form.permissions.filter((item) => item !== value),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <label className='flex items-center gap-2 text-sm'>
            <Checkbox
              checked={form.is_active}
              onCheckedChange={(checked) =>
                setForm({ ...form, is_active: Boolean(checked) })
              }
            />
            Account is active
          </label>
          <DialogFooter>
            <Button
              variant='outline'
              disabled={save.isPending}
              onClick={() => setEditorOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                save.isPending ||
                !form.email ||
                !form.full_name ||
                (!editing && form.password.length < 8)
              }
              onClick={() => save.mutate()}
            >
              {editing ? 'Save changes' : 'Create user'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) =>
          !remove.isPending && !open && setDeleting(undefined)
        }
        title='Delete local user?'
        desc={`The account ${deleting?.email ?? ''} will be permanently removed and its sessions revoked.`}
        confirmText='Delete user'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </CloudPageShell>
  )
}
