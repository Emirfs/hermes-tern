// `/fallback`: the profile's fallback chain (config.yaml `fallback_providers`, tried in order when the
// primary model fails), in a sheet: N adds one through the model picker, D removes the selected one,
// X clears the chain (both ask first), C runs `hermes fallback check`. The chain is the profile's, for
// every session and chat: Hermes has no per-chat chain. hermes/fallback.ts reads and writes it.
//
//   /fallback [list]        the sheet
//   /fallback add           the model picker, adding instead of switching
//   /fallback remove <n>    remove entry n (1-based), after asking
//   /fallback clear         empty the chain, after asking
//   /fallback check         whether each entry can serve (`hermes fallback check`)

import type { JSX, Key, PickerItem } from '@stencil-hq/tern'

import type { CommandHost, LocalCommand } from '../commands/local.js'
import { optional } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import { entryLabel, type FallbackChain, readFallbacks, writeFallbacks } from '../hermes/fallback.js'
import { openModelPicker } from '../overlays/models.js'
import type { Overlay } from '../overlays/overlay.js'
import { confirmOverlay } from '../overlays/prompts.js'
import { moveSelection } from '../overlays/search.js'
import { reportError } from '../overlays/sheet.js'

import { argWords, cliPanel, hermesExec } from './cli.js'

const USAGE = 'Usage: /fallback [list|add|remove <n>|clear|check]'
const KEY = 'fallback'

/** Asks, then removes entry `index` (0-based) of `chain`; `done` runs after the write. */
function confirmRemove(host: CommandHost, chain: FallbackChain, index: number, done: () => void) {
  const entry = chain.entries[index]

  if (!entry) {
    return host.transcript.notice(`The chain has no entry ${index + 1}. ${USAGE}`, 'warning')
  }

  host.open(
    confirmOverlay(host, {
      confirm: 'Remove',
      detail: `${entryLabel(entry)} leaves the profile's fallback chain (every session and chat).`,
      onConfirm: () =>
        void reportError(host.transcript, async () => {
          await writeFallbacks(host, chain, chain.entries.filter((_, i) => i !== index))
          host.transcript.notice(`Removed fallback: ${entryLabel(entry)}.`, 'success')
          done()
        }),
      title: 'Remove this fallback?'
    })
  )
}

/** Asks, then empties the chain; `done` runs after the write. */
function confirmClear(host: CommandHost, chain: FallbackChain, done: () => void) {
  if (!chain.entries.length) {
    return host.transcript.notice('The fallback chain is already empty.')
  }

  host.open(
    confirmOverlay(host, {
      confirm: 'Clear',
      detail: `${chain.entries.length} fallback${chain.entries.length === 1 ? '' : 's'} leave the profile's chain. A failing primary model then fails the turn.`,
      onConfirm: () =>
        void reportError(host.transcript, async () => {
          await writeFallbacks(host, chain, [])
          host.transcript.notice('Fallback chain cleared.', 'success')
          done()
        }),
      title: 'Clear the fallback chain?'
    })
  )
}

