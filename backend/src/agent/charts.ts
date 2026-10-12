import { z } from 'zod/v4'
import type { Effect, ToolRun } from './tools'

/**
 * Charts on the desk. The model draws one with show_chart from figures a data tool returned; the chart rides in the
 * reply's body as a fenced block (```tierra-chart + JSON) that the desk renders and WhatsApp never receives.
 */

export const CHART_FENCE = 'tierra-chart'
export const CHART_LIMIT = 2
const POINTS = 36

export const chartSpec = z
  .object({
    type: z
      .enum(['bar', 'line', 'pie'])
      .describe('bar: compare amounts across months or items; line: a trend over many months; pie: shares of one total (one series, at most 8 slices)'),
    title: z.string().min(2).max(80).describe('What the chart shows, e.g. "Revenue and expenses, Feb to Jul 2026"'),
    labels: z.array(z.string().min(1).max(40)).min(1).max(POINTS).describe('The x-axis categories (months, items, customers) in order, e.g. ["Feb 26", "Mar 26"]'),
    series: z
      .array(
        z.object({
          name: z.string().min(1).max(40),
          values: z.array(z.number()).min(1).max(POINTS).describe('One value per label, in the same order, exactly as the tool returned it'),
        }),
      )
      .min(1)
      .max(4),
    unit: z.enum(['inr', 'count', 'kg', 'pcs']).optional().describe('inr for rupee amounts (whole rupees, never lakhs)'),
    stacked: z.boolean().optional().describe('bar only: stack the series (parts of one total)'),
    note: z.string().max(160).optional().describe('A short footnote, e.g. "SAP book figures as of 31 Jul 2026"'),
  })
  .refine((chart) => chart.series.every((series) => series.values.length === chart.labels.length), {
    message: 'every series needs exactly one value per label',
  })
  .refine((chart) => chart.type !== 'pie' || (chart.series.length === 1 && chart.labels.length <= 8 && chart.series[0]!.values.every((v) => v >= 0)), {
    message: 'a pie has one series of at most 8 values, none negative',
  })

export type ChartSpec = z.infer<typeof chartSpec>

/** The chart as it is stored in the reply. */
export function chartBlock(chart: ChartSpec): string {
  return `\`\`\`${CHART_FENCE}\n${JSON.stringify(chart)}\n\`\`\``
}

const BLOCK = new RegExp(`\\n*\`\`\`${CHART_FENCE}\\n[\\s\\S]*?\\n\`\`\``, 'g')

/** A reply without its charts (what the model reads back as history: the figures are in the text). */
export function withoutCharts(text: string): string {
  return text.replace(BLOCK, '').trim()
}

function numbersIn(value: unknown, out: number[]): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value)
  else if (Array.isArray(value)) value.forEach((item) => numbersIn(item, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => numbersIn(item, out))
  return out
}

/**
 * Whether every value on the chart is a figure some data tool returned this turn (to the rupee, or within 0.5% for a
 * rounded one): a chart never shows a number the tools did not give.
 */
export function chartBacked(chart: ChartSpec, runs: readonly ToolRun[]): boolean {
  const known = runs
    .filter((run) => run.ok && run.name !== 'show_chart')
    .flatMap((run) => {
      try {
        return numbersIn(JSON.parse(run.result) as unknown, [])
      } catch {
        return []
      }
    })
  return chart.series.every((series) =>
    series.values.every((value) => known.some((n) => Math.abs(n - value) <= Math.max(1, Math.abs(n) * 0.005))),
  )
}

/**
 * The chart blocks a reply carries: each queued chart whose figures are backed by the turn's tool results, and a
 * line for any left out.
 */
export function chartParts(effects: readonly Effect[], runs: readonly ToolRun[]): string[] {
  const charts = effects.flatMap((effect) => (effect.kind === 'show_chart' ? [effect.chart] : []))
  const backed = charts.filter((chart) => chartBacked(chart, runs))
  return [
    ...backed.map(chartBlock),
    ...(backed.length < charts.length ? ['(A chart was left out: its figures did not match the data.)'] : []),
  ]
}
