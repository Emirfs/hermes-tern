// The conversation as text: `/history`'s panel, and what `/handoff omp` carries over.

import type { Entry } from '../model.js'

import { answerText } from './turns.js'

/** `/history [chars]`: the conversation so far, each prompt and answer clipped to `chars` (Ink's preview). */
export function historyText(entries: readonly Entry[], arg: string): string {
  const preview = Math.max(80, Number.parseInt(arg, 10) || 400)
  let n = 0

  const lines = entries.flatMap(e => {
    if (e.kind !== 'user' && e.kind !== 'turn') {
      return []
    }

    const tools = e.kind === 'turn' ? e.blocks.filter(b => b.kind === 'tool').length : 0
    const said = e.kind === 'user' ? e.text.trim() : answerText(e)
    const body = said || (tools ? `(${tools} tool call${tools === 1 ? '' : 's'})` : '(empty)')
    const clipped = body.length > preview ? `${body.slice(0, preview).trimEnd()}…` : body

    return [`**${e.kind === 'user' ? 'You' : 'Hermes'} #${++n}**\n${clipped}`]
  })

  return lines.length ? lines.join('\n\n') : 'No conversation yet.'
}
