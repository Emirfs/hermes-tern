import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CommandHost } from '../commands/local.js'
import { MESSAGING_COMMANDS } from '../extras/messaging.js'
import { FIRST_MS, PlatformWatch, POLL_MS } from '../messaging/attention.js'
import { DEADLINE_MS, handOff, type HandoffClock } from '../messaging/handoff.js'
import type { Overlay } from '../overlays/overlay.js'
import { openInbox } from '../overlays/inbox.js'
import { chatWithDevice, openField } from '../overlays/field.js'

import { FakeGateway, key, must, stub, tree } from './fakes.js'

afterEach(() => vi.useRealTimers())

function host(gw = new FakeGateway()) {
  const overlays: Overlay[] = []
  const notice = vi.fn()
  const submit = vi.fn()
  const newSession = vi.fn(async () => undefined)
  const resume = vi.fn(async () => undefined)
  const h = stub<CommandHost>({
    gw: gw.client, busy: null, session: { ref: { live: 'live', stored: 'stored' } },
    changed: vi.fn(), open: (o: Overlay) => overlays.push(o), close: (o: Overlay) => { o.onClose?.(); const i = overlays.indexOf(o); if (i >= 0) overlays.splice(i, 1) },
    transcript: { notice, panel: vi.fn() }, control: () => ({ submit }), newSession, resume
  })
  return { h, gw, overlays, notice, submit, newSession, resume }
}

async function run(name: string, h: CommandHost, arg: string) {
  await must(MESSAGING_COMMANDS.find(c => c.name === name)).run(h, arg)
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

it('never sends before the exact target and text have been confirmed; Cancel sends nothing', async () => {
  const x = host(new FakeGateway({ replies: {
    'plugin.hermes-tern.messaging.targets': () => ({ targets: [] }),
    'cli.exec': () => ({ code: 0, output: 'sent' })
  } }))
  await run('send', x.h, '--to telegram:579:1232 MEDIA:C:/photo.png hello')
  expect(x.gw.sent('cli.exec')).toEqual([])
  const ask = must(x.overlays.at(-1))
  expect(JSON.stringify(tree(ask.node('ask')))).toContain('telegram:579:1232')
  ask.onKey(key('escape'))
  expect(x.gw.sent('cli.exec')).toEqual([])
  await run('send', x.h, '--to telegram:579:1232 MEDIA:C:/photo.png hello')
  must(x.overlays.at(-1)).onKey(key('enter'))
  await flush()
  expect(x.gw.sent('cli.exec')).toEqual([{ argv: ['send', '--to', 'telegram:579:1232', '--', 'MEDIA:C:/photo.png hello'] }])
})

it('pairing approves and revokes only after confirmation, with literal platform/id arguments', async () => {
  const x = host(new FakeGateway({ replies: { 'cli.exec': () => ({ output: 'ok', code: 0 }) } }))
  await run('pairing', x.h, 'approve fieldai e05c637911fb1942')
  expect(x.gw.sent('cli.exec')).toEqual([])
  must(x.overlays.at(-1)).onKey(key('enter')); await flush()
  await run('pairing', x.h, 'revoke telegram 579')
  must(x.overlays.at(-1)).onKey(key('escape')); await flush()
  expect(x.gw.sent('cli.exec')).toEqual([{ argv: ['pairing', 'approve', 'fieldai', 'e05c637911fb1942'] }])
})

describe('handoff watcher', () => {
  const clock = (): HandoffClock => {
    let now = 0
    return { now: () => now, sleep: async ms => { now += ms } }
  }
  it('polls a queued native handoff to completion', async () => {
    let polls = 0
    const gw = new FakeGateway({ replies: {
      'handoff.request': () => ({ queued: true, home_name: 'Emir topic' }),
      'handoff.state': () => ({ state: ++polls > 1 ? 'completed' : 'running', error: '' })
    } })
    const states: string[] = []
    expect(await handOff(gw.client, 'live', 'telegram', s => states.push(s), clock())).toEqual({ ok: true, home: 'Emir topic' })
    expect(gw.sent('handoff.request')).toEqual([{ platform: 'telegram', session_id: 'live' }])
    expect(states).toEqual(['pending', 'running', 'completed'])
  })
  it('withdraws only a not-yet-claimed request at timeout and accepts a concurrent completion', async () => {
    const gw = new FakeGateway({ replies: {
      'handoff.request': () => ({ home_name: 'home' }),
      'handoff.state': () => ({ state: 'pending', error: '' }),
      'handoff.fail': () => ({ failed: false, state: 'completed' })
    } })
    expect(await handOff(gw.client, 'live', 'whatsapp', undefined, clock())).toEqual({ ok: true, home: 'home' })
    expect(gw.sent('handoff.fail')[0]).toMatchObject({ session_id: 'live', error: expect.stringContaining(String(DEADLINE_MS / 1000)) })
  })
  it('does not queue an invalid or busy session and asks before the first RPC', async () => {
    const x = host()
    await run('handoff', x.h, 'telegram extra')
    expect(x.notice).toHaveBeenCalled()
    await run('handoff', x.h, 'telegram')
    expect(x.gw.sent('handoff.request')).toEqual([])
    must(x.overlays.at(-1)).onKey(key('escape'))
    expect(x.gw.sent('handoff.request')).toEqual([])
  })
})

describe('platform-attention polling lifecycle', () => {
  it('updates a warning and removes it on recovery, then stops on dispose', async () => {
    vi.useFakeTimers()
    let broken = true
    const gw = new FakeGateway({ replies: { 'plugin.hermes-tern.messaging.status': () => ({ source: 'file', gateway: null, platforms: [{ key: 'whatsapp', name: 'whatsapp', state: 'disconnected', needs_attention: broken }] }) } })
    const watch = new PlatformWatch({ changed: vi.fn(), gw: gw.client })
    await vi.advanceTimersByTimeAsync(FIRST_MS)
    expect(watch.text).toContain('WhatsApp needs attention')
    broken = false
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(watch.text).toBeUndefined()
    watch.dispose()
    const n = gw.calls.length
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)
    expect(gw.calls.length).toBe(n)
  })
  it('stops quietly on a gateway without the plugin RPC', async () => {
    vi.useFakeTimers()
    const gw = new FakeGateway({ replies: { 'plugin.hermes-tern.messaging.status': () => { throw Object.assign(new Error('Method not found'), { code: -32601 }) } } })
    const watch = new PlatformWatch({ changed: vi.fn(), gw: gw.client })
    await vi.advanceTimersByTimeAsync(FIRST_MS + POLL_MS * 3)
    expect(gw.calls.length).toBe(1)
    expect(watch.text).toBeUndefined()
    watch.dispose()
  })
  it('drops a reply that lands after dispose: no line, no render', async () => {
    vi.useFakeTimers()
    const { promise, resolve } = Promise.withResolvers<unknown>()
    const gw = new FakeGateway({ replies: { 'plugin.hermes-tern.messaging.status': () => promise } })
    const changed = vi.fn()
    const watch = new PlatformWatch({ changed, gw: gw.client })
    await vi.advanceTimersByTimeAsync(FIRST_MS)
    expect(gw.calls.length).toBe(1)
    watch.dispose()
    resolve({ source: 'file', gateway: null, platforms: [{ key: 'whatsapp', name: 'whatsapp', state: 'disconnected', needs_attention: true }] })
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)
    expect(watch.text).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
    expect(gw.calls.length).toBe(1)
  })
})

