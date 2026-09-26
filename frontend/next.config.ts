import type { NextConfig } from 'next'

const apiUrl = process.env.API_URL ?? 'http://localhost:3002'

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiUrl}/api/:path*` },
      { source: '/webhooks/:path*', destination: `${apiUrl}/webhooks/:path*` },
    ]
  },
}

export default nextConfig
