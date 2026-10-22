import { createFileRoute } from '@tanstack/react-router'
import { AgentPage } from '@/features/agent/agent-page'

export const Route = createFileRoute('/_authenticated/ai-assistant')({
  component: AgentPage,
})
