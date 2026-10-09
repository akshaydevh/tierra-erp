export const DEV_PASSWORD = 'tierra-dev'

export const seedUsers = [
  {
    id: 'usr_alex',
    email: 'alex.thomas@tierra.test',
    name: 'Alex Thomas',
    role: 'admin' as const,
  },
  {
    id: 'usr_joshy',
    email: 'joshy@tierra.test',
    name: 'Joshy',
    role: 'manager' as const,
  },
  {
    id: 'usr_anju',
    email: 'anju@tierra.test',
    name: 'Anju',
    role: 'office' as const,
  },
]
