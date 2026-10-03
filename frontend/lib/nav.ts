export type NavItem = {
  href: string
  label: string
  icon: string
  group?: string
}

export const navItems: NavItem[] = [
  { href: '/', label: 'Command Centre', icon: 'circles' },
  { href: '/my-day', label: 'My Day', icon: 'checks' },
  { href: '/approvals', label: 'Approvals', icon: 'seal' },
  { href: '/orders', label: 'Orders', icon: 'clipboard', group: 'Operations' },
  { href: '/production', label: 'Production', icon: 'factory' },
  { href: '/procurement', label: 'Procurement', icon: 'bag' },
  { href: '/dispatch', label: 'Dispatch', icon: 'truck' },
  { href: '/inventory', label: 'Inventory', icon: 'warehouse' },
  { href: '/payments', label: 'Payments', icon: 'card', group: 'Finance' },
  { href: '/costing', label: 'Costing', icon: 'chart' },
  { href: '/payroll', label: 'Payroll and attendance', icon: 'users' },
  { href: '/reports', label: 'Reports', icon: 'file' },
  { href: '/masters', label: 'Masters', icon: 'books', group: 'System' },
]

const placeholders: Record<string, string> = {
  'my-day': 'My Day',
  approvals: 'Approvals',
  dispatch: 'Dispatch',
  payments: 'Payments',
  costing: 'Costing',
  payroll: 'Payroll and attendance',
  reports: 'Reports',
  masters: 'Masters',
}

export function placeholderTitle(module: string): string | null {
  return placeholders[module] ?? null
}

export function titleForPath(path: string): string {
  if (path.startsWith('/orders/')) return 'Order'
  if (path === '/settings') return 'Settings'
  const item = navItems.find((entry) => entry.href === path)
  return item?.label ?? 'Tierra'
}
