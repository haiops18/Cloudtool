import { useSearch } from '@tanstack/react-router'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { AuthLayout } from '../auth-layout'
import { UserAuthForm } from './components/user-auth-form'

export function SignIn() {
  const { redirect } = useSearch({ from: '/(auth)/sign-in' })
  return (
    <AuthLayout>
      <Card className='w-[min(82vw,46rem)] max-w-none gap-5 shadow-lg'>
        <CardHeader className='px-9 pt-8'>
          <CardTitle className='text-xl tracking-tight'>Sign in</CardTitle>
          <CardDescription>Sign in to CloudTool.</CardDescription>
        </CardHeader>
        <CardContent className='px-9 pb-8'>
          <UserAuthForm redirectTo={redirect} />
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
