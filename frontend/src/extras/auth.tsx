// Signing in and out of model providers.
//
//   /login                 the Accounts sheet: each provider the gateway knows, signed in or not
//   /login <provider>      `hermes auth add <provider>` in a split below the chat
//   /logout                the Accounts sheet
//   /logout <provider>     after asking, the gateway's `model.disconnect`
//
// A sign-in runs Hermes' own CLI in a terminal: its OAuth device code or browser flow, or its hidden
// prompt for an API key, so no secret passes through this pane or the gateway connection. A sign-out
// removes every credential of the provider (its env keys and OAuth state), as `hermes logout` does.

import type { ModelOptionProvider } from '@hermes/shared/gateway-events'
import type { JSX, Key, PickerItem } from '@stencil-hq/tern'

import type { CommandHost, LocalCommand } from '../commands/local.js'
import { launchEnv } from '../config/env.js'
import { optional } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import { providerDisplayNames } from '../hermes/providers.js'
import type { Overlay } from '../overlays/overlay.js'
import { confirmOverlay } from '../overlays/prompts.js'
import { editQuery, moveSelection } from '../overlays/search.js'
import { reportError } from '../overlays/sheet.js'
import { openHermesSplit } from '../watch/spec.js'
import { rpc } from '../wire/rpc.js'

const PROVIDER = /^[a-z0-9][a-z0-9._-]*$/i
const KEY = 'accounts'

/** `hermes auth add <slug>` in a split below the chat; says what to run when Tern's CLI cannot open one. */
export async function signIn(host: CommandHost, slug: string): Promise<void> {
  const argv = ['auth', 'add', slug]

  if (await openHermesSplit(argv, host.session.info?.cwd || launchEnv().cwd)) {
    return host.transcript.notice(`Signing in to ${slug} in the split below. /login shows the result once it finishes.`)
  }

  host.transcript.notice(`Could not open a Tern split. In a terminal, run: hermes ${argv.join(' ')}`, 'warning')
}

/** Asks, then removes every credential of `slug` (`model.disconnect`); `done` runs after it. */
export function confirmSignOut(host: CommandHost, slug: string, name: string, done: () => void = () => undefined) {
  host.open(
    confirmOverlay(host, {
      confirm: 'Sign out',
      detail: `Every saved credential of ${name} (OAuth sign-ins and API keys) is removed. Sessions and chats that run on ${name}, its fallbacks included, fail until you sign in again.`,
      onConfirm: () =>
        void reportError(host.transcript, async () => {
          const r = await rpc(host.gw, 'model.disconnect', { slug })
          host.transcript.notice(r.disconnected ? `Signed out of ${r.name || name}.` : `${r.name || name} had no saved credentials.`, r.disconnected ? 'success' : 'info')
          done()
        }),
      title: `Sign out of ${name}?`
    })
  )
}

interface Account {
  provider: ModelOptionProvider
  name: string
}

