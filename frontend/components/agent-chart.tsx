'use client'

import { useEffect, useRef, useState } from 'react'
import { inr, inrShort, num } from '@/lib/format'

/**
 * A chart Tierra Agent attached to a reply (backend agent/charts.ts): bars, a line or a donut, drawn in SVG at the
 * bubble's width, with a hover tooltip, a legend for two or more series and a table view.
 */

export type ChartSpec = {
  type: 'bar' | 'line' | 'pie'
  title: string
  labels: string[]
  series: Array<{ name: string; values: number[] }>
  unit?: 'inr' | 'count' | 'kg' | 'pcs'
  stacked?: boolean
  note?: string
  /** Pie: the last label is the remainder ("All other ..."), drawn in neutral grey rather than a series colour. */
  other?: boolean
}

/** The spec from a reply's ```tierra-chart block, or null when it is not one the desk can draw. */
export function parseChart(json: string): ChartSpec | null {
  try {
    const value = JSON.parse(json) as Partial<ChartSpec>
    const labels = value.labels
    const series = value.series
    if (!value.type || !['bar', 'line', 'pie'].includes(value.type) || typeof value.title !== 'string') return null
    if (!Array.isArray(labels) || labels.length === 0 || !Array.isArray(series) || series.length === 0 || series.length > 4) return null
    const ok = series.every(
      (row) => typeof row?.name === 'string' && Array.isArray(row.values) && row.values.length === labels.length && row.values.every(Number.isFinite),
    )
    return ok ? { ...value, labels: labels.map(String), series } as ChartSpec : null
  } catch {
    return null
  }
}

/** Categorical slots in fixed order (validated on the bubble surface); a series keeps its slot. */
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)']
const HEIGHT = 220

/** A pie slice's colour: its categorical slot, or neutral grey for the remainder. */
function sliceColor(chart: ChartSpec, i: number): string {
  return chart.other && i === chart.labels.length - 1 ? 'var(--chart-other)' : SERIES[i % SERIES.length]!
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-06" or "2026-06-01" -> "Jun 26"; anything else as written. */
function labelText(label: string): string {
  const month = /^(\d{4})-(\d{2})(?:-01)?$/.exec(label)
  if (!month) return label
  return `${MONTHS[Number(month[2]) - 1] ?? month[2]} ${month[1]!.slice(2)}`
}

/** Months (or days) run left to right; anything else (customers, items, headings) is ranked in horizontal bars. */
const TIME_LABEL = /^(?:\d{4}-\d{2}(?:-\d{2})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s*'?\d{2,4})?|q[1-4]\b.*|fy\s*\d.*|\d{1,2}(?:\/\d{1,2})?)$/i
const isTimeAxis = (labels: string[]) => labels.every((label) => TIME_LABEL.test(label.trim()))

function fullValue(value: number, unit: ChartSpec['unit']): string {
  if (unit === 'inr') return inr(value)
  if (unit === 'kg') return `${num(value, 2)} kg`
  if (unit === 'pcs') return `${num(value)} pcs`
  return num(value, 2)
}

function shortValue(value: number, unit: ChartSpec['unit']): string {
  if (unit === 'inr') return inrShort(value)
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1e7) return `${sign}${+(abs / 1e7).toFixed(2)} cr`
  if (abs >= 1e5) return `${sign}${+(abs / 1e5).toFixed(1)}L`
  if (abs >= 1e3) return `${sign}${+(abs / 1e3).toFixed(1)}K`
  return num(value, 1)
}

/** About `count` clean ticks covering lo..hi (both include 0). */
function ticks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo || Math.abs(hi) || 1
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag
  const out: number[] = []
  for (let t = Math.floor(lo / step) * step; t <= hi + step * 0.001; t += step) out.push(Math.round(t / step) * step)
  if (out.at(-1)! < hi) out.push(out.at(-1)! + step)
  return out
}

/** A bar from the baseline to the value: square at the baseline, 4px rounded at the data end. */
function barPath(horizontal: boolean, at: number, thick: number, base: number, end: number, round: boolean): string {
  const len = Math.abs(end - base)
  const r = round ? Math.min(4, thick / 2, len) : 0
  const s = end < base ? 1 : -1
  if (!horizontal) {
    return `M${at},${base}L${at},${end + s * r}Q${at},${end} ${at + r},${end}L${at + thick - r},${end}Q${at + thick},${end} ${at + thick},${end + s * r}L${at + thick},${base}Z`
  }
  return `M${base},${at}L${end + s * r},${at}Q${end},${at} ${end},${at + r}L${end},${at + thick - r}Q${end},${at + thick} ${end + s * r},${at + thick}L${base},${at + thick}Z`
}

