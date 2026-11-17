// The Kanban sheet (`/kanban`): Hermes' task board (`hermes kanban …`) in one `picker`, the tasks
// grouped by column (triage, todo, ready, running, review, blocked, scheduled, done), each row its
// title with its assignee, priority and age; the preview shows `kanban show <id>`. Tab switches the
// board (this sheet only: `/kanban boards switch` changes the active one). N adds a task, M moves the
// selected one (the verbs kanban_db.py has for each status), C completes, B blocks (asking why), U
// unblocks, A assigns, X archives (asking first), R reloads, Enter or → gives the details the sheet.
// Every read and write is `hermes kanban [--board <slug>] …` through cli.exec, then a reload.

import type { JSX, Key, PickerColumn, PickerGroup, PickerItem, Tone } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { optional } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import { clip } from '../core/text.js'
import { type CliRun, hermesExec, hermesJson } from '../extras/cli.js'
import {
  assignArgv,
  boardList,
  boardsArgv,
  can,
  columnsOf,
  completeArgv,
  createArgv,
  type KanbanBoard,
  type KanbanDetail,
  type KanbanTask,
  listArgv,
  moveTargets,
  showArgv,
  taskAge,
  taskDetail,
  taskList,
  verbArgv
} from '../kanban/model.js'
import { ageShort, relative } from '../view/format.js'
import { type Fact, facts } from '../view/ui/facts.js'

import { choiceOverlay, formOverlay } from './form.js'
import type { Overlay } from './overlay.js'
import { confirmOverlay } from './prompts.js'
import { moveSelection } from './search.js'

/** What the Kanban sheet reaches of the app. */
export type KanbanHost = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open' | 'transcript'>

const KEY = 'kanban'

const TONES: Readonly<Record<string, Tone>> = {
  blocked: 'error',
  done: 'success',
  ready: 'info',
  review: 'warning',
  running: 'accent'
}

/** The tone of a task's status dot. */
export const statusTone = (status: string): Tone => (Object.hasOwn(TONES, status) ? (TONES[status] ?? 'muted') : 'muted')

/** The picker's order: each column as a group, then its tasks. */
export function kanbanOrder(tasks: readonly KanbanTask[]): (string | PickerGroup)[] {
  return columnsOf(tasks).flatMap(c => [{ count: c.tasks.length, group: c.status, label: c.label }, ...c.tasks.map(t => t.id)])
}

/** One task's row: its title, and its assignee, priority and age. */
export function taskItem(t: KanbanTask, now: number): PickerItem {
  return {
    ...optional('badges', t.tenant ? [{ text: t.tenant }] : undefined),
    ...optional('detail', t.last_failure_error ? clip(t.last_failure_error.split('\n')[0] ?? '', { max: 80 }) : undefined),
    dot: statusTone(t.status),
    facts: {
      age: t.created_at ? ageShort(taskAge(t, now)) : '',
      assignee: t.assignee || '—',
      priority: t.priority ?? 0
    },
    id: t.id,
    label: t.title,
    ...optional('tone', t.status === 'done' ? 'muted' : undefined)
  }
}

/** What a write's run says in a line: its output's last line, or why it failed. */
export function runOutcome(r: CliRun, argv: readonly string[]): { ok: boolean; text: string } {
  if (r.blocked) {
    return { ok: false, text: r.hint || `\`hermes ${argv.join(' ')}\` cannot run here.` }
  }

  const lines = r.output.split('\n').filter(l => l.trim())

  return r.code
    ? { ok: false, text: `\`hermes ${argv.join(' ')}\` failed (exit ${r.code}): ${clip(lines.join(' · '), { max: 400 }) || 'no output'}` }
    : { ok: true, text: lines.at(-1)?.trim() || 'Done.' }
}

