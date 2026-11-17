// /field and /devices deliberately leave the user's plugin's /saha and /tus alone.

import type { LocalCommand } from '../commands/local.js'
import { openField } from '../overlays/field.js'

export const FIELD_COMMANDS: readonly LocalCommand[] = [{
  name: 'field', aliases: ['devices'], help: '[device-id] — field boxes, read-only status, and a new device-bound chat',
  run: (host, arg) => {
    const id = arg.trim()
    if (id && !/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
      host.transcript.notice('Usage: /field [device-id] (or /devices). /saha remains the field lab panel.', 'warning')
      return
    }
    openField(host, id || undefined)
  }
}]
