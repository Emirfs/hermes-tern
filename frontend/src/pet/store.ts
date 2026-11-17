// One pet per chat pane. Selection is read once at gateway.ready, then on pet.changed: no poll
// and no animation timer while off/hidden. Each state's frames are fetched/encoded/uploaded once
// per selection; a tick only swaps the image's blob prop. Reduced motion keeps a static frame.

import type { GatewayClient } from '@hermes/shared/gateway-client'

import { errorText } from '../core/errors.js'
import type { TurnEntry } from '../model.js'
import { rpc } from '../wire/rpc.js'

import { cellFramePng } from './frames.js'
import { derivePetState, type PetActivity, type PetState } from './state.js'

export interface PetView {
  blob: string
  name: string
  state: PetState
  width: number
  height: number
}

interface Frames {
  blobs: string[]
  ms: number
  width: number
  height: number
}

export interface PetHost {
  gw: GatewayClient
  blob(bytes: Uint8Array, mime: string): string | undefined
  changed(): void
  /** Cheap image-only frame update, without rebuilding the transcript. */
  frame(blob: string): void
  notice(text: string): void
}

export class Pet {
  readonly #host: PetHost
  readonly #cache = new Map<PetState, Frames>()
  #name = ''
  #key = ''
  #enabled = false
  #visible = true
  #reduce = false
  #disposed = false
  #state: PetState = 'idle'
  #flash: { state: PetState; until: number } | undefined
  #flashTimer: ReturnType<typeof setTimeout> | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #index = 0
  #scale = 0.33
  #loading = false
  #again = false
  #metaLoading = false
  #metaAgain = false
  #fault = ''
  #lastTurn: string | undefined
  #lastEnd = ''
  view: PetView | undefined

