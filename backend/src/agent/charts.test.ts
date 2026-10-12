import { describe, expect, it } from 'vitest'
import { chartBacked, chartBlock, chartParts, chartSpec, withoutCharts, type ChartSpec } from './charts'
import type { ToolRun } from './tools'

const chart: ChartSpec = {
  type: 'bar',
  title: 'Revenue and expenses',
  labels: ['2026-06', '2026-07'],
  series: [
    { name: 'Revenue', values: [7811397, 7506946] },
    { name: 'Expenses', values: [3993180, 1467556] },
  ],
  unit: 'inr',
}

const pnl: ToolRun = {
  name: 'monthly_pnl',
  args: {},
  ok: true,
  result: JSON.stringify({
    months: { '2026-06': { revenue: 7811397, expenses: 3993180 }, '2026-07': { revenue: 7506946, expenses: 1467556 } },
  }),
}

describe('charts', () => {
  it('takes one value per label, and a pie of one series without negatives', () => {
    expect(chartSpec.safeParse(chart).success).toBe(true)
    expect(chartSpec.safeParse({ ...chart, labels: ['2026-06'] }).success).toBe(false)
    expect(chartSpec.safeParse({ ...chart, type: 'pie' }).success).toBe(false)
    expect(chartSpec.safeParse({ type: 'pie', title: 'Split', labels: ['a', 'b'], series: [{ name: 's', values: [1, -1] }] }).success).toBe(false)
  })

  it('keeps a chart only when every value came from a tool result', () => {
    expect(chartBacked(chart, [pnl])).toBe(true)
    expect(chartBacked({ ...chart, series: [{ name: 'Revenue', values: [7811397, 7600000] }] }, [pnl])).toBe(false)
    // a show_chart result is not a source of figures
    expect(chartBacked(chart, [{ ...pnl, name: 'show_chart' }])).toBe(false)
    expect(chartParts([{ kind: 'show_chart', chart }], [])).toEqual(['(A chart was left out: its figures did not match the data.)'])
    expect(chartParts([{ kind: 'show_chart', chart }], [pnl])).toEqual([chartBlock(chart)])
  })

  it('strips charts from a reply', () => {
    const reply = `Revenue was *₹75,06,946* in July.\n\n${chartBlock(chart)}\n\n${chartBlock(chart)}`
    expect(withoutCharts(reply)).toBe('Revenue was *₹75,06,946* in July.')
  })
})
