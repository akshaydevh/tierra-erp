'use client'

import { useState } from 'react'

/** Pre-wrapped text cut to a few lines, with "Show more" when it is long. */
export function ClampText({ text, lines = 3 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 220 || text.split('\n').length > lines
  return (
    <div className="clampwrap">
      <p className={open || !long ? 'taskdetail pre' : 'taskdetail pre clamp'} style={{ WebkitLineClamp: lines }}>
        {text}
      </p>
      {long ? (
        <button type="button" className="linkbtn" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  )
}
