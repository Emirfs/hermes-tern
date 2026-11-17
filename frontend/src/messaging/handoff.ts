// /handoff <platform>: hands this session to a messaging platform's home channel, as Desktop's /handoff
// does (use-prompt-actions `handoffSession`). The gateway's `handoff.request` only writes the request;
// the messaging gateway's watcher claims it, repoints the platform's home chat at this session and runs
// its first turn there. The pane polls `handoff.state` until it completes or fails, and after a minute
// withdraws a request nobody claimed (`handoff.fail`, which loses to a watcher that claimed it meanwhile).

import { setTimeout as sleep } from 'node:timers/promises'

import { errorText } from '../core/errors.js'
import { type Requester, rpc } from '../wire/rpc.js'

export const HANDOFF_USAGE = 'Usage: /handoff <platform>, e.g. /handoff telegram. The session continues in that platform\'s home channel (set one there with /sethome).'
/** How often the request is polled, and how long the pane waits for the watcher. */
export const POLL_MS = 800
export const DEADLINE_MS = 60_000

const PLATFORM = /^[a-z][a-z0-9_]*$/

/** `/handoff <platform>`'s platform, lowercased; undefined when the argument is not one name. */
export function handoffPlatform(arg: string): string | undefined {
  const p = arg.trim().toLowerCase()

  return PLATFORM.test(p) ? p : undefined
}

/** How a handoff ended. */
export type HandoffOutcome =
  | { ok: true; home: string }
  | { ok: false; error: string; timedOut?: boolean }

/** What a handoff waits with: the clock and a pause (tests pass their own). */
export interface HandoffClock {
  now(): number
  sleep(ms: number): Promise<void>
}

const realClock: HandoffClock = { now: () => Date.now(), sleep: ms => sleep(ms) }

/** Requests the handoff of session `sid` to `platform` and waits for the watcher's verdict. */
export async function handOff(
  gw: Requester,
  sid: string,
  platform: string,
  onState: (state: string) => void = () => undefined,
  clock: HandoffClock = realClock
): Promise<HandoffOutcome> {
  let home: string

  try {
    const r = await rpc(gw, 'handoff.request', { platform, session_id: sid })
    home = r.home_name || platform
  } catch (error) {
    return { error: errorText(error), ok: false }
  }

  onState('pending')
  const deadline = clock.now() + DEADLINE_MS
  let last = 'pending'

  while (clock.now() < deadline) {
    await clock.sleep(POLL_MS)

    let state: string
    let error = ''

    try {
      const r = await rpc(gw, 'handoff.state', { session_id: sid })
      state = r.state || 'pending'
      error = r.error
    } catch {
      // A dropped poll (the gateway busy) is retried on the next tick.
      continue
    }

    if (state !== last) {
      last = state
      onState(state)
    }

    if (state === 'completed') {
      return { home, ok: true }
    }

    if (state === 'failed') {
      return { error: error || `the handoff to ${platform} failed`, ok: false }
    }
  }

  const timedOut = `nothing picked the handoff up within ${DEADLINE_MS / 1000}s; is the messaging gateway running with ${platform} connected? (/platforms)`

  try {
    const r = await rpc(gw, 'handoff.fail', { error: timedOut, session_id: sid })

    if (r.state === 'completed') {
      return { home, ok: true }
    }
  } catch {
    // The withdrawal failed too: the request may still be claimed later; say what we know.
  }

  return { error: timedOut, ok: false, timedOut: true }
}
