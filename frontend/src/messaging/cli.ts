// What /send and /pairing run: `hermes send` and `hermes pairing` argv built from what the user typed,
// checked first so a typo never reaches a messaging platform. The send targets come from the plugin
// (backend/gateway/messaging.py `messaging.targets`).

import * as z from 'zod/mini'

import type { Requester } from '../wire/rpc.js'
import { loose, rowsOf } from '../wire/schemas.js'

export const TARGETS_METHOD = 'plugin.hermes-tern.messaging.targets'

export const SEND_USAGE = 'Usage: /send [--to <target>] <message>. Targets: `telegram` (home channel), `telegram:<chat>:<thread>`, `whatsapp:<jid>`… Attach a file with MEDIA:<path> in the text. Without --to, /send asks for the target.'
export const PAIRING_USAGE = 'Usage: /pairing [list] · /pairing approve <platform> <code|request-id> · /pairing revoke <platform> <user-id>'

/** `platform`, `platform:chat`, `platform:chat:thread` or `platform:#channel`: `hermes send --to`'s forms. */
const TARGET = /^[a-z][a-z0-9_]*(?::\S+)?$/i
const PLATFORM = /^[a-z][a-z0-9_]*$/i

/** A `/send` the user typed: where to (undefined: ask), and the text as typed. */
export interface SendRequest {
  to: string | undefined
  message: string
}

/** `/send [--to <target>|-t <target>|--to=<target>] <message>`, or the line that says what is wrong. */
export function parseSend(arg: string): SendRequest | { error: string } {
  if (/^\s*(?:--to|-t)(?:=|\s|$)/.test(arg)) {
    // A named target must be followed by its value and then the text: `--to`, `--to=` or `--to x` alone never send.
    const m = /^\s*(?:--to|-t)(?:=|\s+)(?<to>[^\s=]\S*)\s+(?<message>\S[\s\S]*)$/.exec(arg)
    const to = m?.groups?.['to']
    const message = (m?.groups?.['message'] ?? '').trim()

    if (!to || !message) {
      return { error: `--to needs a target and a message. ${SEND_USAGE}` }
    }

    return TARGET.test(to) ? { message, to } : { error: `\`${to}\` is not a target. ${SEND_USAGE}` }
  }

  const message = arg.trim()

  return message ? { message, to: undefined } : { error: SEND_USAGE }
}

/** `hermes send` for `to` and `message`: after `--`, so a message that starts with `-` stays the message. */
export function sendArgv(to: string, message: string): string[] {
  return ['send', '--to', to, '--', message]
}

/** The files a message attaches (`MEDIA:<path>`), for the confirmation to name. */
export function mediaOf(message: string): string[] {
  return [...message.matchAll(/MEDIA:(\S+)/g)].flatMap(m => (m[1] ? [m[1]] : []))
}

/** One place `hermes send` can deliver. */
export interface SendTarget {
  target: string
  platform: string
  name: string
  /** `home` (a platform's home channel), `topic` (a Telegram DM topic), `dm`, `group`, `channel`… */
  kind: string
  /** The skill the topic's conversation runs with (Telegram DM topics). */
  skill?: string | undefined
}

const target = z.object({ target: z.string(), platform: z.string(), name: z.string(), kind: z.string(), skill: loose(z.string()) })
const targetsResult = z.object({ targets: z.array(z.unknown()) })

/** The targets the plugin offers; rejects when the gateway does not serve the method. */
export async function sendTargets(gw: Requester): Promise<SendTarget[]> {
  const r = targetsResult.safeParse(await gw.request<unknown>(TARGETS_METHOD, {}))

  if (!r.success) {
    throw new Error('messaging.targets answered in an unknown shape (is the hermes-tern plugin loaded in the gateway?)')
  }

  return rowsOf(target, r.data.targets)
}

/** The targets whose target or name holds `query` (any case); all of them for an empty one. */
export function matchTargets(targets: readonly SendTarget[], query: string): SendTarget[] {
  const q = query.trim().toLowerCase()

  return q ? targets.filter(t => t.target.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)) : [...targets]
}

/** The confirmation's text: exactly where it goes and what it says. */
export function sendConfirmText(to: string, message: string, targets: readonly SendTarget[]): string {
  const known = targets.find(t => t.target === to)
  const files = mediaOf(message)

  return [
    `To: ${to}${known ? ` (${known.name})` : ''}`,
    ...(files.length ? [`Attaches: ${files.join(', ')}`] : []),
    '',
    message
  ].join('\n')
}

/** A /pairing the user typed. */
export type PairingRequest =
  | { kind: 'list' }
  | { kind: 'approve'; platform: string; code: string }
  | { kind: 'revoke'; platform: string; user: string }

/** `/pairing [list|approve <platform> <code>|revoke <platform> <user>]` from its words, or what is wrong. */
export function parsePairing(words: readonly string[]): PairingRequest | { error: string } {
  const [verb = 'list', platform, id, ...rest] = words

  switch (verb.toLowerCase()) {
    case 'list':
      return platform === undefined ? { kind: 'list' } : { error: PAIRING_USAGE }

    case 'approve':

    case 'revoke':
      if (!platform || !id || rest.length || !PLATFORM.test(platform) || id.startsWith('-')) {
        return { error: PAIRING_USAGE }
      }

      return verb.toLowerCase() === 'approve'
        ? { code: id, kind: 'approve', platform: platform.toLowerCase() }
        : { kind: 'revoke', platform: platform.toLowerCase(), user: id }

    default:
      return { error: PAIRING_USAGE }
  }
}

/** `hermes pairing …` for a request. */
export function pairingArgv(r: PairingRequest): string[] {
  switch (r.kind) {
    case 'list':
      return ['pairing', 'list']

    case 'approve':
      return ['pairing', 'approve', r.platform, r.code]

    case 'revoke':
      return ['pairing', 'revoke', r.platform, r.user]
  }
}
