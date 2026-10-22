import { createFileRoute } from '@tanstack/react-router'
import { AllSgRulesPage } from '@/features/cloud/all-sg-rules-page'

export const Route = createFileRoute('/_authenticated/all-sg-rules')({
  component: AllSgRulesPage,
})
