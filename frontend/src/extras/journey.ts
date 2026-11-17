// `/journey` (also /learning, /memory-graph): what Hermes learned over time, as the desktop's Star Map
// and the TUI's overlay show it. `hermes journey --json` (on the gateway host) gives the learned
// skills and memories; the panel draws them with Tern's own renderers: an svg chart of both
// growing over time, in the theme's colors, and a table. `list`, `delete` and `edit` work on one
// node id; `edit` needs an editor, so it runs in a split with `tern open --wait` as $EDITOR.

import * as z from 'zod/mini'

import type { CommandHost, LocalCommand } from '../commands/local.js'
import { errorText } from '../core/errors.js'
import { confirmOverlay } from '../overlays/prompts.js'
import { splitHermes } from '../watch/spec.js'

import { argWords, hermesExec, hermesJson } from './cli.js'
import { fenced } from './logs.js'

const text = z.catch(z.string(), '')
const count = z.catch(z.number(), 0)

const journeyNode = z.object({
  category: z.catch(z.nullable(z.string()), null),
  createdBy: z.catch(z.nullable(z.string()), null),
  id: z.string(),
  kind: text,
  label: text,
  pinned: z.catch(z.boolean(), false),
  state: text,
  timestamp: z.catch(z.nullable(z.number()), null),
  useCount: count
})

/** `hermes journey --json`: the nodes it draws (the rest of the payload is the desktop's graph). */
export const journeyPayload = z.object({ nodes: z.array(journeyNode) })

export type JourneyNode = z.infer<typeof journeyNode>

/** The kinds the chart draws, each with its series color. */
const SERIES = [
  { color: 'var(--c1)', kind: 'skill', label: 'Skills' },
  { color: 'var(--c2)', kind: 'memory', label: 'Memories' }
] as const

