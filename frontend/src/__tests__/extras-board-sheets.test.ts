// The Kanban sheet and the Cron tab's additions, driven by keys against a gateway whose cli.exec
// answers like `hermes kanban … --json` does: what each key runs, and what the sheet shows.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { columnsOf, createArgv, type KanbanTask, moveTargets, verbArgv, withPositionals } from '../kanban/model.js'
import { type BackgroundHost, openBackground } from '../overlays/background.js'
import { type KanbanHost, kanbanOrder, openKanban, runOutcome, taskItem } from '../overlays/kanban.js'
import type { Overlay } from '../overlays/overlay.js'

import { key, must, stub } from './fakes.js'

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

const NOW = Date.UTC(2026, 10, 17, 12)
const ago = (h: number) => (NOW - h * 3_600_000) / 1000

const task = (id: string, status: string, over: Partial<KanbanTask> = {}): KanbanTask => ({
  assignee: null,
  created_at: ago(2),
  id,
  priority: 0,
  status,
  title: `Task ${id}`,
  ...over
})

const TASKS = [
  task('t_c', 'done', { title: 'Wire the relay' }),
  task('t_a', 'todo', { assignee: 'field', priority: 2, title: 'Flash box 4' }),
  task('t_b', 'running', { assignee: 'field', title: 'Read sensor 7' }),
  task('t_d', 'blocked', { title: 'Order parts' })
]

const BOARDS = [
  { is_current: true, name: 'Default', slug: 'default', total: 4 },
  { is_current: false, name: 'Site B', slug: 'site-b', total: 0 }
]

const DETAIL = {
  children: [],
  comments: [{ author: 'emir', body: 'box 4 is on the roof', created_at: ago(1) }],
  events: [],
  latest_summary: null,
  parents: ['t_d'],
  runs: [],
  task: TASKS[1]
}

/** A host whose cli.exec answers the board's reads, and `write` for anything else. */
function host(write: (argv: string[]) => { code: number; output: string } = () => ({ code: 0, output: 'Created t_e' })) {
  const opened: Overlay[] = []
  const argvs: string[][] = []
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    const argv = Array.isArray(params['argv']) ? params['argv'].map(String) : []
    const line = argv.join(' ')
    argvs.push(argv)

    const json = (doc: unknown) => ({ blocked: false, code: 0, output: `warming up\n${JSON.stringify(doc)}` })

    if (method !== 'cli.exec') {
      return {}
    }

    if (line === 'kanban boards list --json') {
      return json(BOARDS)
    }

    if (line.endsWith('list --json')) {
      return json(line.includes('site-b') ? [] : TASKS)
    }

    if (line.includes(' show --json ')) {
      return json(DETAIL)
    }

    return { blocked: false, ...write(argv) }
  })

  return {
    argvs,
    changed: vi.fn(),
    close: vi.fn(),
    gw: { request },
    open: vi.fn((o: Overlay) => opened.push(o)),
    opened,
    transcript: { notice: vi.fn(), panel: vi.fn() },
    /** The cli.exec argv that were not the board's own reads. */
    writes: () => argvs.filter(a => !a.includes('--json'))
  }
}

type Host = ReturnType<typeof host>

const paste = (o: Overlay, text: string) => o.onKey(key('paste', { text }))

async function openSheet(h: Host) {
  await openKanban(stub<KanbanHost>(h))

  return must(h.opened[0])
}

/** Waits for the sheet's write to finish: its outcome line shows instead of what it is doing. */
const idle = (sheet: Overlay) => vi.waitFor(() => expect(JSON.stringify(sheet.node('layer.kanban'))).toContain('"t":"Created t_e"'))

afterEach(() => vi.useRealTimers())

