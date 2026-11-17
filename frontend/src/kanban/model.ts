// Hermes' kanban board (`hermes kanban …`, a SQLite board per project) for the /kanban sheet and its
// text forms: the shapes `hermes kanban list|show|boards list --json` print (hermes_cli/kanban_output.py
// `_task_to_dict`, kanban.py `_cmd_show`, kanban_boards.py), the board's columns, the status moves the
// CLI has a verb for, and the `hermes` argv of every write. The gateway's `slash.exec` answers the
// read verbs of `/kanban` (gateway/session_commands.py `_KANBAN_READS`) and refuses the rest; those
// run as `hermes kanban …` through `cli.exec`.

import * as z from 'zod/mini'

import { loose } from '../wire/schemas.js'

const text = loose(z.nullable(z.string()))
const stamp = loose(z.nullable(z.number()))

/** One task of `hermes kanban list --json` (and `show --json`'s `task`); stamps are Unix seconds. */
const task = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  assignee: text,
  priority: stamp,
  tenant: text,
  body: text,
  result: text,
  created_by: text,
  created_at: stamp,
  started_at: stamp,
  completed_at: stamp,
  workspace_kind: text,
  workspace_path: text,
  branch_name: text,
  last_failure_error: text,
  skills: loose(z.array(z.string()))
})

export type KanbanTask = z.infer<typeof task>

export const taskList = z.array(task)

/** One board of `hermes kanban boards list --json`. */
const board = z.object({
  slug: z.string(),
  name: text,
  description: text,
  is_current: loose(z.boolean()),
  total: stamp
})

export type KanbanBoard = z.infer<typeof board>

export const boardList = z.array(board)

/** `hermes kanban show <id> --json`. */
export const taskDetail = z.object({
  task,
  latest_summary: text,
  parents: z.catch(z.array(z.string()), []),
  children: z.catch(z.array(z.string()), []),
  comments: z.catch(z.array(z.object({ author: text, body: text, created_at: stamp })), []),
  events: z.catch(z.array(z.object({ kind: z.string(), created_at: stamp })), []),
  runs: z.catch(
    z.array(z.object({ profile: text, status: text, outcome: text, summary: text, error: text, started_at: stamp, ended_at: stamp })),
    []
  )
})

export type KanbanDetail = z.infer<typeof taskDetail>

/** The board's columns, in the order the sheet shows them (hermes_cli/kanban_workflow.py DEFAULT_WORKFLOW). */
export const COLUMNS = [
  { label: 'Triage', status: 'triage' },
  { label: 'Todo', status: 'todo' },
  { label: 'Ready', status: 'ready' },
  { label: 'Running', status: 'running' },
  { label: 'Review', status: 'review' },
  { label: 'Blocked', status: 'blocked' },
  { label: 'Scheduled', status: 'scheduled' },
  { label: 'Done', status: 'done' }
] as const

export interface Column {
  status: string
  label: string
  tasks: KanbanTask[]
}

/** The non-empty columns of `tasks`, in COLUMNS order (a status the board does not know goes last, under its own name). */
export function columnsOf(tasks: readonly KanbanTask[]): Column[] {
  const known: readonly string[] = COLUMNS.map(c => c.status)
  const other = [...new Set(tasks.map(t => t.status).filter(s => !known.includes(s)))]

  return [...COLUMNS, ...other.map(s => ({ label: s, status: s }))]
    .map(c => ({ label: c.label, status: c.status, tasks: tasks.filter(t => t.status === c.status) }))
    .filter(c => c.tasks.length > 0)
}

/** How long ago `t` was created, in ms (0 when the board does not say). */
export function taskAge(t: Pick<KanbanTask, 'created_at'>, now: number): number {
  return t.created_at ? Math.max(0, now - t.created_at * 1000) : 0
}

/** A status move the CLI has a verb for (kanban_db.py: which statuses each verb takes a task from). */
export interface MoveTarget {
  status: string
  label: string
  verb: string
  /** `block` asks why (the reason is also a comment). */
  reason?: boolean
}

