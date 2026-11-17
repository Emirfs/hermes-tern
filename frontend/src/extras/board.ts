// Managing Hermes from Tern: the kanban board, cron jobs, plugins and state snapshots. The shared
// gateway's `slash.exec` refuses their writes (and /cron's reads: the profile's cron store is the
// gateway's own), so these run `hermes …` through `cli.exec`, a separate `hermes` process on the
// gateway host, and show its output; the ones that delete or replace something ask first.
//
// - `/kanban` opens the Kanban sheet (overlays/kanban.tsx); its read verbs stay with `slash.exec`, the
//   rest run as `hermes kanban …` (kanban/model.ts `kanbanText`).
// - `/cron` opens the Background sheet's Cron tab; `/cron <verb> …` runs `hermes cron <verb> …`.
// - `/plugins [list|all]` lists from `plugins.manage`; `/plugins <verb> <name>` runs `hermes plugins …`.
// - `/snapshot create` runs `hermes backup --quick`; list, restore and prune call the plugin's
//   `snapshots.*` RPC methods (backend/gateway/snapshots.py), which call the classic CLI's functions.

import type { AgentPluginRow } from '@hermes/shared/gateway-events'
import * as z from 'zod/mini'

import type { CommandHost, LocalCommand } from '../commands/local.js'
import { optional } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import { kanbanText, option } from '../kanban/model.js'
import { openBackground } from '../overlays/background.js'
import { openKanban } from '../overlays/kanban.js'
import { confirmOverlay } from '../overlays/prompts.js'
import { openHermesSplit } from '../watch/spec.js'
import { rpc } from '../wire/rpc.js'
import { loose } from '../wire/schemas.js'

import { argWords, hermesExec } from './cli.js'

/** A `hermes <argv>` run whose output shows in a panel titled `title`; `confirm` is asked first. */
export interface CliForm {
  kind: 'run'
  argv: string[]
  title: string
  confirm?: string
  /** The question's detail; else the command it runs. */
  detail?: string
  timeout?: number
}

/** A command form's usage notice. */
export interface Usage {
  kind: 'usage'
  text: string
}

const usage = (text: string): Usage => ({ kind: 'usage', text })

/** cli.exec's longest wait, for runs that call a model or a package index. */
const LONG = 600

// ── Running ────────────────────────────────────────────────────────────

/** Runs `form` (asking first when it says to); `done` runs after a run that went. */
function runForm(host: CommandHost, name: string, form: CliForm, done?: () => void): Promise<void> | void {
  const go = async () => {
    const r = await hermesExec(host, form.argv, form.timeout)

    if (r.blocked) {
      return host.transcript.notice(r.hint || `\`hermes ${form.argv.join(' ')}\` cannot run here.`, 'warning')
    }

    host.transcript.panel(form.title, r.output || '(no output)')

    if (r.code) {
      host.transcript.notice(`\`hermes ${form.argv.join(' ')}\` exited with code ${r.code}.`, 'warning')
    }

    done?.()
  }

  if (!form.confirm) {
    return go()
  }

  host.open(
    confirmOverlay(host, {
      confirm: 'Run',
      detail: form.detail ?? `Runs \`hermes ${form.argv.join(' ')}\`.`,
      onConfirm: () => void go().catch((e: unknown) => host.transcript.notice(`/${name} failed: ${errorText(e)}`, 'error')),
      title: form.confirm
    })
  )
}

/** Runs a command, reporting what it throws as `/<name> failed: …`. */
const guarded =
  (name: string, run: LocalCommand['run']): LocalCommand['run'] =>
  async (host, arg) => {
    try {
      return await run(host, arg)
    } catch (e) {
      host.transcript.notice(`/${name} failed: ${errorText(e)}`, 'error')
    }
  }

// ── /kanban ────────────────────────────────────────────────────────────