/** The Accounts sheet: typing filters, Enter signs in (or adds another credential), Ctrl+D signs out, Shift+R reads again. */
export function openAccounts(host: CommandHost) {
  let accounts: Account[] = []
  let error = ''
  let reading = false
  let loaded = false
  let selected: string | undefined
  let query = ''

  const shown = () => {
    const q = query.toLowerCase()

    return q ? accounts.filter(a => `${a.name} ${a.provider.slug}`.toLowerCase().includes(q)) : accounts
  }

  const read = async () => {
    if (reading) {
      return
    }

    reading = true
    host.changed()

    try {
      const sid = host.session.ref.live
      // Every provider Hermes can sign in to, not only the configured ones the model picker lists.
      const r = await rpc(host.gw, 'model.options', { include_unconfigured: true, ...(sid ? { session_id: sid } : {}) })
      const list = r.providers ?? []
      const names = providerDisplayNames(list)
      // Signed in first, then the gateway's order.
      accounts = list
        .map((provider, i) => ({ name: names[i] ?? provider.name, provider }))
        .sort((a, b) => Number(Boolean(b.provider.authenticated)) - Number(Boolean(a.provider.authenticated)))
      error = ''
      loaded = true
    } catch (e) {
      error = errorText(e)
    }

    reading = false
    host.changed()
  }

  const chosen = () => shown().find(a => a.provider.slug === selected)

  const login = () => {
    const a = chosen()

    if (a) {
      host.close(overlay)
      void reportError(host.transcript, () => signIn(host, a.provider.slug))
    }
  }

  const logout = () => {
    const a = chosen()

    if (a) {
      confirmSignOut(host, a.provider.slug, a.name, () => void read())
    }
  }

  const overlay: Overlay = {
    cancel: () => host.close(overlay),
    key: KEY,
    modal: true,
    node: () => {
      const list = shown()
      const order = list.map(a => a.provider.slug)

      if (!selected || !order.includes(selected)) {
        selected = order[0]
      }

      const a = chosen()

      return (
        <picker
          actions={[
            { id: 'login', keys: ['enter'], label: a?.provider.authenticated ? 'Add credential' : 'Sign in', primary: true },
            { ...optional('disabled', a?.provider.authenticated ? undefined : 'Not signed in'), id: 'logout', keys: ['ctrl+d'], label: 'Sign out' },
            { id: 'refresh', keys: ['shift+r'], label: 'Refresh' },
            { end: true, id: 'close', keys: ['esc'], label: 'Close' }
          ]}
          columns={[{ head: 'Auth', id: 'auth', priority: 1 }]}
          empty={error ? `Could not read the providers: ${error}` : loaded ? 'The gateway lists no providers. /login <provider> signs in to one by its id.' : 'Reading providers…'}
          icon="key-round"
          items={list.map(accountItem)}
          key={KEY}
          noun="providers"
          onAction={{ close: () => host.close(overlay), login, logout, refresh: () => void read() }}
          onActivate={ev => {
            selected = ev.item
            login()
          }}
          onSelect={ev => {
            selected = ev.item
            host.changed()
          }}
          order={order}
          placeholder="Find a provider…"
          query={query}
          preview="side"
          {...optional('selected', selected)}
          size="lg"
          state={reading && !loaded ? 'loading' : 'ready'}
          subtitle={[{ s: 'muted', t: 'Sign-in runs in a split: no secret passes this pane' }]}
          title="Accounts"
          total={list.length}
        >
          {a ? accountDetail(a) : null}
        </picker>
      )
    },
    onKey: (k: Key) => {
      if (k.name === 'escape') {
        host.close(overlay)
      } else if (k.name === 'enter') {
        login()
      } else if (k.name === 'd' && k.ctrl) {
        logout()
      } else if (k.name === 'r' && k.shift) {
        void read()
      } else {
        const moved = moveSelection(k, shown().map(a => a.provider.slug), selected)

        if (moved !== undefined) {
          selected = moved
        } else {
          query = editQuery(k, query) ?? query
        }
      }

      return true
    }
  }

  host.open(overlay)
  void read()
}

function accountItem({ name, provider }: Account): PickerItem {
  return {
    badges: [provider.authenticated ? { text: 'signed in', tone: 'success' } : { text: 'signed out', tone: 'warning' }],
    detail: provider.slug,
    facts: { auth: provider.auth_type ?? '' },
    id: provider.slug,
    label: name,
    mark: { seed: provider.slug, text: name }
  }
}

function accountDetail({ name, provider }: Account): JSX.Element[] {
  return [
    <text key="name" text={name} wrap="word" />,
    <text key="slug" spans={[{ s: 'muted', t: `${provider.slug}${provider.auth_type ? ` · ${provider.auth_type}` : ''}${provider.key_env ? ` · ${provider.key_env}` : ''}` }]} wrap="word" />,
    ...(provider.is_current ? [<text key="current" spans={[{ s: 'success', t: 'The provider of config.yaml’s default model.' }]} wrap="word" />] : []),
    ...(provider.warning ? [<text key="warning" spans={[{ s: 'warning', t: provider.warning }]} wrap="word" />] : []),
    <text
      key="how"
      spans={[{ s: 'muted', t: `Enter runs \`hermes auth add ${provider.slug}\` below the chat; Ctrl+D removes every credential of ${name}.` }]}
      wrap="word"
    />
  ]
}

/** The provider an argument names: one id, else undefined. */
function providerArg(arg: string): string | undefined {
  const words = arg.trim().split(/\s+/).filter(Boolean)

  return words.length === 1 && words[0] && PROVIDER.test(words[0]) ? words[0].toLowerCase() : undefined
}

export const AUTH_COMMANDS: readonly LocalCommand[] = [
  {
    help: '[provider] — sign in to a model provider (Hermes’ own CLI in a split); bare opens Accounts',
    name: 'login',
    run: (host, arg) => {
      if (!arg.trim()) {
        return openAccounts(host)
      }

      const slug = providerArg(arg)

      return slug ? reportError(host.transcript, () => signIn(host, slug)) : host.transcript.notice('Usage: /login [provider]', 'warning')
    }
  },
  {
    help: '[provider] — sign out of a model provider (asks first); bare opens Accounts',
    name: 'logout',
    run: (host, arg) => {
      if (!arg.trim()) {
        return openAccounts(host)
      }

      const slug = providerArg(arg)

      return slug ? confirmSignOut(host, slug, slug) : host.transcript.notice('Usage: /logout [provider]', 'warning')
    }
  }
]
