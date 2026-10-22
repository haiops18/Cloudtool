import { useCallback, useEffect, useRef } from 'react'

// Window listeners must also be removed if the panel disappears mid-drag.
export function useWindowPointerDrag(enabled = true) {
  const cleanup = useRef<(() => void) | undefined>(undefined)
  useEffect(
    () => () => {
      cleanup.current?.()
    },
    [enabled]
  )
  return useCallback(
    (move: (event: PointerEvent) => void) => {
      cleanup.current?.()
      if (!enabled) return
      const stop = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
        window.removeEventListener('blur', stop)
        cleanup.current = undefined
      }
      cleanup.current = stop
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
      window.addEventListener('blur', stop)
    },
    [enabled]
  )
}