/** The sheet: the chain in order, the primary on its subtitle, and `hermes fallback check`'s answer beside it. */
export function openFallbacks(host: CommandHost) {
  let chain: FallbackChain | undefined
  let error = ''
  let reading = false
  let check = ''
  let checking = false
  let selected: string | undefined

  const ids = () => (chain?.entries ?? []).map((_, i) => String(i))

  const read = async () => {
    if (reading) {
      return
    }

    reading = true
    host.changed()

    try {
      chain = await readFallbacks(host)
      error = ''
    } catch (e) {
      error = errorText(e)
    }

    reading = false
    host.changed()
  }

  const runCheck = async () => {
    if (checking) {
      return
    }

    checking = true
    check = ''
    host.changed()

    try {
      const r = await hermesExec(host, ['fallback', 'check'])
      check = r.blocked ? r.hint : r.output || '(no output)'
    } catch (e) {
      check = errorText(e)
    }

    checking = false
    host.changed()
  }

  const reopen = () => {
    host.open(overlay)
    void read()
  }

  const add = () => {
    host.close(overlay)
    openModelPicker(host, { added: reopen, kind: 'fallback' })
  }

  const remove = () => {
    const index = Number(selected)

    if (chain && Number.isInteger(index)) {
      confirmRemove(host, chain, index, () => void read())
    }
  }

  const clear = () => {
    if (chain) {
      confirmClear(host, chain, () => void read())
    }
  }

  const overlay: Overlay = {
    cancel: () => host.close(overlay),
    key: KEY,
    modal: true,
    node: () => {
      const entries = chain?.entries ?? []
      const order = ids()

      if (!selected || !order.includes(selected)) {
        selected = order[0]
      }

      const entry = selected === undefined ? undefined : entries[Number(selected)]
      const info = host.session.info
      const primary = info?.model ? `${info.model}${info.provider ? ` (via ${info.provider})` : ''}` : 'unknown'
      const readOnly = chain?.readOnly ?? ''
      const detail: JSX.Element[] = [
        ...(entry ? [<text key="entry" text={entryLabel(entry)} wrap="word" />] : []),
        ...(readOnly ? [<text key="ro" spans={[{ s: 'warning', t: readOnly }]} wrap="word" />] : []),
        <md
          key="check"
          text={checking ? '_Checking every entry…_' : check ? `### hermes fallback check\n\`\`\`text\n${check}\n\`\`\`` : '_C checks whether each entry can serve._'}
        />
      ]

      return (
        <picker
          actions={[
            { ...optional('disabled', readOnly || undefined), id: 'add', keys: ['n'], label: 'Add…', primary: true },
            { ...optional('disabled', readOnly || (entries.length ? undefined : 'Empty')), id: 'remove', keys: ['d'], label: 'Remove' },
            { ...optional('disabled', readOnly || (entries.length ? undefined : 'Empty')), id: 'clear', keys: ['x'], label: 'Clear' },
            { ...optional('disabled', checking ? 'Checking' : undefined), id: 'check', keys: ['c'], label: 'Check' },
            { id: 'refresh', keys: ['shift+r'], label: 'Refresh' },
            { end: true, id: 'close', keys: ['esc'], label: 'Close' }
          ]}
          empty={error ? `Could not read the chain: ${error}` : chain ? 'No fallback models: a failing primary fails the turn. N adds one.' : 'Reading the chain…'}
          icon="layers"
          items={entries.map((e, i): PickerItem => ({ detail: `via ${e.provider}`, id: String(i), label: `${i + 1}. ${e.model}` }))}
          key={KEY}
          noun="fallbacks"
          onAction={{
            add,
            check: () => void runCheck(),
            clear,
            close: () => host.close(overlay),
            refresh: () => void read(),
            remove
          }}
          onSelect={ev => {
            selected = ev.item
            host.changed()
          }}
          order={order}
          preview="side"
          {...optional('selected', selected)}
          size="lg"
          state={reading && !chain ? 'loading' : 'ready'}
          subtitle={[{ s: 'muted', t: `Primary: ${primary} · profile-wide` }]}
          title="Fallback models"
          total={entries.length}
        >
          {detail}
        </picker>
      )
    },
    onKey: (k: Key) => {
      const writable = Boolean(chain && !chain.readOnly)

      if (k.name === 'escape') {
        host.close(overlay)
      } else if (k.name === 'n' && writable) {
        add()
      } else if (k.name === 'd' && writable) {
        remove()
      } else if (k.name === 'x' && writable) {
        clear()
      } else if (k.name === 'c') {
        void runCheck()
      } else if (k.name === 'r' && k.shift) {
        void read()
      } else {
        selected = moveSelection(k, ids(), selected) ?? selected
      }

      return true
    }
  }

  reopen()
}

async function fallback(host: CommandHost, arg: string) {
  const [verb = 'list', ...rest] = argWords(arg)

  switch (verb.toLowerCase()) {
    case 'list':
    case 'ls':
      return openFallbacks(host)
    case 'add':
      return openModelPicker(host, { added: () => openFallbacks(host), kind: 'fallback' })
    case 'check':
      return cliPanel(host, '/fallback check', ['fallback', 'check'])
    case 'remove':
    case 'rm': {
      const n = Number.parseInt(rest[0] ?? '', 10)

      if (!Number.isInteger(n) || n < 1) {
        return host.transcript.notice(USAGE, 'warning')
      }

      return confirmRemove(host, await readFallbacks(host), n - 1, () => undefined)
    }
    case 'clear':
      return confirmClear(host, await readFallbacks(host), () => undefined)
    default:
      return host.transcript.notice(USAGE, 'warning')
  }
}

export const FALLBACK_COMMANDS: readonly LocalCommand[] = [
  {
    help: '[list|add|remove <n>|clear|check] — the profile’s fallback models, tried in order when the primary fails',
    name: 'fallback',
    run: (host, arg) => reportError(host.transcript, () => fallback(host, arg))
  }
]
