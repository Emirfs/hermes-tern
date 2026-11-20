// /handoff omp: hands this conversation to an omp coding agent in a new Tern tab. The conversation so
// far (and, in a device tab, which box it is) goes into a Markdown file under the plugin's data folder,
// and `tern-bridge omp` (the Tern plugin hermes-bridge's queue) starts an omp agent whose first prompt
// points at that file. The Hermes session stays as it was: nothing is sent to its chat or its box.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { LaunchDevice } from '../config/env.js'

export const OMP_USAGE = 'Usage: /handoff omp [--cwd DIR] [what omp should do]'
/** How long `tern-bridge --wait` waits for the Tern plugin to start the agent. */
const WAIT_S = 20

/** What the handoff carries over. */
export interface OmpHandoff {
  /** The Hermes session (its stored id) and title. */
  readonly session: string
  readonly title: string
  readonly model: string
  readonly device: LaunchDevice | undefined
  /** The conversation as `/history` writes it. */
  readonly history: string
  /** What the user asked omp to do ('' when nothing). */
  readonly note: string
}

/** `/handoff omp [--cwd DIR] [note…]`'s folder and note; undefined when the argument is not that form. */
export function ompArgs(words: readonly string[]): { cwd: string | undefined; note: string } | undefined {
  if (words[0]?.toLowerCase() !== 'omp') {
    return undefined
  }

  const rest = words.slice(1)

  if (rest[0] === '--cwd') {
    const cwd = rest[1]

    return cwd ? { cwd, note: rest.slice(2).join(' ') } : undefined
  }

  return { cwd: undefined, note: rest.join(' ') }
}

/** The context file omp reads first. */
export function handoffMarkdown(h: OmpHandoff, at: Date): string {
  const device = h.device
    ? [
        `- Field device: **${h.device.name}** (\`${h.device.id}\`${h.device.kind ? `, ${h.device.kind}` : ''}), Telegram topic ${h.device.threadId || '?'}`,
        `- Its live tab: \`tern-bridge esp ${h.device.id}\`; its mission: \`field-ai-box/missions/${h.device.id}.md\``
      ]
    : []

  return [
    `# Handoff from Hermes: ${h.title || h.session}`,
    '',
    `- Handed over: ${at.toISOString()}`,
    `- Hermes session: \`${h.session}\`${h.model ? ` (model ${h.model})` : ''}`,
    ...device,
    '',
    '## What the user asks of you',
    '',
    h.note || '(nothing more: pick up where the conversation stands)',
    '',
    '## Rules',
    '',
    '- No device-writing action (RF transmit, arming, firmware or STM push, provisioning, relay or IR commands, anything that changes a field device) without the user approving that exact action.',
    '- No message sent on the user\'s behalf (Telegram, `hermes send`, …) without approval.',
    '- Ask Hermes what it knows with `hermes -z "…"`; never read its `.env` or `auth*.json`.',
    '',
    '## The conversation so far',
    '',
    h.history
  ].join('\n')
}

/** The first prompt: where the context is, and the ask. */
export function handoffPrompt(file: string, h: Pick<OmpHandoff, 'device' | 'note'>): string {
  const what = h.device ? `Hermes' conversation about the field device ${h.device.name} (${h.device.id})` : 'a Hermes conversation'

  return [
    `You take over ${what}. Read ${file} first: it holds the conversation, the rules and what the user asks.`,
    h.note ? `The ask: ${h.note}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Writes the context under `<data>/handoffs/` and returns its path. */
export async function writeHandoff(data: string, markdown: string, at: Date): Promise<string> {
  const dir = join(data, 'handoffs')
  await mkdir(dir, { recursive: true })
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
  const file = join(dir, `${stamp}-omp.md`)
  await writeFile(file, markdown, 'utf8')

  return file
}

/**
 * How to run `tern-bridge`: on Windows its `.cmd` shim needs a shell, so the Python script beside the
 * shim runs directly (no shell quoting of the folder); elsewhere the command itself.
 */
export function bridgeCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (path: string) => boolean = existsSync): readonly [string, ...string[]] | undefined {
  if (platform !== 'win32') {
    return ['tern-bridge']
  }

  // The win32 branch reads Windows' PATH whatever the host (the tests run it anywhere).
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(';').filter(Boolean)
  const script = dirs.map(d => join(d, 'tern_bridge.py')).find(exists)

  if (!script) {
    return undefined
  }

  const python = dirs.some(d => exists(join(d, 'python.exe'))) ? 'python' : 'py'

  return python === 'py' ? ['py', '-3', script] : ['python', script]
}

/** Runs `tern-bridge omp --from hermes --cwd <cwd> --wait N -` with `prompt` on stdin; resolves its outcome. */
export function startOmp(
  command: readonly [string, ...string[]],
  cwd: string,
  prompt: string
): Promise<{ ok: boolean; output: string }> {
  const [file, ...args] = command
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; output: string }>()
  const child = execFile(
    file,
    [...args, 'omp', '--from', 'hermes', '--cwd', cwd, '--wait', String(WAIT_S), '-'],
    // The prompt is UTF-8 on stdin: Python on Windows reads its console code page otherwise.
    { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: (WAIT_S + 15) * 1000, windowsHide: true },
    (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}`.trim() || (error ? error.message : '') })
  )
  child.stdin?.end(prompt)

  return promise
}
