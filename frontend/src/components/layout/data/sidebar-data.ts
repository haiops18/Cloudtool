import {
  Bot,
  Layers,
  FileClock,
  History,
  KeyRound,
  Network,
  Server,
  ServerCog,
  Terminal,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  user: {
    name: 'CloudTool Operator',
    email: 'secure-session',
    avatar: '/images/favicon.png',
  },
  teams: [],
  navGroups: [
    {
      title: 'Cloud resources',
      items: [
        { title: 'Servers', url: '/', icon: Server, permission: 'servers' },
        {
          title: 'Terraform deployments',
          url: '/#terraform',
          icon: ServerCog,
          permission: 'servers',
        },
        {
          title: 'Network',
          url: '/network',
          icon: Network,
          permission: 'private_ips',
        },
        {
          title: 'Private IPs',
          url: '/private-ips',
          icon: Network,
          permission: 'private_ips',
        },
        {
          title: 'Security groups',
          url: '/security-groups',
          icon: ShieldCheck,
          permission: 'security_groups',
        },
        {
          title: 'VPC peering',
          url: '/vpc-peerings',
          icon: Network,
          permission: 'private_ips',
        },
      ],
    },
    {
      title: 'AI',
      items: [
        {
          title: 'Project analysis',
          url: '/ai-assistant',
          icon: Bot,
          permission: 'servers',
        },
      ],
    },
    {
      title: 'All projects',
      items: [
        {
          title: 'All servers',
          url: '/all-servers',
          icon: Layers,
          permission: 'servers',
        },
        {
          title: 'ALL SG Rule',
          url: '/all-sg-rules',
          icon: ShieldCheck,
          permission: 'security_groups',
        },
        {
          title: 'Teleport Multi Console',
          url: '/teleport-multi-console',
          icon: Terminal,
          permission: 'servers',
        },
      ],
    },
    {
      title: 'Configuration',
      items: [
        {
          title: 'Password profiles',
          url: '/password-profiles',
          icon: KeyRound,
          permission: 'password_profiles',
        },
        {
          title: 'Local users',
          url: '/users',
          icon: Users,
          permission: 'user_management',
        },
      ],
    },
    {
      title: 'Audit',
      items: [
        {
          title: 'User activity',
          url: '/audit-activity',
          icon: FileClock,
          permission: 'audit_logs',
        },
        {
          title: 'Cloud API history',
          url: '/cloud-api-history',
          icon: History,
          permission: 'audit_logs',
        },
      ],
    },
  ],
}
