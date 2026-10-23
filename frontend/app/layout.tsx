import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const sans = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-sans' })

export const metadata: Metadata = {
  title: 'Tierra',
  description: 'Tierra Food India order desk',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${sans.className}`}>{children}</body>
    </html>
  )
}
