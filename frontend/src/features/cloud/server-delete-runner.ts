import { AxiosError } from 'axios'
import { apiClient } from '@/lib/api-client'
import { resizeErrorMessage } from './resize-error-message'

export interface DeleteTarget {
  server_id: string
  name: string
  volumes: string[]
  eips: string[]
  private_ips: string[]
}

export interface DeleteOutcome {
  server_id: string
  name?: string
  status: string
  error?: string
  error_detail?: unknown
}

export async function runServerDeletions(
  targets: DeleteTarget[],
  projectId: string,
  onProgress: (rows: DeleteOutcome[]) => void
): Promise<DeleteOutcome[]> {
  const rows: DeleteOutcome[] = targets.map(({ server_id, name }) => ({
    server_id,
    name,
    status: 'queued',
  }))
  const publish = () => onProgress(rows.map((row) => ({ ...row })))
  publish()
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(3, targets.length) }, async () => {
      while (cursor < targets.length) {
        const index = cursor++
        const { name, ...item } = targets[index]
        rows[index] = { ...rows[index], status: 'processing' }
        publish()
        try {
          const { data } = await apiClient.post<{ items: DeleteOutcome[] }>(
            '/cloud/servers/delete',
            { items: [item] },
            { headers: { 'X-Project-Id': projectId }, timeout: 0 }
          )
          const result = data.items?.find(
            (row) => row.server_id === item.server_id
          )
          rows[index] = result
            ? { ...result, name: result.name || name }
            : {
                ...rows[index],
                status: 'unconfirmed',
                error:
                  'The API returned no result for this VM. Verify its state before deleting again.',
              }
        } catch (error) {
          const status =
            error instanceof AxiosError ? error.response?.status : undefined
          const detail =
            error instanceof AxiosError
              ? (error.response?.data ?? error.message)
              : error instanceof Error
                ? error.message
                : error
          rows[index] = {
            ...rows[index],
            status:
              status && status >= 400 && status < 500
                ? 'failed'
                : 'unconfirmed',
            error: resizeErrorMessage(detail),
            error_detail: detail,
          }
        }
        publish()
      }
    })
  )
  return rows
}