async function kanban(host: CommandHost, arg: string) {
  const t = kanbanText(argWords(arg))

  switch (t.kind) {
    case 'sheet':
      return void openKanban(host, optional('board', t.board))

    case 'gateway':
      return false

    case 'usage':
      return host.transcript.notice(t.text, 'warning')

    case 'split':
      return (await openHermesSplit(t.argv, host.session.info?.cwd || process.env['HOME'] || '/'))
        ? host.transcript.notice(`Running \`hermes ${t.argv.join(' ')}\` in the split below (Ctrl+C there stops it).`)
        : host.transcript.notice(`\`hermes ${t.argv.join(' ')}\` streams until Ctrl+C: run it in a terminal.`, 'warning')

    case 'run':
      return runForm(host, 'kanban', t)
  }
}

// ── /cron ──────────────────────────────────────────────────────────────

export type CronText = { kind: 'sheet' } | CliForm | Usage

const CRON_READS: Readonly<Record<string, true>> = {
  doctor: true,
  history: true,
  incidents: true,
  list: true,
  notepad: true,
  runs: true,
  status: true
}

/** Verbs that take a job id first. */
const CRON_JOB_VERBS: Readonly<Record<string, true>> = {
  cancel: true,
  delete: true,
  edit: true,
  pause: true,
  remove: true,
  resume: true,
  rm: true,
  run: true
}

const CRON_USAGE =
  'Usage: /cron opens the Cron tab. /cron list|status|runs|incidents|doctor reads; /cron create <schedule> [prompt] [--name …] [--deliver …], edit|pause|resume|run|cancel|remove <job id> change.'

/** What `/cron <words>` does. */
export function cronText(words: readonly string[]): CronText {
  const [first, ...rest] = words
  const verb = first?.toLowerCase()

  if (!verb) {
    return { kind: 'sheet' }
  }

  const argv = ['cron', verb, ...rest]
  const title = `/cron ${words.join(' ')}`

  if (Object.hasOwn(CRON_READS, verb)) {
    return { argv, kind: 'run', title }
  }

  if (verb === 'create' || verb === 'add') {
    return rest.length ? { argv, kind: 'run', title } : usage('Usage: /cron create <schedule> [prompt] [--name …] [--deliver telegram|whatsapp|…]')
  }

  if (verb === 'tick') {
    return usage("The gateway's scheduler already runs due jobs. /cron run <job id> runs one now.")
  }

  if (!Object.hasOwn(CRON_JOB_VERBS, verb)) {
    return usage(`Unknown /cron verb \`${first}\`. ${CRON_USAGE}`)
  }

  const [id] = rest

  if (!id) {
    return usage(`Usage: /cron ${verb} <job id> (the Cron tab and /cron list show the ids)`)
  }

  if (verb === 'remove' || verb === 'rm' || verb === 'delete') {
    return { argv, confirm: `Remove cron job ${id}? It will not run again.`, kind: 'run', title }
  }

  // `run` runs the job to its end in that process (hermes_cli/cron.py `_job_action`).
  return { argv, kind: 'run', title, ...(verb === 'run' ? { timeout: LONG } : {}) }
}

function cron(host: CommandHost, arg: string) {
  const t = cronText(argWords(arg))

  switch (t.kind) {
    case 'sheet':
      return openBackground(host, { tab: 'cron' })

    case 'usage':
      return host.transcript.notice(t.text, 'warning')

    case 'run':
      return runForm(host, 'cron', t, () => void host.cron.refresh())
  }
}

// ── /plugins ───────────────────────────────────────────────────────────

/** What a plugin's line reads of its `plugins.manage` row. */
type PluginRow = Pick<AgentPluginRow, 'name'> & Partial<Pick<AgentPluginRow, 'description' | 'source' | 'status' | 'version'>>

/** One Markdown line per plugin: ✓ enabled, ✗ disabled, else its status in words. */
export function pluginLines(rows: readonly PluginRow[]): string[] {
  const mark = (status = '') => (status === 'enabled' ? '✓' : status === 'disabled' ? '✗' : '·')

  return rows.map(p => {
    const facts = [p.version, p.source, p.status === 'enabled' || p.status === 'disabled' ? '' : p.status]
      .filter(Boolean)
      .join(', ')

    return `- ${mark(p.status)} **${p.name}**${facts ? ` (${facts})` : ''}${p.description ? ` — ${p.description}` : ''}`
  })
}

