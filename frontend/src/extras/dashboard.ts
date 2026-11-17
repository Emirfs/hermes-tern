// `/dashboard [status|stop] [--port N]`: Hermes' web dashboard (`hermes dashboard`) in a Tern
// browser pane beside the chat. The server runs for as long as it is wanted, so it starts detached
// from this pane (cli.exec would wait for it to end), its output in a log file; the pane opens once
// the server answers. `status` and `stop` are `hermes dashboard --status` / `--stop`.

import { execFile, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { CommandHost, LocalCommand } from '../commands/local.js'
import { readLaunchEnv } from '../config/env.js'
import { dataDir } from '../config/dataDir.js'
import { errorText } from '../core/errors.js'
import { confirmOverlay } from '../overlays/prompts.js'

import { argWords, hermesExec } from './cli.js'
import { fenced } from './logs.js'

export const DEFAULT_PORT = 9119
export const DASHBOARD_USAGE = 'Usage: /dashboard [status | stop] [--port N]'

/** A `/dashboard` argument read. */
export type DashboardRequest = { action: 'open' | 'status' | 'stop'; port: number } | { error: string }

export function dashboardRequest(arg: string): DashboardRequest {
  const words = argWords(arg)
  let action: 'open' | 'status' | 'stop' = 'open'
  let port = DEFAULT_PORT

  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''

    if ((word === 'status' || word === 'stop' || word === 'open') && i === 0) {
      action = word
    } else if (word === '--port' || word.startsWith('--port=')) {
      const value = word.includes('=') ? word.slice('--port='.length) : (words[++i] ?? '')
      port = /^\d+$/.test(value) ? Number(value) : 0

      if (!(port >= 1 && port <= 65_535)) {
        return { error: `--port takes a port number, not “${value}”.` }
      }
    } else {
      return { error: `Unknown /dashboard argument “${word}”.` }
    }
  }

  return { action, port }
}

/** What opening the dashboard reaches outside the app, so tests can stand in for it. */
export interface DashboardDeps {
  /** Whether an HTTP server answers at `url`. */
  answers(url: string): Promise<boolean>
  /** Starts `argv` detached with its output in `log`; resolves its exit code once it ends. */
  start(argv: readonly string[], log: string): { exited: Promise<number | null> }
  /** Shows `url` in a Tern browser block beside this pane; the reason when it cannot. */
  browse(url: string): Promise<string | undefined>
  /** The tail of the server's log, for a start that failed. */
  logTail(log: string): string
  wait(ms: number): Promise<void>
}

/** How long a start may take: the first one builds the web UI. */
const START_MS = 180_000
const POLL_MS = 1000

const DEPS: DashboardDeps = {
  answers: async url => {
    try {
      await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1500) })

      return true
    } catch {
      return false
    }
  },
  browse: url => {
    const { promise, resolve } = Promise.withResolvers<string | undefined>()
    const owner = process.env['TERN_PANE']

    if (!owner) {
      resolve('this is not a Tern pane Tern’s CLI can reach')
    } else {
      execFile('tern', ['browser', JSON.stringify({ how: 'beside', op: 'open', owner, url })], { timeout: 15_000 }, (error, stdout, stderr) =>
        resolve(error ? (stderr || stdout || error.message).trim() : undefined)
      )
    }

    return promise
  },
  logTail: log => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').slice(-15).join('\n')
    } catch {
      return ''
    }
  },
  start: (argv, log) => {
    mkdirSync(dirname(log), { recursive: true })
    const fd = openSync(log, 'w')
    const [file = '', ...args] = argv
    const child = spawn(file, args, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
    closeSync(fd)
    const { promise, resolve } = Promise.withResolvers<number | null>()
    child.once('exit', code => resolve(code))
    child.once('error', () => resolve(null))
    child.unref()

    return { exited: promise }
  },
  wait: ms => {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, ms)

    return promise
  }
}

/** The server's log file. */
export const dashboardLog = (port: number, env: NodeJS.ProcessEnv = process.env) => join(dataDir(env), `dashboard-${port}.log`)

