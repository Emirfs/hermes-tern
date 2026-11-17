// The board slice's command forms: what `hermes …` argv each one runs through cli.exec, which ones
// stay with the gateway, which ask first, and how /snapshot reads the plugin's snapshots.* answers.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type CommandHost, localCommand } from '../commands/local.js'
import { cronText, pluginLines, pluginsText, snapshotTable, snapshotText } from '../extras/board.js'
import { cronCreateArgv, cronRunArgv } from '../processes/cron.js'
import { openBackground } from '../overlays/background.js'
import type { Overlay } from '../overlays/overlay.js'
import { openHermesSplit } from '../watch/spec.js'

import { key, must, stub } from './fakes.js'

vi.mock('../overlays/background.js', () => ({ openBackground: vi.fn() }))
vi.mock('../watch/spec.js', () => ({ openHermesSplit: vi.fn(async () => true) }))

type Reply = (method: string, params: Record<string, unknown>) => unknown

/** The slice of the command host these commands reach; `reply` answers every request. */
function app(reply: Reply = () => ({ blocked: false, code: 0, output: 'ok' })) {
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => reply(method, params))
  const opened: Overlay[] = []

  return {
    changed: vi.fn(),
    close: vi.fn(),
    cron: { refresh: vi.fn(async () => undefined) },
    gw: { request },
    open: vi.fn((o: Overlay) => opened.push(o)),
    opened,
    request,
    session: { info: { cwd: '/repo' }, ref: { live: 'sid-1', stored: null } },
    transcript: { notice: vi.fn(), panel: vi.fn() }
  }
}

type Fake = ReturnType<typeof app>

const run = (a: Fake, name: string, arg = '') => must(localCommand(name)).run(stub<CommandHost>(a), arg)

/** The argv of every cli.exec the fake saw. */
const execs = (a: Fake) => a.request.mock.calls.filter(([m]) => m === 'cli.exec').map(([, p]) => p?.['argv'])

/** Answers the confirm sheet on top with yes. */
const confirmTop = (a: Fake) => must(a.opened.at(-1)).onKey(key('y'))

beforeEach(() => vi.clearAllMocks())

