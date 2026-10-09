import type { Role } from './types'

export type NavItem = {
  href: string
  label: string
  icon: string
  group?: string
  roles?: Role[]
}

export const navItems: NavItem[] = [
  { href: '/', label: 'Command Centre', icon: 'circles' },
  { href: '/agent', label: 'Tierra Agent', icon: 'chat' },
  { href: '/my-day', label: 'My Day', icon: 'checks' },
  { href: '/approvals', label: 'Approvals', icon: 'seal' },
  { href: '/orders', label: 'Orders', icon: 'clipboard', group: 'Operations' },
  { href: '/production', label: 'Production', icon: 'factory' },
  { href: '/procurement', label: 'Procurement', icon: 'bag' },
  { href: '/dispatch', label: 'Dispatch', icon: 'truck' },
  { href: '/inventory', label: 'Inventory', icon: 'warehouse' },
  { href: '/payments', label: 'Payments', icon: 'card', group: 'Finance', roles: ['admin', 'manager'] },
  { href: '/costing', label: 'Costing', icon: 'chart', roles: ['admin', 'manager'] },
  { href: '/payroll', label: 'Payroll and attendance', icon: 'users', roles: ['admin'] },
  { href: '/reports', label: 'Reports', icon: 'file' },
  { href: '/masters', label: 'Masters', icon: 'books', group: 'System' },
]

export function navFor(role: Role): NavItem[] {
  return navItems.filter((item) => !item.roles || item.roles.includes(role))
}

export function canOpen(role: Role, href: string): boolean {
  const item = navItems.find((entry) => entry.href === href)
  return !item?.roles || item.roles.includes(role)
}

const placeholders: Record<string, string> = {
  masters: 'Masters',
}

export function placeholderTitle(module: string): string | null {
  return placeholders[module] ?? null
}

export function titleForPath(path: string): string {
  if (path.startsWith('/orders/so/')) return 'Sales order'
  if (path.startsWith('/orders/tso/')) return 'Tierra sales order'
  if (path.startsWith('/orders/po/')) return 'Customer PO'
  if (path.startsWith('/production/')) return 'Work order'
  if (path === '/settings') return 'Settings'
  const item = navItems.find((entry) => entry.href === path)
  return item?.label ?? 'Tierra'
}
