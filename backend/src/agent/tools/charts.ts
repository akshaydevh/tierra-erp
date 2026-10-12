import { CHART_LIMIT, chartSpec } from '../charts'
import { defineTool } from './types'

/** show_chart: a chart under the reply on the desk (charts.ts). It reads no data; the figures come from other tools. */
export const chartTools = [
  defineTool({
    name: 'show_chart',
    description:
      'Draws a chart under your reply on the Tierra desk (web), from figures another tool returned in this conversation. Use it when a chart makes the answer clearer: a monthly trend (revenue, expenses, profit, sales, payments), a comparison across items or customers, or the parts of a total. Pass the values exactly as the tool returned them. At most 2 charts per reply.',
    scope: 'internal',
    deskOnly: true,
    args: chartSpec,
    async run(ctx, args) {
      if (ctx.via !== 'desk') return { queued: false, message: 'Charts are shown on the Tierra desk only.' }
      if (ctx.effects.filter((effect) => effect.kind === 'show_chart').length >= CHART_LIMIT) {
        return { queued: false, message: `At most ${CHART_LIMIT} charts per reply.` }
      }
      ctx.effects.push({ kind: 'show_chart', chart: args })
      return { queued: true, message: 'The chart appears under your reply; still give the key figures in words.' }
    },
  }),
]
