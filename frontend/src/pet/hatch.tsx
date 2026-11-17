// Hermes exposes the desktop's generation pipeline headlessly: pet.generate → draft picker →
// pet.hatch → explicit adoption. Both image-provider stages ask before incurring usage. No
// generation runs merely by opening the form, and discarding drafts releases their server token.

import type { CommandHost } from '../commands/local.js'
import { errorText } from '../core/errors.js'
import { formOverlay } from '../overlays/form.js'
import type { Overlay } from '../overlays/overlay.js'
import { confirmOverlay } from '../overlays/prompts.js'
import { actionsRow, button } from '../view/ui/button.js'
import { rpc } from '../wire/rpc.js'

const running = new WeakSet<object>()

export function hatchName(prompt: string): string {
  return prompt.replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim().split(/\s+/).slice(0, 3).join(' ').slice(0, 28) || 'Pet'
}

/** `/hatch [description]`: a form when no description was typed, otherwise a usage confirmation. */
export function openHatch(host: CommandHost, arg: string) {
  if (running.has(host)) return host.transcript.notice('A pet is already generating or hatching in this pane.', 'warning')
  if (!arg.trim()) {
    host.open(formOverlay(host, {
      detail: 'Describe your pet. Generation uses your configured image provider; you will confirm its usage before it starts.',
      fields: [{ id: 'prompt', label: 'Description', required: true }],
      key: 'pet-hatch',
      onSubmit: values => openHatch(host, values['prompt'] ?? ''),
      submit: 'Continue',
      title: 'Hatch a pet'
    }))
    return
  }
  host.open(confirmOverlay(host, {
    confirm: 'Generate drafts',
    detail: `“${arg.trim()}” — generates 3 draft images through your configured image provider and may incur provider charges. Nothing is selected or installed yet.`,
    onConfirm: () => void generate(host, arg.trim()),
    title: 'Generate pet drafts?'
  }))
}

async function generate(host: CommandHost, prompt: string) {
  if (running.has(host)) return
  running.add(host)
  // The two image operations may take minutes, rather than the ordinary short RPC deadline.
  const long = { request: <T,>(method: string, params: Record<string, unknown>) => host.gw.request<T>(method, params, 900_000) }
  try {
    const status = await rpc(host.gw, 'pet.generate.status', {})
    if (!status.available) throw new Error('No reference-capable image provider is configured. Configure one in Hermes before using /hatch.')
    host.transcript.notice('Generating three pet drafts…')
    host.changed()
    const result = await rpc(long, 'pet.generate', { count: 3, prompt, style: 'auto' })
    if (!result.ok || !result.token || !result.drafts.length) throw new Error('The image provider returned no pet drafts.')
    const drafts = result.drafts.map(d => ({ blob: host.pet.preview(d.dataUri), index: d.index }))
    let selected = false
    const release = () => void rpc(host.gw, 'pet.cancel', { token: result.token }).catch((e: unknown) => {
      host.transcript.notice(`Could not release pet drafts: ${errorText(e)}`, 'warning')
      host.changed()
    })
    const pick = (index: number) => {
      selected = true
      host.close(overlay)
      let hatching = false
      const ask = confirmOverlay(host, {
        confirm: 'Hatch',
        detail: 'Draws the full animated spritesheet through your image provider (additional provider usage). The pet is installed but not selected until you adopt it.',
        onConfirm: () => {
          hatching = true
          void hatch(host, result.token, index, prompt)
        },
        title: `Hatch ${hatchName(prompt)}?`
      })
      // The sheet closes itself (this exact object) before its onConfirm runs: decide after this
      // turn whether it was declined, and release the drafts' token then.
      ask.onClose = () => queueMicrotask(() => { if (!hatching) release() })
      host.open(ask)
    }
    const overlay: Overlay = {
      cancel: () => host.close(overlay),
      key: 'pet-drafts',
      modal: true,
      node: () => (
        <overlay anchor="center" head="Choose a pet draft" key="pet-drafts" modal size="lg">
          <col gap="md" key="body">
            <text key="prompt" text={prompt} wrap="word" />
            <row gap="md" key="drafts" wrap>
              {drafts.map((d, i) => (
                <col gap="sm" key={d.index}>
                  <image alt={`Pet draft ${i + 1}`} blob={d.blob} h={180} key="image" w={180} />
                  {button({ key: 'pick', label: `Hatch draft ${i + 1}`, onClick: () => pick(d.index) })}
                </col>
              ))}
            </row>
            {actionsRow([{ key: 'cancel', label: 'Discard drafts', onClick: () => host.close(overlay) }])}
          </col>
        </overlay>
      ),
      onClose: () => { if (!selected) release() },
      onKey: key => {
        if (key.name === 'escape') host.close(overlay)
        else {
          const draft = drafts[Number(key.name) - 1]
          if (draft) pick(draft.index)
        }
        return true
      }
    }
    host.open(overlay)
  } catch (e) {
    host.transcript.notice(`/hatch failed: ${errorText(e)}`, 'error')
  } finally {
    running.delete(host)
    host.changed()
  }
}

async function hatch(host: CommandHost, token: string, index: number, prompt: string) {
  if (running.has(host)) return
  running.add(host)
  const long = { request: <T,>(method: string, params: Record<string, unknown>) => host.gw.request<T>(method, params, 900_000) }
  try {
    host.transcript.notice('Hatching the animated pet… This can take several minutes.')
    host.changed()
    const pet = await rpc(long, 'pet.hatch', { index, name: hatchName(prompt), prompt, style: 'auto', token })
    if (!pet.ok || !pet.slug) throw new Error('Hatching returned no installed pet.')
    host.transcript.notice(`Hatched ${pet.displayName} (${pet.slug}). Installed, not selected. Use /pet select ${pet.slug} to adopt it.`)
    host.open(confirmOverlay(host, {
      confirm: 'Adopt',
      detail: `Selects ${pet.slug} as the active pet and enables it beside the composer.`,
      onConfirm: () => void rpc(host.gw, 'pet.select', { slug: pet.slug })
        .then(() => host.pet.refresh())
        .catch((e: unknown) => host.transcript.notice(`Could not adopt the pet: ${errorText(e)}`, 'error'))
        .finally(() => host.changed()),
      title: `Adopt ${pet.displayName}?`
    }))
  } catch (e) {
    host.transcript.notice(`/hatch failed: ${errorText(e)}`, 'error')
  } finally {
    running.delete(host)
    host.changed()
  }
}
