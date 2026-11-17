// Native messaging sheets: /platforms, /inbox, and the target picker /send opens when no --to was named.
// All use the same picker vocabulary as Sessions and Background. Polls end when the sheet closes.

import type { JSX, Key, PickerItem } from '@stencil-hq/tern'
import * as z from 'zod/mini'

import type { ChatPorts } from '../app/ports.js'
import { launchEnv } from '../config/env.js'
import { optional } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import { storedSessionId } from '../core/ids.js'
import type { ListedSession } from '../hermes/sessionList.js'
import { matchTargets, type SendTarget } from '../messaging/cli.js'
import { chatLabel, type Chat, type InboxRow, inboxPreview, inboxTitle, platformMark, readChatsOf, readInbox } from '../messaging/inbox.js'
import { platformFix, platformName, platformStatus, platformTone, type PlatformStatus, rowLabel } from '../messaging/platforms.js'
import { relative } from '../view/format.js'
import { openHermesSplit } from '../watch/spec.js'

import type { Overlay } from './overlay.js'
import { editQuery, moveSelection } from './search.js'
import { reportError } from './sheet.js'

export type MessagingSheetHost = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open' | 'resume' | 'session' | 'transcript'>

/** The conversations from messaging platforms, refreshed every 15 seconds while open. */
export function openInbox(host: MessagingSheetHost) {
  let sessions: ListedSession[] = []
  let chats = new Map<string, Chat>()
  let selected: string | undefined
  let error = ''
  let loaded = false
  let pending = false
  let closed = false
  let query = ''
  const rows = (): InboxRow[] => sessions.map(session => ({ chat: chats.get(session.id), session }))
    .filter(row => `${inboxTitle(row)} ${chatLabel(row)} ${inboxPreview(row)}`.toLowerCase().includes(query.toLowerCase()))
  const read = async () => {
    if (pending || closed) return
    pending = true
    try {
      const next = await readInbox(host.gw)
      const names = await readChatsOf(host.gw, next.map(s => s.id))
      if (!closed) { sessions = next; chats = names; error = ''; loaded = true }
    } catch (e) {
      error = errorText(e)
      if (!closed) host.transcript.notice(`Could not read inbox: ${error}`, 'error')
    } finally {
      pending = false
      if (!closed) host.changed()
    }
  }
  const resume = (id: string | undefined) => {
    if (!id) return
    host.close(overlay)
    void reportError(host.transcript, () => host.resume(storedSessionId(id)))
  }
  const overlay: Overlay = {
    key: 'inbox', modal: true,
    onClose: () => { closed = true; clearInterval(timer) },
    onKey: (k: Key) => {
      if (k.name === 'escape') host.close(overlay)
      else if (k.name === 'enter') resume(selected)
      else if (k.name === 'r' && k.shift) void read()
      else {
        selected = moveSelection(k, rows().map(r => r.session.id), selected) ?? selected
        query = editQuery(k, query) ?? query
      }
      return true
    },
    node: () => {
      const list = rows()
      if (!list.some(r => r.session.id === selected)) selected = list[0]?.session.id
      const current = list.find(r => r.session.id === selected)
      return <picker key="inbox" title="Messaging inbox" icon="inbox" noun="conversations" size="lg" preview="side"
        state={pending && !loaded ? 'loading' : 'ready'}
        empty={error ? `Could not read inbox: ${error}` : loaded ? 'No messaging conversations match.' : 'Reading conversations…'}
        items={list.map(inboxItem)} order={list.map(r => r.session.id)} {...optional('selected', selected)}
        placeholder="Find a chat, topic or message…" query={query}
        columns={[{ head: 'Platform', id: 'platform', priority: 1 }, { head: 'Activity', id: 'time', priority: 2, format: 'dim' }]}
        actions={[{ id: 'resume', label: 'Resume here', keys: ['enter'], primary: true }, { id: 'refresh', label: 'Refresh', keys: ['shift+r'] }, { id: 'close', label: 'Close', keys: ['esc'], end: true }]}
        onAction={{ close: () => host.close(overlay), refresh: () => void read(), resume: () => resume(selected) }}
        onSelect={ev => { selected = ev.item; host.changed() }} onActivate={ev => resume(ev.item)}
        subtitle={[{ s: 'muted', t: 'Newest activity first · live refresh · Enter resumes in this pane' }]} total={list.length}>
        {current ? inboxDetail(current) : null}
      </picker>
    }
  }
  const timer = setInterval(() => void read(), 15_000)
  timer.unref()
  host.open(overlay)
  void read()
}