type Hover = { index: number; x: number; y: number } | null

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

function Tooltip({ chart, hover, width }: { chart: ChartSpec; hover: NonNullable<Hover>; width: number }) {
  const left = Math.min(Math.max(hover.x + 12, 0), Math.max(width - 190, 0))
  const pie = chart.type === 'pie'
  const total = pie ? chart.series[0]!.values.reduce((sum, v) => sum + v, 0) : 0
  return (
    <div className="charttip" style={{ left, top: Math.max(hover.y - 12, 0) }} role="status">
      <div className="charttiphead">{labelText(chart.labels[hover.index]!)}</div>
      {pie ? (
        <div className="charttiprow">
          <span className="key" style={{ background: sliceColor(chart, hover.index) }} />
          <span className="num">{fullValue(chart.series[0]!.values[hover.index]!, chart.unit)}</span>
          <span className="chartmuted">{total ? `${Math.round((chart.series[0]!.values[hover.index]! / total) * 100)}%` : ''}</span>
        </div>
      ) : (
        chart.series.map((series, i) => (
          <div key={series.name} className="charttiprow">
            <span className="key" style={{ background: SERIES[i] }} />
            <span>{series.name}</span>
            <span className="num">{fullValue(series.values[hover.index]!, chart.unit)}</span>
          </div>
        ))
      )}
    </div>
  )
}

