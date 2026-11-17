import { describe, expect, it, vi } from 'vitest'

import type { CommandHost } from '../commands/local.js'
import { dashboardRequest, openDashboard, type DashboardDeps } from '../extras/dashboard.js'
import { JOURNEY_COMMANDS, journeyMarkdown, journeyPayload, type JourneyNode } from '../extras/journey.js'
import { fenced, logsRequest } from '../extras/logs.js'
import { PET_COMMANDS, petRequest } from '../extras/pet.js'
import type { Overlay } from '../overlays/overlay.js'

import { FakeGateway, key, must, stub } from './fakes.js'

function app(output = '') {
  const gw = new FakeGateway({ replies: { 'cli.exec': () => ({ code: 0, output }) } })
  const overlays: Overlay[] = []
  const host = {
    changed: vi.fn(),
    close: (o: Overlay) => { const i = overlays.indexOf(o); if (i >= 0) overlays.splice(i, 1) },
    gw: gw.client,
    open: (o: Overlay) => overlays.push(o),
    pet: { refresh: vi.fn(async () => undefined) },
    session: { info: { cwd: '/repo' } },
    transcript: { notice: vi.fn(), panel: vi.fn() }
  }
  return { gw, host: stub<CommandHost>(host), overlays, raw: host }
}

const node = (id: string, kind: string, timestamp: number): JourneyNode => ({ category: kind === 'skill' ? 'hardware' : 'memory', createdBy: null, id, kind, label: id, pinned: false, state: 'active', timestamp, useCount: 3 })

it('renders a dated learning chart and compact table with escaped labels, newest first', () => {
  const text = journeyMarkdown([node('old', 'skill', 1_700_000_000), node('new | <script>', 'memory', 1_700_086_400)])
  expect(text).toContain('**1** learned skills · **1** memories')
  expect(text).toContain('```svg\n<svg')
  expect(text).toContain('stroke="var(--c1)"')
  expect(text).toContain('new | &lt;script&gt;')
  expect(text).toContain('| new \\| <script> | memory | 3 | active | 2023-11-15 |')
  expect(text.indexOf('| new')).toBeLessThan(text.indexOf('| old'))
  expect(journeyMarkdown([])).toContain('not learned')
})

it('checks journey JSON at the boundary, refusing an unrelated document', () => {
  expect(journeyPayload.safeParse({ nodes: [{ id: 'one', kind: 'skill', timestamp: 1 }] }).success).toBe(true)
  expect(journeyPayload.safeParse({ ok: true }).success).toBe(false)
})

it('runs journey JSON through cli.exec and turns a failed parse into an error notice', async () => {
  const a = app('warning before JSON\n' + JSON.stringify({ nodes: [node('one', 'skill', 1_700_000_000)] }))
  await must(JOURNEY_COMMANDS[0]).run(a.host, '')
  expect(a.gw.sent('cli.exec')).toEqual([{ argv: ['journey', '--json'] }])
  expect(a.raw.transcript.panel).toHaveBeenCalledWith('Learning journey', expect.stringContaining('one'))
  const b = app('Traceback: no graph')
  await must(JOURNEY_COMMANDS[0]).run(b.host, '')
  expect(b.raw.transcript.notice).toHaveBeenCalledWith(expect.stringContaining('no graph'), 'error')
})

it('does not delete until confirmed; preserves a quoted node id in argv', async () => {
  const a = app('Removed memory')
  await must(JOURNEY_COMMANDS[0]).run(a.host, 'delete "memory:profile:2:abc"')
  expect(a.gw.calls).toHaveLength(0)
  must(a.overlays[0]).onKey(key('escape'))
  expect(a.gw.calls).toHaveLength(0)
  await must(JOURNEY_COMMANDS[0]).run(a.host, 'delete "memory:profile:2:abc"')
  must(a.overlays[0]).onKey(key('enter'))
  await vi.waitFor(() => expect(a.gw.sent('cli.exec')).toEqual([{ argv: ['journey', 'delete', '-y', 'memory:profile:2:abc'] }]))
  await vi.waitFor(() => expect(a.raw.changed).toHaveBeenCalled())
})

