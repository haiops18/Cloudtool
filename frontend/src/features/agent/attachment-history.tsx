import { useEffect, useState } from 'react'
import { Download, FileText, Image as ImageIcon } from 'lucide-react'
import { toast } from 'sonner'

export type WorkspaceAttachment = {
  path: string
  name: string
  media_type: string
  size: number
  data_url?: string
}
function AttachmentPreview({
  attachment,
  agentBaseUrl,
  headers,
}: {
  attachment: WorkspaceAttachment
  agentBaseUrl: string
  headers?: Record<string, string>
}) {
  const [savedSource, setSource] = useState<string>()
  const source = attachment.media_type.startsWith('image/')
    ? attachment.data_url ?? savedSource
    : undefined
  const [downloading, setDownloading] = useState(false)
  useEffect(() => {
    if (attachment.data_url) return
    if (!attachment.media_type.startsWith('image/') || !headers) return
    let active = true
    void fetch(
      `${agentBaseUrl}/project-context/file?path=${encodeURIComponent(attachment.path)}`,
      { credentials: 'include', headers }
    )
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{
              content_base64: string
              media_type: string
            }>)
          : undefined
      )
      .then((data) => {
        if (active && data)
          setSource(`data:${data.media_type};base64,${data.content_base64}`)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [agentBaseUrl, attachment.data_url, attachment.media_type, attachment.path, headers])
  const download = async () => {
    if (downloading) return
    setDownloading(true)
    try {
      let dataUrl = attachment.data_url
      if (!dataUrl) {
        if (!headers) throw new Error('Please reconnect before downloading this file.')
        const response = await fetch(
          `${agentBaseUrl}/project-context/file?path=${encodeURIComponent(attachment.path)}`,
          { credentials: 'include', headers }
        )
        if (!response.ok) throw new Error('Unable to download attachment')
        const data = await response.json() as { media_type: string; content_base64: string }
        dataUrl = `data:${data.media_type};base64,${data.content_base64}`
      }
      const response = await fetch(dataUrl)
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = attachment.name
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to download attachment')
    } finally {
      setDownloading(false)
    }
  }
  return (
    <button
      aria-label={`Download ${attachment.name}`}
      className='flex max-w-56 items-center gap-2 rounded-lg border bg-muted/20 p-1.5 text-left hover:bg-muted/40 disabled:opacity-60'
      disabled={downloading}
      onClick={() => void download()}
      type='button'
    >
      <>
        {source ? (
          <img
            alt={attachment.name}
            className='size-12 rounded object-cover'
            src={source}
          />
        ) : attachment.media_type.startsWith('image/') ? (
          <div className='grid size-12 place-items-center rounded bg-background'>
            <ImageIcon className='size-5 text-muted-foreground' />
          </div>
        ) : (
          <div className='grid size-12 place-items-center rounded bg-background'>
            <FileText className='size-5 text-muted-foreground' />
          </div>
        )}
      </>
      <span className='truncate text-xs font-medium' title={attachment.path}>
        {attachment.name}
      </span>
      <Download className='size-3.5 shrink-0' />
    </button>
  )
}

export function MessageAttachments({
  attachments,
  agentBaseUrl,
  headers,
}: {
  attachments: WorkspaceAttachment[]
  agentBaseUrl: string
  headers?: Record<string, string>
}) {
  if (!attachments.length) return null
  return (
    <div className='mt-2 flex flex-wrap gap-2'>
      {attachments.map((attachment) => (
        <AttachmentPreview
          agentBaseUrl={agentBaseUrl}
          attachment={attachment}
          headers={headers}
          key={attachment.path}
        />
      ))}
    </div>
  )
}
