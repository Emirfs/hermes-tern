// A device tab (`hermes tern --device <id>`, launch/launcher.py): the field box's Telegram DM topic session,
// shown live and followed. The gateway already streams that session's turns to this view (a Telegram
// message or a cron run is admitted into the session's FIFO and its events fan out to every viewer), and
// what the user types here is admitted into the same FIFO, so the reply goes to the topic with its
// channel_overrides. What this adds:
//   - the topic's open session, read every few seconds (`field.session`): a tab whose topic had none
//     attaches when one opens, and a `session_reset` moves the tab to the new session and says so;
//   - a status line of the box above the composer: the platform's heartbeat on every read, and a
//     read-only `field.status` query on a slow interval (never a write to the box);
//   - the side panel of the box's autonomous agent (extras/devicePanel.tsx), toggled from the status line;
//   - `/esp`, which opens or focuses Tern's ESP session (a tab per box) through `hermes tern --esp-tabs`.

import { execFile } from 'node:child_process'

import type { JSX } from '@stencil-hq/tern'

import type { LaunchDevice } from '../config/env.js'
import { Disposables } from '../core/disposables.js'
import { errorText } from '../core/errors.js'
import { type StoredSessionId, storedSessionId } from '../core/ids.js'
import type { HermesCommand } from '../hermes/connect.js'
import { answered, type DeviceSession, fieldSession, fieldStatus, type FieldStatus, statusLines } from '../messaging/field.js'
import type { NoticeEntry } from '../model.js'
import type { SwitchGate } from '../turn/router.js'
import type { Requester } from '../wire/rpc.js'

import { agoText } from './ago.js'
import { DevicePanel } from './devicePanel.js'

/** How often the topic's open session (and the heartbeat) is read. */
export const SESSION_POLL_MS = 5_000
/** How often the box is asked for its status (one read-only query, up to 25 s). */
export const STATUS_POLL_MS = 120_000
/** The first reads, once the gateway had a moment to attach. */
const FIRST_POLL_MS = 1_500

/** What a device tab reaches of the app. */
export interface DeviceHost {
  readonly gw: Pick<Requester, 'request'>
  readonly device: LaunchDevice
  /** The stored id of the session the pane shows, null for none. */
  shown(): string | null
  /** Whether the view may move to another session now (not while a turn runs). */
  canSwitch(): SwitchGate
  resume(id: StoredSessionId): Promise<void>
  notice(text: string, tone?: NoticeEntry['tone']): void
  changed(): void
}

/** The box's state as the status line says it, from the last status query, else the heartbeat. */
export function presenceOf(live: FieldStatus | string | undefined, heard: DeviceSession | undefined): 'bilinmiyor' | 'çevrimdışı' | 'çevrimiçi' {
  if (live && typeof live !== 'string') {
    return answered(live) ? 'çevrimiçi' : 'çevrimdışı'
  }

  return heard?.online === true ? 'çevrimiçi' : heard?.online === false ? 'çevrimdışı' : 'bilinmiyor'
}

/** A device tab's follower and status line. */
export class DeviceLive {
  readonly #host: DeviceHost
  /** The agent's side panel: its own reads, drawn in Tern's aside. */
  readonly panel: DevicePanel
  readonly #timers = new Disposables()
  /** The topic session this tab opened last (the launcher's, then each one it followed to). */
  #current: string | null
  #session: DeviceSession | undefined
  #sessionError = ''
  /** The last status query's answer, or why it failed; undefined before the first. */
  #status: FieldStatus | string | undefined
  #statusAt = 0
  #reading = false
  #querying = false

  constructor(host: DeviceHost, initial: string) {
    this.#host = host
    this.#current = initial || null
    this.panel = new DevicePanel(host)
    this.#timers.timeout(() => this.#loop(), FIRST_POLL_MS)
    this.#timers.timeout(() => this.#statusLoop(), FIRST_POLL_MS)
  }

  /** The topic session this tab follows (null while the topic has none). */
  get current(): string | null {
    return this.#current
  }

  dispose() {
    this.#timers.dispose()
    this.panel.dispose()
  }