describe('/kanban', () => {
  it('bare opens the sheet; read verbs stay with the gateway', async () => {
    const a = app(() => ({ blocked: false, code: 0, output: '[]' }))

    await run(a, 'kanban')
    expect(must(a.opened[0]).key).toBe('kanban')

    for (const arg of ['list', 'show t_1', '--board ops stats', 'assignees', 'log t_1', 'diag']) {
      expect(await run(a, 'kanban', arg)).toBe(false)
    }
  })

  it('runs each write as `hermes kanban …`, with --board kept before the verb', async () => {
    const a = app()

    await run(a, 'kanban', 'create "Flash ESP32 #4" --assignee field --priority 2')
    await run(a, 'kanban', '--board ops complete t_1 --result "flashed"')
    await run(a, 'kanban', '--board=ops block t_2 waiting for parts')
    await run(a, 'kanban', 'assign t_3 none')
    await run(a, 'kanban', 'comment t_3 "sensor reads 0"')
    await run(a, 'kanban', 'boards create site-b --switch')
    await run(a, 'kanban', 'boards')

    expect(execs(a)).toEqual([
      ['kanban', 'create', 'Flash ESP32 #4', '--assignee', 'field', '--priority', '2'],
      ['kanban', '--board', 'ops', 'complete', 't_1', '--result', 'flashed'],
      ['kanban', '--board', 'ops', 'block', 't_2', 'waiting', 'for', 'parts'],
      ['kanban', 'assign', 't_3', 'none'],
      ['kanban', 'comment', 't_3', 'sensor reads 0'],
      ['kanban', 'boards', 'create', 'site-b', '--switch'],
      ['kanban', 'boards', 'list']
    ])
    expect(a.transcript.panel).toHaveBeenCalledWith('/kanban --board ops complete t_1 --result flashed', 'ok')
  })

  it.each([
    ['unblock t_2', ['kanban', 'unblock', 't_2']],
    ['edit t_2 --title "New title"', ['kanban', 'edit', 't_2', '--title', 'New title']],
    ['link t_1 t_2', ['kanban', 'link', 't_1', 't_2']],
    ['unlink t_1 t_2', ['kanban', 'unlink', 't_1', 't_2']],
    ['promote t_2', ['kanban', 'promote', 't_2']],
    ['reopen-review t_2 --reason "retry"', ['kanban', 'reopen-review', 't_2', '--reason', 'retry']],
    ['request-review t_2 --summary "tested"', ['kanban', 'request-review', 't_2', '--summary', 'tested']],
    ['request-changes t_2 "fix sensor"', ['kanban', 'request-changes', 't_2', 'fix sensor']],
    ['boards switch ops', ['kanban', 'boards', 'switch', 'ops']]
  ])('runs %s with the CLI argument order intact', async (arg, argv) => {
    const a = app()

    await run(a, 'kanban', String(arg))
    expect(execs(a)).toEqual([argv])
  })


  it('asks before archive and boards rm, and runs only on yes', async () => {
    const a = app()

    await run(a, 'kanban', 'archive t_1 t_2')
    expect(execs(a)).toEqual([])
    expect(JSON.stringify(must(a.opened.at(-1)).node('layer.x'))).toContain('Archive t_1, t_2?')
    confirmTop(a)
    await vi.waitFor(() => expect(execs(a)).toEqual([['kanban', 'archive', 't_1', 't_2']]))

    await run(a, 'kanban', 'boards rm site-b --delete')
    expect(JSON.stringify(must(a.opened.at(-1)).node('layer.x'))).toContain('Delete board site-b and its tasks for good?')
    must(a.opened.at(-1)).onKey(key('n'))
    expect(execs(a)).toHaveLength(1)
  })

  it('gives model verbs the longest wait, streams tail in a split, and answers bad forms with usage', async () => {
    const a = app()

    await run(a, 'kanban', 'decompose t_9')
    expect(a.request).toHaveBeenCalledWith('cli.exec', { argv: ['kanban', 'decompose', 't_9'], timeout: 600 })

    await run(a, 'kanban', 'watch')
    expect(openHermesSplit).toHaveBeenCalledWith(['kanban', 'watch'], '/repo')

    await run(a, 'kanban', 'assign t_1')
    await run(a, 'kanban', 'frobnicate')
    await run(a, 'kanban', 'constructor')
    await run(a, 'kanban', '--board')
    expect(a.transcript.notice.mock.calls.slice(-4).map(c => [String(c[0]).split('.')[0], c[1]])).toEqual([
      ['Usage: /kanban assign <id> <profile|none>', 'warning'],
      ['Unknown /kanban verb `frobnicate`', 'warning'],
      ['Unknown /kanban verb `constructor`', 'warning'],
      ['Usage: /kanban --board <slug> [verb …]', 'warning']
    ])
    expect(execs(a)).toHaveLength(1)
  })
})

describe('/cron', () => {
  it('bare opens the Cron tab', async () => {
    const a = app()

    await run(a, 'cron')
    expect(openBackground).toHaveBeenCalledWith(a, { tab: 'cron' })
    expect(a.request).not.toHaveBeenCalled()
  })

  it('maps each form to `hermes cron …`', () => {
    expect(cronText(['list', '--all'])).toEqual({ argv: ['cron', 'list', '--all'], kind: 'run', title: '/cron list --all' })
    expect(cronText(['add', 'every 2h', 'check the ESP32 field boxes', '--deliver', 'telegram'])).toMatchObject({
      argv: ['cron', 'add', 'every 2h', 'check the ESP32 field boxes', '--deliver', 'telegram']
    })
    expect(cronText(['run', 'j1'])).toEqual({ argv: ['cron', 'run', 'j1'], kind: 'run', timeout: 600, title: '/cron run j1' })
    expect(cronText(['remove', 'j1'])).toMatchObject({ argv: ['cron', 'remove', 'j1'], confirm: 'Remove cron job j1? It will not run again.' })
    expect(cronText(['pause'])).toEqual({ kind: 'usage', text: 'Usage: /cron pause <job id> (the Cron tab and /cron list show the ids)' })
    expect(cronText(['create']).kind).toBe('usage')
    expect(cronText(['tick']).kind).toBe('usage')
    expect(cronText(['toString']).kind).toBe('usage')
  })

  it.each([
    [['status'], ['cron', 'status']],
    [['runs', 'j1'], ['cron', 'runs', 'j1']],
    [['incidents'], ['cron', 'incidents']],
    [['doctor'], ['cron', 'doctor']],
    [['create', '30m', 'check devices'], ['cron', 'create', '30m', 'check devices']],
    [['edit', 'j1', '--prompt', 'new prompt'], ['cron', 'edit', 'j1', '--prompt', 'new prompt']],
    [['resume', 'j1'], ['cron', 'resume', 'j1']],
    [['cancel', 'j1'], ['cron', 'cancel', 'j1']]
  ])('preserves cron arguments %j', (words, argv) => {
    expect(cronText(words)).toMatchObject({ argv, kind: 'run' })
  })


  it('reloads the Cron tab after a write, and asks before remove', async () => {
    const a = app()

    await run(a, 'cron', 'pause j1')
    expect(execs(a)).toEqual([['cron', 'pause', 'j1']])
    expect(a.cron.refresh).toHaveBeenCalledTimes(1)

    await run(a, 'cron', 'rm j1')
    expect(execs(a)).toHaveLength(1)
    confirmTop(a)
    await vi.waitFor(() => expect(execs(a)).toEqual([['cron', 'pause', 'j1'], ['cron', 'rm', 'j1']]))
  })

  it('builds the Cron tab’s create and run argv, with `--` before a prompt that starts with a dash', () => {
    expect(cronCreateArgv({ deliver: 'telegram', name: 'Field check', prompt: 'Ping every ESP32', schedule: '0 9 * * *' })).toEqual([
      'cron',
      'create',
      '--name=Field check',
      '--deliver=telegram',
      '0 9 * * *',
      'Ping every ESP32'
    ])
    expect(cronCreateArgv({ prompt: '-v report', schedule: '30m' })).toEqual(['cron', 'create', '--', '30m', '-v report'])
    expect(cronRunArgv('j1')).toEqual(['cron', 'run', 'j1'])
  })
})

