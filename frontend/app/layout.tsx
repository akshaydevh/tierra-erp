import type { Metadata } from 'next'
import { Fraunces, Outfit } from 'next/font/google'
import './globals.css'

const sans = Outfit({ subsets: ['latin'], display: 'swap', variable: '--font-sans' })
const display = Fraunces({ subsets: ['latin'], display: 'swap', variable: '--font-serif' })

export const metadata: Metadata = {
  title: 'Tierra',
  description: 'Tierra Food India order desk',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${display.variable} ${sans.className}`}>{children}</body>
    </html>
  )
}