/** Opening the server only appends output and schedules a redraw; it need not own a transcript. */
export interface DashboardHost {
  changed(): void
  transcript: Pick<CommandHost['transcript'], 'notice' | 'panel'>
}

/**
 * Opens the dashboard on `port` beside the chat, starting it first when nothing answers there.
 * `hermes` is the launcher's command for this Hermes.
 */
export async function openDashboard(host: DashboardHost, port: number, hermes: readonly string[] | undefined, deps: DashboardDeps = DEPS) {
  const url = `http://127.0.0.1:${port}/`

  if (!(await deps.answers(url))) {
    if (!hermes) {
      return host.transcript.notice('This pane has no command to start Hermes with; run `hermes dashboard` in a terminal.', 'warning')
    }

    const log = dashboardLog(port)
    const { exited } = deps.start([...hermes, 'dashboard', '--no-open', '--port', String(port)], log)
    let code: number | null | undefined
    void exited.then(c => (code = c))
    host.transcript.notice(`Starting the Hermes dashboard on port ${port}… (its output goes to ${log})`)
    host.changed()

    for (let waited = 0; ; waited += POLL_MS) {
      if (await deps.answers(url)) {
        break
      }

      if (code !== undefined || waited >= START_MS) {
        const tail = deps.logTail(log)
        host.transcript.notice(
          code !== undefined
            ? `\`hermes dashboard\` ended (exit ${code ?? 'unknown'}) before it answered on port ${port}.`
            : `The dashboard did not answer on port ${port} within ${START_MS / 1000} s; it may still be building (see ${log}).`,
          'warning'
        )

        if (tail) {
          host.transcript.panel('hermes dashboard', fenced(tail))
        }

        return
      }

      await deps.wait(POLL_MS)
    }
  }

  const failed = await deps.browse(url)

  host.transcript.notice(
    failed ? `The dashboard runs at ${url}, but Tern could not open it beside the chat (${failed}). Open it in a browser.` : `Opened the Hermes dashboard (${url}) beside the chat.`,
    failed ? 'warning' : 'info'
  )
}

async function status(host: CommandHost) {
  const r = await hermesExec(host, ['dashboard', '--status'])

  if (r.blocked) {
    return host.transcript.notice(r.hint || '`hermes dashboard --status` cannot run here.', 'warning')
  }

  host.transcript.panel('hermes dashboard --status', fenced(r.output, 'No output.'))
  if (r.code) host.transcript.notice(`\`hermes dashboard --status\` exited with code ${r.code}.`, 'warning')
}

function stop(host: CommandHost) {
  const run = async () => {
    try {
      const r = await hermesExec(host, ['dashboard', '--stop'])

      if (r.blocked) {
        host.transcript.notice(r.hint || '`hermes dashboard --stop` cannot run here.', 'warning')
      } else {
        host.transcript.notice(r.output || 'Stopped the dashboard.', r.code ? 'warning' : 'info')
      }
    } catch (e) {
      host.transcript.notice(`/dashboard stop failed: ${errorText(e)}`, 'error')
    }

    host.changed()
  }

  host.open(
    confirmOverlay(host, {
      confirm: 'Stop',
      detail: "Stops this profile's Hermes web dashboard processes (`hermes dashboard --stop`). Browser panes showing it lose their connection.",
      onConfirm: () => void run(),
      title: 'Stop the Hermes dashboard?'
    })
  )
}

export const DASHBOARD_COMMANDS: readonly LocalCommand[] = [
  {
    help: 'The Hermes web dashboard in a browser pane beside the chat, started when it is not running (status, stop, --port N)',
    name: 'dashboard',
    run: async (host, arg) => {
      const req = dashboardRequest(arg)

      if ('error' in req) {
        return host.transcript.notice(`${req.error}\n${DASHBOARD_USAGE}`, 'warning')
      }

      try {
        switch (req.action) {
          case 'open':
            return await openDashboard(host, req.port, readLaunchEnv().hermes)
          case 'status':
            return await status(host)
          case 'stop':
            return stop(host)
        }
      } catch (e) {
        host.transcript.notice(`/dashboard failed: ${errorText(e)}`, 'error')
      }
    }
  }
]
