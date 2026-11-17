// `hermes <argv>` run headless on the gateway host through the gateway's `cli.exec` (Python
// `python -m hermes_cli.main`, output captured, 240 s default, 600 s cap). The gateway blocks only
// interactive shapes (`setup`, `gateway …`, `sessions browse`, `config edit`) and answers those
// with a hint instead of running them.

import type { ZodMiniType } from 'zod/mini'

import type { ChatPorts } from '../app/ports.js'
import { parseJson } from '../wire/json.js'
import { rpc } from '../wire/rpc.js'

/** What a `hermes` run reaches of the app. */
export type CliHost = Pick<ChatPorts, 'gw' | 'transcript'>

/** One run's outcome: `blocked` carries the gateway's hint and no output. */
export interface CliRun {
  blocked: boolean
  hint: string
  code: number
  output: string
}

/** Runs `hermes <argv>` on the gateway host and returns its outcome. */
export async function hermesExec(host: Pick<CliHost, 'gw'>, argv: readonly string[], timeout?: number): Promise<CliRun> {
  const r = await rpc(host.gw, 'cli.exec', { argv: [...argv], ...(timeout ? { timeout } : {}) })

  return {
    blocked: Boolean(r?.blocked),
    code: Number(r?.code ?? 0),
    hint: r?.hint ?? '',
    output: (r?.output ?? '').trim()
  }
}

/** Runs `hermes <argv>` and shows its output in a panel titled `title` (hermesExec for the run itself). */
export async function cliPanel(host: CliHost, title: string, argv: readonly string[]): Promise<void> {
  const r = await hermesExec(host, argv)

  if (r.blocked) {
    return host.transcript.notice(r.hint || `\`hermes ${argv.join(' ')}\` cannot run here.`, 'warning')
  }

  host.transcript.panel(title, r.output || '(no output)')

  if (r.code) {
    host.transcript.notice(`\`hermes ${argv.join(' ')}\` exited with code ${r.code}.`, 'warning')
  }
}

/**
 * Runs `hermes <argv>` (a `--json` form) and checks its document against `schema`; throws with the
 * output when it is not JSON or not that shape.
 */
export async function hermesJson<T>(host: Pick<CliHost, 'gw'>, argv: readonly string[], schema: ZodMiniType<T>): Promise<T> {
  const r = await hermesExec(host, argv)

  if (r.blocked) {
    throw new Error(r.hint || `hermes ${argv.join(' ')} cannot run here`)
  }

  // `cli.exec` joins stdout and stderr: the JSON document is the first `{` or `[` onward.
  const start = r.output.search(/[[{]/)
  const parsed = schema.safeParse(start < 0 ? undefined : parseJson(r.output.slice(start)))

  if (!parsed.success) {
    throw new Error(`hermes ${argv.join(' ')} (exit ${r.code}): ${r.output.slice(0, 400) || 'no output'}`)
  }

  return parsed.data
}

/** Splits a command argument into words, honoring "double" and 'single' quotes. */
export function argWords(arg: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g

  for (const m of arg.matchAll(re)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }

  return out
}
