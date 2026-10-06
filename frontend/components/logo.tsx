import { Caveat, Libre_Baskerville } from 'next/font/google'

const serif = Libre_Baskerville({ subsets: ['latin'], weight: '700' })
const script = Caveat({ subsets: ['latin'], weight: '500' })

const ink = '#64261c'

const chips: Array<[number, number, number, number, number]> = [
  [118, 168, 22, 15, -18],
  [158, 160, 26, 17, 12],
  [200, 166, 28, 18, -6],
  [242, 158, 22, 15, 16],
  [96, 150, 18, 13, 8],
  [268, 172, 20, 14, -14],
  [176, 184, 30, 18, 4],
  [132, 186, 20, 14, -24],
  [224, 188, 24, 15, 20],
]

function Chip({ x, y, rx, ry, rotate }: { x: number; y: number; rx: number; ry: number; rotate: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate})`}>
      <ellipse rx={rx} ry={ry} fill="#ffffff" stroke={ink} strokeWidth="1.7" />
      <path
        d={`M ${-rx * 0.62} ${-ry * 0.12} Q 0 ${-ry * 0.72} ${rx * 0.58} ${-ry * 0.05}`}
        fill="none"
        stroke={ink}
        strokeWidth="1.35"
      />
      <path
        d={`M ${-rx * 0.5} ${ry * 0.02} Q 0 ${-ry * 0.22} ${rx * 0.48} ${ry * 0.08}`}
        fill="none"
        stroke={ink}
        strokeWidth="1.2"
      />
      <path
        d={`M ${-rx * 0.68} ${ry * 0.28} Q 0 ${ry * 0.02} ${rx * 0.64} ${ry * 0.34}`}
        fill="none"
        stroke={ink}
        strokeWidth="1.35"
      />
    </g>
  )
}

export function Logo({ variant = 'full' }: { variant?: 'full' | 'mark' }) {
  const full = variant === 'full'
  return (
    <svg
      className="tierra-logo"
      viewBox={full ? '0 0 340 292' : '8 4 324 214'}
      role="img"
      aria-label={full ? 'Tierra. Here for a good time.' : 'Tierra'}
    >
      <ellipse cx="170" cy="112" rx="156" ry="100" fill="#ffffff" stroke={ink} strokeWidth="3.2" />
      <g fill={ink}>
        <path d="M112 48c6-12 14-12 18 0-6-3-12-3-18 0z" />
        <path d="M136 44c5-11 12-11 16 0-5-3-11-3-16 0z" />
      </g>
      <path
        d="M206 42c8-12 18-10 24 0 8-11 18-9 24 2 10-8 20-2 20 8-24 5-52 4-68-10z"
        fill="none"
        stroke={ink}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <text
        className={serif.className}
        x="170"
        y="86"
        textAnchor="middle"
        fill={ink}
        fontSize="34"
        letterSpacing="1.5"
      >
        TIERRA
      </text>
      <g fill="none" stroke={ink} strokeWidth="1.5" strokeLinecap="round">
        <path d="M28 128c46-10 92-4 150 8" />
        <path d="M24 146c52-12 100-2 140 12" />
        <path d="M36 166c40-8 78 0 108 14" />
        <path d="M48 122v46M92 116v52M136 118v48M180 122v40M224 116v46M268 120v42" />
        <path d="M42 132c70-6 150 2 250 10" />
        <path d="M40 146c74-4 154 6 252 12" />
      </g>
      <g>
        {chips.map(([x, y, rx, ry, rotate]) => (
          <Chip key={`${x}-${y}`} x={x} y={y} rx={rx} ry={ry} rotate={rotate} />
        ))}
      </g>
      {full ? (
        <text className={script.className} x="170" y="268" textAnchor="middle" fill={ink} fontSize="32">
          Here for a good time
        </text>
      ) : null}
    </svg>
  )
}
