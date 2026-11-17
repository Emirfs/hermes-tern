// The same states and priority as Hermes' Ink usePet and desktop derivePetState. A paused turn
// waiting on its user outranks reasoning and tools; transient error/celebration/completion beats
// outrank them all. This module knows the chat model, not how a pet is drawn.

import type { TurnEntry } from '../model.js'

export type PetState = 'idle' | 'wave' | 'run' | 'failed' | 'review' | 'jump' | 'waiting'

export interface PetActivity {
  busy: boolean
  awaitingInput: boolean
  toolRunning: boolean
  reasoning: boolean
  error?: boolean
  celebrate?: boolean
  justCompleted?: boolean
}

export function derivePetState(a: PetActivity): PetState {
  if (a.error) return 'failed'
  if (a.celebrate) return 'jump'
  if (a.justCompleted) return 'wave'
  if (a.awaitingInput) return 'waiting'
  if (a.toolRunning) return 'run'
  if (a.reasoning) return 'review'
  return a.busy ? 'run' : 'idle'
}

/** Only live tools/thoughts drive activity; a resumed finished turn must not appear busy. */
export function petActivity(turn: TurnEntry | undefined, busy: boolean, awaitingInput: boolean): PetActivity {
  const blocks = turn?.end.status === 'live' ? turn.blocks : []
  return {
    awaitingInput,
    busy,
    reasoning: blocks.some(b => b.kind === 'thinking' && !b.endedAt),
    toolRunning: blocks.some(b => b.kind === 'tool' && b.call.outcome.kind === 'running')
  }
}