const MOVES: readonly (MoveTarget & { from: readonly string[] })[] = [
  { from: ['todo', 'blocked'], label: 'Ready (promote)', status: 'ready', verb: 'promote' },
  { from: ['scheduled'], label: 'Ready (unschedule)', status: 'ready', verb: 'unblock' },
  { from: ['review'], label: 'Back to work (reopen review)', status: 'ready', verb: 'reopen-review' },
  { from: ['ready', 'running'], label: 'Review (request review)', status: 'review', verb: 'request-review' },
  { from: ['ready', 'running'], label: 'Blocked', reason: true, status: 'blocked', verb: 'block' },
  { from: ['todo', 'ready', 'running', 'blocked'], label: 'Scheduled', status: 'scheduled', verb: 'schedule' },
  { from: ['ready', 'running', 'blocked', 'review'], label: 'Done (complete)', status: 'done', verb: 'complete' }
]

/** Where a task in `status` can move, and the verb that moves it there. */
export function moveTargets(status: string): MoveTarget[] {
  return MOVES.filter(m => m.from.includes(status)).map(({ from: _, ...m }) => m)
}

/** The statuses each sheet key's verb takes a task from. */
const CAN: Readonly<Record<'block' | 'complete' | 'unblock', readonly string[]>> = {
  block: ['ready', 'running'],
  complete: ['ready', 'running', 'blocked', 'review'],
  unblock: ['blocked', 'scheduled']
}

export const can = (verb: keyof typeof CAN, status: string) => CAN[verb].includes(status)

/**
 * `options`, then `positionals` with `--` before them when one starts with `-` (argparse would
 * read it as an option: a title like `-v flag broken`).
 */
export function withPositionals(options: readonly string[], positionals: readonly string[]): string[] {
  return [...options, ...(positionals.some(p => p.startsWith('-')) ? ['--'] : []), ...positionals]
}

/** `--name=value`: one word, so a value that starts with `-` stays the option's value. */
export const option = (name: string, value: string) => `--${name}=${value}`

/** `hermes kanban [--board <slug>]`. */
export const kanbanArgv = (board?: string): string[] => ['kanban', ...(board ? ['--board', board] : [])]

export const listArgv = (board?: string) => [...kanbanArgv(board), 'list', '--json']
export const boardsArgv = () => ['kanban', 'boards', 'list', '--json']
export const showArgv = (board: string | undefined, id: string) => [...kanbanArgv(board), 'show', '--json', ...withPositionals([], [id])]

/** `kanban create`: the title, and the assignee and opening post when given. */
export function createArgv(board: string | undefined, f: { title: string; assignee?: string; body?: string }): string[] {
  const assignee = f.assignee?.trim()
  const body = f.body?.trim()

  return [
    ...kanbanArgv(board),
    'create',
    ...withPositionals([...(assignee ? [option('assignee', assignee)] : []), ...(body ? [option('body', body)] : [])], [f.title.trim()])
  ]
}

/** `<verb> <id> [reason]`: a move, complete, block, unblock or archive of one task. */
export function verbArgv(board: string | undefined, verb: string, id: string, reason?: string): string[] {
  const why = reason?.trim()

  // reopen-review and unblock take the reason as an option; block, schedule and promote as words.
  if (why && (verb === 'reopen-review' || verb === 'unblock')) {
    return [...kanbanArgv(board), verb, ...withPositionals([option('reason', why)], [id])]
  }

  return [...kanbanArgv(board), verb, ...withPositionals([], [id, ...(why ? [why] : [])])]
}

/** `kanban assign <id> <profile>`; an empty profile unassigns (`none`). */
export function assignArgv(board: string | undefined, id: string, profile: string): string[] {
  return [...kanbanArgv(board), 'assign', ...withPositionals([], [id, profile.trim() || 'none'])]
}

/** Completes with handoff evidence; `force` is used only after confirming a live run may be closed. */
export function completeArgv(board: string | undefined, id: string, result: string, force: boolean): string[] {
  return [
    ...kanbanArgv(board),
    'complete',
    ...withPositionals([...(result.trim() ? [option('result', result.trim())] : []), ...(force ? ['--force'] : [])], [id])
  ]
}


