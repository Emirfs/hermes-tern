// A device tab's agent panel (extras/devicePanel.tsx): Tern's aside beside the chat, drawn from `field.agent`
// (the box agent's mission, journal and vault note, read-only): Görev, Senden beklenenler (highlighted while
// non-empty), Son kararlar, Protokol haritası (verified and candidate rows look different), Son işler. The
// status line's `panel` segment shows or hides it; it never sends anything.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Node, plain } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readLaunchEnv } from '../config/env.js'
import { DevicePanel, factStatus, missionLead } from '../extras/devicePanel.js'
import { readAgent } from '../messaging/field.js'

import { FakeGateway, fakeTern, must, settle, topNodes } from './fakes.js'

process.env['HERMES_HOME'] = mkdtempSync(join(tmpdir(), 'hermes-tern-device-panel-'))

// After HERMES_HOME is set: the app reads it when its modules load.
const { App } = await import('../app/chat.js')

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

const MHI = { chatId: '5795068189', id: 'fa-7ae9b284', kind: 'mhi-vrf-gateway', name: 'MHI klima', sessionKey: 'agent:main:telegram:dm:5795068189:1409', threadId: '1409' }
const AGENT = 'plugin.hermes-tern.field.agent'
const SESSION = 'plugin.hermes-tern.field.session'
const NOW = 1_794_900_000_000
const at = (minutesAgo: number) => (NOW - minutesAgo * 60_000) / 1000
const entry = (id: string, kind: string, title: string, minutesAgo: number, extra: Record<string, unknown> = {}) => ({ body: '', evidence: '', id, kind, title, ts: at(minutesAgo), ...extra })

/** What field.agent answers for the MHI box: two open help requests, a decision, a map, a report and a wake. */
const ANSWER = {
  decisions: [entry('d1', 'decision', 'Kompresörü 22°C sabitlemeye karar verdim', 30, { body: 'Gece boyu döngüyü izlemek için.', evidence: 'session:abc' })],
  device: MHI.id,
  errors: {},
  facts: [
    { evidence: 'capture:0707-a', field: 'b2.bit0', meaning: 'güç açık', status: 'verified', updated: '2026-11-19' },
    { evidence: '', field: 'family 0707 b4', meaning: 'mod?', status: 'candidate', updated: '2026-11-18' },
    { evidence: '', field: 'b3', meaning: 'fan hızı', status: 'rejected', updated: '2026-11-17' }
  ],
  help_requests: [
    entry('h2', 'help_request', 'Dış ünite etiketinin fotoğrafını at', 5, { status: 'open' }),
    entry('h1', 'help_request', 'Kumandadan modu COOL yap', 90, { status: 'open' })
  ],
  mission: '# MHI VRF protokolünü çöz\n\nSadece dinle; Emir onaylamadan TX yok.',
  reports: [
    entry('w1', 'wake', 'Otonom tur', 2, { reason: 'kutu yeniden çevrimiçi', trigger: 'event' }),
    entry('r1', 'report', 'b2.bit0 doğrulandı', 40, { evidence: 'capture:0707-a' })
  ]
}

let gw: FakeGateway

