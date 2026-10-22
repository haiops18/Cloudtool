import type { ColumnDef } from '@tanstack/react-table'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CloudDataTable } from './cloud-data-table'

interface Item {
  id: string
  name: string
  region: string
}

const rows: Item[] = [
  { id: '1', name: 'Alpha', region: 'north' },
  { id: '2', name: 'Beta', region: 'central' },
  { id: '3', name: 'Gamma', region: 'south' },
]

const columns: ColumnDef<Item>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'region', header: 'Region' },
]

describe('CloudDataTable', () => {
  it('uses 1,000 rows per page and renders the template pagination footer', async () => {
    const screen = await render(
      <CloudDataTable
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
      />
    )

    await expect.element(screen.getByText('Rows per page')).toBeVisible()
    await expect.element(screen.getByText('Page 1 of 1')).toBeVisible()
    await expect
      .element(screen.getByRole('combobox').getByText('1000'))
      .toBeVisible()
  })

  it('shows the template bulk-actions toolbar when rows are selected', async () => {
    const screen = await render(
      <CloudDataTable
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        entityName='task'
      />
    )

    const rowCheckboxes = screen.getByRole('checkbox', { name: 'Select row' })
    await userEvent.click(rowCheckboxes.nth(0))
    await userEvent.click(rowCheckboxes.nth(1))

    await expect
      .element(
        screen.getByRole('toolbar', {
          name: 'Bulk actions for 2 selected rows',
        })
      )
      .toBeInTheDocument()
  })

  it('filters a selected column by comma and line separated values', async () => {
    const screen = await render(
      <CloudDataTable
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
      />
    )

    await userEvent.click(
      screen.getByRole('button', { name: /Advanced search/i })
    )
    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(screen.getByRole('button', { name: 'Name', exact: true }))
    await userEvent.fill(
      screen.getByLabelText('Values to find'),
      'Beta,\nGamma'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Search 2 value(s)' })
    )

    await expect
      .element(screen.getByText('Beta', { exact: true }))
      .toBeVisible()
    await expect
      .element(screen.getByText('Gamma', { exact: true }))
      .toBeVisible()
    await expect
      .element(screen.getByText('Alpha', { exact: true }))
      .not.toBeInTheDocument()
  })

  it('keeps the actions column sticky at the right edge', async () => {
    const screen = await render(
      <CloudDataTable
        data={rows}
        columns={[
          ...columns,
          {
            id: 'actions',
            header: 'Actions',
            cell: () => <button>Edit</button>,
          },
        ]}
        getRowId={(row) => row.id}
      />
    )

    await expect
      .element(screen.getByRole('button', { name: 'Edit' }).first())
      .toBeVisible()
    expect(document.querySelector('td.sticky.right-0')).not.toBeNull()
  })
})
