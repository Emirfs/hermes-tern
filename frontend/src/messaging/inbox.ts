// The /inbox: the conversations that came in over a messaging platform (Telegram, WhatsApp, a field
// box over `fieldai`…), newest activity first. The gateway's `session.list` names each session's
// `source` but has no filter for it, so the inbox reads the live scope and the first stored pages
// and keeps the messaging ones; the plugin (`messaging.chats`) adds where each one talks: the chat
// or Telegram topic and its name.

import * as z from 'zod/mini'

import { type ListedSession, liveSessions, storedPage } from '../hermes/sessionList.js'
import type { Requester } from '../wire/rpc.js'
import { loose } from '../wire/schemas.js'

import { platformName } from './platforms.js'

export const CHATS_METHOD = 'plugin.hermes-tern.messaging.chats'

/** Sources that are not a messaging platform: this machine's own clients, jobs and the API. */
const LOCAL_SOURCES: Record<string, true> = {
  '': true,
  acp: true,
  api_server: true,
  cli: true,
  cron: true,
  desktop: true,
  gui: true,
  kanban: true,
  local: true,
  msgraph_webhook: true,
  oneshot: true,
  relay: true,
  subagent: true,
  tern: true,
  tool: true,
  tui: true,
  webhook: true
}

/** Whether a session's `source` is a messaging platform. */
export const isMessagingSource = (source: string) => !LOCAL_SOURCES[source.toLowerCase()]

/** Where a messaging session talks, from its stored row. */
export interface Chat {
  platform: string
  chatId: string
  threadId: string | null
  chatType: string | null
  /** `hermes send --to`'s form for this chat. */
  target: string
  name: string | null
}

/** One inbox row. */
export interface InboxRow {
  session: ListedSession
  chat: Chat | undefined
}

const chat = z.object({
  platform: z.string(),
  chat_id: z.string(),
  thread_id: loose(z.nullable(z.string())),
  chat_type: loose(z.nullable(z.string())),
  target: z.string(),
  name: loose(z.nullable(z.string()))
})

const chatsResult = z.object({ chats: z.record(z.string(), z.unknown()) })

/** `messaging.chats`'s answer read: session id → its chat; empty for anything else. */
export function readChats(raw: unknown): Map<string, Chat> {
  const r = chatsResult.safeParse(raw)
  const out = new Map<string, Chat>()

  for (const [id, value] of Object.entries(r.success ? r.data.chats : {})) {
    const c = chat.safeParse(value)

    if (c.success) {
      out.set(id, {
        chatId: c.data.chat_id,
        chatType: c.data.chat_type ?? null,
        name: c.data.name ?? null,
        platform: c.data.platform,
        target: c.data.target,
        threadId: c.data.thread_id ?? null
      })
    }
  }

  return out
}

/** The messaging sessions among `sessions`, each once (the first listing wins), newest activity first. */
export function inboxSessions(sessions: readonly ListedSession[]): ListedSession[] {
  const seen = new Set<string>()

  return sessions
    .filter(s => isMessagingSource(s.source) && !seen.has(s.id) && Boolean(seen.add(s.id)))
    .sort((a, b) => b.lastActive - a.lastActive)
}

/** The inbox's sessions: all stored pages (jobs can bury old messaging chats), plus live conversations. */
export async function readInbox(gw: Requester): Promise<ListedSession[]> {
  const rows: ListedSession[] = [...(await liveSessions(gw))]
  let cursor: string | undefined

  for (;;) {
    const p = await storedPage(gw, {}, cursor)
    rows.push(...p.rows)

    if (!p.next) {
      break
    }

    cursor = p.next
  }

  return inboxSessions(rows)
}

/** Each session's chat from the plugin, in batches of its 200-id cap. Failures reach the sheet's notice. */
export async function readChatsOf(gw: Requester, ids: readonly string[]): Promise<Map<string, Chat>> {
  const chats = new Map<string, Chat>()

  for (let at = 0; at < ids.length; at += 200) {
    const batch = readChats(await gw.request<unknown>(CHATS_METHOD, { ids: ids.slice(at, at + 200) }))
    for (const [id, chat] of batch) chats.set(id, chat)
  }

  return chats
}

/** The row's chat as people read it: the topic's or chat's name, else the platform's DM or group. */
export function chatLabel(row: InboxRow): string {
  const c = row.chat

  if (c?.name) {
    return c.name
  }

  const platform = platformName(row.session.source)

  if (!c) {
    return platform
  }

  return c.threadId ? `${platform} topic ${c.threadId}` : `${platform} ${c.chatType ?? 'chat'} ${c.chatId}`
}

/** The row's title: the session's own title, else its first prompt, else its chat. */
export function inboxTitle(row: InboxRow): string {
  return row.session.title || row.session.preview.split('\n')[0]?.slice(0, 110) || chatLabel(row)
}

/** The row's last line: the newest reply, else the first prompt. */
export function inboxPreview(row: InboxRow): string {
  return (row.session.lastReply || row.session.preview).replace(/\s+/g, ' ').trim()
}

const MARKS: Record<string, string> = { discord: 'DC', fieldai: 'FA', signal: 'SG', slack: 'SL', telegram: 'TG', whatsapp: 'WA' }

/** A short mark for the platform: the two letters a row's badge shows. */
export function platformMark(source: string): string {
  return MARKS[source] ?? source.slice(0, 2).toUpperCase()
}