describe('the Kanban sheet model', () => {
  it('groups tasks by column in board order, and shows each row’s assignee, priority and age', () => {
    expect(columnsOf(TASKS).map(c => [c.status, c.tasks.map(t => t.id)])).toEqual([
      ['todo', ['t_a']],
      ['running', ['t_b']],
      ['blocked', ['t_d']],
      ['done', ['t_c']]
    ])
    expect(kanbanOrder([...TASKS, task('t_x', 'mystery')]).map(o => (typeof o === 'string' ? o : `[${o.label} ${o.count}]`))).toEqual([
      '[Todo 1]',
      't_a',
      '[Running 1]',
      't_b',
      '[Blocked 1]',
      't_d',
      '[Done 1]',
      't_c',
      '[mystery 1]',
      't_x'
    ])
    expect(taskItem(must(TASKS[1]), NOW)).toMatchObject({ dot: 'muted', facts: { age: '2h', assignee: 'field', priority: 2 }, label: 'Flash box 4' })
    expect(taskItem(must(TASKS[2]), NOW)).toMatchObject({ dot: 'accent', facts: { assignee: 'field' } })
    expect(taskItem(task('t_n', 'ready', { created_at: null }), NOW).facts).toEqual({ age: '', assignee: '—', priority: 0 })
  })

  it('offers the moves the CLI has a verb for, from each status', () => {
    const moves = (s: string) => moveTargets(s).map(m => `${m.status}:${m.verb}`)

    expect(moves('todo')).toEqual(['ready:promote', 'scheduled:schedule'])
    expect(moves('running')).toEqual(['review:request-review', 'blocked:block', 'scheduled:schedule', 'done:complete'])
    expect(moves('review')).toEqual(['ready:reopen-review', 'done:complete'])
    expect(moves('scheduled')).toEqual(['ready:unblock'])
    expect(moves('done')).toEqual([])
  })

  it('builds the write argv, with `--` before a title or id that starts with a dash', () => {
    expect(createArgv('ops', { assignee: ' field ', body: '', title: 'Flash box 5' })).toEqual(['kanban', '--board', 'ops', 'create', '--assignee=field', 'Flash box 5'])
    expect(createArgv(undefined, { body: '-v output attached', title: '-x fails' })).toEqual(['kanban', 'create', '--body=-v output attached', '--', '-x fails'])
    expect(verbArgv('ops', 'block', 't_1', 'no parts')).toEqual(['kanban', '--board', 'ops', 'block', 't_1', 'no parts'])
    expect(verbArgv(undefined, 'unblock', 't_1', 'parts came')).toEqual(['kanban', 'unblock', '--reason=parts came', 't_1'])
    expect(verbArgv(undefined, 'complete', 't_1')).toEqual(['kanban', 'complete', 't_1'])
    expect(withPositionals(['--x=1'], ['a', 'b'])).toEqual(['--x=1', 'a', 'b'])
  })

  it('reads a run’s outcome: its last line, or why it failed', () => {
    expect(runOutcome({ blocked: false, code: 0, hint: '', output: 'warn\nCreated t_e' }, ['kanban'])).toEqual({ ok: true, text: 'Created t_e' })
    expect(runOutcome({ blocked: false, code: 1, hint: '', output: 'task t_b is running\n' }, ['kanban', 'complete', 't_b'])).toEqual({
      ok: false,
      text: '`hermes kanban complete t_b` failed (exit 1): task t_b is running'
    })
    expect(runOutcome({ blocked: true, code: 0, hint: 'interactive', output: '' }, ['kanban'])).toEqual({ ok: false, text: 'interactive' })
  })
})

