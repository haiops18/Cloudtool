import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { SearchableSelect } from './searchable-select'

function SelectInsideDialog({
  onValueChange,
  onSearchChange,
  inline = false,
}: {
  onValueChange: (value: string) => void
  onSearchChange?: (value: string) => void
  inline?: boolean
}) {
  const [value, setValue] = useState('')
  const [search, setSearch] = useState('')
  return (
    <Dialog open>
      <DialogContent onInteractOutside={(event) => event.preventDefault()}>
        <DialogTitle>Select cloud project</DialogTitle>
        <DialogDescription>Choose a project.</DialogDescription>
        <SearchableSelect
          inline={inline}
          value={value}
          onValueChange={(nextValue) => {
            setValue(nextValue)
            onValueChange(nextValue)
          }}
          placeholder='Select project'
          searchValue={search}
          onSearchChange={(nextValue) => {
            setSearch(nextValue)
            onSearchChange?.(nextValue)
          }}
          options={[
            {
              value: 'project-1',
              label: 'Production',
              description: 'project-1',
            },
          ]}
        />
      </DialogContent>
    </Dialog>
  )
}

describe('SearchableSelect', () => {
  it('selects an option and closes its popover inside a modal dialog', async () => {
    const onValueChange = vi.fn()
    const screen = await render(
      <SelectInsideDialog onValueChange={onValueChange} />
    )

    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(screen.getByText('Production', { exact: true }))

    expect(onValueChange).toHaveBeenCalledWith('project-1')
    await expect
      .element(screen.getByRole('combobox'))
      .toHaveTextContent('Production')
    await expect.element(screen.getByRole('combobox')).toBeInTheDocument()
    await expect
      .element(screen.getByPlaceholder('Search...'))
      .not.toBeInTheDocument()
  })

  it('allows typing in a remotely-controlled search inside a modal dialog', async () => {
    const onSearchChange = vi.fn()
    const screen = await render(
      <SelectInsideDialog
        onValueChange={vi.fn()}
        onSearchChange={onSearchChange}
      />
    )

    await userEvent.click(screen.getByRole('combobox'))
    const search = screen.getByPlaceholder('Search...')
    await userEvent.click(search)
    await userEvent.fill(search, 'STDV')

    await expect.element(search).toHaveValue('STDV')
    expect(onSearchChange).toHaveBeenLastCalledWith('STDV')
  })

  it('keeps inline project search focusable in a blocking modal', async () => {
    const onSearchChange = vi.fn()
    const screen = await render(
      <SelectInsideDialog
        inline
        onValueChange={vi.fn()}
        onSearchChange={onSearchChange}
      />
    )

    const search = screen.getByPlaceholder('Search...')
    await userEvent.click(search)
    await userEvent.fill(search, 'project name')

    await expect.element(search).toHaveValue('project name')
    expect(onSearchChange).toHaveBeenLastCalledWith('project name')
  })
})
