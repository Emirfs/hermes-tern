// The messaging gateway's platforms (Telegram, WhatsApp, the `fieldai` boxes…) as the plugin reads them
// (backend/gateway/messaging.py `messaging.status`): each platform's state, its error, whether it needs
// attention and since when, and what fixes a broken one. The /platforms sheet and the status strip's
// attention notice read this.

import * as z from 'zod/mini'

import type { Requester } from '../wire/rpc.js'
import { loose, rowsOf } from '../wire/schemas.js'

export const STATUS_METHOD = 'plugin.hermes-tern.messaging.status'

/** One platform the gateway runs. */
export interface PlatformRow {
  /** The gateway's key: the platform, or `<profile>:<platform>` for another profile's. */
  key: string
  name: string
  profile: string | null
  state: string
  errorCode: string | null
  errorMessage: string | null
  needsAttention: boolean
  /** ISO time: when it started retrying, else its last state change. */
  since: string | null
}

/** What `messaging.status` answers. */
export interface PlatformStatus {
  /** Where it was read: the gateway's memory (`live`), its state file (`file`), or nowhere (`none`). */
  source: string
  gateway: { state: string; pid: number | null; updatedAt: string | null; version: string | null } | null
  platforms: PlatformRow[]
}

const text = loose(z.nullable(z.string()))

const row = z.object({
  key: z.string(),
  name: z.string(),
  profile: text,
  state: text,
  error_code: text,
  error_message: text,
  needs_attention: loose(z.boolean()),
  since: text
})

const status = z.object({
  source: z.string(),
  gateway: z.catch(
    z.nullable(z.object({ state: text, pid: loose(z.nullable(z.number())), updated_at: text, version: text })),
    null
  ),
  platforms: z.array(z.unknown())
})

/** `raw` (a `messaging.status` answer) read; undefined when it is not one. */
export function readPlatformStatus(raw: unknown): PlatformStatus | undefined {
  const r = status.safeParse(raw)

  if (!r.success) {
    return undefined
  }

  const g = r.data.gateway

  return {
    gateway: g ? { pid: g.pid ?? null, state: g.state ?? 'unknown', updatedAt: g.updated_at ?? null, version: g.version ?? null } : null,
    platforms: rowsOf(row, r.data.platforms).map(p => ({
      errorCode: p.error_code ?? null,
      errorMessage: p.error_message ?? null,
      key: p.key,
      name: p.name,
      needsAttention: p.needs_attention ?? false,
      profile: p.profile ?? null,
      since: p.since ?? null,
      state: p.state ?? 'unknown'
    })),
    source: r.data.source
  }
}

/** Asks the plugin; rejects when the gateway does not serve the method (an old plugin) or answers something else. */
export async function platformStatus(gw: Requester): Promise<PlatformStatus> {
  const r = readPlatformStatus(await gw.request<unknown>(STATUS_METHOD, {}))

  if (!r) {
    throw new StatusShapeError('messaging.status answered in an unknown shape')
  }

  return r
}

/** The gateway answered `messaging.status` with something else: not this plugin's method. */
export class StatusShapeError extends Error {}

const NAMES: Record<string, string> = {
  bluebubbles: 'iMessage',
  discord: 'Discord',
  email: 'Email',
  fieldai: 'Field AI',
  matrix: 'Matrix',
  mattermost: 'Mattermost',
  signal: 'Signal',
  slack: 'Slack',
  sms: 'SMS',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  whatsapp_cloud: 'WhatsApp Cloud'
}

/** A platform's name as people write it: `WhatsApp`, `Field AI`, else the name capitalized. */
export function platformName(name: string): string {
  return NAMES[name] ?? (name ? name[0]?.toUpperCase() + name.slice(1) : 'Unknown')
}

/** A row's label: its platform's name, and the profile when it is another profile's. */
export function rowLabel(p: Pick<PlatformRow, 'name' | 'profile'>): string {
  return p.profile ? `${platformName(p.name)} (${p.profile})` : platformName(p.name)
}

export type PlatformTone = 'error' | 'muted' | 'success' | 'warning'

/** The row's dot: green connected, red needing attention, amber anything in between. */
export function platformTone(p: Pick<PlatformRow, 'needsAttention' | 'state'>): PlatformTone {
  if (p.needsAttention) {
    return 'error'
  }

  return p.state === 'connected' ? 'success' : p.state === 'unknown' ? 'muted' : 'warning'
}

/**
 * What fixes a broken platform: what to do, and the action Enter takes: `split` runs `hermes <split>` in a
 * split below, `check` asks the plugin to check the platform's credentials (`messaging.check`).
 */
export interface PlatformFix {
  text: string
  split?: readonly string[]
  check?: boolean
}

const RESTART = 'Once fixed, the gateway reconnects on its own retry; if it stays down, run `hermes gateway restart` in a terminal (it also serves Telegram, so pick a quiet moment).'

/** The fix for `p`, when it needs one. */
export function platformFix(p: Pick<PlatformRow, 'errorCode' | 'errorMessage' | 'name' | 'needsAttention' | 'state'>): PlatformFix | undefined {
  if (!p.needsAttention && p.state === 'connected') {
    return undefined
  }

  const code = p.errorCode ?? ''

  switch (p.name) {
    case 'whatsapp':
      return code === 'whatsapp_npm_install_failed'
        ? { split: ['whatsapp'], text: `The WhatsApp bridge could not install its packages. Run \`hermes whatsapp\` to set it up again (Enter opens it in a split below). ${RESTART}` }
        : {
            split: ['whatsapp'],
            text: `WhatsApp is logged out or its bridge lost the link. Relink it: \`hermes whatsapp\` shows a QR code to scan from the phone (WhatsApp → Linked devices). Enter opens it in a split below. ${RESTART}`
          }

    case 'telegram':
      if (code === 'telegram_auth_error' || code === 'missing_credentials') {
        return {
          check: true,
          text: `Telegram refuses the bot token, or none is set. Check \`TELEGRAM_BOT_TOKEN\` in the profile's \`.env\` (BotFather → /mybots → API Token). Enter asks Telegram whether the token the gateway holds is valid (getMe; nothing is sent). ${RESTART}`
        }
      }

      if (code === 'telegram_polling_conflict') {
        return { text: `Another program polls the same bot token (a second gateway, another machine). Stop it; Telegram allows one poller per token. ${RESTART}` }
      }

      return {
        check: true,
        text: `Telegram is unreachable (${p.errorMessage || p.state}). The gateway keeps retrying; check this machine's network or proxy. Enter checks the bot token (getMe). ${RESTART}`
      }

    case 'fieldai':
      return { text: `The Field AI platform lost its broker link (${p.errorMessage || p.state}). Check FIELDAI_HOME and the network; /field lists the boxes. ${RESTART}` }

    default:
      return { text: `${platformName(p.name)} is ${p.state}${p.errorMessage ? `: ${p.errorMessage}` : ''}. \`hermes doctor\` checks its setup. ${RESTART}` }
  }
}

/** The status strip's line while any platform needs attention; undefined while none does. */
export function attentionText(platforms: readonly Pick<PlatformRow, 'name' | 'needsAttention' | 'profile'>[]): string | undefined {
  const broken = platforms.filter(p => p.needsAttention)
  const [first] = broken

  if (!first) {
    return undefined
  }

  return broken.length === 1 ? `${rowLabel(first)} needs attention · /platforms` : `${broken.length} messaging platforms need attention · /platforms`
}
