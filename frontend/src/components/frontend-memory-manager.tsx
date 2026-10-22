import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { installQueryMemoryPolicy } from '@/lib/query-memory-policy'

export function FrontendMemoryManager() {
  const client = useQueryClient()
  const router = useRouter()
  useEffect(() => {
    const policy = installQueryMemoryPolicy(client)
    router.update({
      ...router.options,
      defaultGcTime: 0,
      defaultPreloadGcTime: 0,
    })
    const releasePage = () => {
      // Cached route matches are separate from API query data. Active matches
      // and pending mutations/background sync jobs are not removed.
      router.clearCache()
      policy.releaseUnused()
    }
    const unsubscribe = router.subscribe('onResolved', releasePage)
    releasePage()
    return () => {
      unsubscribe()
      policy()
    }
  }, [client, router])
  return null
}
