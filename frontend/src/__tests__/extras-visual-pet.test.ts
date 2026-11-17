import { inflateSync } from 'node:zlib'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { cellFramePng } from '../pet/frames.js'
import { hatchName, openHatch } from '../pet/hatch.js'
import { derivePetState, petActivity } from '../pet/state.js'
import { Pet, type PetHost } from '../pet/store.js'
import type { CommandHost } from '../commands/local.js'
import type { Overlay } from '../overlays/overlay.js'
import { Transcript } from '../transcript/store.js'

import { FakeGateway, key, must, stub } from './fakes.js'

const rgba = [[[255, 0, 0, 255, 0, 0, 255, 128]]]
const idle = { awaitingInput: false, busy: false, reasoning: false, toolRunning: false }

afterEach(() => vi.useRealTimers())

it('encodes top/bottom cell pixels into a valid RGBA PNG without color or alpha loss', () => {
  const result = cellFramePng(rgba)
  const bytes = Buffer.from(result.png)
  expect([result.width, result.height]).toEqual([1, 2])
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(bytes.readUInt32BE(16)).toBe(1)
  expect(bytes.readUInt32BE(20)).toBe(2)
  const length = bytes.readUInt32BE(33)
  expect(bytes.toString('ascii', 37, 41)).toBe('IDAT')
  expect([...inflateSync(bytes.subarray(41, 41 + length))]).toEqual([0, 255, 0, 0, 255, 0, 0, 0, 255, 128])
  expect(() => cellFramePng([[[1, 2]]])).toThrow('invalid RGBA')
})

it('follows Ink/desktop state priority (error, celebrate, complete, waiting, tools, thought, busy, idle)', () => {
  expect(derivePetState(idle)).toBe('idle')
  expect(derivePetState({ ...idle, busy: true })).toBe('run')
  expect(derivePetState({ ...idle, busy: true, reasoning: true })).toBe('review')
  expect(derivePetState({ ...idle, reasoning: true, toolRunning: true })).toBe('run')
  expect(derivePetState({ ...idle, toolRunning: true, awaitingInput: true })).toBe('waiting')
  expect(derivePetState({ ...idle, awaitingInput: true, justCompleted: true })).toBe('wave')
  expect(derivePetState({ ...idle, justCompleted: true, celebrate: true })).toBe('jump')
  expect(derivePetState({ ...idle, celebrate: true, error: true })).toBe('failed')
})

it('reads live reasoning, but never drives a resumed finished thought as working', () => {
  const transcript = new Transcript()
  const turn = transcript.messageStart()
  turn.blocks.push({ id: turn.id, kind: 'thinking', startedAt: 1, text: 'thinking' })
  expect(petActivity(turn, true, false).reasoning).toBe(true)
  turn.end = { status: 'done' }
  expect(petActivity(turn, false, false).reasoning).toBe(false)
})

