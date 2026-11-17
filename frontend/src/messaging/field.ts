// The field AI boxes (ESP32-S3 + STM32) the /field sheet lists, from the plugin
// (backend/gateway/field.py): `field.devices` (the registry, each box's Telegram topic, and what the
// gateway's `fieldai` platform last heard from it) and `field.status` (one read-only status query of a
// box: ESP status, STM32 status, RF status). Nothing here can write to a box.

import * as z from 'zod/mini'

import type { Requester } from '../wire/rpc.js'
import { loose } from '../wire/schemas.js'

export const DEVICES_METHOD = 'plugin.hermes-tern.field.devices'
export const STATUS_METHOD = 'plugin.hermes-tern.field.status'
export const SESSION_METHOD = 'plugin.hermes-tern.field.session'
/** The skill a box's conversation runs with (the Telegram DM topics use it too). */
export const FIELD_SKILL = 'field-device-chat'

/** One provisioned box. */
export interface FieldDevice {
  id: string
  name: string
  /** devices.json's label: `field-ai-box` (LG), `mhi-vrf-gateway`, `field-arm`… */
  kind: string
  /** Its Telegram DM topic, when it has one. */
  topic: { threadId: string; name: string | null; target: string | null } | null
  /** What the `fieldai` platform last heard: null when it never did (or does not run in this gateway). */
  online: boolean | null
  /** Epoch ms of its last heartbeat. */
  lastSeen: number | null
  fw: string | null
  ssid: string | null
  rssi: number | null
}

/** What `field.devices` answers. */
export interface FieldDevices {
  host: string
  transport: string
  /** The `fieldai` platform's adapter runs in this gateway (online and last-seen come from it). */
  adapter: boolean
  /** The `fieldai` platform's state, as /platforms shows it. */
  platformState: string | null
  devices: FieldDevice[]
}

const str = loose(z.nullable(z.string()))
const num = loose(z.nullable(z.number()))
const id = z.union([z.string(), z.number()])

const device = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.catch(z.string(), ''),
  topic: z.catch(z.nullable(z.object({ thread_id: id, name: str, target: str })), null),
  online: loose(z.nullable(z.boolean())),
  last_seen: num,
  fw: str,
  ssid: str,
  rssi: num
})

const devicesResult = z.object({
  host: z.catch(z.string(), ''),
  transport: z.catch(z.string(), 'cloud'),
  adapter: z.catch(z.boolean(), false),
  platform: z.catch(z.nullable(z.object({ state: str })), null),
  devices: z.array(device)
})

/** `field.devices`'s answer read; undefined when it is not one. */
export function readDevices(raw: unknown): FieldDevices | undefined {
  const r = devicesResult.safeParse(raw)

  if (!r.success) {
    return undefined
  }

  return {
    adapter: r.data.adapter,
    devices: r.data.devices.map(d => ({
      fw: d.fw ?? null,
      id: d.id,
      kind: d.kind,
      lastSeen: d.last_seen ? Math.round(d.last_seen * 1000) : null,
      name: d.name,
      online: d.online ?? null,
      rssi: d.rssi ?? null,
      ssid: d.ssid ?? null,
      topic: d.topic ? { name: d.topic.name ?? null, target: d.topic.target ?? null, threadId: String(d.topic.thread_id) } : null
    })),
    host: r.data.host,
    platformState: r.data.platform?.state ?? null,
    transport: r.data.transport
  }
}

export async function fieldDevices(gw: Requester): Promise<FieldDevices> {
  const r = readDevices(await gw.request<unknown>(DEVICES_METHOD, {}))

  if (!r) {
    throw new Error('field.devices answered in an unknown shape (is the hermes-tern plugin loaded in the gateway?)')
  }

  return r
}

/** One status query's outcome. */
export interface FieldStatus {
  device: string
  transport: string
  /** Each read's answer as the box sent it: `esp`, `stm32`, `rf` (or `arm` for an arm box). */
  reads: Record<string, Record<string, unknown>>
  /** Each read that failed, by name (`esp`'s timeout means the box is offline). */
  errors: Record<string, string>
  elapsedMs: number | null
}

const statusResult = z.object({
  device: z.string(),
  transport: z.catch(z.string(), 'cloud'),
  reads: z.catch(z.record(z.string(), z.record(z.string(), z.unknown())), {}),
  errors: z.catch(z.record(z.string(), z.string()), {}),
  elapsed_ms: num
})

export function readStatus(raw: unknown): FieldStatus | undefined {
  const r = statusResult.safeParse(raw)

  return r.success
    ? { device: r.data.device, elapsedMs: r.data.elapsed_ms ?? null, errors: r.data.errors, reads: r.data.reads, transport: r.data.transport }
    : undefined
}

export async function fieldStatus(gw: Requester, device: string): Promise<FieldStatus> {
  const r = readStatus(await gw.request<unknown>(STATUS_METHOD, { device }))

  if (!r) {
    throw new Error('field.status answered in an unknown shape')
  }

  return r
}

