// Opening a subagent beside the chat: a Tern split running a second `hermes tern` in watch mode
// (and `hermes update` below the chat, for /update).
// `tern split` starts its command in Tern's own environment, so what the watcher needs (the
// profile's home, which agent) travels on its command line: through `env`, or on Windows through a
// small Node launcher (splitProgram).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { readLaunchEnv } from '../config/env.js'
import type { LiveSessionId } from '../core/ids.js'
import type { Subagent } from '../model.js'
import { readWatchSpecText } from '../wire/files.js'

const run = promisify(execFile)

/** The variable carrying a watcher's spec from the launching frontend to the watching one. */
export const WATCH_ENV = 'HERMES_TERN_WATCH'

/** Which agent a watcher shows. */
export interface WatchSpec {
  /** The delegating session's runtime id (for session.transcript, subagent.list / steer / interrupt). */
  sid: LiveSessionId
  subagent: string
  name: string
  goal: string
  index: number
  startedAt: number
}

/** The spec this process was launched to watch; undefined for a chat pane (or a spec it cannot read). */
export function readWatchSpec(env: NodeJS.ProcessEnv = process.env): WatchSpec | undefined {
  return readWatchSpecText(env[WATCH_ENV])
}

export function specOf(a: Subagent, name: string, sid: LiveSessionId): WatchSpec {
  return { goal: a.goal, index: a.index, name, sid, startedAt: a.startedAt, subagent: a.id }
}

/** The one sidebar this pane opened, so a new one replaces it instead of piling up splits. */
let sidebar: string | undefined

/**
 * Runs a split's program on Windows. Tern there starts a split's command through
 * `powershell.exe -c '<words>'`: there is no `env`, and Windows PowerShell 5.1 drops the double
 * quotes inside an argument it hands a program (a JSON spec, say). So the command is this Node
 * with a script free of double quotes and one base64 word holding `{env, argv}`; Node then starts
 * `argv` itself, with `env` over Tern's environment and every argument exactly as given.
 */
export const WINDOWS_LAUNCHER =
  "const p=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));" +
  "const r=require('child_process').spawnSync(p.argv[0],p.argv.slice(1),{stdio:'inherit',env:Object.assign({},process.env,p.env)});" +
  'if(r.error)console.error(r.error.message);process.exit(r.status==null?1:r.status)'

/**
 * `argv` as a split's command line with `vars` set first: `env VAR=… argv…` on macOS and Linux,
 * the Node launcher above on Windows (`node` is the Node that runs it).
 */
export function splitProgram(
  vars: Readonly<Record<string, string>>,
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
  node: string = process.execPath
): string[] {
  if (platform !== 'win32') {
    return ['env', ...Object.entries(vars).map(([name, value]) => `${name}=${value}`), ...argv]
  }

  return [node, '-e', WINDOWS_LAUNCHER, Buffer.from(JSON.stringify({ argv, env: vars }), 'utf8').toString('base64')]
}

/** How a split runs: beside or below this pane, kept open after its program ends, the OS it builds for. */
export interface SplitOptions {
  side?: 'down' | 'right'
  keepOpen?: boolean
  /** Set in the split's environment, after HERMES_HOME. */
  vars?: Readonly<Record<string, string>>
  platform?: NodeJS.Platform
}

/**
 * This pane and `hermes <args>` as a split's command line, `vars` set first. Undefined when this
 * isn't a Tern pane Tern's CLI can reach (over ssh, say) or the launcher named no command for Hermes.
 */
function hermesSplit(env: NodeJS.ProcessEnv, vars: Readonly<Record<string, string>>, args: readonly string[], platform?: NodeJS.Platform) {
  const pane = env['TERN_PANE']
  // The launcher's command for this Hermes (Hermes' own `hermes_command()`).
  const hermes = readLaunchEnv(env).hermes

  if (!pane || !hermes) {
    return undefined
  }

  const home = env['HERMES_HOME']
  const command = splitProgram({ ...(home ? { HERMES_HOME: home } : {}), ...vars }, [...hermes, ...args], platform)

  return { command, pane }
}

/**
 * Opens `spec` in a split right of this pane, closing the sidebar opened before. False when
 * this isn't a Tern pane Tern's CLI can reach (over ssh, say): the caller falls back.
 */
export async function openSidebar(spec: WatchSpec, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const split = hermesSplit(env, { [WATCH_ENV]: JSON.stringify(spec) }, ['tern'])

  if (!split) {
    return false
  }

  if (sidebar) {
    await run('tern', ['close', sidebar]).catch(() => undefined)
    sidebar = undefined
  }

  try {
    const { stdout } = await run('tern', ['split', split.pane, 'right', '--cwd', cwd, '--', ...split.command])
    sidebar = stdout.trim().split(/\s+/).at(-1) || undefined

    return true
  } catch {
    return false
  }
}

/** A split's outcome: the new block's id, or why there is none. */
export type SplitResult = { opened: true; block: string } | { opened: false; reason: string }

/**
 * Runs `hermes <args>` in a split of this pane (below and kept open after it ends, unless
 * `options` says otherwise), so its last lines stay readable.
 */
export async function splitHermes(args: readonly string[], cwd: string, options: SplitOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<SplitResult> {
  const split = hermesSplit(env, options.vars ?? {}, args, options.platform)

  if (!split) {
    return { opened: false, reason: env['TERN_PANE'] ? 'the launcher named no command for Hermes' : 'this is not a Tern pane Tern’s CLI can reach' }
  }

  const keep = options.keepOpen === false ? [] : ['--keep-open']

  try {
    const { stdout } = await run('tern', ['split', split.pane, options.side ?? 'down', '--cwd', cwd, ...keep, '--', ...split.command])

    return { block: stdout.trim().split(/\s+/).at(-1) ?? '', opened: true }
  } catch (e) {
    return { opened: false, reason: e instanceof Error ? e.message.trim() : String(e) }
  }
}

/**
 * Runs `hermes <args>` in a split below this pane (`/update`), kept open after it ends so its
 * last lines stay readable. False when Tern's CLI cannot reach this pane.
 */
export async function openHermesSplit(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform?: NodeJS.Platform
): Promise<boolean> {
  return (await splitHermes(args, cwd, platform ? { platform } : {}, env)).opened
}
