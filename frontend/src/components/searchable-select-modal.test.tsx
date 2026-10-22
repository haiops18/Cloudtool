import { expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { SearchableSelect } from './searchable-select'
import { SearchableSelectV2 } from './searchable-select-v2'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog'

it.each(['legacy', 'v2'] as const)(
  'searches %s options inside a modal using keyboard focus',
  async (variant) => {
    const options = [
      { value: 'alpha', label: 'Alpha' },
      { value: 'beta', label: 'Beta' },
    ]
    const screen = await render(
      <Dialog open>
        <DialogContent
          style={{
            position: 'fixed',
            top: 20,
            left: 20,
            width: 500,
            height: 200,
            transform: 'translateX(1px)',
            overflow: 'hidden',
          }}
        >
          <DialogHeader>
            <DialogTitle>Test modal</DialogTitle>
            <DialogDescription>Search test</DialogDescription>
          </DialogHeader>
          {variant === 'legacy' ? (
            <SearchableSelect
              value=''
              onValueChange={() => {}}
              options={options}
              searchPlaceholder='Search modal options'
            />
          ) : (
            <SearchableSelectV2
              items={options}
              searchPlaceholder='Search modal options'
            />
          )}
        </DialogContent>
      </Dialog>
    )
    await userEvent.click(screen.getByRole('combobox'))
    const input = screen.getByPlaceholder('Search modal options')
    await expect.element(input).toBeVisible()
    await userEvent.click(input)
    await expect
      .poll(() => document.activeElement?.getAttribute('placeholder'))
      .toBe('Search modal options')
    await userEvent.type(input, 'Beta')
    await expect.element(input).toHaveValue('Beta')
    await expect
      .element(screen.getByText('Beta', { exact: true }))
      .toBeVisible()
    expect(document.body.textContent).not.toContain('Alpha')
    await userEvent.click(screen.getByText('Beta', { exact: true }))
    await expect
      .element(screen.getByText('Test modal', { exact: true }))
      .toBeVisible()
    await expect.element(input).not.toBeInTheDocument()
  }
)

it.each(['legacy', 'v2'] as const)(
  'still searches %s options outside a modal',
  async (variant) => {
    const options = [
      { value: 'alpha', label: 'Alpha' },
      { value: 'beta', label: 'Beta' },
    ]
    const screen = await render(
      variant === 'legacy' ? (
        <SearchableSelect
          value=''
          onValueChange={() => {}}
          options={options}
          searchPlaceholder='Search page options'
        />
      ) : (
        <SearchableSelectV2
          items={options}
          searchPlaceholder='Search page options'
        />
      )
    )
    await userEvent.click(screen.getByRole('combobox'))
    const input = screen.getByPlaceholder('Search page options')
    await userEvent.type(input, 'Beta')
    await expect.element(input).toHaveValue('Beta')
    expect(document.body.textContent).not.toContain('Alpha')
  }
)