export type PluginsText = { kind: 'list'; all: boolean } | CliForm | Usage

const ACTIVATION =
  'Hermes attempts to activate enabled plugins through live gateway reload without stopping messaging. The CLI output reports what is live or deferred; restart only if that output requests it.'

const PLUGINS_USAGE =
  'Usage: /plugins [list|all], /plugins enable|disable|info|install|remove|update <name>, /plugins search [term], /plugins browse, /plugins check-updates'

/** Verbs that need a plugin name, and whether they ask first. */
const PLUGIN_NAMED: Readonly<Record<string, { confirm?: (name: string) => string }>> = {
  disable: {},
  enable: {},
  info: {},
  install: { confirm: name => `Install plugin ${name}?` },
  remove: { confirm: name => `Remove plugin ${name}?` },
  rm: { confirm: name => `Remove plugin ${name}?` },
  show: {},
  uninstall: { confirm: name => `Remove plugin ${name}?` }
}

/** What `/plugins <words>` does. */
export function pluginsText(words: readonly string[]): PluginsText {
  const [first = 'list', ...rest] = words
  const verb = first.toLowerCase()
  const title = `/plugins ${words.join(' ')}`

  if (verb === 'list' || verb === 'ls' || verb === 'all') {
    return { all: verb === 'all', kind: 'list' }
  }

  if (verb === 'search' || verb === 'browse' || verb === 'check-updates' || verb === 'check') {
    return { argv: ['plugins', verb, ...rest], kind: 'run', title }
  }

  if (verb === 'update') {
    const [name] = rest

    // With no name, `hermes plugins update` asks before updating them all; without a terminal it needs --yes.
    return name
      ? { argv: ['plugins', 'update', ...rest], confirm: `Update plugin ${name}?`, kind: 'run', timeout: LONG, title }
      : {
          argv: ['plugins', 'update', '--yes', ...rest],
          confirm: 'Update every plugin that has an update?',
          detail: '`/plugins check-updates` lists them first. ' + ACTIVATION,
          kind: 'run',
          timeout: LONG,
          title
        }
  }

  const spec = Object.hasOwn(PLUGIN_NAMED, verb) ? PLUGIN_NAMED[verb] : undefined

  if (!spec) {
    return usage(`Unknown /plugins verb \`${first}\`. ${PLUGINS_USAGE}`)
  }

  const [name] = rest

  if (!name) {
    return usage(`Usage: /plugins ${verb} <name>`)
  }

  if (verb === 'install') {
    // cmd_install refuses dependency consent without a TTY. Our confirmation supplies that consent
    // explicitly; --no-deps leaves the plugin disabled, as Hermes documents. Existing flags win;
    // scanners, capabilities and admission remain Hermes' own fail-closed gates.
    const noDeps = rest.includes('--no-deps')
    const consent = !noDeps && !rest.includes('--yes-deps') ? ['--yes-deps'] : []
    const activate = !noDeps && !rest.includes('--enable') && !rest.includes('--no-enable') ? ['--enable'] : []
    const deps = noDeps ? 'Do not install Python dependencies (--no-deps).' : 'Consent to install this plugin’s declared Python dependencies.'
    const enabled = !noDeps && !rest.includes('--no-enable')

    return {
      argv: ['plugins', 'install', ...consent, ...activate, ...rest],
      confirm: `Install plugin ${name}?`,
      detail: `${deps} ${enabled ? 'Enable the plugin and attempt live activation.' : 'Leave the plugin disabled.'} Hermes’ security scanner and capability permissions still apply. ${ACTIVATION}`,
      kind: 'run',
      timeout: LONG,
      title
    }
  }

  return {
    argv: ['plugins', verb, ...rest],
    ...(spec.confirm ? { confirm: spec.confirm(name) } : {}),
    kind: 'run',
    title
  }
}

