// A device tab's side panel (Tern's aside: a `prefs` sheet in the layer, the chat narrowed beside it, the
// panel as the sheet's extra content, as the PR aside once was). It shows what the box's autonomous agent
// left in its files, read every few seconds through `field.agent`: its mission, the help requests it waits
// on (highlighted), its latest decisions, the protocol map of its memory-vault note, and its latest work
// (reports and the waker's turns). The panel only reads: it sends nothing to the agent, the topic or the
// box. It takes no keys, the composer keeps them; its close button (or the status line's `panel` segment)
// hides it, and the session sidebar takes its place while that is open.

import type { JSX, SpanData } from '@stencil-hq/tern'

import type { LaunchDevice } from '../config/env.js'
import { Disposables } from '../core/disposables.js'
import { errorText } from '../core/errors.js'
import { type AgentEntry, type AgentFact, type DeviceAgent, fieldAgent } from '../messaging/field.js'
import type { Requester } from '../wire/rpc.js'

import { agoText } from './ago.js'

/** How often the agent's files are read. */
export const AGENT_POLL_MS = 10_000
/** The first read, once the gateway had a moment to attach. */
const FIRST_POLL_MS = 1_500
/** Lines of an entry's body the panel shows. */
const BODY_LINES = 3

/** What the panel reaches of the app. */
export interface DevicePanelHost {
  readonly gw: Pick<Requester, 'request'>
  readonly device: LaunchDevice
  changed(): void
}

/** How a protocol-map row's status reads: verified, candidate and rejected each look different. */
export function factStatus(status: string): SpanData {
  switch (status) {
    case 'verified':
      return { s: 'success strong', t: '✓ verified' }
    case 'candidate':
      return { s: 'warning', t: '? candidate' }
    case 'rejected':
      return { s: 'muted del', t: '✗ rejected' }
    default:
      return { s: 'muted', t: status || '?' }
  }
}

