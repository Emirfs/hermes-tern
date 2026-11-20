// /field and /devices deliberately leave the user's plugin's /saha and /tus alone. /esp opens Tern's ESP
// session: a tab per field box, each its Telegram topic's live chat (extras/device.tsx).

import type { LocalCommand } from '../commands/local.js'
import { launchEnv } from '../config/env.js'
import { errorText } from '../core/errors.js'
import { openField } from '../overlays/field.js'

import { openEspTabs } from './device.js'

const DEVICE_ID = /^[A-Za-z0-9_.-]{1,64}$/

export const FIELD_COMMANDS: readonly LocalCommand[] = [
  {
    aliases: ['devices'],
    help: '[device-id] — field boxes, read-only status, and each box’s live Telegram chat',
    name: 'field',
    run: (host, arg) => {
      const id = arg.trim()

      if (id && !DEVICE_ID.test(id)) {
        host.transcript.notice('Usage: /field [device-id] (or /devices). /saha remains the field lab panel.', 'warning')

        return
      }

      openField(host, id || undefined)
    }
  },
  {
    help: '[device] — the ESP session in Tern: a live Telegram chat tab per field box (opens what is missing)',
    name: 'esp',
    run: async (host, arg) => {
      const focus = arg.trim()

      try {
        const out = await openEspTabs(launchEnv().hermes, focus || undefined)
        host.transcript.notice(out ? `ESP session ready:\n${out}` : 'ESP session ready.', 'success')
      } catch (e) {
        host.transcript.notice(`Could not open the ESP tabs: ${errorText(e)}`, 'error')
      }
    }
  }
]