describe('the Kanban sheet', () => {
  it('loads the active board and its tasks, and previews the selected task from `kanban show`', async () => {
    const h = host()
    const sheet = await openSheet(h)

    expect(h.argvs.slice(0, 2)).toEqual([
      ['kanban', 'boards', 'list', '--json'],
      ['kanban', 'list', '--json']
    ])
    await vi.waitFor(() => expect(h.argvs).toContainEqual(['kanban', '--board', 'default', 'show', '--json', 't_a']))

    const view = JSON.stringify(sheet.node('layer.kanban'))
    expect(view).toContain('"tab":"default"')
    expect(view).toContain('Site B')
    expect(view).toContain('Comments (1)')
    expect(view).toContain('box 4 is on the roof')
  })

  it('N asks for a title (required) and an assignee, then creates the task and reloads', async () => {
    const h = host()
    const sheet = await openSheet(h)

    sheet.onKey(key('n'))
    const form = must(h.opened.at(-1))
    form.onKey(key('enter'))
    form.onKey(key('enter'))
    form.onKey(key('enter'))
    expect(JSON.stringify(form.node('layer.form'))).toContain('Title is required.')
    expect(h.writes()).toEqual([])

    paste(form, 'Flash box 5')
    form.onKey(key('tab'))
    paste(form, 'field')
    form.onKey(key('enter'))
    form.onKey(key('enter'))
    await vi.waitFor(() => expect(h.writes()).toEqual([['kanban', '--board', 'default', 'create', '--assignee=field', 'Flash box 5']]))
    // The write's last line shows under the title once it ran, and the board was read again.
    await idle(sheet)
    expect(h.argvs.slice(h.argvs.findIndex(a => a.includes('create')))).toContainEqual(['kanban', '--board', 'default', 'list', '--json'])
  })

  it('M moves the selected task through the verb of the chosen column', async () => {
    const h = host()
    const sheet = await openSheet(h)

    sheet.onKey(key('m'))
    const pick = must(h.opened.at(-1))
    expect(JSON.stringify(pick.node('layer.choice'))).toContain('Ready (promote)')
    pick.onKey(key('down'))
    pick.onKey(key('enter'))
    await vi.waitFor(() => expect(h.writes()).toEqual([['kanban', '--board', 'default', 'schedule', 't_a']]))
  })

  it('C, B and U act only from the statuses their verb takes; B asks why', async () => {
    const h = host()
    const sheet = await openSheet(h)

    sheet.onKey(key('c'))
    sheet.onKey(key('u'))
    expect(h.opened).toHaveLength(1)
    expect(h.writes()).toEqual([])

    sheet.onKey(key('down'))
    sheet.onKey(key('b'))
    const why = must(h.opened.at(-1))
    paste(why, 'no parts')
    why.onKey(key('enter'))
    await vi.waitFor(() => expect(h.writes()).toEqual([['kanban', '--board', 'default', 'block', 't_b', 'no parts']]))
    await idle(sheet)

    sheet.onKey(key('down'))
    sheet.onKey(key('u'))
    await vi.waitFor(() => expect(h.writes().at(-1)).toEqual(['kanban', '--board', 'default', 'unblock', 't_d']))
  })

  it('C requires evidence outside review and asks before overriding a running worker', async () => {
    const h = host()
    const sheet = await openSheet(h)

    sheet.onKey(key('down'))
    sheet.onKey(key('c'))
    const result = must(h.opened.at(-1))
    result.onKey(key('enter'))
    expect(JSON.stringify(result.node('layer.result'))).toContain('Result / verification is required.')
    expect(h.writes()).toEqual([])

    paste(result, 'Checked telemetry from all four sensors')
    result.onKey(key('enter'))
    expect(h.writes()).toEqual([])
    expect(JSON.stringify(must(h.opened.at(-1)).node('layer.confirm'))).toContain('overrides the live-claim guard')
    must(h.opened.at(-1)).onKey(key('y'))
    await vi.waitFor(() =>
      expect(h.writes()).toEqual([
        ['kanban', '--board', 'default', 'complete', '--result=Checked telemetry from all four sensors', '--force', 't_b']
      ])
    )
  })


  it('X archives only after yes; A assigns, empty unassigns', async () => {
    const h = host()
    const sheet = await openSheet(h)

    sheet.onKey(key('x'))
    must(h.opened.at(-1)).onKey(key('n'))
    expect(h.writes()).toEqual([])
    sheet.onKey(key('x'))
    must(h.opened.at(-1)).onKey(key('y'))
    await vi.waitFor(() => expect(h.writes()).toEqual([['kanban', '--board', 'default', 'archive', 't_a']]))
    await idle(sheet)

    sheet.onKey(key('a'))
    const form = must(h.opened.at(-1))
    form.onKey(key('u', { ctrl: true }))
    form.onKey(key('enter'))
    await vi.waitFor(() => expect(h.writes().at(-1)).toEqual(['kanban', '--board', 'default', 'assign', 't_a', 'none']))
  })

  it('a failed write is an error notice with the CLI’s words', async () => {
    const h = host(() => ({ code: 1, output: 'task t_a is not running' }))
    const sheet = await openSheet(h)

    sheet.onKey(key('m'))
    must(h.opened.at(-1)).onKey(key('enter'))
    await vi.waitFor(() =>
      expect(h.transcript.notice).toHaveBeenCalledWith('`hermes kanban --board default promote t_a` failed (exit 1): task t_a is not running', 'error')
    )
  })

  it('Tab switches the board this sheet shows', async () => {
    const h = host()
    const sheet = await openSheet(h)

    sheet.onKey(key('tab'))
    await vi.waitFor(() => expect(h.argvs.at(-1)).toEqual(['kanban', '--board', 'site-b', 'list', '--json']))
    await vi.waitFor(() => expect(JSON.stringify(sheet.node('layer.kanban'))).toContain('No tasks on this board'))
  })
})

