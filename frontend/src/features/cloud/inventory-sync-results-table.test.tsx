import { expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { CloudDataTable } from '@/components/cloud-data-table'
import { createProjectSyncResults } from './inventory-project-sync'
import { InventorySyncResultsTable } from './inventory-sync-results-table'

it('renders only 50 rows for a large sync while still searching all projects', async () => {
  const results = createProjectSyncResults()
  results.reset(
    Array.from({ length: 1000 }, (_, index) => ({
      id: String(index),
      name: `Project ${index}`,
      display_name: `Project ${index}`,
      organization: '',
      status: 'queued',
    }))
  )
  const screen = await render(
    <InventorySyncResultsTable
      results={results}
      columns={[
        { accessorKey: 'name', header: 'Project' },
        { accessorKey: 'status', header: 'Status' },
      ]}
    />
  )
  expect(document.querySelectorAll('tbody tr')).toHaveLength(50)
  await expect
    .element(screen.getByText('1000 result(s)', { exact: true }))
    .toBeVisible()
  results.update(new Map([['999', { status: 'succeeded', servers: 100000 }]]))
  await screen.getByPlaceholder('Search sync results...').fill('Project 999')
  await expect
    .element(screen.getByText('succeeded', { exact: true }))
    .toBeVisible()
  expect(document.querySelectorAll('tbody tr')).toHaveLength(1)
  await screen.unmount()
  results.reset([])
})

it('selects all matching projects without mounting all their rows', async () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    id: String(index),
    name: `Project ${index}`,
  }))
  const screen = await render(
    <CloudDataTable
      data={rows}
      columns={[{ accessorKey: 'name', header: 'Project' }]}
      getRowId={(row) => row.id}
      initialPageSize={50}
      selectAllMatchingRows
      toolbar={(selected) => <span>{selected.length} projects selected</span>}
    />
  )
  await screen
    .getByRole('checkbox', { name: 'Select all rows', exact: true })
    .click()
  await expect
    .element(screen.getByText('200 projects selected', { exact: true }))
    .toBeVisible()
  expect(document.querySelectorAll('tbody tr')).toHaveLength(50)
  await screen.unmount()
})
