// Two small sheets the frontend asks with itself: a form of text fields (a new kanban task, a new
// cron job) and a pick from a short list (where a task moves). Each answers through its callback and
// closes; Esc or Ctrl+C closes it unanswered.

import type { Key, PickerItem } from '@stencil-hq/tern'

import { optional } from '../core/assert.js'
import { Composer } from '../draft/composer.js'
import { isCtrlC } from '../prompts/ask.js'
import { actionsRow } from '../view/ui/button.js'

import type { Overlay, OverlayHost } from './overlay.js'
import { moveSelection } from './search.js'

/** One text field of a form. */
export interface FormField {
  id: string
  label: string
  /** Prefilled text. */
  value?: string
  /** Submitting with it empty says so instead. */
  required?: boolean
}

/** The fields' trimmed values by id, or the label of the first required one left empty. */
export function formValues(fields: readonly FormField[], texts: readonly string[]): { values: Record<string, string> } | { missing: string } {
  const values: Record<string, string> = {}

  for (const [i, f] of fields.entries()) {
    const v = (texts[i] ?? '').trim()

    if (f.required && !v) {
      return { missing: f.label }
    }

    values[f.id] = v
  }

  return { values }
}

/** A sheet of `fields`: Tab or Enter moves to the next one, Enter on the last submits. */
export function formOverlay(
  host: OverlayHost,
  form: { key: string; title: string; detail?: string; fields: readonly FormField[]; submit: string; onSubmit(values: Record<string, string>): void }
): Overlay {
  const key = `form:${form.key}`
  const drafts = form.fields.map(f => {
    const c = new Composer()

    if (f.value) {
      c.set(f.value)
    }

    return c
  })

  let at = 0
  let error = ''

  const submit = () => {
    const r = formValues(
      form.fields,
      drafts.map(d => d.text)
    )

    if ('missing' in r) {
      error = `${r.missing} is required.`
      at = Math.max(0, form.fields.findIndex(f => f.label === r.missing))
      host.changed()

      return
    }

    host.close(overlay)
    form.onSubmit(r.values)
  }

  const overlay: Overlay = {
    key,
    modal: true,
    cancel: () => host.close(overlay),
    focus: id => `${id}.body.${form.fields[at]?.id ?? ''}`,
    node: () => (
      <overlay anchor="bottom" key={key} modal role="omp.overlay.ask" size="md">
        <col gap="md" key="body">
          <md key="question" role="omp.ask.question" text={form.title} />
          {form.detail ? <text key="detail" spans={[{ s: 'muted', t: form.detail }]} wrap="word" /> : null}
          {form.fields.map((f, i) => (
            <input
              cursor={drafts[i]?.cursor ?? 0}
              key={f.id}
              onEdit={ev => {
                at = i
                drafts[i]?.edit(ev)
                host.changed()
              }}
              onFocus={() => {
                at = i
                host.changed()
              }}
              placeholder={f.required ? f.label : `${f.label} (optional)`}
              role="omp.ask.input"
              text={drafts[i]?.text ?? ''}
            />
          ))}
          {error ? <text key="error" spans={[{ s: 'error', t: error }]} /> : null}
          {actionsRow([
            { hint: 'escape', key: 'cancel', keys: ['escape'], label: 'Cancel', onClick: () => host.close(overlay) },
            { hint: 'enter', key: 'ok', keys: ['enter'], kind: 'primary', label: form.submit, onClick: submit }
          ])}
        </col>
      </overlay>
    ),
    onKey: (k: Key) => {
      if (k.name === 'escape' || isCtrlC(k)) {
        host.close(overlay)
      } else if (k.name === 'tab') {
        at = (at + (k.shift ? form.fields.length - 1 : 1)) % form.fields.length
      } else if (k.name === 'enter' && !k.shift && !k.alt && at < form.fields.length - 1) {
        at += 1
      } else if (k.name === 'enter' && !k.shift && !k.alt) {
        submit()
      } else if (k.name !== 'up' && k.name !== 'down') {
        drafts[at]?.key(k)
        error = ''
      }

      return true
    }
  }

  return overlay
}

/** One choice of a pick. */
export interface Choice {
  id: string
  label: string
  detail?: string
}

/** A pick from `choices`: arrows move, Enter (or a click) chooses. */
export function choiceOverlay(
  host: OverlayHost,
  ask: { key: string; title: string; subtitle?: string; choices: readonly Choice[]; onChoose(id: string): void }
): Overlay {
  const key = `choice:${ask.key}`
  const ids = ask.choices.map(c => c.id)
  let selected = ids[0]

  const choose = (id: string | undefined) => {
    if (id === undefined || !ids.includes(id)) {
      return
    }

    host.close(overlay)
    ask.onChoose(id)
  }

  const overlay: Overlay = {
    key,
    modal: true,
    cancel: () => host.close(overlay),
    node: () => (
      <picker
        actions={[
          { end: true, id: 'close', keys: ['esc'], label: 'Cancel' },
          { id: 'choose', keys: ['enter'], label: 'Choose', primary: true }
        ]}
        items={ask.choices.map((c): PickerItem => ({ id: c.id, label: c.label, ...optional('detail', c.detail) }))}
        key={key}
        noun="choices"
        onAction={{ choose: () => choose(selected), close: () => host.close(overlay) }}
        onActivate={ev => choose(ev.item)}
        onSelect={ev => {
          selected = ev.item
          host.changed()
        }}
        order={ids}
        preview="none"
        {...optional('selected', selected)}
        size="md"
        {...optional('subtitle', ask.subtitle ? [{ s: 'muted', t: ask.subtitle }] : undefined)}
        title={ask.title}
        total={ids.length}
      />
    ),
    onKey: (k: Key) => {
      if (k.name === 'escape' || isCtrlC(k)) {
        host.close(overlay)
      } else if (k.name === 'enter') {
        choose(selected)
      } else {
        selected = moveSelection(k, ids, selected) ?? selected
      }

      return true
    }
  }

  return overlay
}
