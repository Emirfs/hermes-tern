// A device tab (`hermes tern --device`): it shows its Telegram topic's session, waits for one, follows a
// session_reset, sends what the user types into the shown session (the topic's FIFO), and draws the box's
// status line from read-only reads.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LaunchDevice } from '../config/env.js'
import { readLaunchEnv } from '../config/env.js'
import { agoText } from '../extras/ago.js'
import { DeviceLive, type DeviceHost, presenceOf } from '../extras/device.js'
import { readDeviceSession } from '../messaging/field.js'

import { FakeGateway, fakeTern, must, topNodes } from './fakes.js'

process.env['HERMES_HOME'] = mkdtempSync(join(tmpdir(), 'hermes-tern-device-'))

const { App } = await import('../app/chat.js')

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

const LG: LaunchDevice = { chatId: '5795068189', id: 'fa-61d44cb4', kind: 'field-ai-box', name: 'LG klima kutusu', sessionKey: 'agent:main:telegram:dm:5795068189:1232', threadId: '1232' }
const SESSION = 'plugin.hermes-tern.field.session'
const STATUS = 'plugin.hermes-tern.field.status'
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/** What field.session answers: the topic's open session `open`, rotated from `current` when it names another. */
const topic = (open: string | null, { ended = 'session_reset', rotated = true } = {}) => (p: Record<string, unknown>) => ({
  ended_reason: p['current'] && p['current'] !== open ? ended : null,
  last_seen: 1794900000,
  online: true,
  rotated: Boolean(p['current'] && open && p['current'] !== open && rotated),
  session_id: open,
  session_key: LG.sessionKey
})

let gw: FakeGateway