async function plugins(host: CommandHost, arg: string) {
  const t = pluginsText(argWords(arg))

  if (t.kind === 'usage') {
    return host.transcript.notice(t.text, 'warning')
  }

  if (t.kind === 'run') {
    return runForm(host, 'plugins', t)
  }

  // The Plugins Hub's own list (`plugins.manage list`), user plugins first as the hub shows them.
  const r = await rpc(host.gw, 'plugins.manage', { action: 'list' })
  const rows = r?.plugins ?? []
  const user = rows.filter(p => p.source !== 'bundled')
  // No user plugins: the bundled ones, so the list is never empty when some exist (as the hub falls back).
  const shown = t.all || !user.length ? rows : user
  const hidden = rows.length - shown.length

  if (!rows.length) {
    return host.transcript.notice('No plugins installed.')
  }

  host.transcript.panel(
    'Plugins',
    [
      ...pluginLines(shown),
      ...(hidden ? ['', `${hidden} bundled plugin${hidden === 1 ? '' : 's'} not shown: /plugins all lists them.`] : [])
    ].join('\n')
  )
}

// ── /snapshot ──────────────────────────────────────────────────────────

export type SnapshotText = { kind: 'list' } | { kind: 'restore'; ref: string } | { kind: 'prune'; keep: number } | CliForm | Usage

const SNAPSHOT_USAGE = 'Usage: /snapshot [list], /snapshot create [label], /snapshot restore <id|number>, /snapshot prune [keep, default 20]'

/** The classic CLI's /snapshot prune default (backend/gateway/snapshots.py DEFAULT_KEEP). */
export const DEFAULT_KEEP = 20

/** What `/snapshot <words>` does. */
export function snapshotText(words: readonly string[]): SnapshotText {
  const [first = 'list', ...rest] = words
  const verb = first.toLowerCase()

  switch (verb) {
    case 'list':
    case 'ls':
      return { kind: 'list' }

    case 'create': {
      const label = rest.join(' ').trim()

      return { argv: ['backup', '--quick', ...(label ? [option('label', label)] : [])], kind: 'run', title: '/snapshot create' }
    }

    case 'restore':
    case 'rewind': {
      const [ref] = rest

      return ref ? { kind: 'restore', ref } : usage('Usage: /snapshot restore <id|number> (/snapshot list shows them)')
    }

    case 'prune': {
      const [keep = String(DEFAULT_KEEP)] = rest

      // Digits only: a negative keep would delete the newest ones instead (the classic CLI's check).
      return /^\d+$/.test(keep) ? { keep: Number(keep), kind: 'prune' } : usage('Usage: /snapshot prune [how many to keep, default 20]')
    }

    default:
      return usage(`Unknown /snapshot verb \`${first}\`. ${SNAPSHOT_USAGE}`)
  }
}

const SNAPSHOTS = 'plugin.hermes-tern.snapshots.'

const snapshotRow = z.object({
  id: z.string(),
  label: loose(z.string()),
  timestamp: loose(z.string()),
  file_count: loose(z.number()),
  total_size: loose(z.number())
})

export type SnapshotRow = z.infer<typeof snapshotRow>

const snapshotList = z.object({ dir: z.string(), snapshots: z.array(snapshotRow), total: z.number() })
const restoreAnswer = z.object({
  alternative: loose(z.string()),
  id: z.string(),
  reason: loose(z.string()),
  refused: z.boolean(),
  restored: z.boolean()
})
const pruneAnswer = z.object({ deleted: z.number(), keep: z.number() })

/** Calls the plugin's `snapshots.<method>` and checks its answer against `schema`. */
async function snapshotsRpc<T>(host: Pick<CommandHost, 'gw'>, method: string, params: Record<string, unknown>, schema: z.ZodMiniType<T>): Promise<T> {
  const r = schema.safeParse(await host.gw.request<unknown>(`${SNAPSHOTS}${method}`, params))

  if (!r.success) {
    throw new Error(`snapshots.${method} answered in an unknown shape: restart the gateway so it loads this hermes-tern version.`)
  }

  return r.data
}

