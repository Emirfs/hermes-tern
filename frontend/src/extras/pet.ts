// Pet management through Hermes' own CLI (on the gateway host); the chat's Pet store follows
// pet.changed and refreshes after each command. The installed list uses the local-only gallery
// RPC so it includes the selection even while off. No local Hermes files are read here.

import type { CommandHost, LocalCommand } from '../commands/local.js'
import { errorText } from '../core/errors.js'
import { confirmOverlay } from '../overlays/prompts.js'
import { openHatch } from '../pet/hatch.js'
import { rpc } from '../wire/rpc.js'

import { argWords, hermesExec } from './cli.js'
import { fenced } from './logs.js'

export const PET_USAGE = 'Usage: /pet [list [query] [--installed] [--limit N] | select <slug> | off | scale 0.1–3 | install <slug> [--force] [--select] | remove <slug> | doctor]'

export type PetRequest = { action: 'installed' } | { action: 'cli'; argv: string[]; confirm: boolean } | { error: string }

export function petRequest(arg: string): PetRequest {
  const words = argWords(arg)
  const [action, value, ...rest] = words
  if (!action || action === 'show' && !value) return { action: 'installed' }
  if (action === 'off' || action === 'doctor') {
    return words.length === 1 ? { action: 'cli', argv: ['pets', action], confirm: false } : { error: `${action} takes no arguments.` }
  }
  if (action === 'scale') {
    const scale = Number(value)
    return value && !rest.length && Number.isFinite(scale) && scale >= 0.1 && scale <= 3
      ? { action: 'cli', argv: ['pets', 'scale', String(scale)], confirm: false }
      : { error: 'Pet scale must be a number from 0.1 to 3.' }
  }
  if (action === 'select' || action === 'remove' || action === 'install') {
    if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) return { error: `${action} needs a pet slug (for example boxcat).` }
    if (rest.length && (action !== 'install' || rest.some(v => v !== '--force' && v !== '--select'))) return { error: `Unknown ${action} arguments.` }
    return { action: 'cli', argv: ['pets', action, value, ...rest], confirm: action === 'install' || action === 'remove' }
  }
  if (action === 'list') {
    let query = false
    for (let i = 1; i < words.length; i++) {
      const word = words[i] ?? ''
      if (word === '--installed') continue
      if (word === '--limit') {
        if (!/^\d+$/.test(words[++i] ?? '')) return { error: '--limit takes a nonnegative integer (0 means all).' }
      } else if (!word.startsWith('-') && !query) {
        query = true
      } else return { error: `Unknown list argument “${word}”.` }
    }
    return { action: 'cli', argv: ['pets', ...words], confirm: false }
  }
  // The classic /pet <slug> shorthand, but never hand an unknown option to the CLI.
  if (words.length === 1 && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(action)) {
    return { action: 'cli', argv: ['pets', 'select', action], confirm: false }
  }
  return { error: `Unknown /pet action “${action}”.` }
}

async function installed(host: CommandHost) {
  const r = await rpc(host.gw, 'pet.gallery', { localOnly: true })
  const pets = r.pets?.filter(p => p.installed) ?? []
  const safe = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ')
  host.transcript.panel('Pets', [
    `Selected: **${safe(r.active || 'none')}** · ${r.enabled ? 'on' : 'off'}`,
    '',
    ...(pets.length ? ['| Pet | Slug | |', '| --- | --- | --- |', ...pets.map(p => `| ${safe(p.displayName)} | ${safe(p.slug)} | ${p.slug === r.active ? 'selected' : ''} |`)] : ['No pets installed.']),
    '',
    '`/pet select <slug>` · `/pet off` · `/pet scale 0.5` · `/pet list` browses Petdex · `/pet install <slug>` · `/hatch <description>`'
  ].join('\n'))
  await host.pet.refresh()
}

async function execute(host: CommandHost, argv: string[]) {
  try {
    const r = await hermesExec(host, argv)
    if (r.blocked) host.transcript.notice(r.hint || '`hermes pets` cannot run here.', 'warning')
    else {
      host.transcript.panel(`hermes ${argv.join(' ')}`, fenced(r.output, '(no output)'))
      if (r.code) host.transcript.notice(`\`hermes ${argv.join(' ')}\` exited with code ${r.code}.`, 'warning')
      await host.pet.refresh()
    }
  } catch (e) {
    host.transcript.notice(`/pet failed: ${errorText(e)}`, 'error')
  }
  host.changed()
}

export const PET_COMMANDS: readonly LocalCommand[] = [
  {
    help: 'Installed pets and selection; select <slug>, off, scale <n>, list, install, remove, doctor. The active pet animates beside the composer.',
    name: 'pet',
    run: async (host, arg) => {
      const req = petRequest(arg)
      if ('error' in req) return host.transcript.notice(`${req.error}\n${PET_USAGE}`, 'warning')
      try {
        if (req.action === 'installed') return await installed(host)
        if (!req.confirm) return await execute(host, req.argv)
        const action = req.argv[1]
        host.open(confirmOverlay(host, {
          confirm: action === 'remove' ? 'Remove' : 'Install',
          detail: action === 'remove' ? 'Deletes the installed pet from disk; disables it if selected.' : 'Downloads the pet from the public Petdex gallery. --force replaces an existing install; --select enables it.',
          onConfirm: () => void execute(host, req.argv),
          title: `${action === 'remove' ? 'Remove' : 'Install'} ${req.argv[2]}?`
        }))
      } catch (e) {
        host.transcript.notice(`/pet failed: ${errorText(e)}`, 'error')
      }
    }
  },
  {
    aliases: ['generate-pet'],
    help: 'Generate a pet headlessly: /hatch <description> (confirms image-provider usage, choose a draft, hatch, then adopt)',
    name: 'hatch',
    run: openHatch
  }
]
