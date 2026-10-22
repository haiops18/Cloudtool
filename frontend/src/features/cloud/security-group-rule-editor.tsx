import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

export type AdaptiveRuleInput = {
  direction: 'ingress' | 'egress' | 'both'
  protocols: string[]
  ports: string
  prefixes: string
  description: string
  delete_at: string
}

export function SecurityGroupRuleEditor({
  open: adaptiveEditorOpen,
  onOpenChange,
  protocols: PROTOCOLS,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  protocols: string[]
  onAdd: (input: AdaptiveRuleInput) => void
}) {
  // Keep keystrokes local: the inventory and review tables should only update
  // when generated rules are submitted, not on every input change.
  const [adaptiveDirection, setAdaptiveDirection] =
    useState<AdaptiveRuleInput['direction']>('ingress')
  const [adaptiveProtocols, setAdaptiveProtocols] = useState<string[]>(['tcp'])
  const [adaptivePorts, setAdaptivePorts] = useState('')
  const [adaptivePrefixes, setAdaptivePrefixes] = useState('')
  const [draft, setDraft] = useState({ description: '', delete_at: '' })
  const adaptiveCanReview =
    adaptiveProtocols.length > 0 && Boolean(adaptivePrefixes.trim())
  const addAdaptiveRules = () => {
    if (!adaptiveCanReview) return
    onAdd({
      direction: adaptiveDirection,
      protocols: adaptiveProtocols,
      ports: adaptivePorts,
      prefixes: adaptivePrefixes,
      description: draft.description,
      delete_at: draft.delete_at,
    })
  }
  return (
    <Dialog open={adaptiveEditorOpen} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90svh] !w-[620px] !max-w-[calc(100vw-2rem)] overflow-y-auto sm:!max-w-[620px]'>
        <DialogHeader>
          <DialogTitle>Add rule</DialogTitle>
          <DialogDescription>
            Configure direction, protocol, ports and CIDRs, then add the
            generated rules to review.
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-4 rounded-lg border bg-background p-4'>
          <div className='space-y-2'>
            <div className='space-y-2'>
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <Label>Direction</Label>
              </div>
              <div className='inline-flex w-full rounded-md border bg-muted/30 p-1'>
                {(
                  [
                    { value: 'ingress', label: 'Inbound' },
                    { value: 'egress', label: 'Outbound' },
                    { value: 'both', label: 'Both (in/out)' },
                  ] as const
                ).map((item) => (
                  <Button
                    key={item.value}
                    type='button'
                    size='sm'
                    variant={
                      adaptiveDirection === item.value ? 'secondary' : 'ghost'
                    }
                    className='h-8 flex-1 px-2 text-xs'
                    onClick={() => setAdaptiveDirection(item.value)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
          <div className='space-y-2'>
            <Label>
              Protocols{' '}
              <span className='font-normal text-muted-foreground'>
                (select one or more)
              </span>
            </Label>
            <div className='flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-md border bg-muted/10 p-2'>
              {PROTOCOLS.map((protocol) => {
                const selected = adaptiveProtocols.includes(protocol)
                return (
                  <Button
                    key={protocol}
                    type='button'
                    size='sm'
                    variant={selected ? 'secondary' : 'ghost'}
                    className='h-7 px-2 font-mono text-[11px] uppercase'
                    onClick={() =>
                      setAdaptiveProtocols((current) =>
                        selected
                          ? current.filter((item) => item !== protocol)
                          : [...current, protocol]
                      )
                    }
                  >
                    {protocol}
                  </Button>
                )
              })}
            </div>
          </div>
          <div className='space-y-2'>
            <Label>
              Ports / ranges{' '}
              <span className='font-normal text-muted-foreground'>
                (optional; comma-separated, e.g. 22,80,1000-2000)
              </span>
            </Label>
            <Input
              value={adaptivePorts}
              onChange={(event) => setAdaptivePorts(event.target.value)}
              placeholder='22, 80, 443, 1000-2000'
            />
          </div>
          <div className='space-y-2'>
            <Label>
              Remote IP / CIDRs{' '}
              <span className='font-normal text-muted-foreground'>
                (comma or new line)
              </span>
            </Label>
            <Textarea
              className='h-[4.5rem] resize-y font-mono text-sm'
              value={adaptivePrefixes}
              onChange={(event) => setAdaptivePrefixes(event.target.value)}
              placeholder={'10.0.0.0/24, 192.168.1.0/24\n2001:db8::/64'}
            />
          </div>
          <div className='space-y-2'>
            <Label>
              Description{' '}
              <span className='font-normal text-muted-foreground'>
                (optional, applied to every generated rule)
              </span>
            </Label>
            <Textarea
              className='h-[4.5rem] resize-y'
              value={draft.description}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              placeholder='For example: Allow management access'
            />
          </div>
          <div className='space-y-2'>
            <Label>
              Delete at{' '}
              <span className='font-normal text-muted-foreground'>
                (optional)
              </span>
            </Label>
            <Input
              className='w-60'
              type='datetime-local'
              value={draft.delete_at || ''}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  delete_at: event.target.value,
                }))
              }
            />
          </div>
        </div>
        <div className='flex justify-end gap-2 pt-3'>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!adaptiveCanReview}
            onClick={() => {
              addAdaptiveRules()
              onOpenChange(false)
            }}
          >
            <Plus /> Add to review
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
