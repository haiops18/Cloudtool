import { useQueryClient } from '@tanstack/react-query'
import { MemoryStick } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function ReleasePageCacheButton() {
  const queryClient = useQueryClient()
  const release = () => {
    // Browsers intentionally do not expose a way for application code to
    // force garbage collection. Clearing cache alone therefore cannot promise
    // an immediate memory drop. Unloading this document can; the reload keeps
    // the current URL, session cookie and localStorage intact.
    queryClient.clear()
    window.location.reload()
  }
  return (
    <Button
      variant='ghost'
      size='icon'
      className='shrink-0 rounded-full'
      aria-label='Release frontend memory and reload this page'
      title='Release frontend memory (reloads this page)'
      onClick={release}
    >
      <MemoryStick className='size-[1.1rem]' />
      <span className='sr-only'>Release frontend memory and reload this page</span>
    </Button>
  )
}
