import { Caveat } from 'next/font/google'
import logo from './tierra-logo.webp'

const script = Caveat({ subsets: ['latin'], weight: '500' })

/**
 * The coloured Tierra oval. Imported rather than put in public/: the auth middleware sends unknown paths to
 * /login, but it lets /_next/static through, so the login page can show it too.
 */
export function Logo({ variant = 'full' }: { variant?: 'full' | 'mark' }) {
  const mark = <img className="tierra-logo" src={logo.src} width={logo.width} height={logo.height} alt="Tierra" />
  if (variant === 'mark') return mark
  return (
    <figure className="tierra-lockup">
      {mark}
      <figcaption className={`tierra-tagline ${script.className}`}>Here for a good time</figcaption>
    </figure>
  )
}
