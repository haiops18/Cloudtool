import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useWindowPointerDrag } from './use-window-pointer-drag'

it('releases drag listeners when a panel closes or unmounts mid-drag', async () => {
  const move = vi.fn()
  function Panel({ open }: { open: boolean }) {
    const start = useWindowPointerDrag(open)
    return <button onClick={() => start(move)}>Resize</button>
  }
  const screen = await render(<Panel open />)
  await screen.getByRole('button').click()
  window.dispatchEvent(new PointerEvent('pointermove'))
  expect(move).toHaveBeenCalledOnce()
  await screen.rerender(<Panel open={false} />)
  move.mockClear()
  window.dispatchEvent(new PointerEvent('pointermove'))
  expect(move).not.toHaveBeenCalled()
  await screen.rerender(<Panel open />)
  await screen.getByRole('button').click()
  await screen.unmount()
  move.mockClear()
  window.dispatchEvent(new PointerEvent('pointermove'))
  expect(move).not.toHaveBeenCalled()
})

it('releases the previous drag on restart, cancellation and window blur', async () => {
  const move = vi.fn()
  function Panel() {
    const start = useWindowPointerDrag()
    return (
      <button
        onClick={() => {
          start(move)
          start(move)
        }}
      >
        Resize
      </button>
    )
  }
  const screen = await render(<Panel />)
  await screen.getByRole('button').click()
  window.dispatchEvent(new PointerEvent('pointermove'))
  expect(move).toHaveBeenCalledOnce()
  window.dispatchEvent(new Event('blur'))
  move.mockClear()
  window.dispatchEvent(new PointerEvent('pointermove'))
  expect(move).not.toHaveBeenCalled()
  await screen.getByRole('button').click()
  window.dispatchEvent(new PointerEvent('pointercancel'))
  window.dispatchEvent(new PointerEvent('pointermove'))
  expect(move).not.toHaveBeenCalled()
  await screen.unmount()
})
