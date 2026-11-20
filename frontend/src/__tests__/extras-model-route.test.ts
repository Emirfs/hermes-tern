// A messaging chat's model route read into session.info (session/route.ts), the fallback chain's
// read and write through `hermes config` (hermes/fallback.ts), and how `/handoff omp` finds tern-bridge.
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { liveSessionId, NO_SESSION, storedSessionId } from '../core/ids.js'
import { addFallback, readFallbacks } from '../hermes/fallback.js'
import { bridgeCommand, ompArgs } from '../messaging/ompHandoff.js'
import { SessionRoute } from '../session/route.js'
import { SessionState } from '../session/state.js'
import { parseJson } from '../wire/json.js'

import { FakeGateway } from './fakes.js'

const ROUTE = 'plugin.hermes-tern.session.route'

function shown(info: Record<string, unknown> | null) {
  const state = new SessionState(() => undefined)
  state.ref = { ...NO_SESSION, live: liveSessionId('s1'), stored: storedSessionId('s1') }
  state.info = info
  return state
}

describe('SessionRoute', () => {
  const telegram = { fast: false, messaging: true, model: 'gpt-6.1-sol', provider: 'openai-codex', reasoning_effort: 'high' }

  it('fills the model a messaging chat runs into session.info, which named none', async () => {
    const gw = new FakeGateway({ replies: { [ROUTE]: () => telegram } })
    const state = shown({ cwd: '/w' })
    const route = new SessionRoute({ gw: gw.client, messagingTab: true, notice: () => undefined, state })

    // The adopt asks at once (the request goes out before the read's first await).
    route.adopted()
    expect(gw.sent(ROUTE)).toEqual([{ session_id: 's1' }])

    await route.read()
    expect(state.info).toMatchObject({ cwd: '/w', model: 'gpt-6.1-sol', provider: 'openai-codex', reasoning_effort: 'high' })
    expect(route.messaging).toBe(true)
  })

  it('reads again after an info without a model (a pick from any viewer), and never for a local session', async () => {
    let model = 'gpt-6.1-sol'
    const gw = new FakeGateway({ replies: { [ROUTE]: () => ({ ...telegram, model }) } })
    const state = shown(null)
    const route = new SessionRoute({ gw: gw.client, messagingTab: true, notice: () => undefined, state })
    await route.read()

    model = 'claude-sonnet-5'
    route.infoChanged(undefined)
    expect(gw.sent(ROUTE)).toHaveLength(2)
    await route.read()
    expect(state.info?.model).toBe('claude-sonnet-5')

    const local = new FakeGateway({ replies: { [ROUTE]: () => ({ messaging: false }) } })
    const localRoute = new SessionRoute({ gw: local.client, messagingTab: false, notice: () => undefined, state: shown({ model: 'm' }) })
    localRoute.adopted()
    localRoute.infoChanged(undefined)
    expect(local.sent(ROUTE)).toEqual([])
  })

  it('says once, in a device tab only, that a plugin without session.route cannot read the model', async () => {
    const notices: string[] = []
    const gw = new FakeGateway({
      replies: {
        [ROUTE]: () => {
          throw new Error('method not found')
        }
      }
    })
    const route = new SessionRoute({ gw: gw.client, messagingTab: true, notice: text => void notices.push(text), state: shown(null) })
    await route.read()
    await route.read()
    expect(notices).toHaveLength(1)

    const quiet: string[] = []
    await new SessionRoute({ gw: gw.client, messagingTab: false, notice: text => void quiet.push(text), state: shown(null) }).read()
    expect(quiet).toEqual([])
  })
})

describe('the fallback chain', () => {
  /** A gateway whose `hermes config get|set fallback_providers` answer from `stored`. */
  function configGateway(stored: { output: string; code?: number }) {
    return new FakeGateway({
      replies: {
        'cli.exec': p => {
          const argv = Array.isArray(p['argv']) ? p['argv'].map(String) : []

          if (argv[1] === 'set') {
            stored.output = argv[3] ?? ''
            stored.code = 0

            return { code: 0, output: '✓ Set fallback_providers' }
          }

          return { code: stored.code ?? 0, output: stored.output }
        }
      }
    })
  }

  it('reads an unset key as an empty chain and appends a route once', async () => {
    const stored = { code: 1, output: 'Config key not set: fallback_providers' }
    const gw = configGateway(stored)

    expect((await readFallbacks({ gw: gw.client })).entries).toEqual([])
    expect(await addFallback({ gw: gw.client }, 'openrouter', 'deepseek/deepseek-chat')).toBe(true)
    expect(await addFallback({ gw: gw.client }, 'openrouter', 'deepseek/deepseek-chat')).toBe(false)
    expect(parseJson(stored.output)).toEqual([{ model: 'deepseek/deepseek-chat', provider: 'openrouter' }])
  })

  it('never writes back a chain whose read masked a credential', async () => {
    const stored = { output: JSON.stringify([{ api_key: '***', base_url: 'http://x', model: 'm', provider: 'custom' }]) }
    const gw = configGateway(stored)

    expect((await readFallbacks({ gw: gw.client })).readOnly).not.toBe('')
    await expect(addFallback({ gw: gw.client }, 'openrouter', 'x')).rejects.toThrow(/credential/)
    expect(gw.sent('cli.exec').some(p => Array.isArray(p['argv']) && p['argv'][1] === 'set')).toBe(false)
  })
})

describe('/handoff omp', () => {
  it('reads the folder and the ask', () => {
    expect(ompArgs(['omp', '--cwd', 'C:/repo', 'fix', 'it'])).toEqual({ cwd: 'C:/repo', note: 'fix it' })
    expect(ompArgs(['omp'])).toEqual({ cwd: undefined, note: '' })
    expect(ompArgs(['omp', '--cwd'])).toBeUndefined()
    expect(ompArgs(['telegram'])).toBeUndefined()
  })

  it('runs the Python script beside the Windows shim, with no shell', () => {
    const bin = join('C:', 'Users', 'u', '.local', 'bin')
    const py = join('C:', 'Python314')
    const script = join(bin, 'tern_bridge.py')
    const files = new Set([script, join(py, 'python.exe')])

    expect(bridgeCommand({ PATH: [py, bin].join(';') }, 'win32', f => files.has(f))).toEqual(['python', script])
    expect(bridgeCommand({ PATH: bin }, 'win32', f => f === script)).toEqual(['py', '-3', script])
    expect(bridgeCommand({ PATH: py }, 'win32', f => files.has(f) && f !== script)).toBeUndefined()
    expect(bridgeCommand({}, 'linux')).toEqual(['tern-bridge'])
  })
})