/** What `field.session` says of a device tab's box: its topic's open session and the platform's heartbeat. */
export interface DeviceSession {
  /** The topic's open session; null while it has none. */
  sessionId: string | null
  sessionKey: string | null
  /** The topic moved on from the session the tab named (a `session_reset`), not merely compressed it. */
  rotated: boolean
  /** How the named session ended (`session_reset`, `compression`, …), null while it is open. */
  endedReason: string | null
  online: boolean | null
  /** Epoch ms of the last heartbeat. */
  lastSeen: number | null
}

const sessionResult = z.object({
  ended_reason: str,
  last_seen: num,
  online: loose(z.nullable(z.boolean())),
  rotated: z.catch(z.boolean(), false),
  session_id: str,
  session_key: str
})

export function readDeviceSession(raw: unknown): DeviceSession | undefined {
  const r = sessionResult.safeParse(raw)

  return r.success
    ? {
        endedReason: r.data.ended_reason ?? null,
        lastSeen: r.data.last_seen ? Math.round(r.data.last_seen * 1000) : null,
        online: r.data.online ?? null,
        rotated: r.data.rotated,
        sessionId: r.data.session_id ?? null,
        sessionKey: r.data.session_key ?? null
      }
    : undefined
}

/** `field.session`: box `device`'s topic session, and whether it replaced `current`. */
export async function fieldSession(gw: Requester, device: string, current: string | null): Promise<DeviceSession> {
  const r = readDeviceSession(await gw.request<unknown>(SESSION_METHOD, { device, ...(current ? { current } : {}) }))

  if (!r) {
    throw new Error('field.session answered in an unknown shape (is the hermes-tern plugin in the gateway current?)')
  }

  return r
}

/** `online`, `offline` or `not heard` (the platform has no heartbeat from it, or does not run here). */
export function presence(d: Pick<FieldDevice, 'online'>): 'not heard' | 'offline' | 'online' {
  return d.online === true ? 'online' : d.online === false ? 'offline' : 'not heard'
}

const fieldText = (o: Record<string, unknown> | undefined, key: string): string | undefined => {
  const v = o?.[key]

  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined
}

/** A read's error reply (`{"kind": "error", "error": "stm_timeout"}`), if it is one. */
function replyError(o: Record<string, unknown> | undefined): string | undefined {
  return fieldText(o, 'kind') === 'error' ? (fieldText(o, 'error') ?? 'error') : undefined
}

/** `21h 51m`: an uptime in ms, in its two largest units. */
export function uptimeText(ms: number): string {
  const m = Math.floor(ms / 60_000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)

  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`
}

/** One line per read: what a technician wants to know first. */
export function statusLines(s: FieldStatus): string[] {
  const esp = s.reads['esp']
  const lines: string[] = []

  if (esp) {
    const uptime = Number(esp['uptime_ms'])
    const rssi = fieldText(esp, 'rssi')
    lines.push(
      [
        `ESP ${fieldText(esp, 'chip') ?? ''} fw ${fieldText(esp, 'version') ?? '?'}`.replace(/\s+/g, ' '),
        `Wi-Fi ${fieldText(esp, 'wifi') ?? '?'}${fieldText(esp, 'ssid') ? ` (${fieldText(esp, 'ssid')}${rssi ? `, ${rssi} dBm` : ''})` : ''}`,
        `cloud ${esp['cloud'] === true ? 'up' : 'down'}`,
        ...(Number.isFinite(uptime) && uptime > 0 ? [`up ${uptimeText(uptime)}`] : [])
      ].join(' · ')
    )
  }

  for (const [key, label] of [
    ['stm32', 'STM32'],
    ['rf', 'RF'],
    ['arm', 'Arm']
  ] as const) {
    const read = s.reads[key]

    if (read) {
      const error = replyError(read)
      const summary = Object.entries(read)
        .filter(([k, v]) => k !== 'kind' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
        .slice(0, 6)
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(' · ')
      lines.push(`${label}: ${error ? `error ${error}` : summary || 'ok'}`)
    }
  }

  for (const [key, error] of Object.entries(s.errors)) {
    lines.push(`${key === 'esp' ? 'ESP' : key}: ${error}`)
  }

  return lines
}

/** Whether the query reached the box at all. */
export const answered = (s: FieldStatus) => Object.keys(s.reads).length > 0

/** The first prompt of a new chat about box `d`: the skill, the box, and no writes without asking. */
export function primePrompt(d: Pick<FieldDevice, 'id' | 'kind' | 'name' | 'topic'>): string {
  return [
    `Load the ${FIELD_SKILL} skill. This chat is about field box ${d.id} (${d.name}${d.kind ? `, ${d.kind}` : ''})`,
    d.topic ? `; its Telegram topic is thread ${d.topic.threadId}` : '',
    '. Pass this device id explicitly to every field tool. Read its status first, then wait for my instructions; do not send anything to the box until I ask.'
  ].join('')
}