  #loop() {
    void this.poll().finally(() => {
      if (!this.#timers.disposed) {
        this.#timers.timeout(() => this.#loop(), SESSION_POLL_MS)
      }
    })
  }

  #statusLoop() {
    void this.queryStatus().finally(() => {
      if (!this.#timers.disposed) {
        this.#timers.timeout(() => this.#statusLoop(), STATUS_POLL_MS)
      }
    })
  }

  /** One read of the topic's open session: attaches to a new one, or follows a rotation. */
  async poll(): Promise<void> {
    if (this.#reading) {
      return
    }

    this.#reading = true

    try {
      const s = await fieldSession(this.#host.gw, this.#host.device.id, this.#current)
      this.#session = s
      this.#sessionError = ''

      if (s.sessionId && s.sessionId !== this.#current && (s.rotated || !this.#current)) {
        await this.#follow(s.sessionId, s.endedReason)
      }
    } catch (e) {
      this.#sessionError = errorText(e)
    } finally {
      this.#reading = false
      this.#host.changed()
    }
  }

  /** Moves the view to the topic's session `next` (a later poll tries again while a turn holds the view). */
  async #follow(next: string, ended: string | null) {
    const host = this.#host
    const before = this.#current

    if (host.shown() !== next) {
      if (host.canSwitch().kind !== 'switch') {
        return
      }

      await host.resume(storedSessionId(next))

      if (host.shown() !== next) {
        // Refused or superseded: the next poll asks again.
        return
      }
    }

    this.#current = next
    // After the resume, whose adopt resets the transcript.
    host.notice(
      before
        ? `Telegram konusu yeni oturuma geçti${ended ? ` (${ended})` : ''}: ${before} → ${next}. Bu sekme artık yeni oturumu gösteriyor.`
        : `Telegram konusunda oturum açıldı (${next}); canlı izleniyor.`
    )
  }

  /** One read-only status query of the box. */
  async queryStatus(): Promise<void> {
    if (this.#querying) {
      return
    }

    this.#querying = true

    try {
      this.#status = await fieldStatus(this.#host.gw, this.#host.device.id)
    } catch (e) {
      this.#status = errorText(e)
    } finally {
      this.#statusAt = Date.now()
      this.#querying = false
      this.#host.changed()
    }
  }

  /** The status line above the composer; with Tern's aside, its `panel` segment shows or hides the side panel. */
  node(now = Date.now(), aside = false): JSX.Element {
    const d = this.#host.device
    const live = this.#status
    const state = presenceOf(live, this.#session)
    const seenAt = live && typeof live !== 'string' && answered(live) ? this.#statusAt : this.#session?.lastSeen
    const detail = live === undefined ? 'durum okunuyor…' : typeof live === 'string' ? `durum okunamadı: ${live}` : statusLines(live)[0]
    const topic = this.#sessionError
      ? `oturum okunamadı: ${this.#sessionError}`
      : this.#session && !this.#session.sessionId
        ? 'Telegram oturumu bekleniyor'
        : `Telegram #${d.threadId || '?'} · canlı`
    const pending = this.panel.pending
    const panelText = pending ? `❗ ${pending} bekleyen` : aside ? (this.panel.open ? 'panel ▸' : 'panel ◂') : ''

    return (
      <status key="device" role="hermes.statusline">
        <seg key="box" priority={9} role="hermes.statusline.brand" spans={[{ t: `📟 ${d.name}` }]} title={`${d.name} · ${d.id}${d.kind ? ` · ${d.kind}` : ''}`} />
        <seg
          key="state"
          priority={8}
          role={state === 'çevrimiçi' ? 'hermes.statusline.good' : state === 'çevrimdışı' ? 'hermes.statusline.bad' : 'hermes.statusline.warn'}
          spans={[{ t: state }]}
        />
        {seenAt ? <seg key="seen" priority={6} spans={[{ t: `son görülme ${agoText(seenAt, now)}` }]} /> : null}
        {detail ? <seg key="detail" priority={2} spans={[{ t: detail }]} title={detail} /> : null}
        {panelText ? (
          <seg
            key="panel"
            {...(aside ? { onClick: () => this.panel.toggle() } : {})}
            priority={pending ? 9 : 5}
            role={pending ? 'hermes.statusline.ask' : 'hermes.statusline.panel'}
            side="right"
            spans={[{ t: panelText }]}
            title={aside ? (this.panel.open ? 'Cihaz panelini gizle' : 'Cihaz panelini göster') : 'Senden beklenenler: ajanın açık yardım istekleri'}
          />
        ) : null}
        <seg key="topic" priority={7} side="right" spans={[{ t: topic }]} title={this.#session?.sessionKey ?? d.sessionKey} />
      </status>
    )
  }
}

/** `hermes tern --esp-tabs [device]` from this pane: Tern's ESP session, a tab per box (Tern's CLI finds this window). */
export function openEspTabs(hermes: HermesCommand | undefined, focus?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { promise, reject, resolve } = Promise.withResolvers<string>()

  if (!hermes) {
    reject(new Error('the launcher named no command for Hermes'))

    return promise
  }

  const [file, ...args] = hermes
  execFile(file, [...args, 'tern', '--esp-tabs', ...(focus ? [focus] : [])], { encoding: 'utf8', env, timeout: 60_000 }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error((stderr || stdout || error.message).trim()))
    } else {
      resolve(stdout.trim())
    }
  })

  return promise
}
