// The model route of a messaging chat (a Telegram topic, a device tab's box). The shared gateway's
// session.info names no model for one, and model.options answers config.yaml's default instead of the
// chat's channel_overrides entry or its own /model pick, so the composer's chip was empty and the
// picker checked a model the chat does not run. The plugin's `session.route` (backend/gateway/routes.py)
// answers what the chat's next turn resolves; this store reads it into session.info on each adopt that
// left the model unknown, and again after each session.info of a messaging chat (a pick from any viewer,
// a /model in the chat itself publishes one).

import * as z from 'zod/mini'

import { optional } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import type { NoticeEntry } from '../model.js'
import type { Requester } from '../wire/rpc.js'
import { loose } from '../wire/schemas.js'

import type { SessionState } from './state.js'

export const ROUTE_METHOD = 'plugin.hermes-tern.session.route'

const routeResult = z.object({
  messaging: z.boolean(),
  model: loose(z.string()),
  provider: loose(z.string()),
  reasoning_effort: loose(z.string()),
  reasoning_effort_wire: loose(z.string()),
  service_tier: loose(z.string()),
  fast: loose(z.boolean())
})

/** What the route store reaches of the app. */
export interface RouteHost {
  readonly gw: Pick<Requester, 'request'>
  readonly state: Pick<SessionState, 'info' | 'ticket'>
  /** This pane shows a messaging chat for sure (a device tab): a failed read is worth a line. */
  readonly messagingTab: boolean
  notice(text: string, tone: NoticeEntry['tone']): void
}

export class SessionRoute {
  readonly #host: RouteHost
  /** The shown session is a messaging chat: its session.info never carries the model. */
  #messaging = false
  /** A failed read was reported once: an older plugin without the method stays one line. */
  #warned = false
  /** The read in flight; `#again` asks it for one more pass (the idle fanout sends many infos). */
  #pending: Promise<void> | undefined
  #again = false

  constructor(host: RouteHost) {
    this.#host = host
  }

  get messaging(): boolean {
    return this.#messaging
  }

  /** On adopt: a session whose snapshot named no model is read through the plugin. */
  adopted() {
    this.#messaging = false

    if (!this.#host.state.info?.model) {
      void this.read()
    }
  }

  /** After a session.info: a messaging chat's route may have moved (a pick, the chat's own /model). */
  infoChanged(payloadModel: string | undefined) {
    if (this.#messaging && !payloadModel) {
      void this.read()
    }
  }

  /** Reads the shown chat's route into session.info; a call during a read joins it, and it reads once more. */
  read(): Promise<void> {
    if (this.#pending) {
      this.#again = true

      return this.#pending
    }

    const run = async () => {
      try {
        do {
          this.#again = false
          await this.#readOnce()
        } while (this.#again)
      } finally {
        this.#pending = undefined
      }
    }

    this.#pending = run()

    return this.#pending
  }

  async #readOnce() {
    const { gw, state } = this.#host
    const ticket = state.ticket()

    if (!ticket.sid) {
      return
    }

    try {
      const r = routeResult.safeParse(await gw.request<unknown>(ROUTE_METHOD, { session_id: ticket.sid }))

      if (!r.success) {
        throw new Error('session.route answered in an unknown shape')
      }

      if (!ticket.isCurrent()) {
        return
      }

      this.#messaging = r.data.messaging

      if (r.data.messaging) {
        const d = r.data
        state.info = {
          ...state.info,
          ...optional('model', d.model),
          ...optional('provider', d.provider),
          ...optional('reasoning_effort', d.reasoning_effort),
          ...optional('reasoning_effort_wire', d.reasoning_effort_wire),
          ...optional('service_tier', d.service_tier),
          ...optional('fast', d.fast)
        }
      }
    } catch (error) {
      // Only a device tab knows its session is a messaging chat; elsewhere a session without a model
      // in its snapshot may be a local one, and the route is not worth a warning.
      if (this.#host.messagingTab && !this.#warned && ticket.isCurrent()) {
        this.#warned = true
        this.#host.notice(
          `This chat's model could not be read (${errorText(error)}). Reload the hermes-tern plugin in the gateway to pick up session.route.`,
          'warning'
        )
      }
    }
  }
}
