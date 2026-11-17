// Messaging in the native pane: platform health, confirmed sends and pairing, the inbox and session handoff.

import type { CommandHost, LocalCommand } from '../commands/local.js'
import { errorText } from '../core/errors.js'
import { parsePairing, pairingArgv, parseSend, sendArgv, sendConfirmText, sendTargets, type SendTarget } from '../messaging/cli.js'
import { handOff, handoffPlatform, HANDOFF_USAGE } from '../messaging/handoff.js'
import { openInbox, openPlatforms, openSendTarget } from '../overlays/inbox.js'
import { confirmOverlay } from '../overlays/prompts.js'
import { reportError } from '../overlays/sheet.js'

import { argWords, hermesExec } from './cli.js'

/** The CLI's output kept verbatim (pairing list's table must retain its columns). */
async function output(host: CommandHost, title: string, argv: readonly string[]) {
  const r = await hermesExec(host, argv)
  if (r.blocked) { host.transcript.notice(r.hint, 'warning'); return }
  host.transcript.panel(title, `\`\`\`text\n${r.output || '(no output)'}\n\`\`\``)
  if (r.code) host.transcript.notice(`hermes ${argv.slice(0, 2).join(' ')} exited with code ${r.code}.`, 'error')
  host.changed()
}

function confirmSend(host: CommandHost, to: string, message: string, targets: readonly SendTarget[]) {
  host.open(confirmOverlay(host, {
    title: 'Send this message?', confirm: 'Send', detail: sendConfirmText(to, message, targets),
    onConfirm: () => void reportError(host.transcript, () => output(host, `Send to ${to}`, sendArgv(to, message)))
  }))
}

async function send(host: CommandHost, arg: string) {
  const request = parseSend(arg)
  if ('error' in request) { host.transcript.notice(request.error, 'warning'); return }
  let targets: SendTarget[] = []
  try { targets = await sendTargets(host.gw) }
  catch (e) {
    host.transcript.notice(`Could not read send targets: ${errorText(e)}${request.to ? '' : '. Supply --to <target> explicitly.'}`, 'warning')
    if (!request.to) return
  }
  if (request.to) confirmSend(host, request.to, request.message, targets)
  else if (targets.length) openSendTarget(host, targets, t => confirmSend(host, t.target, request.message, targets))
  else host.transcript.notice('No known targets. Usage: /send --to <platform:chat> <message>', 'warning')
}

async function pairing(host: CommandHost, arg: string) {
  const r = parsePairing(argWords(arg))
  if ('error' in r) { host.transcript.notice(r.error, 'warning'); return }
  const argv = pairingArgv(r)
  if (r.kind === 'list') { await output(host, 'Pairing requests and approved users', argv); return }
  host.open(confirmOverlay(host, {
    title: r.kind === 'approve' ? 'Approve this pairing?' : 'Revoke this user’s access?',
    confirm: r.kind === 'approve' ? 'Approve' : 'Revoke',
    detail: r.kind === 'approve' ? `Platform: ${r.platform}\nRequest ID / code: ${r.code}\nThis grants that user access to Hermes.` : `Platform: ${r.platform}\nUser: ${r.user}\nThis removes that user’s access to Hermes.`,
    onConfirm: () => void reportError(host.transcript, () => output(host, 'Pairing', argv))
  }))
}

async function handoff(host: CommandHost, arg: string) {
  const platform = handoffPlatform(arg)
  if (!platform) { host.transcript.notice(HANDOFF_USAGE, 'warning'); return }
  if (host.busy) { host.transcript.notice('Wait for the current turn to finish before handing it off.', 'warning'); return }
  const sid = host.session.ref.live
  if (!sid) { host.transcript.notice('No current session to hand off.', 'warning'); return }
  // A handoff sends a synthetic first turn to the destination; ask before that leaves this pane.
  host.open(confirmOverlay(host, {
    title: `Hand this session to ${platform}?`, confirm: 'Hand off',
    detail: `The conversation continues in ${platform}’s configured home channel. Hermes sends a first turn there.`,
    onConfirm: () => void reportError(host.transcript, async () => {
      host.transcript.notice(`Handing this session to ${platform}…`); host.changed()
      const r = await handOff(host.gw, sid, platform)
      host.transcript.notice(r.ok ? `Handed off to ${r.home}. Continue there; this pane still shows the conversation.` : `Handoff failed: ${r.error}`, r.ok ? 'success' : 'error')
      host.changed()
    })
  }))
}

const guarded = (run: (host: CommandHost, arg: string) => void | Promise<void>) => (host: CommandHost, arg: string) => reportError(host.transcript, async () => { await run(host, arg) })

export const MESSAGING_COMMANDS: readonly LocalCommand[] = [
  { name: 'platforms', aliases: ['gateway'], help: 'Messaging platform health, errors and relink / token checks', run: guarded((host, arg) => {
    if (arg.trim()) { host.transcript.notice('Usage: /platforms', 'warning'); return }
    openPlatforms(host)
  }) },
  { name: 'send', help: '[--to <target>] <message> — choose a destination and confirm before sending', run: guarded(send) },
  { name: 'inbox', help: 'Messaging conversations, newest first; Enter resumes one here', run: guarded((host, arg) => {
    if (arg.trim()) { host.transcript.notice('Usage: /inbox', 'warning'); return }
    openInbox(host)
  }) },
  { name: 'pairing', help: '[list|approve <platform> <code>|revoke <platform> <user-id>] — approve/revoke ask first', run: guarded(pairing) },
  { name: 'handoff', help: '<platform> — continue this session in its messaging home channel (asks first)', run: guarded(handoff) }
]