/** What `/kanban <arg>` does. */
export type KanbanText =
  /** The sheet, on `board` when given. */
  | { kind: 'sheet'; board?: string }
  /** A read verb: the gateway's `slash.exec` answers it. */
  | { kind: 'gateway' }
  /** `hermes <argv>` through cli.exec, its output in a panel; `confirm` asks first. */
  | { kind: 'run'; argv: string[]; title: string; confirm?: string; timeout?: number }
  /** A verb that streams until Ctrl+C: a split runs it. */
  | { kind: 'split'; argv: string[] }
  | { kind: 'usage'; text: string }

/** The verbs `slash.exec` answers (gateway/session_commands.py `_KANBAN_READS`). */
const READS: Readonly<Record<string, true>> = {
  '--help': true,
  '-h': true,
  '?': true,
  assignees: true,
  context: true,
  diag: true,
  diagnostics: true,
  help: true,
  list: true,
  log: true,
  ls: true,
  runs: true,
  show: true,
  stats: true
}

/** The write verbs, each with the words it needs at least and its usage. */
const WRITES: Readonly<Record<string, readonly [min: number, usage: string]>> = {
  archive: [1, 'archive <id…> [--rm <id…>]'],
  assign: [2, 'assign <id> <profile|none>'],
  attach: [2, 'attach <id> <file>'],
  'attach-rm': [1, 'attach-rm <attachment id>'],
  attachments: [1, 'attachments <id>'],
  block: [1, 'block <id> [reason…]'],
  claim: [1, 'claim <id>'],
  comment: [2, 'comment <id> <text…>'],
  complete: [1, 'complete <id…> [--result …]'],
  create: [1, 'create <title> [--assignee <profile>] [--body …]'],
  decompose: [1, 'decompose <id>'],
  dispatch: [0, 'dispatch'],
  edit: [1, 'edit <id> [--title …] [--body …] [--priority …]'],
  gc: [0, 'gc'],
  heartbeat: [1, 'heartbeat <id>'],
  init: [0, 'init'],
  link: [2, 'link <parent id> <child id>'],
  'notify-list': [0, 'notify-list [id]'],
  'notify-subscribe': [1, 'notify-subscribe <id> …'],
  'notify-unsubscribe': [1, 'notify-unsubscribe <id> …'],
  promote: [1, 'promote <id> [reason…]'],
  reassign: [2, 'reassign <id> <profile>'],
  reclaim: [1, 'reclaim <id>'],
  'reopen-review': [1, 'reopen-review <id…> [--reason …]'],
  repair: [0, 'repair'],
  'request-changes': [2, 'request-changes <id> <reason…>'],
  'request-review': [1, 'request-review <id> [--summary …]'],
  schedule: [1, 'schedule <id> [reason…]'],
  'set-model': [1, 'set-model <id> …'],
  specify: [1, 'specify <id>'],
  swarm: [1, 'swarm …'],
  unblock: [1, 'unblock <id…> [--reason …]'],
  unlink: [2, 'unlink <parent id> <child id>']
}

/** Verbs that call a model or run a dispatcher pass: they get cli.exec's longest wait. */
const SLOW: Readonly<Record<string, true>> = { decompose: true, dispatch: true, specify: true, swarm: true }

/** Writes that delete or archive, and what the question says. */
const DESTRUCTIVE: Readonly<Record<string, (rest: readonly string[]) => string>> = {
  archive: rest =>
    rest.includes('--rm')
      ? `Delete archived task${rest.length > 2 ? 's' : ''} ${rest.filter(w => w !== '--rm').join(', ')} from the board for good?`
      : `Archive ${rest.join(', ')}? A running task's worker is stopped.`,
  'attach-rm': rest => `Delete attachment ${rest.join(' ')}?`,
  gc: () => 'Garbage-collect the board (old workspaces, logs and archived rows)?'
}

