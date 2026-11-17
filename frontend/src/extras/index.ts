// Commands this fork adds beyond upstream hermes-tern: Hermes features the shared gateway refuses
// or that only the Ink TUI / classic CLI had (kanban writes, journey, pets, logs, dashboard, cron and
// plugin management, snapshots), and the messaging side (Telegram/WhatsApp gateway, field devices).
// local.ts puts these ahead of upstream's own, so a name here wins.

import type { LocalCommand } from '../commands/local.js'

import { BOARD_COMMANDS } from './board.js'
import { DASHBOARD_COMMANDS } from './dashboard.js'
import { FIELD_COMMANDS } from './field.js'
import { JOURNEY_COMMANDS } from './journey.js'
import { LOGS_COMMANDS } from './logs.js'
import { MESSAGING_COMMANDS } from './messaging.js'
import { PET_COMMANDS } from './pet.js'

export const EXTRA_COMMANDS: readonly LocalCommand[] = [
  ...BOARD_COMMANDS,
  ...JOURNEY_COMMANDS,
  ...PET_COMMANDS,
  ...LOGS_COMMANDS,
  ...DASHBOARD_COMMANDS,
  ...MESSAGING_COMMANDS,
  ...FIELD_COMMANDS
]
