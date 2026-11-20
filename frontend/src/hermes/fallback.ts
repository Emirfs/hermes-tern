// The fallback chain: config.yaml's `fallback_providers`, tried in order when the primary model fails
// (rate limits, overload, connection errors). It is the profile's, for every session and chat; Hermes
// has no per-chat chain. `hermes fallback add|remove|clear` are terminal pickers, so the chain is read
// and written here through `hermes config get|set` (cli.exec); the gateway re-reads it for the next
// turn without a restart (run_config_loaders.py).
//
// The read is masked as `hermes config get` masks it: an entry carrying a credential-shaped field
// (a custom route's api_key) reads masked, and writing the chain back would store the mask. Such a
// chain is read-only here; `hermes fallback remove` in a terminal still edits it.

import * as z from 'zod/mini'

import { type CliHost, hermesExec } from '../extras/cli.js'
import { parseJson } from '../wire/json.js'

/** One entry as config.yaml holds it: provider and model, and whatever else the route needs. */
export type FallbackEntry = Readonly<Record<string, unknown>> & { readonly provider: string; readonly model: string }

/** The chain, and whether this pane may write it back. */
export interface FallbackChain {
  readonly entries: readonly FallbackEntry[]
  /** Why the chain cannot be written from here ('' when it can). */
  readonly readOnly: string
}

const SECRET_FIELD = /key|token|secret|password/i

const entry = z.record(z.string(), z.unknown())
const chain = z.nullable(z.array(entry))

const isEntry = (e: Readonly<Record<string, unknown>>): e is FallbackEntry =>
  typeof e['provider'] === 'string' && typeof e['model'] === 'string'

/** `model (via provider)`, as `hermes fallback list` writes an entry. */
export function entryLabel(e: Pick<FallbackEntry, 'model' | 'provider'>): string {
  return `${e.model} (via ${e.provider})`
}

/** Whether two entries name the same route: provider, model and endpoint. */
export function sameRoute(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  return a['provider'] === b['provider'] && a['model'] === b['model'] && (a['base_url'] ?? '') === (b['base_url'] ?? '')
}

/** Reads the chain (`hermes config get fallback_providers --json`); an unset key is an empty chain. */
export async function readFallbacks(host: Pick<CliHost, 'gw'>): Promise<FallbackChain> {
  const r = await hermesExec(host, ['config', 'get', 'fallback_providers', '--json'])

  if (r.blocked) {
    throw new Error(r.hint || 'hermes config get cannot run here')
  }

  const unset = r.code !== 0 && /not set/i.test(r.output)
  // cli.exec joins stdout and stderr: the document is the first `[` or `{` onward (or a bare `null`).
  const json = r.output.slice(Math.max(0, r.output.search(/[[{]/)))
  const parsed = unset ? { data: [], success: true as const } : chain.safeParse(parseJson(json))

  if (!parsed.success) {
    throw new Error(`hermes config get fallback_providers (exit ${r.code}): ${r.output.slice(0, 400) || 'no output'}`)
  }

  const raw = parsed.data ?? []
  const entries = raw.filter(isEntry)
  const masked = raw.some(e => Object.keys(e).some(k => SECRET_FIELD.test(k)))
  const odd = entries.length !== raw.length

  return {
    entries,
    readOnly: masked
      ? 'An entry carries a credential, which this read masks: edit the chain with `hermes fallback` in a terminal.'
      : odd
        ? 'An entry has no provider or model: fix fallback_providers in config.yaml first.'
        : ''
  }
}

/** Writes `entries` as the whole chain (`hermes config set fallback_providers <json>`). */
export async function writeFallbacks(host: Pick<CliHost, 'gw'>, current: FallbackChain, entries: readonly FallbackEntry[]): Promise<void> {
  if (current.readOnly) {
    throw new Error(current.readOnly)
  }

  const r = await hermesExec(host, ['config', 'set', 'fallback_providers', JSON.stringify(entries)])

  if (r.blocked || r.code) {
    throw new Error(r.hint || r.output || `hermes config set fallback_providers exited ${r.code}`)
  }
}

/** Appends `provider`/`model` to the chain; false when the chain already has that route. */
export async function addFallback(host: Pick<CliHost, 'gw'>, provider: string, model: string): Promise<boolean> {
  const current = await readFallbacks(host)
  const next: FallbackEntry = { model, provider }

  if (current.entries.some(e => sameRoute(e, next))) {
    return false
  }

  await writeFallbacks(host, current, [...current.entries, next])

  return true
}