const BOARD_WRITES: Readonly<Record<string, readonly [min: number, usage: string]>> = {
  create: [1, 'boards create <slug> [--name …] [--switch]'],
  export: [1, 'boards export <slug> …'],
  import: [1, 'boards import <archive> …'],
  new: [1, 'boards new <slug>'],
  rename: [2, 'boards rename <slug> <name>'],
  'set-default-workdir': [2, 'boards set-default-workdir <slug> <path>'],
  switch: [1, 'boards switch <slug>'],
  use: [1, 'boards use <slug>']
}

const BOARD_READS: Readonly<Record<string, true>> = { current: true, list: true, ls: true, show: true }
const BOARD_REMOVE: Readonly<Record<string, true>> = { delete: true, remove: true, rm: true }

/** `table[key]` when `key` is the table's own (a typed `constructor` is not a verb). */
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined)

export const KANBAN_USAGE =
  'Usage: /kanban opens the board. /kanban list|show <id>|stats|… reads it; /kanban create <title>, complete|block|unblock|archive <id>, assign <id> <profile>, comment <id> <text>, boards list|create|switch|rm <slug>… change it.'

/** What `/kanban <words>` does (`words` split as argWords splits them). */
export function kanbanText(words: readonly string[]): KanbanText {
  let board: string | undefined
  const rest: string[] = []

  // `--board <slug>` (or `--board=<slug>`) before the verb picks the board, as the CLI takes it.
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? ''

    if (!rest.length && w === '--board') {
      board = words[++i] ?? ''
    } else if (!rest.length && w.startsWith('--board=')) {
      board = w.slice('--board='.length)
    } else {
      rest.push(w)
    }
  }

  if (board !== undefined && !board) {
    return { kind: 'usage', text: 'Usage: /kanban --board <slug> [verb …]' }
  }

  const [first, ...args] = rest
  const verb = first?.toLowerCase()

  if (!verb) {
    return board ? { board, kind: 'sheet' } : { kind: 'sheet' }
  }

  if (Object.hasOwn(READS, verb)) {
    return { kind: 'gateway' }
  }

  const base = kanbanArgv(board)
  const title = `/kanban ${words.join(' ')}`

  if (verb === 'tail' || verb === 'watch') {
    return { argv: [...base, verb, ...args], kind: 'split' }
  }

  if (verb === 'daemon') {
    return { kind: 'usage', text: '`hermes kanban daemon` is retired: the gateway runs the dispatcher. /kanban dispatch runs one pass now.' }
  }

  if (verb === 'boards') {
    const [subWord = 'list', ...subArgs] = args
    const sub = subWord.toLowerCase()
    const argv = [...base, 'boards', sub, ...subArgs]

    if (Object.hasOwn(BOARD_READS, sub)) {
      return { argv, kind: 'run', title }
    }

    if (Object.hasOwn(BOARD_REMOVE, sub)) {
      const [slug] = subArgs

      if (!slug) {
        return { kind: 'usage', text: 'Usage: /kanban boards rm <slug> [--delete]' }
      }

      return {
        argv,
        confirm: subArgs.includes('--delete')
          ? `Delete board ${slug} and its tasks for good?`
          : `Archive board ${slug}? It moves to boards/_archived/ and can be restored.`,
        kind: 'run',
        title
      }
    }

    const spec = own(BOARD_WRITES, sub)

    if (!spec) {
      return { kind: 'usage', text: 'Usage: /kanban boards list|show|create|switch|rename|rm|set-default-workdir|export|import …' }
    }

    return subArgs.length < spec[0] ? { kind: 'usage', text: `Usage: /kanban ${spec[1]}` } : { argv, kind: 'run', title }
  }

  const spec = own(WRITES, verb)

  if (!spec) {
    return { kind: 'usage', text: `Unknown /kanban verb \`${first}\`. ${KANBAN_USAGE}` }
  }

  if (args.length < spec[0]) {
    return { kind: 'usage', text: `Usage: /kanban ${spec[1]}` }
  }

  const ask = own(DESTRUCTIVE, verb)

  return {
    argv: [...base, verb, ...args],
    ...(ask ? { confirm: ask(args) } : {}),
    kind: 'run',
    ...(Object.hasOwn(SLOW, verb) ? { timeout: 600 } : {}),
    title
  }
}