beforeEach(() => {
  vi.useRealTimers()
  gw = new FakeGateway()
  gw.handlers.set('setup.status', () => ({ provider_configured: true }))
  gw.handlers.set('session.create', () => ({ info: { stored_session_id: 'new' }, session_id: 'new', subscription_id: 'sub-new' }))
  gw.handlers.set('session.resume', p => ({ info: { stored_session_id: p['session_id'] }, running: false, session_id: p['session_id'], subscription_id: `sub-${String(p['session_id'])}` }))
  gw.handlers.set(STATUS, p => ({ device: p['device'], elapsed_ms: 900, errors: {}, reads: { esp: { chip: 'esp32s3', cloud: true, version: '0.1.4', wifi: 'up' } }, transport: 'cloud' }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A device tab's app on the fakes, attached; `resume` is the topic's open session the launcher found. */
async function deviceTab(resume: string) {
  const tern = fakeTern({ draws: true })
  const launch = readLaunchEnv({ HERMES_TERN_LAUNCH: JSON.stringify({ device: { chat_id: LG.chatId, id: LG.id, kind: LG.kind, name: LG.name, session_key: LG.sessionKey, thread_id: LG.threadId }, resume }) }, '/work')
  const app = new App(tern.session, gw.client, '', { launch })
  void app.run()
  gw.event({ payload: {}, type: 'gateway.ready' })
  await flush()
  await flush()

  return { app, tern }
}

const notices = (app: InstanceType<typeof App>) => app.transcript.entries.flatMap(e => (e.kind === 'notice' ? [e.text] : []))

describe('a device tab', () => {
  it('shows its topic’s open session, and what the user types goes into that session’s FIFO', async () => {
    const { app } = await deviceTab('20261105_141039_46405555')

    expect(gw.sent('session.resume')).toEqual([{ session_id: '20261105_141039_46405555' }])
    expect(gw.methods('session.create')).toEqual([])
    app.control().submit('kompresör ne durumda?')
    await vi.waitFor(() => expect(gw.methods('prompt.submit')).toHaveLength(1))
    // The shown session is the Telegram topic's: the gateway's owner admits it into the topic's FIFO, so the
    // reply goes to the topic and its channel_overrides apply (no new session, no other route).
    expect(gw.sent('prompt.submit')[0]).toMatchObject({ session_id: '20261105_141039_46405555', text: 'kompresör ne durumda?' })
    app.dispose()
  })

  it('waits for a topic without an open session, then attaches to the one that opens', async () => {
    gw.handlers.set(SESSION, topic(null))
    const { app } = await deviceTab('')

    expect(gw.methods('session.create')).toEqual([])
    expect(gw.methods('session.resume')).toEqual([])
    expect(notices(app).some(n => n.includes('açık oturum yok'))).toBe(true)

    await must(app.stores.device).poll()
    expect(gw.methods('session.resume')).toEqual([])

    gw.handlers.set(SESSION, topic('s-open'))
    await must(app.stores.device).poll()
    expect(gw.sent('session.resume')).toEqual([{ session_id: 's-open' }])
    expect(app.session.ref.stored).toBe('s-open')
    expect(notices(app).at(-1)).toContain('oturum açıldı (s-open)')
    app.dispose()
  })

  it('follows a session_reset to the new session and says so, and leaves the old one without closing it', async () => {
    const { app } = await deviceTab('s1')
    gw.handlers.set(SESSION, topic('s1'))
    await must(app.stores.device).poll()
    expect(gw.sent(SESSION).at(-1)).toEqual({ current: 's1', device: LG.id })
    expect(gw.methods('session.resume')).toHaveLength(1)

    gw.handlers.set(SESSION, topic('s2'))
    await must(app.stores.device).poll()
    await flush()
    expect(gw.sent('session.resume').map(p => p['session_id'])).toEqual(['s1', 's2'])
    expect(app.session.ref.stored).toBe('s2')
    expect(must(app.stores.device).current).toBe('s2')
    expect(notices(app).at(-1)).toBe('Telegram konusu yeni oturuma geçti (session_reset): s1 → s2. Bu sekme artık yeni oturumu gösteriyor.')
    // A device tab only watches: no end_reason, so the owner never closes the topic's session.
    expect(gw.sent('session.detach')).toEqual([{ session_id: 's1', subscription_id: 'sub-s1' }])
    app.dispose()
  })

  it('stays on its session through a compression, and waits for a running turn before it follows', async () => {
    const { app } = await deviceTab('s1')
    gw.handlers.set(SESSION, topic('s1-tip', { ended: 'compression', rotated: false }))
    await must(app.stores.device).poll()
    expect(gw.methods('session.resume')).toHaveLength(1)

    gw.handlers.set(SESSION, topic('s2'))
    app.stores.activity.set({ label: 'working', since: {}, startedAt: Date.now() })
    await must(app.stores.device).poll()
    expect(gw.methods('session.resume')).toHaveLength(1)
    app.stores.activity.set(null)
    await must(app.stores.device).poll()
    expect(gw.sent('session.resume').at(-1)).toEqual({ session_id: 's2' })
    app.dispose()
  })

  it('draws the box’s status line above the composer from read-only reads', async () => {
    gw.handlers.set(SESSION, topic('s1'))
    const { app, tern } = await deviceTab('s1')
    await must(app.stores.device).poll()
    await must(app.stores.device).queryStatus()
    app.changed()
    const lineText = () =>
      topNodes(tern.region('dock'))
        .find(n => n.props['key'] === 'device')
        ?.children.map(s => (Array.isArray(s.props['spans']) ? s.props['spans'].flatMap((x: unknown) => (x && typeof x === 'object' && 't' in x && typeof x.t === 'string' ? [x.t] : [])).join('') : ''))
        .join(' | ') ?? ''
    await vi.waitFor(() => expect(lineText()).toContain('çevrimiçi'))

    expect(lineText()).toContain('📟 LG klima kutusu')
    expect(lineText()).toContain('esp32s3')
    expect(lineText()).toContain('Telegram #1232 · canlı')
    // Only the read RPCs reach the box; nothing writes.
    expect(gw.calls.map(c => c.method).filter(m => m.startsWith('plugin.hermes-tern.field.'))).toEqual(expect.arrayContaining([SESSION, STATUS]))
    expect(gw.calls.every(c => !/rf_|arm_|firmware|provision/.test(c.method))).toBe(true)
    app.dispose()
  })

  it('is not there in an ordinary pane', async () => {
    const app = new App(fakeTern().session, gw.client, '', { launch: readLaunchEnv({}, '/work') })

    expect(app.stores.device).toBeUndefined()
  })
})

describe('the device follower on its own', () => {
  const host = (over: Partial<DeviceHost> = {}): DeviceHost & { log: string[] } => {
    const log: string[] = []
    let shown: string | null = 'a'

    return {
      canSwitch: () => ({ kind: 'switch' }),
      changed: () => undefined,
      device: LG,
      gw: gw.client,
      log,
      notice: text => void log.push(text),
      resume: id => {
        log.push(`resume ${id}`)
        shown = id

        return Promise.resolve()
      },
      shown: () => shown,
      ...over
    }
  }

  it('keeps asking when a resume was refused', async () => {
    gw.handlers.set(SESSION, topic('b'))
    const h = host({ resume: () => Promise.resolve() })
    const live = new DeviceLive(h, 'a')
    await live.poll()
    expect(live.current).toBe('a')
    expect(h.log).toEqual([])
    live.dispose()
  })

  it('reads the session answer, the presence and the age', () => {
    expect(readDeviceSession({ ended_reason: null, last_seen: 2, online: false, rotated: true, session_id: 'x', session_key: 'k' })).toEqual({
      endedReason: null, lastSeen: 2000, online: false, rotated: true, sessionId: 'x', sessionKey: 'k'
    })
    expect(readDeviceSession({ rotated: 'yes' })).toMatchObject({ rotated: false, sessionId: null })
    expect(presenceOf(undefined, undefined)).toBe('bilinmiyor')
    expect(presenceOf({ device: 'd', elapsedMs: 1, errors: { esp: 'timeout' }, reads: {}, transport: 'cloud' }, undefined)).toBe('çevrimdışı')
    expect(presenceOf('boom', { endedReason: null, lastSeen: null, online: true, rotated: false, sessionId: null, sessionKey: null })).toBe('çevrimiçi')
    expect(agoText(0, 10_000)).toBe('az önce')
    expect(agoText(0, 5 * 60_000)).toBe('5 dk önce')
    expect(agoText(0, 3 * 3600_000)).toBe('3 sa önce')
  })
})
