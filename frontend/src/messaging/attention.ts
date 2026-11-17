// The status strip's standing line while a messaging platform needs attention (WhatsApp logged out,
// Telegram's token refused): `messaging.status` asked every 30 s, the first time a few seconds after the
// pane starts. A gateway without the method (an older plugin, one not reloaded since this pane's
// version) ends the watch at once: nothing to show, and nothing to ask again.

import type { Requester } from '../wire/rpc.js'

import { attentionText, platformStatus, StatusShapeError } from './platforms.js'

/** How often the platforms are read, and how long after the start the first read waits. */
export const POLL_MS = 30_000
export const FIRST_MS = 3_000

/** Whether `error` says the gateway does not serve the method (JSON-RPC's -32601, or its words). */
export function isMissingMethod(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }

  const code = 'code' in error ? error.code : undefined
  const message = 'message' in error && typeof error.message === 'string' ? error.message : ''

  return code === -32601 || /method not found|unknown method|no such method|unknown_method/i.test(message)
}

/** What the watch reaches of the app. */
export interface AttentionHost {
  readonly gw: Requester
  /** Asks for a render. */
  changed(): void
}

/** The platforms' attention line, kept current by polling until dispose(). */
export class PlatformWatch {
  readonly #host: AttentionHost
  #timer: NodeJS.Timeout | undefined
  #text: string | undefined
  #stopped = false

  constructor(host: AttentionHost, firstMs = FIRST_MS) {
    this.#host = host
    this.#schedule(firstMs)
  }

  /** The line to show, while a platform needs attention. */
  get text(): string | undefined {
    return this.#text
  }

  dispose() {
    this.#stopped = true
    clearTimeout(this.#timer)
  }

  /** One read: the line follows the answer; a missing method or an answer of another shape ends the watch. */
  async poll(): Promise<void> {
    let next: string | undefined

    try {
      next = attentionText((await platformStatus(this.#host.gw)).platforms)

      if (this.#stopped) {
        // The strip was disposed while this read was in flight: its answer belongs to nobody.
        return
      }
    } catch (error) {
      if (isMissingMethod(error) || error instanceof StatusShapeError) {
        // Not a gateway with this plugin's messaging methods: stop asking, show nothing.
        this.dispose()
        return
      }

      // Any other failure (the gateway restarting) keeps the last line until the next read.
      next = this.#text
    }

    if (next !== this.#text) {
      this.#text = next
      this.#host.changed()
    }
  }

  #schedule(ms: number) {
    if (this.#stopped) {
      return
    }

    this.#timer = setTimeout(() => {
      void this.poll().finally(() => this.#schedule(POLL_MS))
    }, ms)
    // The watch alone never keeps the process alive.
    this.#timer.unref()
  }
}