/** A node's date, YYYY-MM-DD (UTC); '' when it has none. */
export function nodeDate(node: Pick<JourneyNode, 'timestamp'>): string {
  return node.timestamp ? new Date(node.timestamp * 1000).toISOString().slice(0, 10) : ''
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The chart: one step line per kind counting its nodes as they were learned (x: time, y: how many
 * by then), a dot per node, date ticks and a legend. Only theme colors, sized by its viewBox.
 * Undefined when no node has a time.
 */
export function journeySvg(nodes: readonly JourneyNode[]): string | undefined {
  const dated = nodes.filter((n): n is JourneyNode & { timestamp: number } => typeof n.timestamp === 'number').toSorted((a, b) => a.timestamp - b.timestamp)
  const first = dated[0]
  const last = dated.at(-1)

  if (!first || !last) {
    return undefined
  }

  const [W, H, left, right, top, bottom] = [760, 280, 48, 24, 36, 40]
  const t0 = first.timestamp
  const span = Math.max(last.timestamp - t0, 86_400)
  const counts = SERIES.map(s => dated.filter(n => n.kind === s.kind).length)
  const max = Math.max(1, ...counts)
  const x = (t: number) => left + ((t - t0) / span) * (W - left - right)
  const y = (n: number) => H - bottom - (n / max) * (H - top - bottom)
  const f = (v: number) => Number(v.toFixed(1))
  const parts: string[] = []

  // Axes and the count's gridlines.
  // Every count up to 6, else quarters: no skipped tick between evenly spaced lines.
  const steps = max <= 6 ? max : 4

  for (let i = 0; i <= steps; i++) {
    const n = Math.round((max * i) / steps)
    parts.push(
      `<line x1="${left}" x2="${W - right}" y1="${f(y(n))}" y2="${f(y(n))}" stroke="var(--border)" stroke-width="1"/>`,
      `<text x="${left - 8}" y="${f(y(n) + 4)}" text-anchor="end" font-size="12" fill="var(--muted)">${n}</text>`
    )
  }

  // Date ticks: the first, the last and up to three between.
  for (let i = 0; i <= 4; i++) {
    const t = t0 + (span * i) / 4
    const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle'
    parts.push(
      `<text x="${f(x(t))}" y="${H - bottom + 20}" text-anchor="${anchor}" font-size="12" fill="var(--muted)">${nodeDate({ timestamp: t })}</text>`
    )
  }

  SERIES.forEach((s, i) => {
    const mine = dated.filter(n => n.kind === s.kind)

    if (mine.length) {
      const path = [`M${f(x(t0))},${f(y(0))}`, ...mine.map((n, k) => `H${f(x(n.timestamp))}V${f(y(k + 1))}`), `H${W - right}`].join('')
      parts.push(`<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.5"/>`)
      parts.push(
        ...mine.map(
          (n, k) =>
            `<circle cx="${f(x(n.timestamp))}" cy="${f(y(k + 1))}" r="4" fill="${s.color}"><title>${escapeXml(`${n.label} · ${nodeDate(n)}`)}</title></circle>`
        )
      )
    }

    const lx = left + i * 150
    parts.push(
      `<rect x="${lx}" y="10" width="12" height="12" rx="3" fill="${s.color}"/>`,
      `<text x="${lx + 18}" y="21" font-size="14" fill="var(--fg)">${s.label} · ${counts[i] ?? 0}</text>`
    )
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

/** How many rows the table shows, newest first. */
const TABLE_ROWS = 60

/** The panel: a summary line, the chart and the table, newest first. */
export function journeyMarkdown(nodes: readonly JourneyNode[]): string {
  if (!nodes.length) {
    return 'Hermes has not learned any skills or memories yet.'
  }

  const skills = nodes.filter(n => n.kind === 'skill').length
  const memories = nodes.filter(n => n.kind === 'memory').length
  const categories = new Set(nodes.filter(n => n.kind === 'skill' && n.category).map(n => n.category)).size
  const svg = journeySvg(nodes)
  const rows = nodes.toSorted((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))

  return [
    `**${skills}** learned skills · **${memories}** memories · ${categories} skill categories`,
    ...(svg ? ['', '```svg', svg, '```'] : []),
    '',
    '| Kind | Label | Category | Uses | State | Date |',
    '| --- | --- | --- | ---: | --- | --- |',
    ...rows
      .slice(0, TABLE_ROWS)
      .map(n => `| ${cell(n.kind)} | ${cell(n.label || n.id)} | ${cell(n.category ?? '')} | ${n.useCount} | ${cell(n.state)}${n.pinned ? ' · pinned' : ''} | ${nodeDate(n)} |`),
    ...(rows.length > TABLE_ROWS ? ['', `…and ${rows.length - TABLE_ROWS} older.`] : []),
    '',
    '`/journey list` shows each id; `/journey delete <id>` and `/journey edit <id>` work on one.'
  ].join('\n')
}

export const JOURNEY_USAGE = 'Usage: /journey [list | delete <id> | edit <id>]'

/** `tern open --wait` as $EDITOR for the split: Tern's own CLI file (tern.com on Windows) when its path splits cleanly. */
export function ternEditor(env: NodeJS.ProcessEnv = process.env): string {
  const exe = env['TERN_EXE']

  return `${exe && !/\s/.test(exe) ? exe : 'tern'} open --wait`
}

async function show(host: CommandHost) {
  const payload = await hermesJson(host, ['journey', '--json'], journeyPayload)
  host.transcript.panel('Learning journey', journeyMarkdown(payload.nodes))
}

async function list(host: CommandHost) {
  const r = await hermesExec(host, ['journey', 'list', '--no-color'])

  if (r.blocked) {
    return host.transcript.notice(r.hint || '`hermes journey list` cannot run here.', 'warning')
  }

  host.transcript.panel('Learning journey ids', fenced(r.output, 'Nothing learned yet.'))
  if (r.code) host.transcript.notice(`\`hermes journey list\` exited with code ${r.code}.`, 'warning')
}

function remove(host: CommandHost, id: string) {
  const run = async () => {
    try {
      const r = await hermesExec(host, ['journey', 'delete', '-y', id])

      if (r.blocked) {
        host.transcript.notice(r.hint || '`hermes journey delete` cannot run here.', 'warning')
      } else {
        host.transcript.notice(r.output || `Deleted ${id}.`, r.code ? 'warning' : 'info')
      }
    } catch (e) {
      host.transcript.notice(`/journey delete failed: ${errorText(e)}`, 'error')
    }

    host.changed()
  }

  host.open(
    confirmOverlay(host, {
      confirm: 'Delete',
      detail: `A learned skill is archived, a memory is removed. Runs \`hermes journey delete -y ${id}\`.`,
      onConfirm: () => void run(),
      title: `Delete ${id}?`
    })
  )
}

async function edit(host: CommandHost, id: string) {
  const split = await splitHermes(['journey', 'edit', id], host.session.info?.cwd || process.cwd(), {
    side: 'right',
    vars: { EDITOR: ternEditor() }
  })

  host.transcript.notice(
    split.opened
      ? `Editing ${id} in a Tern file block beside the split on the right; save and close it to apply the change.`
      : `Could not open a split for \`hermes journey edit ${id}\`: ${split.reason}. Run it in a terminal instead.`,
    split.opened ? 'info' : 'warning'
  )
}

export const JOURNEY_COMMANDS: readonly LocalCommand[] = [
  {
    aliases: ['learning', 'memory-graph'],
    help: 'What Hermes learned over time: skills and memories as a chart and a table (list, delete <id>, edit <id>)',
    name: 'journey',
    run: async (host, arg) => {
      const [action, id, ...rest] = argWords(arg)

      try {
        switch (action) {
          case undefined:
            return await show(host)
          case 'list':
            return id ? host.transcript.notice(JOURNEY_USAGE, 'warning') : await list(host)
          case 'delete':
          case 'edit':
            if (!id || rest.length) {
              return host.transcript.notice(`Usage: /journey ${action} <id> (\`/journey list\` shows the ids)`, 'warning')
            }

            return action === 'delete' ? remove(host, id) : await edit(host, id)
          default:
            return host.transcript.notice(JOURNEY_USAGE, 'warning')
        }
      } catch (e) {
        host.transcript.notice(`/journey failed: ${errorText(e)}`, 'error')
      }
    }
  }
]
