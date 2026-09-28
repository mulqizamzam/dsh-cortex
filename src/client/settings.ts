/**
 * Settings page card — `settings.section`, id `cortex`, order 30
 * (`docs/HOST-API.md` §9; dsh-mnemon uses 20).
 *
 * Three things, all of them true:
 *   - is the host half answering at all (`ping` on `/dsh-cortex-read`, plus a
 *     write-channel probe that cannot mutate anything);
 *   - what the host reported about itself (version, state root, injection
 *     switch, module wiring when — and only when — the host actually sends it);
 *   - why there is no form here. Config lives host-side and the only supported
 *     way to change it in v1 is a profile patch, which REPLACES the whole
 *     config value for this plugin (HOST-API §2 profile-patch rule). A form that
 *     wrote one key by hand would silently drop the rest, so v1 ships a
 *     self-test and the exact shape to patch instead.
 *
 * Split deliberately: `probeCortex()` (async logic), `SettingsCardView` (pure
 * function of state + actions, no hooks), `CortexSettingsCard` (four hooks that
 * glue them). The middle one is what the tests render.
 */
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { pluginErrorCode } from './api.ts'
import type { CortexApi, CortexError, CortexResult, PingValue } from './api.ts'
import { text, textSpan } from './text.ts'

/** Card identity, exported so the entry and the tests cannot drift apart. */
export const SETTINGS_CARD_ID = 'cortex'
export const SETTINGS_CARD_ORDER = 30

/** One channel's reachability, as probed — never asumed. */
export type ChannelProbe = 'unknown' | 'probing' | 'alive' | 'down'

export interface SettingsProbe {
  ping: CortexResult<PingValue> | null
  /** Does the WRITE channel dispatch at all? Probed without writing. */
  write: ChannelProbe
  writeError: CortexError | null
  /** `status.self`, which the frozen contract says this card may use. */
  status: 'available' | 'missing' | 'error'
  statusModules: Record<string, string> | null
  testedAt: number
}

export const EMPTY_PROBE: SettingsProbe = {
  ping: null,
  write: 'unknown',
  writeError: null,
  status: 'missing',
  statusModules: null,
  testedAt: 0,
}

/**
 * A write-channel probe that cannot change state: an endpoint name the host
 * dispatcher does not know. `unknown-endpoint` proves both halves are wired
 * (the dispatcher answered); any other answer is reported as-is.
 */
const PROBE_ENDPOINT = '__cortex_probe__'

export async function probeCortex(api: CortexApi): Promise<SettingsProbe> {
  const ping = await api.ping()
  const write = await api.probeWriteChannel(PROBE_ENDPOINT)
  const status = await api.statusSelf()
  const modules = status.ok && status.value && typeof status.value.modules === 'object' && status.value.modules !== null
    ? (status.value.modules as Record<string, string>)
    : null
  return {
    ping,
    write: write.ok === true ? 'alive' : pluginErrorCode(write.error) === 'unknown-endpoint' ? 'alive' : 'down',
    writeError: write.ok === true ? null : write.error,
    status: status.ok === true ? 'available' : pluginErrorCode(status.error) === 'unknown-endpoint' ? 'missing' : 'error',
    statusModules: modules,
    testedAt: Date.now(),
  }
}

/** One `label: value` line. Values arrive through the text layer only. */
function row(label: string, value: unknown): React.ReactNode {
  return h(
    'div',
    { className: 'cx-row', key: label },
    h('span', { className: 'cx-row-label' }, `${label}: `),
    textSpan(value === undefined || value === null || value === '' ? '—' : String(value)),
  )
}

function statusLine(result: CortexResult<PingValue> | null): { text: string; tone: string } {
  if (result === null) return { text: 'not probed yet', tone: 'idle' }
  if (result.ok === false) return { text: `read channel down — ${pluginErrorCode(result.error)}`, tone: 'error' }
  return { text: 'read channel alive', tone: 'ok' }
}

export interface SettingsCardViewProps {
  probe: SettingsProbe
  busy: boolean
  onTest(): void
}

