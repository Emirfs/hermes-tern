// /field: provisioned boxes, their platform heartbeat, and a read-only status preview. Enter starts a
// new chat about the selected device, primed with field-device-chat. R re-reads that device's status.

import type { ChatPorts } from '../app/ports.js'
import { optional } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import { answered, fieldDevices, type FieldDevice, type FieldDevices, fieldStatus, type FieldStatus, presence, primePrompt, statusLines } from '../messaging/field.js'
import { relative } from '../view/format.js'

import type { Overlay } from './overlay.js'
import { moveSelection } from './search.js'
import { reportError } from './sheet.js'

export type FieldSheetHost = Pick<ChatPorts, 'busy' | 'changed' | 'close' | 'control' | 'gw' | 'newSession' | 'open' | 'transcript'>

/** A chat explicitly bound to one device: no field action is exposed here, only its status reads. */
export async function chatWithDevice(host: FieldSheetHost, d: FieldDevice): Promise<void> {
  if (host.busy) throw new Error('Wait for the current turn to finish before starting a device chat.')
  await host.newSession(`${d.name} · ${d.id}`)
  host.control().submit(primePrompt(d))
}

export function openField(host: FieldSheetHost, focus?: string) {
  let state: FieldDevices | undefined
  let selected = focus
  let error = ''
  let closed = false
  let reading = false
  const statuses = new Map<string, FieldStatus | string | null>()
  const loadStatus = (d: FieldDevice | undefined, force = false) => {
    if (!d || (!force && statuses.has(d.id)) || statuses.get(d.id) === null) return
    statuses.set(d.id, null)
    void fieldStatus(host.gw, d.id).then(s => {
      if (!closed) { statuses.set(d.id, s); host.changed() }
    }).catch((e: unknown) => {
      if (!closed) { statuses.set(d.id, errorText(e)); host.transcript.notice(`Could not read ${d.id}: ${errorText(e)}`, 'error'); host.changed() }
    })
  }
  const read = async () => {
    if (reading || closed) return
    reading = true
    try {
      const next = await fieldDevices(host.gw)
      if (closed) return
      state = next
      error = ''
      if (focus && !next.devices.some(d => d.id === focus)) {
        host.transcript.notice(`Unknown field device ${focus}. Known: ${next.devices.map(d => d.id).join(', ') || 'none'}.`, 'warning')
        focus = undefined
        selected = undefined
      }
    }
    catch (e) { error = errorText(e); if (!closed) host.transcript.notice(`Could not list field devices: ${error}`, 'error') }
    finally { reading = false; if (!closed) host.changed() }
  }
  const current = () => state?.devices.find(d => d.id === selected)
  const chat = () => {
    const d = current()
    if (!d) return
    host.close(overlay)
    void reportError(host.transcript, () => chatWithDevice(host, d))
  }
  const overlay: Overlay = {
    key: 'field', modal: true,
    onClose: () => { closed = true; clearInterval(timer) },
    onKey: k => {
      if (k.name === 'escape') host.close(overlay)
      else if (k.name === 'enter') chat()
      else if (k.name === 'r' && !k.ctrl && !k.meta && !k.alt) { if (k.shift) void read(); else loadStatus(current(), true) }
      else selected = moveSelection(k, state?.devices.map(d => d.id) ?? [], selected) ?? selected
      return true
    },
    node: () => {
      const list = state?.devices ?? []
      if (!list.some(d => d.id === selected)) selected = list[0]?.id
      const d = current()
      loadStatus(d)
      const s = d ? statuses.get(d.id) : undefined
      return <picker key="field" title="Field devices" icon="cpu" size="lg" noun="devices" preview="side"
        state={!state && reading ? 'loading' : 'ready'} empty={error || (state ? 'No provisioned devices in devices.json.' : 'Reading the field registry…')}
        items={list.map(d => {
          const s = statuses.get(d.id)
          const status = s && typeof s !== 'string' ? statusLines(s)[0] : undefined
          return { id: d.id, label: d.name, detail: status || `${d.id} · ${d.kind}`, dot: d.online === true ? 'success' as const : d.online === false ? 'error' as const : 'muted' as const,
            facts: { online: presence(d), seen: d.lastSeen ? relative(new Date(d.lastSeen).toISOString(), Date.now()) : 'unknown' } }
        })}
        columns={[{ id: 'online', head: 'Heartbeat', priority: 1 }, { id: 'seen', head: 'Last seen', format: 'dim', priority: 2 }]}
        order={list.map(d => d.id)} {...optional('selected', selected)} total={list.length}
        subtitle={[{ s: 'muted', t: state ? `Field AI platform: ${state.platformState ?? 'unknown'} · ${state.transport} · read-only status` : 'Read-only status' }]}
        actions={[{ id: 'chat', label: 'New device chat', keys: ['enter'], primary: true }, { id: 'status', label: 'Read status', keys: ['r'] }, { id: 'refresh', label: 'Refresh list', keys: ['shift+r'] }, { id: 'close', label: 'Close', keys: ['esc'], end: true }]}
        onAction={{ chat, close: () => host.close(overlay), refresh: () => void read(), status: () => loadStatus(d, true) }}
        onSelect={ev => { selected = ev.item; host.changed() }} onActivate={ev => { selected = ev.item; chat() }}>
        {d ? <col key="detail" gap="md">
          <text key="device" text={`${d.name} · ${d.id}`} wrap="word" />
          <text key="topic" text={d.topic ? `Telegram thread ${d.topic.threadId}: ${d.topic.name ?? ''}` : 'No Telegram topic mapped.'} wrap="word" />
          <text key="heartbeat" text={`${presence(d)}${d.fw ? ` · fw ${d.fw}` : ''}${d.ssid ? ` · ${d.ssid}` : ''}${d.rssi !== null ? ` · ${d.rssi} dBm` : ''}`} wrap="word" />
          {!state?.adapter ? <text key="adapter" text="No in-memory fieldai heartbeat data; use Read status for a live query." wrap="word" /> : null}
          {s === null ? <text key="loading" text="Reading ESP / STM32 / RF status (up to 25 s)…" /> : typeof s === 'string' ? <text key="error" text={s} tone="error" wrap="word" /> : s ? <col key="status" gap="sm">
            <text key="answer" text={answered(s) ? 'Live status reply' : 'No status reply'} tone={answered(s) ? 'success' : 'warning'} />
            {statusLines(s).map((line, i) => <text key={`line-${i}`} text={line} wrap="word" />)}
            <md key="raw" text={`\`\`\`json\n${JSON.stringify(s.reads, null, 2)}\n\`\`\``} />
          </col> : null}
          <text key="safety" text="This sheet only reads status. Enter opens a separate, device-bound chat with field-device-chat." wrap="word" />
        </col> : null}
      </picker>
    }
  }
  const timer = setInterval(() => void read(), 30_000)
  timer.unref()
  host.open(overlay)
  void read()
}