/** The mission's first heading or line: what the folded Mission section says. */
export function missionLead(md: string): string {
  const line = md.split('\n').find(l => l.trim()) ?? ''

  return line.replace(/^#+\s*/, '').trim()
}

export class DevicePanel {
  readonly #host: DevicePanelHost
  readonly #timers = new Disposables()
  #open = true
  #agent: DeviceAgent | undefined
  #error = ''
  #reading = false

  constructor(host: DevicePanelHost) {
    this.#host = host
    this.#timers.timeout(() => this.#loop(), FIRST_POLL_MS)
  }

  /** Whether the panel is shown (beside the chat, where Tern has an aside). */
  get open(): boolean {
    return this.#open
  }

  /** The last read; undefined before the first answer. */
  get agent(): DeviceAgent | undefined {
    return this.#agent
  }

  /** How many help requests wait on the user. */
  get pending(): number {
    return this.#agent?.helpRequests.length ?? 0
  }

  toggle() {
    this.#open = !this.#open
    this.#host.changed()
  }

  dispose() {
    this.#timers.dispose()
  }

  #loop() {
    void this.poll().finally(() => {
      if (!this.#timers.disposed) {
        this.#timers.timeout(() => this.#loop(), AGENT_POLL_MS)
      }
    })
  }

  /** One read of the agent's files. */
  async poll(): Promise<void> {
    if (this.#reading) {
      return
    }

    this.#reading = true

    try {
      this.#agent = await fieldAgent(this.#host.gw, this.#host.device.id)
      this.#error = ''
    } catch (e) {
      this.#error = errorText(e)
    } finally {
      this.#reading = false
      this.#host.changed()
    }
  }

  /** The aside, while it is open. */
  node(now = Date.now()): JSX.Element | null {
    if (!this.#open) {
      return null
    }

    const d = this.#host.device
    const a = this.#agent
    const help = a?.helpRequests ?? []
    const problems = [...(this.#error ? [`could not read: ${this.#error}`] : []), ...Object.entries(a?.errors ?? {}).map(([part, why]) => `${part}: ${why}`)]

    return (
      <prefs
        key="device"
        onAction={{
          close: (ev: { value?: unknown }) => {
            // A row's `close` is an open menu closing; only the sheet's own close has no row.
            if (!ev.value) {
              this.toggle()
            }
          }
        }}
        page="device"
        pages={[]}
        role="hermes.device.aside"
        sections={[]}
        title={`📟 ${d.name}`}
      >
        <col gap="md" key="view" role="hermes.device.panel">
          {a === undefined && !this.#error ? <text key="loading" spans={[{ s: 'muted', t: 'Reading the agent’s files…' }]} /> : null}
          {problems.map((p, i) => (
            <text key={`problem-${i}`} spans={[{ s: 'warning', t: p }]} wrap="word" />
          ))}
          <section collapsed collapsible head={[{ s: 'strong', t: 'Mission' }, ...(a?.mission ? [{ s: 'muted', t: ` · ${missionLead(a.mission)}` }] : [])]} key="mission" role="hermes.device.mission">
            {a?.mission ? <md key="md" text={a.mission} /> : <text key="none" spans={[{ s: 'muted', t: `No mission file (missions/${d.id}.md).` }]} />}
          </section>
          <card
            head={[{ s: 'strong', t: 'Needs you' }, ...(help.length ? [{ s: 'warning strong', t: ` · ${help.length}` }] : [])]}
            key="help"
            role={help.length ? 'hermes.device.help.open' : 'hermes.device.help'}
            tone={help.length ? 'warning' : 'muted'}
          >
            {help.length ? entries(help, now, 'help') : <text key="none" spans={[{ s: 'muted', t: 'Nothing is waiting on you right now.' }]} />}
          </card>
          <section collapsible head={[{ s: 'strong', t: 'Recent decisions' }]} key="decisions" role="hermes.device.decisions">
            {a?.decisions.length ? entries(a.decisions, now, 'decisions') : <text key="none" spans={[{ s: 'muted', t: 'No decisions yet.' }]} />}
          </section>
          <section collapsible head={[{ s: 'strong', t: 'Protocol map' }]} key="facts" role="hermes.device.facts">
            {a?.facts.length ? factsTable(a.facts) : <text key="none" spans={[{ s: 'muted', t: `No note in the vault (devices/${d.id}.md).` }]} />}
          </section>
          <section collapsible head={[{ s: 'strong', t: 'Recent work' }]} key="reports" role="hermes.device.reports">
            {a?.reports.length ? entries(a.reports, now, 'reports') : <text key="none" spans={[{ s: 'muted', t: 'No reports yet.' }]} />}
          </section>
        </col>
      </prefs>
    )
  }
}

/** Journal entries, newest first: the title, when and why, and the start of the body. */
function entries(rows: readonly AgentEntry[], now: number, section: 'decisions' | 'help' | 'reports'): JSX.Element {
  return (
    <col gap="sm" key="entries">
      {rows.map((e, i) => {
        const meta = [
          e.at ? agoText(e.at, now) : '',
          e.kind === 'wake' ? `autonomous turn${e.reason ? ` · ${e.reason}` : ''}` : '',
          e.evidence ? `source: ${e.evidence}` : ''
        ].filter(Boolean)

        return (
          <col gap="none" key={e.id || `entry-${i}`} role={`hermes.device.${section}.entry`}>
            <text key="title" spans={[{ s: 'strong', t: e.title || e.kind }]} wrap="word" />
            {meta.length ? <text key="meta" spans={[{ s: 'muted', t: meta.join(' · ') }]} truncate="end" /> : null}
            {e.body ? <text key="body" lines={BODY_LINES} text={e.body} wrap="word" /> : null}
          </col>
        )
      })}
    </col>
  )
}

/** The protocol map: one row per field, a verified field strong, a candidate's meaning tentative. */
function factsTable(facts: readonly AgentFact[]): JSX.Element {
  return (
    <table
      cols={[
        { head: 'Field', id: 'field' },
        { grow: 1, head: 'Meaning', id: 'meaning' },
        { head: 'Status', id: 'status' },
        { head: 'Evidence', id: 'evidence', priority: 1, truncate: 'middle' }
      ]}
      key="table"
      role="hermes.device.facts.table"
      rows={facts.map((f, i) => ({
        cells: {
          evidence: [{ s: 'muted', t: f.evidence }],
          field: [{ s: f.status === 'verified' ? 'mono strong' : 'mono', t: f.field }],
          meaning: [{ s: f.status === 'verified' ? '' : f.status === 'rejected' ? 'muted del' : 'em', t: f.meaning }],
          status: [factStatus(f.status)]
        },
        id: `${i}:${f.field}`
      }))}
    />
  )
}