function inboxItem(row: InboxRow): PickerItem {
  return {
    id: row.session.id, label: inboxTitle(row), detail: `${chatLabel(row)} · ${inboxPreview(row)}`,
    mark: { text: platformMark(row.session.source), seed: row.session.source },
    facts: { platform: platformName(row.session.source), time: relative(new Date(row.session.lastActive).toISOString(), Date.now()) },
    ...(row.session.running ? { badges: [{ text: 'running', tone: 'success' as const }] } : {})
  }
}

function inboxDetail(row: InboxRow): JSX.Element[] {
  return [
    <text key="chat" text={chatLabel(row)} wrap="word" />,
    <text key="title" text={inboxTitle(row)} wrap="word" />,
    <text key="id" spans={[{ s: 'muted', t: `${row.session.id} · ${row.session.messages} messages` }]} wrap="word" />,
    ...(row.chat ? [<text key="target" text={row.chat.target} wrap="word" />] : []),
    <md key="last" text={`### Last reply\n${row.session.lastReply || '(no reply yet)'}\n\n### First message\n${row.session.preview || '(none)'}`} />,
    <text key="watch" spans={[{ s: 'muted', t: 'The session watcher only supports subagents, not messaging sessions. Enter resumes this conversation here.' }]} wrap="word" />
  ]
}

/** Where a message goes; typing filters by target or name. Choosing calls `pick`, not a send. */
export function openSendTarget(host: Pick<MessagingSheetHost, 'changed' | 'close' | 'open'>, targets: readonly SendTarget[], pick: (target: SendTarget) => void) {
  let selected: string | undefined
  let query = ''
  const rows = () => matchTargets(targets, query)
  const choose = (id: string | undefined) => {
    const target = targets.find(t => t.target === id)
    if (!target) return
    host.close(overlay)
    pick(target)
  }
  const overlay: Overlay = {
    key: 'send-target', modal: true,
    onKey: k => {
      if (k.name === 'escape') host.close(overlay)
      else if (k.name === 'enter') choose(selected)
      else { selected = moveSelection(k, rows().map(t => t.target), selected) ?? selected; query = editQuery(k, query) ?? query }
      return true
    },
    node: () => {
      const list = rows()
      if (!list.some(t => t.target === selected)) selected = list[0]?.target
      return <picker key="send-target" title="Send to…" icon="send" noun="targets" size="lg" items={list.map(t => ({ id: t.target, label: t.name, detail: t.target, badges: [{ text: t.kind }] }))}
        placeholder="Find a target or topic…" query={query}
        order={list.map(t => t.target)} {...optional('selected', selected)} empty="No targets match. Use /send --to <platform:chat> <message> to name one."
        actions={[{ id: 'choose', label: 'Choose', keys: ['enter'], primary: true }, { id: 'close', label: 'Cancel', keys: ['esc'], end: true }]}
        onSelect={ev => { selected = ev.item; host.changed() }} onActivate={ev => choose(ev.item)}
        onAction={{ choose: () => choose(selected), close: () => host.close(overlay) }} />
    }
  }
  host.open(overlay)
}

const checkResult = z.object({ ok: z.boolean(), detail: z.string() })