describe('Pet store', () => {
  function setup(enabled = true) {
    const gw = new FakeGateway({ replies: {
      'pet.info.meta': () => ({ displayName: 'Boxcat', enabled, scale: 0.33, slug: 'boxcat', spritesheetRevision: 'r1' }),
      'pet.cells': () => ({ enabled: true, frameMs: 180, frames: [rgba, [[[0, 255, 0, 255, 0, 0, 0, 0]]]] })
    } })
    let id = 0
    const host: PetHost = { blob: vi.fn(() => `blob${++id}`), changed: vi.fn(), frame: vi.fn(), gw: gw.client, notice: vi.fn() }
    return { gw, host, pet: new Pet(host) }
  }
  it('uploads once per state and ticks only the image prop; hiding/reduced-motion/off stop all ticks', async () => {
    vi.useFakeTimers()
    const a = setup()
    await a.pet.refresh()
    expect(a.pet.view).toMatchObject({ blob: 'blob1', name: 'Boxcat', state: 'idle' })
    expect(a.gw.sent('pet.cells')).toEqual([{ cols: 63, graphics: false, state: 'idle', terminal: 'unicode' }])
    await vi.advanceTimersByTimeAsync(180)
    expect(a.host.frame).toHaveBeenLastCalledWith('blob2')
    expect(a.host.blob).toHaveBeenCalledTimes(2)
    a.pet.visible(false)
    const count = vi.mocked(a.host.frame).mock.calls.length
    await vi.advanceTimersByTimeAsync(3600)
    expect(a.host.frame).toHaveBeenCalledTimes(count)
    a.pet.visible(true)
    a.pet.reduceMotion(true)
    await vi.advanceTimersByTimeAsync(3600)
    expect(a.host.frame).toHaveBeenCalledTimes(count)
    a.pet.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does no frame requests, polls or timers while off; a pet.changed event enables it', async () => {
    vi.useFakeTimers()
    const a = setup(false)
    await a.pet.refresh()
    await vi.advanceTimersByTimeAsync(10000)
    expect(a.gw.sent('pet.cells')).toEqual([])
    expect(a.gw.sent('pet.info.meta')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    a.gw.handlers.set('pet.info.meta', () => ({ enabled: true, slug: 'boxcat', scale: 0.33 }))
    a.gw.event({ type: 'pet.changed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(a.pet.view?.name).toBe('boxcat')
    a.pet.dispose()
  })
  it('loads another state only once and reuses it on a later turn', async () => {
    vi.useFakeTimers()
    const a = setup()
    await a.pet.refresh()
    a.pet.activity({ ...idle, reasoning: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(a.pet.view?.state).toBe('review')
    a.pet.activity(idle)
    a.pet.activity({ ...idle, reasoning: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(a.gw.sent('pet.cells').map(p => p['state'])).toEqual(['idle', 'review'])
    a.pet.dispose()
  })
})

it('opens a description form and asks before any paid image generation', async () => {
  const gw = new FakeGateway({ replies: { 'pet.generate.status': () => ({ available: false, providers: [] }) } })
  const overlays: Overlay[] = []
  const notice = vi.fn()
  const host = stub<CommandHost>({ changed: vi.fn(), close: () => overlays.shift(), gw: gw.client, open: (o: Overlay) => overlays.push(o), transcript: { notice } })
  openHatch(host, '')
  expect(must(overlays[0]).key).toBe('form:pet-hatch')
  expect(gw.calls).toHaveLength(0)
  overlays.length = 0
  openHatch(host, 'a tiny field engineer cat')
  expect(gw.calls).toHaveLength(0)
  must(overlays[0]).onKey(key('enter'))
  await vi.waitFor(() => expect(notice).toHaveBeenCalledWith(expect.stringContaining('No reference-capable'), 'error'))
  expect(gw.sent('pet.generate')).toHaveLength(0)
  expect(hatchName('a tiny field engineer cat')).toBe('a tiny field')
})

describe('hatch drafts', () => {
  const png = `data:image/png;base64,${Buffer.from(cellFramePng(rgba).png).toString('base64')}`

  async function drafts(pick = true) {
    const gw = new FakeGateway({ replies: {
      'pet.generate': () => ({ drafts: [{ dataUri: png, index: 0 }, { dataUri: png, index: 1 }], ok: true, token: 'tok1' }),
      'pet.generate.status': () => ({ available: true, providers: [] }),
      'pet.hatch': () => ({ displayName: 'Tiny', ok: true, pet: {}, slug: 'tiny' })
    } })
    const overlays: Overlay[] = []
    const host = stub<CommandHost>({
      changed: vi.fn(),
      close: (o: Overlay) => {
        const i = overlays.indexOf(o)
        if (i >= 0) {
          overlays.splice(i, 1)
          o.onClose?.()
        }
      },
      gw: gw.client,
      open: (o: Overlay) => overlays.push(o),
      pet: { preview: () => 'draft-blob', refresh: vi.fn(async () => undefined) },
      transcript: { notice: vi.fn() }
    })
    openHatch(host, 'tiny cat')
    must(overlays[0]).onKey(key('enter'))
    await vi.waitFor(() => expect(overlays.at(-1)?.key).toBe('pet-drafts'))
    if (pick) {
      must(overlays.at(-1)).onKey(key('2'))
      expect(overlays.at(-1)?.key).toBe('confirm:Hatch tiny cat?')
    }
    return { gw, overlays }
  }

  it('releases the drafts token when the hatch confirmation is declined, without hatching', async () => {
    const { gw, overlays } = await drafts()
    expect(gw.sent('pet.cancel')).toEqual([])
    must(overlays.at(-1)).onKey(key('escape'))
    await vi.waitFor(() => expect(gw.sent('pet.cancel')).toEqual([{ token: 'tok1' }]))
    expect(gw.sent('pet.hatch')).toEqual([])
  })

  it('hatches the picked draft on confirm and keeps the token for it', async () => {
    const { gw, overlays } = await drafts()
    must(overlays.at(-1)).onKey(key('enter'))
    await vi.waitFor(() => expect(gw.sent('pet.hatch')).toEqual([{ index: 1, name: 'tiny cat', prompt: 'tiny cat', style: 'auto', token: 'tok1' }]))
    await Promise.resolve()
    expect(gw.sent('pet.cancel')).toEqual([])
  })

  it('releases the drafts token when the drafts are discarded from the picker', async () => {
    const { gw, overlays } = await drafts(false)
    must(overlays.at(-1)).onKey(key('escape'))
    expect(overlays).toEqual([])
    await vi.waitFor(() => expect(gw.sent('pet.cancel')).toEqual([{ token: 'tok1' }]))
    expect(gw.sent('pet.hatch')).toEqual([])
  })
})