it('inbox resumes through the existing path without submitting anything to the messaging lane', async () => {
  const x = host(new FakeGateway({ replies: {
    'session.list': p => ({ sessions: p['scope'] === 'stored' ? [{ id: 'tg', session_id: 'tg', source: 'telegram', title: 'Field topic', last_active_at: 100 }] : [] }),
    'plugin.hermes-tern.messaging.chats': () => ({ chats: {} })
  } }))
  openInbox(x.h)
  await flush()
  const sheet = must(x.overlays.at(-1))
  expect(JSON.stringify(tree(sheet.node('inbox')))).toContain('Field topic')
  sheet.onKey(key('enter')); await flush()
  expect(x.resume).toHaveBeenCalledWith('tg')
  expect(x.submit).not.toHaveBeenCalled()
  expect(x.gw.sent('prompt.submit')).toEqual([])
})

it('opens a fresh isolated device chat, then primes only that chat with an explicit device and skill', async () => {
  const x = host()
  await chatWithDevice(x.h, { id: 'fa-7ae9b284', name: 'MHI', kind: 'mhi-vrf-gateway', topic: { threadId: '1409', name: 'MHI', target: 'telegram:579:1409' }, fw: null, online: null, lastSeen: null, rssi: null, ssid: null })
  expect(x.newSession).toHaveBeenCalledWith('MHI · fa-7ae9b284')
  expect(x.submit).toHaveBeenCalledWith(expect.stringContaining('Load the field-device-chat skill'))
  expect(x.submit).toHaveBeenCalledWith(expect.stringContaining('fa-7ae9b284'))
  expect(x.resume).not.toHaveBeenCalled()
})

it('names the known devices when /field is given an unknown id, and reads no device status for it', async () => {
  const x = host(new FakeGateway({ replies: {
    'plugin.hermes-tern.field.devices': () => ({ host: 'h', transport: 'cloud', adapter: false, platform: null, devices: [
      { id: 'fa-61d44cb4', name: 'LG', kind: 'field-ai-box' }, { id: 'fa-7ae9b284', name: 'MHI', kind: 'mhi-vrf-gateway' }] })
  } }))
  openField(x.h, 'fa-nope')
  await flush()
  expect(x.notice).toHaveBeenCalledWith('Unknown field device fa-nope. Known: fa-61d44cb4, fa-7ae9b284.', 'warning')
  expect(x.gw.sent('plugin.hermes-tern.field.status')).toEqual([])
  must(x.overlays.at(-1)).onKey(key('escape'))
})
