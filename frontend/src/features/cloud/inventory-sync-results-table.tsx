import { useSyncExternalStore } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { CloudDataTable } from '@/components/cloud-data-table'
import type {
  createProjectSyncResults,
  ProjectSyncResult,
} from './inventory-project-sync'

const getRowId = (row: ProjectSyncResult) => row.id

export function InventorySyncResultsTable({
  results,
  columns,
}: {
  results: ReturnType<typeof createProjectSyncResults>
  columns: ColumnDef<ProjectSyncResult>[]
}) {
  const rows = useSyncExternalStore(results.subscribe, results.getSnapshot)
  return (
    <CloudDataTable
      data={rows}
      columns={columns}
      getRowId={getRowId}
      entityName='sync result'
      searchPlaceholder='Search sync results...'
      initialPageSize={50}
      pageSizeOptions={[20, 50, 100]}
    />
  )
}
