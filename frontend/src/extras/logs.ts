// `/logs [name] [-f] [filters]`: Hermes' log files (`hermes logs`). The last lines show in a panel
// (cli.exec on the gateway host); following one (`-f`, or `/logs follow …`) opens a split below the
// chat that runs `hermes logs -f …` until it is closed.

import type { LocalCommand } from '../commands/local.js'
import { errorText } from '../core/errors.js'
import { splitHermes } from '../watch/spec.js'

import { argWords, hermesExec } from './cli.js'

/** The logs `hermes logs` knows, and `list` for the files it has. */
export const LOG_NAMES = ['agent', 'errors', 'gateway', 'gui', 'desktop', 'update', 'handoff', 'list'] as const
const LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR'] as const
const COMPONENTS = ['gateway', 'agent', 'tools', 'cli', 'cron', 'gui'] as const

export const LOGS_USAGE =
  'Usage: /logs [agent|errors|gateway|gui|desktop|update|handoff|list] [-f] [-n LINES] [--level DEBUG|INFO|WARNING|ERROR] [--session ID] [--since 30m|1h|2d] [--component gateway|agent|tools|cli|cron|gui]'

/** A `/logs` argument read: the `hermes logs` argv and whether it follows, or what is wrong with it. */
export type LogsRequest = { argv: string[]; follow: boolean; title: string } | { error: string }

const isOneOf = <T extends string>(list: readonly T[], value: string): value is T => list.some(v => v === value)

/** Reads `/logs`'s argument into `hermes logs` words. */
export function logsRequest(arg: string): LogsRequest {
  const words = argWords(arg)
  let follow = false
  let name: string | undefined
  const flags: string[] = []

  if (words[0] === 'follow' || words[0] === 'tail') {
    follow = true
    words.shift()
  }

  for (let i = 0; i < words.length; i++) {
    const raw = words[i] ?? ''
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1
    const word = eq > 0 ? raw.slice(0, eq) : raw
    const value = () => (eq > 0 ? raw.slice(eq + 1) : (words[++i] ?? ''))

    if (word === '-f' || word === '--follow') {
      follow = true
    } else if (word === '-n' || word === '--lines' || /^\d+$/.test(word)) {
      const n = /^\d+$/.test(word) ? word : value()

      if (!/^\d+$/.test(n) || Number(n) < 1) {
        return { error: `-n takes a number of lines, not “${n}”.` }
      }

      flags.push('-n', n)
    } else if (word === '--level') {
      const level = value().toUpperCase()

      if (!isOneOf(LEVELS, level)) {
        return { error: `--level is one of ${LEVELS.join(', ')}.` }
      }

      flags.push('--level', level)
    } else if (word === '--session') {
      const id = value()

      if (!id) {
        return { error: '--session takes a session id (or part of one).' }
      }

      flags.push('--session', id)
    } else if (word === '--since') {
      const since = value()

      if (!/^\d+[smhd]$/.test(since)) {
        return { error: `--since takes a time like 30m, 1h or 2d, not “${since}”.` }
      }

      flags.push('--since', since)
    } else if (word === '--component') {
      const component = value()

      if (!isOneOf(COMPONENTS, component)) {
        return { error: `--component is one of ${COMPONENTS.join(', ')}.` }
      }

      flags.push('--component', component)
    } else if (!word.startsWith('-') && !name && isOneOf(LOG_NAMES, word)) {
      name = word
    } else {
      return { error: `Unknown /logs argument “${raw}”.` }
    }
  }

  if (name === 'list' && (follow || flags.length)) {
    return { error: '/logs list takes no other arguments.' }
  }

  const argv = ['logs', ...(name ? [name] : []), ...flags, ...(follow ? ['-f'] : [])]

  return { argv, follow, title: `hermes ${argv.join(' ')}` }
}

/** A command's output as a panel's body: a plain code block, so its lines are not read as Markdown. */
export function fenced(output: string, empty = '(no lines)'): string {
  const fence = '`'.repeat(Math.max(3, ...[...output.matchAll(/`{3,}/g)].map(m => m[0].length + 1)))

  return output.trim() ? `${fence}text\n${output.trim()}\n${fence}` : empty
}

export const LOGS_COMMANDS: readonly LocalCommand[] = [
  {
    help: 'Hermes logs: the last lines in a panel; -f follows one in a split below (agent, errors, gateway, … or list)',
    name: 'logs',
    run: async (host, arg) => {
      const req = logsRequest(arg)

      if ('error' in req) {
        return host.transcript.notice(`${req.error}\n${LOGS_USAGE}`, 'warning')
      }

      if (req.follow) {
        const split = await splitHermes(req.argv, host.session.info?.cwd || process.cwd())

        return split.opened
          ? host.transcript.notice(`Following \`${req.title}\` in the split below. Close it (or press Ctrl+C there) to stop.`)
          : host.transcript.notice(`Could not open a split for \`${req.title}\`: ${split.reason}. Run it in a terminal instead.`, 'warning')
      }

      try {
        const r = await hermesExec(host, req.argv)

        if (r.blocked) {
          return host.transcript.notice(r.hint || `\`${req.title}\` cannot run here.`, 'warning')
        }

        host.transcript.panel(req.title, fenced(r.output))

        if (r.code) {
          host.transcript.notice(`\`${req.title}\` exited with code ${r.code}.`, 'warning')
        }
      } catch (e) {
        host.transcript.notice(`/logs failed: ${errorText(e)}`, 'error')
      }
    }
  }
]
