import { createFileRoute } from '@tanstack/react-router'
import { TeleportMultiConsolePage } from '@/features/teleport-multi-console/teleport-multi-console-page'

export const Route = createFileRoute('/_authenticated/teleport-multi-console')({ component: TeleportMultiConsolePage })
