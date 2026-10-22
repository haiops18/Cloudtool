import { apiClient } from '@/lib/api-client'

export type InventorySearchParams = Record<
  string,
  string | number | boolean | undefined
>
type InventoryPage<T> = {
  items: T[]
  total: number
  page: number
  page_size: number
}

export async function fetchInventoryPage<T>(
  params: InventorySearchParams,
  signal?: AbortSignal
): Promise<InventoryPage<T>> {
  if (params.sql_query)
    return (
      await apiClient.post<InventoryPage<T>>(
        '/cloud/all-server-inventory/sql-search',
        params,
        { timeout: 60_000, signal }
      )
    ).data
  return (
    await apiClient.get<InventoryPage<T>>('/cloud/all-server-inventory', {
      params,
      timeout: 60_000,
      signal,
    })
  ).data
}

export async function loadAllInventory<T>(
  params: InventorySearchParams,
  onProgress: (loaded: number, total: number) => void
): Promise<T[]> {
  const rows: T[] = []
  let page = 1
  let total: number | undefined
  do {
    const data = await fetchInventoryPage<T>({
      ...params,
      page,
      page_size: 500,
    })
    total ??= data.total
    if (!data.items.length && rows.length < total)
      throw new Error(
        'Inventory changed while exporting. Run the search again and retry.'
      )
    rows.push(...data.items)
    onProgress(rows.length, total)
    page++
  } while (rows.length < total)
  return rows
}