  constructor(host: PetHost) {
    this.#host = host
    host.gw.on('event', (ev: { type: string }) => {
      if (ev.type === 'gateway.ready' || ev.type === 'pet.changed') void this.refresh()
      if (ev.type === 'reaction') this.flash('jump')
    })
  }
  /** A generated draft's PNG/JPEG preview, uploaded once for the native draft picker. */
  preview(dataUri: string): string {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUri)
    if (!match?.[1] || !match[2]) throw new Error('Gateway supplied an invalid pet preview.')
    const blob = this.#host.blob(Buffer.from(match[2], 'base64'), match[1])
    if (!blob) throw new Error('This Tern does not accept image blobs.')
    return blob
  }

  /** Current activity, read when a chat frame is drawn (never on an animation tick). */
  activity(activity: PetActivity, turn?: TurnEntry, todosDone = false) {
    if (!this.#enabled || this.#disposed) return
    if (turn && this.#lastTurn === turn.id && this.#lastEnd === 'live' && turn.end.status !== 'live') {
      this.flash(turn.end.status === 'error' ? 'failed' : todosDone ? 'jump' : 'wave')
    }
    this.#lastTurn = turn?.id
    this.#lastEnd = turn?.end.status ?? ''
    const state = this.#flash && Date.now() < this.#flash.until ? this.#flash.state : derivePetState(activity)
    if (state !== this.#state) {
      this.#state = state
      this.#index = 0
      void this.#load()
    }
  }

  flash(state: PetState) {
    if (!this.#enabled || this.#disposed) return
    this.#flash = { state, until: Date.now() + 1600 }
    clearTimeout(this.#flashTimer)
    this.#flashTimer = setTimeout(() => {
      this.#flash = undefined
      this.#host.changed()
    }, 1600)
    this.#host.changed()
  }

  visible(on: boolean) {
    this.#visible = on
    this.#animate()
    if (on && this.#enabled) void this.#load()
  }

  reduceMotion(on: boolean) {
    this.#reduce = on
    this.#animate()
  }

  async refresh(): Promise<void> {
    if (this.#disposed) return
    if (this.#metaLoading) {
      this.#metaAgain = true
      return
    }
    this.#metaLoading = true
    try {
      const meta = await rpc(this.#host.gw, 'pet.info.meta', {})
      if (this.#disposed) return
      const key = `${meta.slug}:${meta.scale}:${meta.spritesheetRevision}`
      if (!meta.enabled) {
        this.#enabled = false
        this.#key = ''
        this.#cache.clear()
        this.view = undefined
        clearTimeout(this.#flashTimer)
        this.#flash = undefined
        this.#animate()
        this.#host.changed()
        return
      }
      if (key !== this.#key) {
        this.#key = key
        this.#cache.clear()
        this.#index = 0
        this.#name = meta.displayName || meta.slug || 'Pet'
        this.#scale = meta.scale ?? 0.33
      }
      this.#enabled = true
      await this.#load()
    } catch (e) {
      this.#report(e)
    } finally {
      this.#metaLoading = false
      if (this.#metaAgain) {
        this.#metaAgain = false
        void this.refresh()
      }
    }
  }

  async #load() {
    if (!this.#enabled || !this.#visible || this.#disposed) return
    if (this.#cache.has(this.#state)) return this.#show()
    if (this.#loading) {
      this.#again = true
      return
    }
    this.#loading = true
    const key = this.#key
    const state = this.#state
    try {
      // Same scaling as the native sprite, up to 128 px per frame. `pet.cells` returns RGBA pairs,
      // not ANSI: use Tern image blobs, never terminal graphics escapes inside a TSP surface.
      const cols = Math.max(24, Math.min(128, Math.round(192 * this.#scale)))
      const result = await rpc(this.#host.gw, 'pet.cells', { cols, graphics: false, state, terminal: 'unicode' })
      if (this.#disposed || key !== this.#key || !this.#enabled) return
      if (!result.enabled) return this.refresh()
      const frames = result.frames
      if (!frames?.length || typeof frames[0] === 'string') throw new Error('Gateway supplied no RGBA pet frames.')
      const blobs: string[] = []
      let width = 0
      let height = 0
      for (const grid of frames) {
        if (typeof grid === 'string') throw new Error('Unexpected terminal graphics in pet frames.')
        const frame = cellFramePng(grid)
        const blob = this.#host.blob(frame.png, 'image/png')
        if (!blob) throw new Error('This Tern does not accept image blobs.')
        blobs.push(blob)
        width = frame.width
        height = frame.height
      }
      this.#cache.set(state, { blobs, height, ms: Math.max(80, result.frameMs ?? 180), width })
      this.#fault = ''
      this.#show()
    } catch (e) {
      this.#report(e)
    } finally {
      this.#loading = false
      if (this.#again) {
        this.#again = false
        void this.#load()
      }
    }
  }

  #show() {
    const frames = this.#cache.get(this.#state)
    const blob = frames?.blobs[this.#index % frames.blobs.length]
    if (!frames || !blob) return
    this.view = { blob, height: frames.height, name: this.#name, state: this.#state, width: frames.width }
    this.#animate()
    this.#host.changed()
  }

  #animate() {
    clearInterval(this.#timer)
    this.#timer = undefined
    const frames = this.#cache.get(this.#state)
    if (!this.#enabled || !this.#visible || this.#reduce || this.#disposed || !frames || frames.blobs.length < 2) return
    this.#timer = setInterval(() => {
      const blob = frames.blobs[++this.#index % frames.blobs.length]
      if (blob && this.view) {
        this.view.blob = blob
        this.#host.frame(blob)
      }
    }, frames.ms)
  }

  #report(e: unknown) {
    const message = errorText(e)
    if (message !== this.#fault) {
      this.#fault = message
      this.#host.notice(`Pet display: ${message}`)
    }
  }

  dispose() {
    this.#disposed = true
    clearInterval(this.#timer)
    clearTimeout(this.#flashTimer)
    this.#cache.clear()
  }
}