/** Opens the sheet on `board` (else the active board); resolves when the first load is in. */
export function openKanban(host: KanbanHost, start: { board?: string } = {}): Promise<void> {
  let board = start.board
  let boards: KanbanBoard[] = []
  let tasks: KanbanTask[] = []
  let state: 'error' | 'loading' | 'ready' = 'loading'
  let error = ''
  /** The last write's outcome, under the title. */
  let note = ''
  /** What a write in flight is doing. */
  let working = ''
  let selected: string | undefined
  let expanded = false
  let loads = 0
  const details = new Map<string, KanbanDetail | string>()
  const close = () => host.close(overlay)

  const current = () => tasks.find(t => t.id === selected)
  const ids = () => kanbanOrder(tasks).filter(o => typeof o === 'string')

  const loadDetail = async (id: string | undefined) => {
    if (!id || details.has(id)) {
      return
    }

    details.set(id, 'Loading details…')

    try {
      details.set(id, await hermesJson(host, showArgv(board, id), taskDetail))
    } catch (e) {
      details.set(id, errorText(e))
    }

    host.changed()
  }

  const load = async () => {
    const at = ++loads
    state = 'loading'
    host.changed()

    try {
      const [b, t] = await Promise.all([hermesJson(host, boardsArgv(), boardList), hermesJson(host, listArgv(board), taskList)])

      if (at !== loads) {
        return
      }

      boards = b
      board ??= b.find(x => x.is_current)?.slug
      tasks = t
      details.clear()
      state = 'ready'
      const shown = ids()
      selected = selected && shown.includes(selected) ? selected : shown[0]
    } catch (e) {
      if (at !== loads) {
        return
      }

      state = 'error'
      error = errorText(e)
    }

    host.changed()
    void loadDetail(selected)
  }

  const write = async (doing: string, argv: string[]) => {
    working = doing
    note = ''
    host.changed()

    try {
      const out = runOutcome(await hermesExec(host, argv), argv)

      if (out.ok) {
        note = out.text
      } else {
        host.transcript.notice(out.text, 'error')
      }
    } catch (e) {
      host.transcript.notice(`hermes ${argv.join(' ')}: ${errorText(e)}`, 'error')
    }

    working = ''
    await load()
  }

  const select = (id: string | undefined) => {
    if (id !== undefined) {
      selected = id
      void loadDetail(id)
    }
  }

  const switchBoard = (slug: string | undefined) => {
    if (slug && slug !== board) {
      board = slug
      selected = undefined
      expanded = false
      void load()
    }
  }

  const newTask = () =>
    host.open(
      formOverlay(host, {
        detail: `On board ${board ?? 'default'}. The assignee is a profile name; empty leaves it unassigned.`,
        fields: [
          { id: 'title', label: 'Title', required: true },
          { id: 'assignee', label: 'Assignee' },
          { id: 'body', label: 'Opening post' }
        ],
        key: 'kanban-new',
        onSubmit: v => void write('Creating the task…', createArgv(board, { assignee: v['assignee'] ?? '', body: v['body'] ?? '', title: v['title'] ?? '' })),
        submit: 'Create',
        title: 'New task'
      })
    )

  const askReason = (t: KanbanTask, verb: string, title: string) =>
    host.open(
      formOverlay(host, {
        detail: 'The reason is also added as a comment.',
        fields: [{ id: 'reason', label: 'Reason' }],
        key: `kanban-${verb}`,
        onSubmit: v => void write(`${title}…`, verbArgv(board, verb, t.id, v['reason'])),
        submit: title,
        title: `${title}: ${t.title}`
      })
    )

  const move = (t: KanbanTask) => {
    const targets = moveTargets(t.status)

    if (!targets.length) {
      note = `No move from ${t.status}: the board moves it on its own, or /kanban <verb> ${t.id} says what is possible.`

      return
    }

    host.open(
      choiceOverlay(host, {
        choices: targets.map(m => ({ detail: `hermes kanban ${m.verb}`, id: `${m.verb}:${m.status}`, label: m.label })),
        key: 'kanban-move',
        onChoose: id => {
          const m = targets.find(x => `${x.verb}:${x.status}` === id)

          if (m?.reason) {
            askReason(t, m.verb, 'Block')
          } else if (m?.verb === 'complete') {
            complete(t)
          } else if (m) {
            void write(`Moving to ${m.status}…`, verbArgv(board, m.verb, t.id))
          }
        },
        subtitle: `From ${t.status}`,
        title: `Move ${t.title}`
      })
    )
  }

  const assign = (t: KanbanTask) =>
    host.open(
      formOverlay(host, {
        detail: 'A profile name; empty unassigns.',
        fields: [{ id: 'profile', label: 'Profile', ...optional('value', t.assignee ?? undefined) }],
        key: 'kanban-assign',
        onSubmit: v => void write('Assigning…', assignArgv(board, t.id, v['profile'] ?? '')),
        submit: 'Assign',
        title: `Assign ${t.title}`
      })
    )

  /** A completion needs evidence unless it approves review; a live run needs an explicit override too. */
  const complete = (t: KanbanTask) => {
    const submit = (result: string) => {
      if (t.status !== 'running') {
        void write('Completing…', completeArgv(board, t.id, result, false))

        return
      }

      host.open(
        confirmOverlay(host, {
          confirm: 'Complete',
          detail: 'This overrides the live-claim guard and closes the active worker run. Its current work may be unfinished.',
          onConfirm: () => void write('Completing…', completeArgv(board, t.id, result, true)),
          title: `Complete running task ${t.title}?`
        })
      )
    }

    if (t.status === 'review') {
      submit('')

      return
    }

    host.open(
      formOverlay(host, {
        detail: 'Hermes requires completion evidence outside review. Describe the result and how it was verified.',
        fields: [{ id: 'result', label: 'Result / verification', required: true }],
        key: 'kanban-complete',
        onSubmit: v => submit(v['result'] ?? ''),
        submit: 'Complete',
        title: `Complete ${t.title}`
      })
    )
  }

  const archive = (t: KanbanTask) =>
    host.open(
      confirmOverlay(host, {
        confirm: 'Archive',
        detail: `${t.id} leaves the board${t.status === 'running' ? ' and its running worker is stopped' : ''}. \`/kanban archive --rm ${t.id}\` deletes it for good later.`,
        onConfirm: () => void write('Archiving…', verbArgv(board, 'archive', t.id)),
        title: `Archive ${t.title}?`
      })
    )

  /** Why the selected task cannot take `verb` now, or undefined when it can. */
  const blocked = (t: KanbanTask | undefined, verb?: 'block' | 'complete' | 'unblock') =>
    !t ? 'No task' : working ? 'Working' : verb && !can(verb, t.status) ? `Not from ${t.status}` : undefined

  const run = (action: string) => {
    const t = current()

    if (action === 'close') {
      return expanded ? void (expanded = false) : close()
    }

    if (action === 'refresh') {
      return void load()
    }

    if (action === 'new') {
      return working ? undefined : newTask()
    }

    if (!t || working) {
      return
    }

    switch (action) {
      case 'details':
        expanded = !expanded

        return void loadDetail(t.id)
      case 'move':
        return move(t)
      case 'complete':
        return blocked(t, 'complete') ? undefined : complete(t)
      case 'block':
        return blocked(t, 'block') ? undefined : askReason(t, 'block', 'Block')
      case 'unblock':
        return blocked(t, 'unblock') ? undefined : void write('Unblocking…', verbArgv(board, 'unblock', t.id))
      case 'assign':
        return assign(t)
      case 'archive':
        return archive(t)
    }
  }

  const KEYS: Readonly<Record<string, string>> = {
    a: 'assign',
    b: 'block',
    c: 'complete',
    m: 'move',
    n: 'new',
    r: 'refresh',
    u: 'unblock',
    x: 'archive'
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    cancel: close,
    node: () => sheetNode(Date.now()),
    onKey: (k: Key) => {
      const bare = !k.ctrl && !k.alt && !k.meta && !k.shift

      if (k.name === 'escape') {
        run('close')
      } else if (k.name === 'enter' || (k.name === 'right' && !expanded)) {
        run('details')
      } else if (k.name === 'left' && expanded) {
        expanded = false
      } else if (k.name === 'tab' && boards.length > 1) {
        const at = boards.findIndex(b => b.slug === board)
        switchBoard(boards[(at + (k.shift ? boards.length - 1 : 1)) % boards.length]?.slug)
      } else if (bare && Object.hasOwn(KEYS, k.name)) {
        run(KEYS[k.name] ?? '')
      } else {
        select(moveSelection(k, ids(), selected))
      }

      return true
    }
  }

  function sheetNode(now: number): JSX.Element {
    const t = current()
    const columns: PickerColumn[] = [
      { format: 'dim', head: 'Assignee', id: 'assignee', min: 10, priority: 1 },
      { format: 'num', head: 'Prio', id: 'priority', priority: 3 },
      { format: 'dim', head: 'Age', id: 'age', priority: 2 }
    ]
    const counts = columnsOf(tasks)
      .map(c => `${c.tasks.length} ${c.label.toLowerCase()}`)
      .join(' · ')

    return (
      <picker
        actions={[
          { ...optional('disabled', working ? 'Working' : undefined), id: 'new', keys: ['n'], label: 'New' },
          { ...optional('disabled', blocked(t)), id: 'move', keys: ['m'], label: 'Move', primary: true },
          { ...optional('disabled', blocked(t, 'complete')), id: 'complete', keys: ['c'], label: 'Complete' },
          { ...optional('disabled', blocked(t, 'block')), id: 'block', keys: ['b'], label: 'Block' },
          { ...optional('disabled', blocked(t, 'unblock')), id: 'unblock', keys: ['u'], label: 'Unblock' },
          { ...optional('disabled', blocked(t)), id: 'assign', keys: ['a'], label: 'Assign' },
          { danger: true, ...optional('disabled', blocked(t)), id: 'archive', keys: ['x'], label: 'Archive' },
          { id: 'refresh', keys: ['r'], label: 'Reload' },
          { end: true, id: 'close', keys: ['esc'], label: expanded ? 'Back' : 'Close' }
        ]}
        columns={columns}
        empty={state === 'loading' ? 'Loading the board…' : 'No tasks on this board. N adds one.'}
        key={KEY}
        {...optional('focus', expanded ? 'preview' : undefined)}
        icon="kanban"
        items={tasks.map(x => taskItem(x, now))}
        {...optional('message', state === 'error' ? [{ s: 'error', t: `Could not read the board: ${error}` }] : undefined)}
        noun="tasks"
        onAction={{
          archive: () => run('archive'),
          assign: () => run('assign'),
          block: () => run('block'),
          close: () => run('close'),
          complete: () => run('complete'),
          move: () => run('move'),
          new: () => run('new'),
          refresh: () => run('refresh'),
          retry: () => run('refresh'),
          tab: ev => switchBoard(ev.value),
          unblock: () => run('unblock')
        }}
        onActivate={ev => {
          select(ev.item)
          run('details')
        }}
        onSelect={ev => {
          select(ev.item)
          host.changed()
        }}
        order={kanbanOrder(tasks)}
        preview="side"
        {...optional('selected', selected)}
        size="lg"
        state={state}
        subtitle={[{ s: 'muted', t: working || note || counts || 'empty' }]}
        {...optional('tab', board)}
        tabs={boards.map(b => ({ ...optional('count', b.total ?? undefined), id: b.slug, label: b.name || b.slug }))}
        title="Kanban"
        total={tasks.length}
      >
        {t ? taskPreview(t, details.get(t.id), now, expanded) : null}
      </picker>
    )
  }

  host.open(overlay)

  return load()
}