/** Every platform's state and error; Enter on a broken WhatsApp opens the relink command below. */
export function openPlatforms(host: MessagingSheetHost) {
  let status: PlatformStatus | undefined
  let selected: string | undefined
  let error = ''
  let pending = false
  let closed = false
  const checks = new Map<string, string>()
  const read = async () => {
    if (pending || closed) return
    pending = true
    try { const next = await platformStatus(host.gw); if (!closed) { status = next; error = '' } }
    catch (e) { error = errorText(e); if (!closed) host.transcript.notice(`Could not read platforms: ${error}`, 'error') }
    finally { pending = false; if (!closed) host.changed() }
  }
  const fix = () => {
    const p = status?.platforms.find(p => p.key === selected)
    if (!p) return
    const action = platformFix(p)
    void reportError(host.transcript, async () => {
      if (p.profile) throw new Error(`This platform belongs to profile ${p.profile}; open that profile to change or check it.`)
      if (action?.split) {
        const opened = await openHermesSplit(action.split, host.session.info?.cwd || launchEnv().cwd)
        if (!opened) host.transcript.notice(`Could not open a Tern split. Run: hermes ${action.split.join(' ')}`, 'warning')
      } else if (p.name === 'telegram') {
        checks.set(p.key, 'Checking the bot token (getMe)…'); host.changed()
        const r = checkResult.parse(await host.gw.request<unknown>('plugin.hermes-tern.messaging.check', { platform: 'telegram' }))
        checks.set(p.key, `${r.ok ? 'Token valid' : 'Check failed'}: ${r.detail}`)
        host.changed()
      }
    })
  }
  const overlay: Overlay = {
    key: 'platforms', modal: true, onClose: () => { closed = true; clearInterval(timer) },
    onKey: k => {
      if (k.name === 'escape') host.close(overlay)
      else if (k.name === 'enter') fix()
      else if (k.name === 'r' && k.shift) void read()
      else selected = moveSelection(k, status?.platforms.map(p => p.key) ?? [], selected) ?? selected
      return true
    },
    node: () => {
      const list = status?.platforms ?? []
      if (!list.some(p => p.key === selected)) selected = list[0]?.key
      const p = list.find(p => p.key === selected)
      const action = p && platformFix(p)
      return <picker key="platforms" title="Messaging platforms" icon="broadcast" noun="platforms" size="lg" preview="side"
        state={!status && pending ? 'loading' : 'ready'} empty={error || (status ? 'The gateway has no platform state yet.' : 'Reading gateway state…')}
        items={list.map(p => ({ id: p.key, label: rowLabel(p), dot: platformTone(p), facts: { state: p.state, since: relative(p.since, Date.now()) }, ...(p.needsAttention ? { badges: [{ text: 'needs attention', tone: 'warning' as const }] } : {}) }))}
        columns={[{ id: 'state', head: 'State', priority: 1 }, { id: 'since', head: 'Since', format: 'dim', priority: 2 }]}
        order={list.map(p => p.key)} {...optional('selected', selected)} total={list.length}
        subtitle={[{ s: 'muted', t: status ? `${status.gateway?.state ?? 'unknown'} · ${status.source === 'live' ? 'gateway memory' : 'gateway_state.json'}` : 'Gateway state' }]}
        actions={[{ id: 'fix', label: action?.split ? 'Relink in split' : p?.name === 'telegram' ? 'Check token' : 'Fix details', keys: ['enter'], primary: true }, { id: 'refresh', label: 'Refresh', keys: ['shift+r'] }, { id: 'close', label: 'Close', keys: ['esc'], end: true }]}
        onAction={{ close: () => host.close(overlay), fix, refresh: () => void read() }}
        onSelect={ev => { selected = ev.item; host.changed() }} onActivate={ev => { selected = ev.item; fix() }}>
        {p ? <col key="detail" gap="md">
          <text key="name" text={`${rowLabel(p)} · ${p.state}${p.needsAttention ? ' · needs attention' : ''}`} wrap="word" />
          <text key="since" text={`Since: ${p.since ?? 'unknown'}`} wrap="word" />
          <text key="error" text={`Error: ${[p.errorCode, p.errorMessage].filter(Boolean).join(' · ') || 'none reported'}`} wrap="word" />
          <md key="fix" text={action?.text ?? 'Connected. No action needed.'} />
          {checks.has(p.key) ? <text key="check" text={checks.get(p.key) ?? ''} wrap="word" /> : null}
        </col> : null}
      </picker>
    }
  }
  const timer = setInterval(() => void read(), 30_000)
  timer.unref()
  host.open(overlay)
  void read()
}