describe('log argv', () => {
  it('keeps all filters and quote-aware session substrings when following', () => {
    expect(logsRequest('follow gateway -n 80 --level warning --session "field alpha" --since=30m --component tools')).toEqual({
      argv: ['logs', 'gateway', '-n', '80', '--level', 'WARNING', '--session', 'field alpha', '--since', '30m', '--component', 'tools', '-f'],
      follow: true,
      title: 'hermes logs gateway -n 80 --level WARNING --session field alpha --since 30m --component tools -f'
    })
    expect(logsRequest('-f')).toMatchObject({ argv: ['logs', '-f'], follow: true })
    expect(logsRequest('desktop 100')).toMatchObject({ argv: ['logs', 'desktop', '-n', '100'], follow: false })
  })
  it.each(['invalid', 'list -f', 'gateway --since potato', '-n 0', '--level FATAL', '--session', '--component kernel'])('refuses %s before running a command', arg => {
    expect(logsRequest(arg)).toHaveProperty('error')
  })
  it('uses a fence longer than one occurring in log text', () => {
    expect(fenced('line\n```\nunsafe')).toBe('````text\nline\n```\nunsafe\n````')
  })
})

describe('pet argv', () => {
  it('maps management actions, scale and installed-only listing without invoking an interactive picker', () => {
    expect(petRequest('')).toEqual({ action: 'installed' })
    expect(petRequest('select boxcat')).toMatchObject({ argv: ['pets', 'select', 'boxcat'], confirm: false })
    expect(petRequest('boxcat')).toMatchObject({ argv: ['pets', 'select', 'boxcat'] })
    expect(petRequest('scale 0.50')).toMatchObject({ argv: ['pets', 'scale', '0.5'] })
    expect(petRequest('install boxcat --force --select')).toMatchObject({ argv: ['pets', 'install', 'boxcat', '--force', '--select'], confirm: true })
    expect(petRequest('list --installed --limit 20 "box cat"')).toMatchObject({ argv: ['pets', 'list', '--installed', '--limit', '20', 'box cat'] })
  })
  it.each(['select', 'scale -1', 'scale NaN', 'scale 4', 'remove ../other', 'install boxcat --bad', 'list --limit -2'])('refuses %s', arg => expect(petRequest(arg)).toHaveProperty('error'))
  it('confirms install before sending the network/disk operation', async () => {
    const a = app('Installed boxcat')
    await must(PET_COMMANDS[0]).run(a.host, 'install boxcat --select')
    expect(a.gw.calls).toHaveLength(0)
    must(a.overlays[0]).onKey(key('enter'))
    await vi.waitFor(() => expect(a.gw.sent('cli.exec')).toEqual([{ argv: ['pets', 'install', 'boxcat', '--select'] }]))
    await vi.waitFor(() => expect(a.raw.pet.refresh).toHaveBeenCalled())
  })
})

describe('dashboard lifecycle', () => {
  const host = () => app().raw
  function deps(answers: boolean[]): DashboardDeps {
    return { answers: vi.fn(async () => answers.shift() ?? true), browse: vi.fn(async () => undefined), logTail: () => 'failed build', start: vi.fn(() => ({ exited: Promise.withResolvers<number | null>().promise })), wait: vi.fn(async () => undefined) }
  }
  it('validates its port and action', () => {
    expect(dashboardRequest('status')).toEqual({ action: 'status', port: 9119 })
    expect(dashboardRequest('--port=9120')).toEqual({ action: 'open', port: 9120 })
    expect(dashboardRequest('--port 0')).toHaveProperty('error')
    expect(dashboardRequest('stop --unknown')).toHaveProperty('error')
  })
  it('does not start a second server when one already answers', async () => {
    const d = deps([true])
    await openDashboard(host(), 9119, ['hermes'], d)
    expect(d.start).not.toHaveBeenCalled()
    expect(d.browse).toHaveBeenCalledWith('http://127.0.0.1:9119/')
  })
  it('starts detached with --no-open then waits for readiness before browsing', async () => {
    const d = deps([false, false, true])
    await openDashboard(host(), 9120, ['python', '-m', 'hermes_cli.main'], d)
    expect(d.start).toHaveBeenCalledWith(['python', '-m', 'hermes_cli.main', 'dashboard', '--no-open', '--port', '9120'], expect.stringContaining('dashboard-9120.log'))
    expect(d.wait).toHaveBeenCalledTimes(1)
    expect(d.browse).toHaveBeenCalledOnce()
  })
  it('surfaces start failure and its log without opening a dead page', async () => {
    const d = deps([false, false, false])
    d.start = () => ({ exited: Promise.resolve(1) })
    const h = host()
    await openDashboard(h, 9119, ['hermes'], d)
    expect(h.transcript.notice).toHaveBeenCalledWith(expect.stringContaining('exit 1'), 'warning')
    expect(h.transcript.panel).toHaveBeenCalledWith('hermes dashboard', expect.stringContaining('failed build'))
    expect(d.browse).not.toHaveBeenCalled()
  })
})