beforeEach(() => {
  gw = new FakeGateway()
  gw.handlers.set('setup.status', () => ({ provider_configured: true }))
  gw.handlers.set('session.resume', p => ({ info: { stored_session_id: p['session_id'] }, running: false, session_id: p['session_id'], subscription_id: `sub-${String(p['session_id'])}` }))
  gw.handlers.set(SESSION, () => ({ online: true, rotated: false, session_id: 's1', session_key: MHI.sessionKey }))
  gw.handlers.set(AGENT, () => ANSWER)
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function deviceTab(features: string[]) {
  const tern = fakeTern({ cols: 120, draws: true, features })
  const launch = readLaunchEnv({ HERMES_TERN_LAUNCH: JSON.stringify({ device: { chat_id: MHI.chatId, id: MHI.id, kind: MHI.kind, name: MHI.name, session_key: MHI.sessionKey, thread_id: MHI.threadId }, resume: 's1' }) }, '/work')
  const app = new App(tern.session, gw.client, '', { launch })
  void app.run()
  gw.event({ payload: {}, type: 'gateway.ready' })
  await settle(gw)

  return { app, tern }
}

const panelNode = (tern: ReturnType<typeof fakeTern>) => topNodes(tern.region('layer')).find(n => n.props['role'] === 'hermes.device.aside')
const statusSeg = (tern: ReturnType<typeof fakeTern>) =>
  topNodes(tern.region('dock'))
    .find(n => n.props['key'] === 'device')
    ?.children.find(s => s.props['key'] === 'panel')
/** Plain text of the drawn panel's own view (a prefs sheet's plain form is its title alone); '' when none. */
const panelText = (tern: ReturnType<typeof fakeTern>) => {
  const view = panelNode(tern)?.children[0]

  return view ? plain(view, 120) : ''
}

/** Every node under `n` with role `role`. */
function byRole(n: Node, role: string): Node[] {
  return [...(n.props['role'] === role ? [n] : []), ...n.children.flatMap(c => byRole(c, role))]
}

describe('the device agent panel', () => {
  it('docks beside the chat with the agent’s mission, open requests, decisions, map and work, read only', async () => {
    const { app, tern } = await deviceTab(['aside'])
    const device = must(app.stores.device)
    await device.panel.poll()
    app.changed()
    await vi.waitFor(() => expect(panelText(tern)).toContain('Senden beklenenler · 2'))

    const panel = must(panelNode(tern))
    const text = panelText(tern)
    expect(panel.kind).toBe('prefs')
    expect(panel.props['title']).toBe('📟 MHI klima')
    for (const label of ['Görev · MHI VRF protokolünü çöz', 'Senden beklenenler · 2', 'Son kararlar', 'Protokol haritası', 'Son işler']) {
      expect(text).toContain(label)
    }

    // Open help requests stand out: a warning card with a role of its own, newest first.
    const help = must(byRole(panel, 'hermes.device.help.open')[0])
    expect(help.props['tone']).toBe('warning')
    expect(plain(help, 120).indexOf('Dış ünite')).toBeLessThan(plain(help, 120).indexOf('Kumandadan'))
    expect(text).toContain('Kompresörü 22°C sabitlemeye karar verdim')
    expect(text).toContain('kaynak: session:abc')
    expect(text).toContain('otonom tur · kutu yeniden çevrimiçi')
    expect(text).toContain('b2.bit0 doğrulandı')

    // The protocol map: verified, candidate and rejected rows read differently.
    const table = must(byRole(panel, 'hermes.device.facts.table')[0])
    expect(table.kind).toBe('table')
    // Each row's cells as drawn: the status chip, and the field name strong only once verified.
    const cells = JSON.stringify(table.props['rows'])
    for (const status of ['verified', 'candidate', 'rejected']) {
      expect(cells).toContain(JSON.stringify(factStatus(status)))
    }
    expect(cells).toContain(JSON.stringify({ s: 'mono strong', t: 'b2.bit0' }))
    expect(cells).toContain(JSON.stringify({ s: 'mono', t: 'family 0707 b4' }))
    expect(new Set([factStatus('verified').s, factStatus('candidate').s, factStatus('rejected').s]).size).toBe(3)

    // The status line says what waits on the user; nothing but reads went out.
    expect(plain(must(statusSeg(tern)), 120)).toContain('❗ 2 bekleyen')
    expect(gw.sent(AGENT).at(-1)).toEqual({ device: MHI.id })
    expect(gw.methods('prompt.submit')).toEqual([])
    expect(gw.calls.map(c => c.method).filter(m => m.startsWith('plugin.hermes-tern.field.') && !/\.field\.(agent|session|status)$/.test(m))).toEqual([])
    app.dispose()
  })

  it('hides and shows from the status line, and gives the edge to the session sidebar while that is open', async () => {
    const { app, tern } = await deviceTab(['aside'])
    const device = must(app.stores.device)
    await device.panel.poll()
    app.changed()
    await vi.waitFor(() => expect(panelText(tern)).toContain('Senden beklenenler · 2'))
    await vi.waitFor(() => expect(panelNode(tern)).toBeDefined())

    void must(statusSeg(tern)).handlers?.onClick?.({ act: 'click', ev: 'action', id: 'x', raw: {}, sf: 'hermes' })
    expect(device.panel.open).toBe(false)
    app.changed()
    await vi.waitFor(() => expect(panelNode(tern)).toBeUndefined())

    device.panel.toggle()
    app.toggleSidebar()
    app.changed()
    await vi.waitFor(() => expect(topNodes(tern.region('layer')).some(n => n.props['key'] === 'sidebar')).toBe(true))
    expect(panelNode(tern)).toBeUndefined()
    app.toggleSidebar()
    app.changed()
    await vi.waitFor(() => expect(panelNode(tern)).toBeDefined())
    app.dispose()
  })

  it('is not drawn where Tern has no aside, but the status line still says what waits', async () => {
    const { app, tern } = await deviceTab([])
    await must(app.stores.device).panel.poll()
    app.changed()
    await vi.waitFor(() => expect(statusSeg(tern)).toBeDefined())

    expect(panelNode(tern)).toBeUndefined()
    const seg = must(statusSeg(tern))
    expect(plain(seg, 120)).toContain('❗ 2 bekleyen')
    expect(seg.handlers?.onClick).toBeUndefined()
    app.dispose()
  })
})

describe('the panel on its own', () => {
  const host = () => ({ changed: () => undefined, device: MHI, gw: gw.client })

  it('says what is missing and why a read failed', async () => {
    gw.handlers.set(AGENT, () => ({ device: MHI.id, errors: { facts: 'ImportError: half written' } }))
    const panel = new DevicePanel(host())
    await panel.poll()
    const view = () => plain(topNodes(panel.node(NOW))[0]?.children[0] ?? [], 120)
    const text = view()
    expect(text).toContain('facts: ImportError: half written')
    expect(text).toContain('Görev dosyası yok (missions/fa-7ae9b284.md).')
    expect(text).toContain('Şu an senden beklenen bir şey yok.')
    expect(text).toContain('Kasada not yok (devices/fa-7ae9b284.md).')
    expect(panel.pending).toBe(0)
    const help = topNodes(must(panel.node(NOW))).flatMap(n => byRole(n, 'hermes.device.help'))
    expect(help[0]?.props['tone']).toBe('muted')

    gw.handlers.set(AGENT, () => {
      throw new Error('unknown method')
    })
    await panel.poll()
    expect(view()).toContain('okunamadı: unknown method')
    panel.dispose()
  })

  it('reads the answer: epoch seconds to ms, junk to defaults', () => {
    const a = must(readAgent(ANSWER))
    expect(a.helpRequests.map(h => h.id)).toEqual(['h2', 'h1'])
    expect(a.helpRequests[0]?.at).toBe(NOW - 5 * 60_000)
    expect(a.reports[0]).toMatchObject({ kind: 'wake', reason: 'kutu yeniden çevrimiçi' })
    expect(must(readAgent({ decisions: 'x', facts: null, mission: 3 }))).toEqual({ decisions: [], errors: {}, facts: [], helpRequests: [], mission: '', reports: [] })
    expect(missionLead('\n## Görev: kompresör\n\nmetin')).toBe('Görev: kompresör')
  })
})
