import { describe, expect, it } from 'vitest'

import { matchTargets, mediaOf, pairingArgv, parsePairing, parseSend, sendArgv, sendConfirmText, sendTargets } from '../messaging/cli.js'
import { answered, presence, primePrompt, readDevices, readStatus, statusLines } from '../messaging/field.js'
import { chatLabel, inboxPreview, inboxSessions, inboxTitle, readChats, readInbox } from '../messaging/inbox.js'
import { attentionText, platformFix, readPlatformStatus } from '../messaging/platforms.js'
import type { ListedSession } from '../hermes/sessionList.js'

import { FakeGateway, must } from './fakes.js'

const target = { kind: 'topic', name: 'LG kutusu', platform: 'telegram', target: 'telegram:579:1232' }
const session = (id: string, source: string, lastActive: number): ListedSession => ({ id, source, lastActive, branch: '', conversation: id, cwd: '', lastReply: 'last\nreply', messages: 2, model: '', pinned: false, preview: 'first', running: false, startedAt: 1, title: '', workspace: '' })

describe('messaging argv', () => {
  it('preserves send text as one positional argument, even options, shell syntax and attachments', () => {
    const message = '-n hello; $(danger)\nMEDIA:C:/field/report.png'
    expect(parseSend(`--to telegram:579:1232 ${message}`)).toEqual({ message, to: target.target })
    expect(sendArgv(target.target, message)).toEqual(['send', '--to', target.target, '--', message])
    expect(mediaOf(message)).toEqual(['C:/field/report.png'])
    expect(sendConfirmText(target.target, message, [target])).toBe(`To: telegram:579:1232 (LG kutusu)\nAttaches: C:/field/report.png\n\n${message}`)
  })
  it('offers a picker without --to and rejects missing text or malformed targets', () => {
    expect(parseSend('hello')).toEqual({ message: 'hello', to: undefined })
    expect(parseSend('-t whatsapp:123@g.us hello')).toEqual({ message: 'hello', to: 'whatsapp:123@g.us' })
    expect(parseSend('--to=telegram hi')).toEqual({ message: 'hi', to: 'telegram' })
    for (const arg of ['', '  ', '--to', '-t', '--to ', '--to=', '--to= hi', '--to telegram', '--to=telegram', '-t telegram   ', '--to !!! hi', '--to =x hi']) {
      expect(parseSend(arg), arg).toHaveProperty('error')
    }
    expect(matchTargets([target], 'lg')).toEqual([target])
    expect(matchTargets([target], '1232')).toEqual([target])
    expect(matchTargets([target], 'whatsapp')).toEqual([])
  })
  it('builds only the three supported pairing forms', () => {
    for (const [words, argv] of [
      [[], ['pairing', 'list']],
      [['list'], ['pairing', 'list']],
      [['approve', 'Telegram', 'e05c637911fb1942'], ['pairing', 'approve', 'telegram', 'e05c637911fb1942']],
      [['revoke', 'whatsapp', '123@g.us'], ['pairing', 'revoke', 'whatsapp', '123@g.us']]
    ]) {
      const r = parsePairing(must(words))
      if ('error' in r) throw new Error(r.error)
      expect(pairingArgv(r)).toEqual(argv)
    }
    for (const words of [['clear-pending'], ['approve', 'telegram'], ['list', 'extra'], ['revoke', 'tg', '--help'], ['approve', 'tg', 'code', 'extra']]) expect(parsePairing(words)).toHaveProperty('error')
  })
  it('checks target RPC results instead of trusting arbitrary JSON', async () => {
    const gw = new FakeGateway({ replies: { 'plugin.hermes-tern.messaging.targets': () => ({ targets: [target, { target: 42 }] }) } })
    expect(await sendTargets(gw.client)).toEqual([target])
  })
})

