import { AxiosError } from 'axios'
import { apiClient } from '@/lib/api-client'
import { resizeErrorMessage } from './resize-error-message'

export type ConsolePasswordResult = {
  server_id: string
  status: string
  error?: string
}

export async function changeConsolePasswords({
  serverIds,
  source,
  projectId,
  onResult,
}: {
  serverIds: string[]
  source: { password: string } | { profile_id: string }
  projectId?: string
  onResult: (result: ConsolePasswordResult) => void
}): Promise<ConsolePasswordResult[]> {
  const results = new Map<string, ConsolePasswordResult>()
  const ids = [...new Set(serverIds)]
  const credentials = { ...source }
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < ids.length) {
      const serverId = ids[nextIndex++]
      onResult({ server_id: serverId, status: 'processing' })
      let result: ConsolePasswordResult
      try {
        const { data } = await apiClient.post<{
          items?: ConsolePasswordResult[]
        }>(
          '/cloud/servers/change-password',
          { server_ids: [serverId], ...credentials },
          {
            timeout: 45_000,
            ...(projectId ? { headers: { 'X-Project-Id': projectId } } : {}),
          }
        )
        result = data.items?.find((item) => item.server_id === serverId) ?? {
          server_id: serverId,
          status: 'unconfirmed',
          error: 'The API returned no result for this VM.',
        }
      } catch (error) {
        const unconfirmed = error instanceof AxiosError && !error.response
        result = {
          server_id: serverId,
          status: unconfirmed ? 'unconfirmed' : 'failed',
          error: unconfirmed
            ? 'No response received. Check the VM or audit logs before retrying.'
            : resizeErrorMessage(
                error instanceof AxiosError
                  ? (error.response?.data ?? error.message)
                  : error instanceof Error
                    ? error.message
                    : error
              ) || 'Password request failed.',
        }
      }
      results.set(serverId, result)
      onResult(result)
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker))
  return ids.map((id) => results.get(id)!)
}