describe('the Cron tab', () => {
  const JOB = { enabled: true, job_id: 'j1', name: 'Field check', schedule: 'every 2h', state: 'scheduled' }

  function cronHost() {
    const h = host(argv => ({ code: 0, output: argv[1] === 'run' ? 'Triggered job: Field check (j1)\n  Ran now: ok.' : 'Created job: j2' }))
    const cron = {
      busy: () => false,
      during: vi.fn(async (_id: string, work: () => Promise<unknown>) => work()),
      error: undefined,
      jobs: () => [JOB],
      loaded: true,
      refresh: vi.fn(async () => undefined),
      warning: undefined,
      watch: () => () => undefined
    }
    const processes = { all: () => [], running: () => [], stopping: () => false, watch: () => () => undefined }
    const transcript = { ...h.transcript, backgroundCalls: () => [], calls: () => [] }

    return { ...h, cron, processes, transcript }
  }

  function openCron(h: ReturnType<typeof cronHost>) {
    openBackground(stub<BackgroundHost>(h), { tab: 'cron' })
    const sheet = must(h.opened[0])
    sheet.node('layer.background')

    return sheet
  }

  it('R runs the selected job now through `hermes cron run`, with the job marked busy', async () => {
    const h = cronHost()
    const sheet = openCron(h)

    expect(JSON.stringify(sheet.node('layer.background'))).toContain('Run now')
    sheet.onKey(key('r'))
    await vi.waitFor(() => expect(h.gw.request).toHaveBeenCalledWith('cli.exec', { argv: ['cron', 'run', 'j1'], timeout: 600 }))
    expect(h.cron.during).toHaveBeenCalledWith('j1', expect.any(Function))
    await vi.waitFor(() => expect(h.transcript.panel).toHaveBeenCalledWith('hermes cron run j1', 'Triggered job: Field check (j1)\n  Ran now: ok.'))
    sheet.onClose?.()
  })

  it('N asks for a schedule and a prompt, then creates the job and reloads the list', async () => {
    const h = cronHost()
    const sheet = openCron(h)

    sheet.onKey(key('n'))
    const form = must(h.opened.at(-1))
    paste(form, '0 9 * * *')
    form.onKey(key('enter'))
    paste(form, 'Ping every ESP32 and report the silent ones')
    form.onKey(key('enter'))
    form.onKey(key('enter'))
    paste(form, 'telegram')
    form.onKey(key('enter'))
    await vi.waitFor(() =>
      expect(h.writes()).toEqual([['cron', 'create', '--deliver=telegram', '0 9 * * *', 'Ping every ESP32 and report the silent ones']])
    )
    await vi.waitFor(() => expect(h.cron.refresh).toHaveBeenCalled())
    expect(h.transcript.notice).toHaveBeenCalledWith('Cron: Created job: j2', 'info')
    sheet.onClose?.()
  })
})