/** Pure view. No hooks, no fetches — a function of the probe it is handed. */
export function SettingsCardView(props: SettingsCardViewProps): React.ReactNode {
  const { probe, busy, onTest } = props
  const ping = probe.ping
  const value = ping !== null && ping.ok === true ? ping.value : null
  const line = statusLine(ping)
  const modules = probe.statusModules

  const children: React.ReactNode[] = [
    h(
      'div',
      { className: 'cx-head', key: 'head' },
      h('h3', { className: 'cx-title' }, 'Cortex'),
      h(
        'div',
        { className: `cx-state cx-state-${line.tone}` },
        text(line.text),
        probe.write === 'alive' ? textSpan(' · write channel dispatching') : textSpan(' · write channel not answering'),
      ),
    ),
    h(
      'div',
      { className: 'cx-actions', key: 'actions' },
      h('button', { type: 'button', className: 'cx-btn', disabled: busy, onClick: onTest }, busy ? 'checking…' : 'Self-test'),
      probe.testedAt > 0
        ? h('span', { className: 'cx-muted' }, text('last check {0}', new Date(probe.testedAt).toLocaleTimeString()))
        : null,
    ),
  ]

  if (ping !== null && ping.ok === false) {
    children.push(
      h(
        'div',
        { className: 'cx-error', key: 'err' },
        text('{0}: {1}', pluginErrorCode(ping.error), ping.error.message),
        h('p', { className: 'cx-muted' }, 'The host half is not answering on /dsh-cortex-read. Check that the plugin is in the active profile and that the web app reloaded after it was added.'),
      ),
    )
  }

  if (value !== null) {
    children.push(
      h(
        'div',
        { className: 'cx-grid', key: 'grid' },
        row('plugin', value.plugin ?? 'dsh-cortex'),
        row('version', value.version ?? 'unknown'),
        row('state root', value.stateRoot ?? 'unknown'),
        row('context injection', value.injectEnabled === true ? 'on' : value.injectEnabled === false ? 'off' : 'not reported'),
        Array.isArray(value.echoKeys) && value.echoKeys.length > 0 ? row('ping echo keys', value.echoKeys.join(', ')) : null,
      ),
    )
  }

  children.push(
    h(
      'div',
      { className: 'cx-modules', key: 'modules' },
      h('span', { className: 'cx-row-label' }, 'module wiring: '),
      modules === null
        ? text(
            probe.status === 'missing'
              ? 'not reported by this host build — ping answers with version, state root and the injection switch only; per-module states are in the cortex_status tool'
              : 'status.self answered without a module map',
          )
        : h(
            'ul',
            { className: 'cx-module-list' },
            Object.entries(modules).map(([name, state]) => h('li', { key: name }, text('{0} {1}', name, state))),
          ),
    ),
  )

  if (probe.writeError !== null) {
    children.push(h('div', { className: 'cx-muted', key: 'werr' }, text('write probe: {0}', probe.writeError.message)))
  }

  children.push(
    h(
      'p',
      { className: 'cx-note', key: 'note' },
      text(
        'No form here on purpose. Cortex settings live host-side, and the only v1 write path is a profile patch of the {0} entry, which REPLACES the whole config object — so the patch must restate every key, not just one. Read {1} for the shape.',
        'dsh-cortex',
        'docs/HOST-API.md §2',
      ),
    ),
  )

  return h('section', { className: 'cx-card', 'data-cortex': 'settings' }, ...children)
}

export interface CortexSettingsCardProps {
  api: CortexApi
}

/** Hook glue: fetch-on-mount once, plus the button. Nothing else holds state. */
export function CortexSettingsCard(props: CortexSettingsCardProps): React.ReactNode {
  const [probe, setProbe] = useState<SettingsProbe>(EMPTY_PROBE)
  const [busy, setBusy] = useState(false)
  const run = useCallback(async () => {
    setBusy(true)
    try {
      setProbe(await probeCortex(props.api))
    } catch (error) {
      // probeCortex swallows RPC failures; this is a thrown bug, shown not hidden.
      setProbe({ ...EMPTY_PROBE, testedAt: Date.now() })
      setBusy(false)
      throw error
    } finally {
      setBusy(false)
    }
  }, [props.api])
  useEffect(() => {
    void run()
  }, [run])
  return h(SettingsCardView, { probe, busy, onTest: () => void run() })
}