describe('platform state and attention', () => {
  it('maps runtime state to a standing warning and concrete fixes', () => {
    const s = must(readPlatformStatus({ source: 'file', gateway: { state: 'running', pid: 1 }, platforms: [
      { key: 'whatsapp', name: 'whatsapp', state: 'disconnected', needs_attention: true, since: '2026-11-16' },
      { key: 'telegram', name: 'telegram', state: 'connected', needs_attention: false }
    ] }))
    expect(attentionText(s.platforms)).toBe('WhatsApp needs attention · /platforms')
    expect(platformFix(must(s.platforms[0]))?.split).toEqual(['whatsapp'])
    expect(platformFix(must(s.platforms[1]))).toBeUndefined()
    expect(readPlatformStatus({})).toBeUndefined()
    expect(attentionText([])).toBeUndefined()
  })
  it('distinguishes token failures from a duplicate Telegram poller', () => {
    const p = { name: 'telegram', state: 'fatal', errorCode: 'telegram_auth_error', errorMessage: null, needsAttention: true }
    expect(platformFix(p)?.check).toBe(true)
    expect(platformFix({ ...p, errorCode: 'telegram_polling_conflict' })?.text).toContain('one poller')
  })
})

describe('inbox source and view model', () => {
  it('keeps messaging sources, merges live/stored duplicates and sorts by newest activity', () => {
    const live = session('tg', 'telegram', 30)
    const rows = inboxSessions([session('job', 'cron', 100), session('local', 'tui', 99), live, session('tg', 'telegram', 20), session('wa', 'whatsapp', 40), session('box', 'fieldai', 10)])
    expect(rows.map(r => r.id)).toEqual(['wa', 'tg', 'box'])
    expect(rows[1]).toBe(live)
  })
  it('resolves a Telegram topic name and preserves the latest preview', () => {
    const chats = readChats({ chats: { tg: { platform: 'telegram', chat_id: '579', thread_id: '1232', target: 'telegram:579:1232', name: 'LG kutusu' }, broken: {} } })
    const row = { session: session('tg', 'telegram', 30), chat: chats.get('tg') }
    expect(chatLabel(row)).toBe('LG kutusu')
    expect(inboxTitle(row)).toBe('first')
    expect(inboxPreview(row)).toBe('last reply')
    expect(chats.size).toBe(1)
  })
  it('reads past five job-only stored pages rather than burying old field conversations', async () => {
    let page = 0
    const gw = new FakeGateway({ replies: { 'session.list': p => {
      if (p['scope'] === 'live') return { sessions: [] }
      page++
      return { sessions: [{ id: `s${page}`, session_id: `s${page}`, source: page === 6 ? 'telegram' : 'cron' }], next_cursor: page < 6 ? `p${page}` : null }
    } } })
    expect((await readInbox(gw.client)).map(s => s.id)).toEqual(['s6'])
    expect(page).toBe(6)
  })
})

describe('field data and status preview', () => {
  it('reads device topic ids of either JSON type and converts heartbeat seconds to ms', () => {
    const d = must(readDevices({ host: 'host', transport: 'cloud', adapter: true, platform: { state: 'connected' }, devices: [{ id: 'fa-1', name: 'LG', kind: 'field-ai-box', topic: { thread_id: 1232 }, online: true, last_seen: 100, rssi: -63 }] }))
    expect(d.devices[0]).toMatchObject({ id: 'fa-1', lastSeen: 100000, topic: { threadId: '1232' }, online: true })
    const box = must(d.devices[0])
    expect(presence(box)).toBe('online')
    expect(primePrompt(box)).toContain('Load the field-device-chat skill')
    expect(primePrompt(box)).toContain('fa-1')
    expect(primePrompt(box)).toContain('thread 1232')
    expect(primePrompt(box)).toContain('do not send anything')
  })
  it('shows ESP firmware/link and STM timeout rather than pretending all status reads succeeded', () => {
    const s = must(readStatus({ device: 'fa-1', transport: 'cloud', reads: { esp: { chip: 'ESP32-S3', version: '0.6.4', wifi: 'connected', ssid: 'saha', rssi: -63, cloud: true, uptime_ms: 3600000 }, stm32: { kind: 'error', error: 'stm_timeout' } }, errors: {}, elapsed_ms: 3541 }))
    expect(answered(s)).toBe(true)
    expect(statusLines(s)).toEqual(['ESP ESP32-S3 fw 0.6.4 · Wi-Fi connected (saha, -63 dBm) · cloud up · up 1h 0m', 'STM32: error stm_timeout'])
    const offline = must(readStatus({ device: 'fa-1', reads: {}, errors: { esp: 'offline' } }))
    expect(answered(offline)).toBe(false)
    expect(statusLines(offline)).toEqual(['ESP: offline'])
  })
})