function Axes({ chart, width }: { chart: ChartSpec; width: number }) {
  const [hover, setHover] = useState<Hover>(null)
  const horizontal = chart.type === 'bar' && !isTimeAxis(chart.labels)
  const n = chart.labels.length
  const stacked = chart.type === 'bar' && Boolean(chart.stacked) && chart.series.length > 1

  // the value range, stacking positives and negatives apart
  let lo = 0
  let hi = 0
  chart.labels.forEach((_, i) => {
    if (stacked) {
      hi = Math.max(hi, chart.series.reduce((sum, s) => sum + Math.max(s.values[i]!, 0), 0))
      lo = Math.min(lo, chart.series.reduce((sum, s) => sum + Math.min(s.values[i]!, 0), 0))
    } else {
      for (const s of chart.series) {
        hi = Math.max(hi, s.values[i]!)
        lo = Math.min(lo, s.values[i]!)
      }
    }
  })
  const bandLabel = horizontal ? Math.min(200, Math.max(72, width * 0.34)) : 0
  const pad = horizontal
    ? { top: 8, right: chart.series.length === 1 ? 64 : 16, bottom: 24, left: bandLabel }
    : { top: 12, right: chart.type === 'line' && chart.series.length === 1 ? 52 : 12, bottom: 28, left: 56 }
  const height = horizontal ? Math.max(120, n * Math.max(28, chart.series.length * 14 + 12) + pad.top + pad.bottom) : HEIGHT
  const plotW = Math.max(width - pad.left - pad.right, 40)
  const plotH = height - pad.top - pad.bottom
  // fewer value ticks where the value axis runs across a narrow bubble
  const full = ticks(lo, hi, horizontal ? Math.max(2, Math.min(4, Math.floor(plotW / 72))) : 4)
  const step = full.length > 1 ? full[1]! - full[0]! : 1
  // a small negative (a reversal, a credit) gets its own room, not a whole step below zero
  const vMin = lo < 0 && -lo < step / 2 ? lo * 1.25 : full[0]!
  const grid = full.filter((t) => t >= vMin)
  const vMax = grid.at(-1)!
  const labelChars = Math.max(6, Math.floor((bandLabel - 12) / 6.4))
  const valueLen = horizontal ? plotW : plotH
  const scale = (v: number) => ((v - vMin) / (vMax - vMin || 1)) * valueLen
  // value -> pixel along the value axis
  const at = (v: number) => (horizontal ? pad.left + scale(v) : pad.top + plotH - scale(v))
  const bandLen = (horizontal ? plotH : plotW) / n
  const bandStart = (i: number) => (horizontal ? pad.top : pad.left) + i * bandLen

  // bars: grouped side by side (2px gap) or stacked, each at most 24px thick
  const groups = stacked ? 1 : chart.series.length
  const thick = Math.max(2, Math.min(24, (bandLen * 0.72 - (groups - 1) * 2) / groups))
  const groupThick = groups * thick + (groups - 1) * 2

  const everyNth = horizontal ? 1 : Math.max(1, Math.ceil((n * 46) / plotW))
  const xMid = (i: number) => bandStart(i) + bandLen / 2

  function onMove(event: React.PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    const along = horizontal ? event.clientY - box.top : event.clientX - box.left
    const index = Math.min(n - 1, Math.max(0, Math.floor(along / bandLen)))
    const svg = event.currentTarget.ownerSVGElement!.getBoundingClientRect()
    setHover({ index, x: event.clientX - svg.left, y: event.clientY - svg.top })
  }

  const base = at(Math.max(vMin, Math.min(0, vMax)))
  return (
    <div className="chartplot">
      <svg width={width} height={height} role="img" aria-label={chart.title}>
        {grid.map((t) => {
          const p = at(t)
          return horizontal ? (
            <g key={t}>
              <line x1={p} x2={p} y1={pad.top} y2={pad.top + plotH} className={t === 0 ? 'chartbase' : 'chartgrid'} />
              <text x={p} y={height - 6} textAnchor="middle" className="charttick">{shortValue(t, chart.unit)}</text>
            </g>
          ) : (
            <g key={t}>
              <line x1={pad.left} x2={pad.left + plotW} y1={p} y2={p} className={t === 0 ? 'chartbase' : 'chartgrid'} />
              <text x={pad.left - 8} y={p + 4} textAnchor="end" className="charttick">{shortValue(t, chart.unit)}</text>
            </g>
          )
        })}
        {chart.labels.map((label, i) =>
          // every nth label counted back from the latest, so the newest month is always named
          (n - 1 - i) % everyNth === 0 ? (
            horizontal ? (
              <text key={i} x={pad.left - 8} y={xMid(i) + 4} textAnchor="end" className="chartlabel">
                {label.length > labelChars ? `${label.slice(0, labelChars - 1)}…` : label}
              </text>
            ) : (
              <text key={i} x={xMid(i)} y={height - 8} textAnchor="middle" className="chartlabel">
                {labelText(label)}
              </text>
            )
          ) : null,
        )}
        {hover && chart.type === 'bar' ? (
          horizontal ? (
            <rect x={pad.left} y={bandStart(hover.index)} width={plotW} height={bandLen} className="charthoverband" />
          ) : (
            <rect x={bandStart(hover.index)} y={pad.top} width={bandLen} height={plotH} className="charthoverband" />
          )
        ) : null}
        {chart.type === 'bar'
          ? chart.labels.map((_, i) => {
              let up = 0
              let down = 0
              const top = stacked
                ? {
                    up: chart.series.map((s) => s.values[i]!).reduce((last, v, k) => (v > 0 ? k : last), -1),
                    down: chart.series.map((s) => s.values[i]!).reduce((last, v, k) => (v < 0 ? k : last), -1),
                  }
                : null
              return chart.series.map((s, k) => {
                const v = s.values[i]!
                if (v === 0) return null
                const start = bandStart(i) + (bandLen - groupThick) / 2 + (stacked ? 0 : k * (thick + 2))
                let from = 0
                if (stacked) {
                  from = v > 0 ? up : down
                  if (v > 0) up += v
                  else down += v
                }
                // a 2px surface gap between stacked segments
                const gap = stacked && from !== 0 ? (horizontal ? (v > 0 ? 1 : -1) : v > 0 ? -1 : 1) * 2 : 0
                const round = !stacked || (v > 0 ? top!.up === k : top!.down === k)
                return <path key={k} d={barPath(horizontal, start, thick, at(from) + gap, at(from + v), round)} fill={SERIES[k]} />
              })
            })
          : null}
        {horizontal && chart.series.length === 1
          ? chart.series[0]!.values.map((v, i) => {
              // a negative bar's label sits left of it, or right of zero when the bar leaves no room for it
              const left = v < 0 && at(v) - pad.left >= 56
              return (
                <text key={i} x={left ? at(v) - 6 : Math.max(at(v), at(0)) + 6} y={xMid(i) + 4} textAnchor={left ? 'end' : 'start'} className="chartvalue">
                  {shortValue(v, chart.unit)}
                </text>
              )
            })
          : null}
        {chart.type === 'line'
          ? chart.series.map((s, k) => (
              <g key={k}>
                <polyline
                  points={s.values.map((v, i) => `${xMid(i)},${at(v)}`).join(' ')}
                  fill="none"
                  stroke={SERIES[k]}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {n === 1 || hover ? (
                  <circle cx={xMid(hover?.index ?? 0)} cy={at(s.values[hover?.index ?? 0]!)} r={4.5} fill={SERIES[k]} className="chartdot" />
                ) : null}
              </g>
            ))
          : null}
        {chart.type === 'line' && chart.series.length === 1 ? (
          <text x={xMid(n - 1) + 8} y={at(chart.series[0]!.values[n - 1]!) + 4} className="chartvalue">
            {shortValue(chart.series[0]!.values[n - 1]!, chart.unit)}
          </text>
        ) : null}
        {chart.type === 'line' && hover ? (
          <line x1={xMid(hover.index)} x2={xMid(hover.index)} y1={pad.top} y2={pad.top + plotH} className="chartcross" />
        ) : null}
        <line
          x1={horizontal ? base : pad.left}
          x2={horizontal ? base : pad.left + plotW}
          y1={horizontal ? pad.top : base}
          y2={horizontal ? pad.top + plotH : base}
          className="chartbase"
        />
        <rect
          x={pad.left}
          y={pad.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover ? <Tooltip chart={chart} hover={hover} width={width} /> : null}
    </div>
  )
}

