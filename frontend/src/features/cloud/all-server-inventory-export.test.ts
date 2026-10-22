import { afterEach, expect, it } from 'vitest'
import { apiClient } from '@/lib/api-client'
import { loadAllInventory } from './all-server-inventory-export'

const adapter = apiClient.defaults.adapter
afterEach(() => {
  apiClient.defaults.adapter = adapter
})

it.each([false, true])(
  'exports every matched page with unchanged search and sorting (SQL: %s)',
  async (sql) => {
    const calls: number[] = []
    const params = {
      project_ids: 'project-a,project-b',
      sort_by: 'server_name',
      sort_desc: false,
      ...(sql
        ? {
            sql_query:
              "SELECT * FROM all_server_inventory_snapshots WHERE power_state = 'running'",
          }
        : {
            q: 'web',
            private_ip: '10.0.',
            batch_fields: 'server_name',
            batch_values: 'web1\nweb2',
            ip_match: 'contains',
          }),
    }
    apiClient.defaults.adapter = async (config) => {
      const actual = sql ? JSON.parse(config.data) : config.params
      expect(config.url).toBe(
        sql
          ? '/cloud/all-server-inventory/sql-search'
          : '/cloud/all-server-inventory'
      )
      expect(actual).toMatchObject(params)
      expect(actual.page_size).toBe(500)
      calls.push(actual.page)
      const start = (actual.page - 1) * 500
      return {
        config,
        status: 200,
        statusText: 'OK',
        headers: {},
        data: {
          items: Array.from(
            { length: Math.min(500, 750 - start) },
            (_, index) => ({ id: start + index })
          ),
          total: 750,
          page: actual.page,
          page_size: 500,
        },
      }
    }
    const progress: number[] = []
    const rows = await loadAllInventory<{ id: number }>(params, (loaded) =>
      progress.push(loaded)
    )
    expect(calls).toEqual([1, 2])
    expect(progress).toEqual([500, 750])
    expect(rows).toHaveLength(750)
    expect(rows[749].id).toBe(749)
  }
)

it('fails instead of silently exporting partial results when a later page is empty', async () => {
  apiClient.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: {
      items: config.params.page === 1 ? [{ id: 1 }] : [],
      total: 2,
      page: config.params.page,
      page_size: 500,
    },
  })
  await expect(loadAllInventory({}, () => undefined)).rejects.toThrow(
    'Inventory changed'
  )
})