describe('/plugins', () => {
  it('lists the user plugins from plugins.manage, and /plugins all the bundled ones too', async () => {
    const plugins = [
      { description: 'Tern frontend', name: 'tern', source: 'user', status: 'enabled', version: '0.4.0' },
      { name: 'old', source: 'git', status: 'disabled' },
      { name: 'memory', source: 'bundled', status: 'enabled' }
    ]
    const a = app(() => ({ plugins }))

    await run(a, 'plugins')
    expect(a.request).toHaveBeenCalledWith('plugins.manage', { action: 'list' })
    expect(a.transcript.panel).toHaveBeenLastCalledWith(
      'Plugins',
      '- ✓ **tern** (0.4.0, user) — Tern frontend\n- ✗ **old** (git)\n\n1 bundled plugin not shown: /plugins all lists them.'
    )

    await run(a, 'plugins', 'all')
    expect(must(a.transcript.panel.mock.lastCall)[1]).toContain('**memory**')
    expect(pluginLines([{ name: 'x', status: 'error' }])).toEqual(['- · **x** (error)'])
  })

  it('maps each verb to `hermes plugins …`; install, remove and update ask first', () => {
    expect(pluginsText(['enable', 'esp-tools'])).toEqual({ argv: ['plugins', 'enable', 'esp-tools'], kind: 'run', title: '/plugins enable esp-tools' })
    expect(pluginsText(['info', 'esp-tools'])).toMatchObject({ argv: ['plugins', 'info', 'esp-tools'] })
    expect(pluginsText(['search', 'serial'])).toMatchObject({ argv: ['plugins', 'search', 'serial'] })
    expect(pluginsText(['check-updates'])).toMatchObject({ argv: ['plugins', 'check-updates'] })
    expect(pluginsText(['browse'])).toMatchObject({ argv: ['plugins', 'browse'] })
    expect(pluginsText(['install', 'owner/esp-tools', '--enable'])).toMatchObject({
      argv: ['plugins', 'install', '--yes-deps', 'owner/esp-tools', '--enable'],
      confirm: 'Install plugin owner/esp-tools?',
      detail: expect.stringContaining('declared Python dependencies'),
      timeout: 600
    })
    expect(pluginsText(['remove', 'old'])).toMatchObject({ argv: ['plugins', 'remove', 'old'], confirm: 'Remove plugin old?' })
    expect(pluginsText(['update', 'tern'])).toMatchObject({ argv: ['plugins', 'update', 'tern'], confirm: 'Update plugin tern?' })
    // With no name, the CLI needs --yes without a terminal.
    expect(pluginsText(['update'])).toMatchObject({ argv: ['plugins', 'update', '--yes'] })
    expect(pluginsText(['enable'])).toEqual({ kind: 'usage', text: 'Usage: /plugins enable <name>' })
    expect(pluginsText(['frob']).kind).toBe('usage')
  })

  it.each([
    [['disable', 'old'], ['plugins', 'disable', 'old']],
    [['show', 'tern'], ['plugins', 'show', 'tern']],
    [['browse'], ['plugins', 'browse']],
    [['check-updates', '--json'], ['plugins', 'check-updates', '--json']]
  ])('preserves plugin arguments %j', (words, argv) => {
    expect(pluginsText(words)).toMatchObject({ argv, kind: 'run' })
  })

  it('installs only after dependency/activation consent, then shows the CLI’s actual live-reload outcome', async () => {
    const output = 'Gateway reloaded plugins; nothing of this plugin needs a session or restart.'
    const a = app(() => ({ blocked: false, code: 0, output }))

    await run(a, 'plugins', 'install esp-tools')
    expect(execs(a)).toEqual([])
    const detail = JSON.stringify(must(a.opened.at(-1)).node('layer.x'))
    expect(detail).toContain('declared Python dependencies')
    expect(detail).toContain('Enable the plugin and attempt live activation')
    expect(detail).toContain('security scanner and capability permissions still apply')
    confirmTop(a)
    await vi.waitFor(() => expect(a.request).toHaveBeenCalledWith('cli.exec', {
      argv: ['plugins', 'install', '--yes-deps', '--enable', 'esp-tools'],
      timeout: 600
    }))
    await vi.waitFor(() => expect(a.transcript.panel).toHaveBeenLastCalledWith('/plugins install esp-tools', output))
    expect(a.transcript.notice).not.toHaveBeenCalled()
  })

  it.each([
    [['install', 'esp-tools', '--no-deps'], ['plugins', 'install', 'esp-tools', '--no-deps']],
    [['install', 'esp-tools', '--no-enable'], ['plugins', 'install', '--yes-deps', 'esp-tools', '--no-enable']],
    [['install', 'esp-tools', '--yes-deps', '--enable'], ['plugins', 'install', 'esp-tools', '--yes-deps', '--enable']]
  ])('honors explicit install dependency/activation flags %j', (words, argv) => {
    const form = pluginsText(words)
    expect(form).toMatchObject({ argv, kind: 'run' })
    if (form.kind === 'run') {
      expect(form.argv).not.toContain('--force')
      expect(form.argv).not.toContain('--allow-removed')
      if (words.includes('--no-deps') || words.includes('--no-enable')) {
        expect(form.detail).toContain('Leave the plugin disabled.')
      }
    }
  })

  it('preserves a CLI-requested restart hint rather than issuing its own unconditional one', async () => {
    const output = 'Dependencies changed. Restart the gateway for the plugin to take effect: hermes gateway restart'
    const a = app(() => ({ blocked: false, code: 0, output }))
    await run(a, 'plugins', 'install esp-tools')
    confirmTop(a)
    await vi.waitFor(() => expect(a.transcript.panel).toHaveBeenCalledWith('/plugins install esp-tools', output))
    expect(a.transcript.notice).not.toHaveBeenCalled()
  })

  it('reports a failed RPC as `/plugins failed: …`', async () => {
    const a = app(() => {
      throw new Error('boom')
    })

    await run(a, 'plugins')
    expect(a.transcript.notice).toHaveBeenCalledWith('/plugins failed: boom', 'error')
  })
})