function Donut({ chart, width }: { chart: ChartSpec; width: number }) {
  const [hover, setHover] = useState<Hover>(null)
  const values = chart.series[0]!.values
  const total = values.reduce((sum, v) => sum + v, 0)
  const size = Math.min(200, width)
  const r = size / 2 - 4
  const inner = r * 0.6
  const c = size / 2
  let angle = -Math.PI / 2
  const arcs = values.map((v, i) => {
    const sweep = total ? (v / total) * Math.PI * 2 : 0
    const a0 = angle
    const a1 = angle + sweep
    angle = a1
    if (sweep <= 0) return null
    const large = sweep > Math.PI ? 1 : 0
    const p = (rad: number, a: number) => `${c + rad * Math.cos(a)},${c + rad * Math.sin(a)}`
    const d =
      sweep >= Math.PI * 2 - 1e-6
        ? `M${c},${c - r}A${r},${r} 0 1 1 ${c - 0.01},${c - r}ZM${c},${c - inner}A${inner},${inner} 0 1 0 ${c + 0.01},${c - inner}Z`
        : `M${p(r, a0)}A${r},${r} 0 ${large} 1 ${p(r, a1)}L${p(inner, a1)}A${inner},${inner} 0 ${large} 0 ${p(inner, a0)}Z`
    return (
      <path
        key={i}
        d={d}
        fill={sliceColor(chart, i)}
        className="chartslice"
        fillRule="evenodd"
        onPointerMove={(event) => {
          const box = event.currentTarget.ownerSVGElement!.getBoundingClientRect()
          setHover({ index: i, x: event.clientX - box.left, y: event.clientY - box.top })
        }}
        onPointerLeave={() => setHover(null)}
      />
    )
  })
  return (
    <div className="chartdonut">
      <div className="chartplot">
        <svg width={size} height={size} role="img" aria-label={chart.title}>
          {arcs}
          <text x={c} y={c - 2} textAnchor="middle" className="chartcentre">{shortValue(total, chart.unit)}</text>
          <text x={c} y={c + 14} textAnchor="middle" className="charttick">total</text>
        </svg>
        {hover ? <Tooltip chart={chart} hover={hover} width={size} /> : null}
      </div>
      <ul className="chartlegend vertical">
        {chart.labels.map((label, i) => (
          <li key={i}>
            <span className="key" style={{ background: sliceColor(chart, i) }} />
            <span>{label}</span>
            <span className="num chartmuted">{total ? `${Math.round((values[i]! / total) * 100)}%` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ChartTable({ chart }: { chart: ChartSpec }) {
  return (
    <div className="charttable">
      <table>
        <thead>
          <tr>
            <th />
            {chart.series.map((s) => (
              <th key={s.name} className="num">{s.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chart.labels.map((label, i) => (
            <tr key={i}>
              <th>{labelText(label)}</th>
              {chart.series.map((s) => (
                <td key={s.name} className="num">{fullValue(s.values[i]!, chart.unit)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AgentChart({ chart }: { chart: ChartSpec }) {
  const [ref, width] = useWidth()
  const [table, setTable] = useState(false)
  return (
    <figure className="chart">
      <figcaption className="charthead">
        <span className="charttitle">{chart.title}</span>
        <button type="button" className="charttoggle" onClick={() => setTable((on) => !on)} aria-pressed={table}>
          {table ? 'Chart' : 'Table'}
        </button>
      </figcaption>
      {chart.type !== 'pie' && chart.series.length > 1 ? (
        <ul className="chartlegend">
          {chart.series.map((s, k) => (
            <li key={s.name}>
              <span className={chart.type === 'line' ? 'key line' : 'key'} style={{ background: SERIES[k] }} />
              {s.name}
            </li>
          ))}
        </ul>
      ) : null}
      <div ref={ref}>
        {table ? <ChartTable chart={chart} /> : width > 0 ? chart.type === 'pie' ? <Donut chart={chart} width={width} /> : <Axes chart={chart} width={width} /> : <div style={{ height: HEIGHT }} />}
      </div>
      {chart.note ? <p className="chartnote">{chart.note}</p> : null}
    </figure>
  )
}