/** The preview: the task's facts, its post and result, then its comments and runs (and events, expanded). */
export function taskPreview(t: KanbanTask, detail: KanbanDetail | string | undefined, now: number, expanded: boolean): JSX.Element[] {
  const at = (s: number | null | undefined) => (s ? relative(new Date(s * 1000).toISOString(), now) : undefined)
  const d = typeof detail === 'object' ? detail : undefined
  const task = d?.task ?? t
  const rows: Fact[] = [
    ['Status', [{ s: statusTone(task.status), t: task.status }]],
    ['Assignee', task.assignee || 'unassigned'],
    ['Priority', String(task.priority ?? 0)],
    ['Created', [at(task.created_at), task.created_by ? `by ${task.created_by}` : ''].filter(Boolean).join(' ')],
    ['Started', at(task.started_at)],
    ['Completed', at(task.completed_at)],
    ['Tenant', task.tenant],
    ['Workspace', [task.workspace_kind, task.workspace_path].filter(Boolean).join(' @ ')],
    ['Branch', task.branch_name],
    ['Skills', task.skills?.join(' · ')],
    ['Parents', d?.parents.join(', ')],
    ['Children', d?.children.join(', ')],
    ['Task', [{ s: 'mono dim', t: task.id }]]
  ]
  const result = task.result || d?.latest_summary
  const comments = d?.comments.slice(expanded ? -20 : -3) ?? []
  const runs = d?.runs.slice(expanded ? -10 : -3) ?? []
  const events = expanded ? (d?.events.slice(-15) ?? []) : []

  return [
    <text key="title" role="omp.hub.title" text={task.title} />,
    <kv items={facts(rows)} key="facts" role="omp.hub.kv" />,
    ...(typeof detail === 'string' ? [<text key="detail" spans={[{ s: 'muted', t: detail }]} wrap="word" />] : []),
    ...(task.last_failure_error ? [<text key="failure" spans={[{ s: 'error', t: task.last_failure_error }]} wrap="word" />] : []),
    ...(task.body
      ? [
          <section head="Post" key="body">
            <md key="text" text={task.body} />
          </section>
        ]
      : []),
    ...(result
      ? [
          <section head={task.result ? 'Result' : 'Latest summary'} key="result">
            <md key="text" text={result} />
          </section>
        ]
      : []),
    ...(comments.length
      ? [
          <section head={`Comments (${d?.comments.length ?? 0})`} key="comments">
            <md key="text" text={comments.map(c => `- **${c.author || 'user'}** ${at(c.created_at) ?? ''}: ${c.body ?? ''}`).join('\n')} />
          </section>
        ]
      : []),
    ...(runs.length
      ? [
          <section head={`Runs (${d?.runs.length ?? 0})`} key="runs">
            <md
              key="text"
              text={runs
                .map(r => `- ${r.profile || '?'} · ${r.outcome || r.status || 'running'} ${at(r.started_at) ?? ''}${r.summary ? ` — ${r.summary}` : r.error ? ` — ${r.error}` : ''}`)
                .join('\n')}
            />
          </section>
        ]
      : []),
    ...(events.length
      ? [
          <section head="Events" key="events">
            <md key="text" text={events.map(e => `- ${at(e.created_at) ?? ''} ${e.kind}`).join('\n')} />
          </section>
        ]
      : [])
  ]
}