/** `2.0 MB`: a size as the classic CLI's /snapshot list writes it. */
export function snapshotSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The /snapshot list panel: a table numbered as `/snapshot restore <number>` takes them. */
export function snapshotTable(list: { dir: string; snapshots: readonly SnapshotRow[]; total: number }): string {
  if (!list.snapshots.length) {
    return 'No snapshots yet. /snapshot create [label] takes one.'
  }

  const cell = (s: string) => s.replace(/\|/g, '\\|')

  return [
    `Snapshots in \`${list.dir}\`, newest first:`,
    '',
    '| # | Snapshot | Files | Size | Label |',
    '|--:|---|--:|--:|---|',
    ...list.snapshots.map(
      (s, i) => `| ${i + 1} | \`${s.id}\` | ${s.file_count ?? 0} | ${snapshotSize(s.total_size ?? 0)} | ${cell(s.label ?? '')} |`
    ),
    ...(list.total > list.snapshots.length ? ['', `${list.total - list.snapshots.length} older not shown.`] : []),
    '',
    '`/snapshot restore <# or id>` restores one, `/snapshot prune [keep]` deletes the oldest.'
  ].join('\n')
}

async function restoreSnapshot(host: CommandHost, ref: string) {
  const check = await snapshotsRpc(host, 'restore', { check: true, id: ref }, restoreAnswer)

  if (check.refused) {
    return host.transcript.notice(`Not restoring ${check.id}: ${check.reason ?? 'the gateway owns this profile.'} ${check.alternative ?? ''}`.trim(), 'warning')
  }

  const restore = async () => {
    const r = await snapshotsRpc(host, 'restore', { id: check.id }, restoreAnswer)

    if (r.restored) {
      host.transcript.notice(`Restored snapshot ${r.id}. Restart Hermes so every process reads the restored state.`)
    } else if (r.refused) {
      host.transcript.notice(`Not restoring ${r.id}: ${r.reason ?? ''} ${r.alternative ?? ''}`.trim(), 'warning')
    } else {
      host.transcript.notice(`Snapshot ${r.id} was not restored completely; the gateway's log says why.`, 'error')
    }
  }

  host.open(
    confirmOverlay(host, {
      confirm: 'Restore',
      detail: "It replaces this profile's state.db, config and cron files with the snapshot's copies: what changed since is lost.",
      onConfirm: () => void restore().catch((e: unknown) => host.transcript.notice(`/snapshot failed: ${errorText(e)}`, 'error')),
      title: `Restore snapshot ${check.id}?`
    })
  )
}

async function pruneSnapshots(host: CommandHost, keep: number) {
  const { total } = await snapshotsRpc(host, 'list', { limit: 1 }, snapshotList)

  if (total <= keep) {
    return host.transcript.notice(`Nothing to prune: ${total} snapshot${total === 1 ? '' : 's'}, keeping ${keep}.`)
  }

  const prune = async () => {
    const r = await snapshotsRpc(host, 'prune', { keep }, pruneAnswer)
    host.transcript.notice(`Deleted ${r.deleted} snapshot${r.deleted === 1 ? '' : 's'}; kept the ${r.keep} newest.`)
  }

  host.open(
    confirmOverlay(host, {
      confirm: 'Delete',
      detail: `${total} snapshots now; the ${keep} newest stay.`,
      onConfirm: () => void prune().catch((e: unknown) => host.transcript.notice(`/snapshot failed: ${errorText(e)}`, 'error')),
      title: `Delete the ${total - keep} oldest snapshot${total - keep === 1 ? '' : 's'}?`
    })
  )
}

async function snapshot(host: CommandHost, arg: string) {
  const t = snapshotText(argWords(arg))

  switch (t.kind) {
    case 'usage':
      return host.transcript.notice(t.text, 'warning')

    case 'run':
      return runForm(host, 'snapshot', t)

    case 'list':
      return host.transcript.panel('Snapshots', snapshotTable(await snapshotsRpc(host, 'list', {}, snapshotList)))

    case 'restore':
      return restoreSnapshot(host, t.ref)

    case 'prune':
      return pruneSnapshots(host, t.keep)
  }
}

export const BOARD_COMMANDS: readonly LocalCommand[] = [
  { name: 'kanban', run: guarded('kanban', kanban) },
  { name: 'cron', run: guarded('cron', cron) },
  { name: 'plugins', run: guarded('plugins', plugins) },
  { aliases: ['snap'], name: 'snapshot', run: guarded('snapshot', snapshot) }
]