describe('/snapshot', () => {
  const LIST = {
    dir: '/h/state-snapshots',
    snapshots: [
      { file_count: 4, id: '20261117-120000-b', label: 'before | flash', timestamp: '2026-11-17T12:00:00', total_size: 2 * 1024 * 1024 },
      { file_count: 3, id: '20261116-090000-a', label: '', timestamp: '2026-11-16T09:00:00', total_size: 900 }
    ],
    total: 3
  }

  it('reads each form', () => {
    expect(snapshotText([])).toEqual({ kind: 'list' })
    expect(snapshotText(['create', 'before', 'flash'])).toEqual({ argv: ['backup', '--quick', '--label=before flash'], kind: 'run', title: '/snapshot create' })
    expect(snapshotText(['create'])).toMatchObject({ argv: ['backup', '--quick'] })
    expect(snapshotText(['rewind', '2'])).toEqual({ kind: 'restore', ref: '2' })
    expect(snapshotText(['prune'])).toEqual({ keep: 20, kind: 'prune' })
    expect(snapshotText(['prune', '5'])).toEqual({ keep: 5, kind: 'prune' })
    expect(snapshotText(['prune', '-1']).kind).toBe('usage')
    expect(snapshotText(['restore']).kind).toBe('usage')
  })

  it('lists as a numbered table, sizes as the classic CLI writes them', () => {
    expect(snapshotTable(LIST)).toBe(
      [
        'Snapshots in `/h/state-snapshots`, newest first:',
        '',
        '| # | Snapshot | Files | Size | Label |',
        '|--:|---|--:|--:|---|',
        '| 1 | `20261117-120000-b` | 4 | 2.0 MB | before \\| flash |',
        '| 2 | `20261116-090000-a` | 3 | 900 B |  |',
        '',
        '1 older not shown.',
        '',
        '`/snapshot restore <# or id>` restores one, `/snapshot prune [keep]` deletes the oldest.'
      ].join('\n')
    )
    expect(snapshotTable({ dir: '/h', snapshots: [], total: 0 })).toBe('No snapshots yet. /snapshot create [label] takes one.')
  })

  it('/snap create runs `hermes backup --quick`; /snapshot list reads snapshots.list', async () => {
    const a = app((m, p) => (m === 'cli.exec' ? { blocked: false, code: 0, output: `ran ${String(p['argv'])}` } : LIST))

    await run(a, 'snap', 'create before upgrade')
    expect(execs(a)).toEqual([['backup', '--quick', '--label=before upgrade']])

    await run(a, 'snapshot', 'list')
    expect(a.request).toHaveBeenLastCalledWith('plugin.hermes-tern.snapshots.list', {})
    expect(a.transcript.panel).toHaveBeenLastCalledWith('Snapshots', snapshotTable(LIST))
  })

  it('restore refused by the gateway says the safe way and restores nothing', async () => {
    const a = app(() => ({ alternative: 'In a terminal, run `hermes --cli` …', id: 'snap-a', reason: 'The gateway owns it.', refused: true, restored: false }))

    await run(a, 'snapshot', 'restore 2')
    expect(a.request.mock.calls).toEqual([['plugin.hermes-tern.snapshots.restore', { check: true, id: '2' }]])
    expect(a.transcript.notice).toHaveBeenCalledWith('Not restoring snap-a: The gateway owns it. In a terminal, run `hermes --cli` …', 'warning')
    expect(a.opened).toEqual([])
  })

  it('restore asks first when it could run, then restores the id the check resolved', async () => {
    const a = app((_, p) => ({ id: 'snap-a', refused: false, restored: p['check'] !== true }))

    await run(a, 'snapshot', 'restore 2')
    confirmTop(a)
    await vi.waitFor(() => expect(a.request).toHaveBeenLastCalledWith('plugin.hermes-tern.snapshots.restore', { id: 'snap-a' }))
    await vi.waitFor(() => expect(must(a.transcript.notice.mock.lastCall)[0]).toMatch(/^Restored snapshot snap-a/))
  })

  it('prune asks with the count it deletes, and does nothing when there are few enough', async () => {
    const a = app(m => (m.endsWith('.list') ? { ...LIST, total: 23 } : { deleted: 3, keep: 20 }))

    await run(a, 'snapshot', 'prune')
    expect(JSON.stringify(must(a.opened.at(-1)).node('layer.x'))).toContain('Delete the 3 oldest snapshots?')
    confirmTop(a)
    await vi.waitFor(() => expect(a.request).toHaveBeenLastCalledWith('plugin.hermes-tern.snapshots.prune', { keep: 20 }))
    await vi.waitFor(() => expect(a.transcript.notice).toHaveBeenLastCalledWith('Deleted 3 snapshots; kept the 20 newest.'))

    const few = app(() => ({ ...LIST, total: 2 }))
    await run(few, 'snapshot', 'prune 5')
    expect(few.transcript.notice).toHaveBeenCalledWith('Nothing to prune: 2 snapshots, keeping 5.')
    expect(few.opened).toEqual([])
  })

  it('says so when the gateway has not loaded the snapshots methods', async () => {
    const a = app(() => null)

    await run(a, 'snapshot', 'list')
    expect(must(a.transcript.notice.mock.lastCall)[0]).toMatch(/^\/snapshot failed: snapshots\.list answered in an unknown shape/)
  })
})
