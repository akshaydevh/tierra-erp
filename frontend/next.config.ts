import type { NextConfig } from 'next'

const apiUrl = process.env.API_URL ?? 'http://localhost:3002'

const nextConfig: NextConfig = {
  // forbidden() (next/navigation): pages a role may not open answer 403, e.g. /payroll for anyone but the admin
  experimental: { authInterrupts: true },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }]
  },
}

export default nextConfig
