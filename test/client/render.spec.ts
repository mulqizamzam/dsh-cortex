// @vitest-environment node
/**
 * Mounts the settings card and the conversation panel against the mock
 * transport, through the harness renderer in `harness.ts`.
 *
 * `vi.mock('react', …)` swaps the hook implementations for the harness
 * dispatcher — the components are unchanged, and the real `react` still
 * supplies `createElement`, so element shapes are exactly what the host renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted above the imports of anything under test, so `panel.ts` and
// `settings.ts` get the harness hooks at module-init time.
vi.mock('react', async () => {
  const { reactHarness } = await import('./harness.ts')
  return { ...reactHarness, default: reactHarness }
})

const { installGlobals, mount, settle, createNode, MiniEvent } = await import('./harness.ts')
const { createCortexApi } = await import('../../src/client/api.ts')
const { createMockTransport } = await import('../../src/client/mock-adapter.ts')
const { createPanelModel } = await import('../../src/client/panel-model.ts')
const { CortexPanel } = await import('../../src/client/panel.ts')
const { CortexSettingsCard, EMPTY_PROBE, SettingsCardView } = await import('../../src/client/settings.ts')

installGlobals()

/** A button by its exact label, at any depth. */
function clickButton(handle: Awaited<ReturnType<typeof mount>>, label: string | RegExp): Promise<void> {
  const node = handle.buttons().find(item => {
    const text = item.textContent
    return typeof label === 'string' ? text === label : label.test(text)
  })
  if (node === undefined) {
    throw new Error(`no button labelled ${String(label)}; have: ${handle.buttons().map(item => item.textContent).join(' | ')}`)
  }
  node.dispatch(new MiniEvent('click'))
  return settle()
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('settings card', () => {
  it('renders the ping answer as text, including state root and injection switch', async () => {
    const api = createCortexApi(createMockTransport().call)
    const model = await api.ping()
    expect(model.ok).toBe(true)
    const handle = await mount(SettingsCardView as never, {
      probe: { ...EMPTY_PROBE, ping: model, write: 'alive', status: 'missing' },
      busy: false,
      onTest: () => {},
    })
    const textContent = handle.text()
    expect(textContent).toContain('state root')
    expect(textContent).toContain('/tmp/dsh-cortex-mock')
    expect(textContent).toContain('context injection')
    // Honest about what the host does NOT report: no module list in ping yet.
    expect(textContent).toContain('not reported by this host build')
    expect(handle.queryOne('.cx-card')?.getAttribute('data-cortex')).toBe('settings')
  })

  it('shows the inline error, not a crash, when ping fails', async () => {
    const api = createCortexApi(createMockTransport({ throwing: ['ping'] }).call)
    const handle = await mount(CortexSettingsCard as never, { api })
    expect(handle.text()).toContain('read channel down')
    expect(handle.queryOne('.cx-error')).not.toBeNull()
    expect(handle.text()).toContain('blew up')
  })

  it('names the ping echo keys it actually got back', async () => {
    const handle = await mount(SettingsCardView as never, {
      probe: { ...EMPTY_PROBE, ping: { ok: true, value: { version: '0.1.0', echoKeys: ['probe'] } } },
      busy: false,
      onTest: () => {},
    })
    expect(handle.text()).toContain('ping echo keys')
    expect(handle.text()).toContain('probe')
  })

  it('the self-test button fires the callback the container owns', async () => {
    let taps = 0
    const handle = await mount(SettingsCardView as never, { probe: EMPTY_PROBE, busy: false, onTest: () => { taps += 1 } })
    await clickButton(handle, 'Self-test')
    expect(taps).toBe(1)
    await clickButton(handle, 'Self-test')
    expect(taps).toBe(2)
  })

  it('says why there is no settings form (profile-patch rule)', async () => {
    const handle = await mount(SettingsCardView as never, { probe: EMPTY_PROBE, busy: false, onTest: () => {} })
    expect(handle.text()).toContain('profile patch')
    expect(handle.text()).toContain('REPLACES')
  })
})

describe('conversation panel', () => {
  it('renders the tab strip and the memory tab from fixtures', async () => {
    const model = createPanelModel(createCortexApi(createMockTransport().call))
    const handle = await mount(CortexPanel as never, { model })
    expect(handle.query('[role=tab]').map(item => item.getAttribute('data-tab')))
      .toEqual(['memory', 'todo', 'rooms', 'board', 'prompts', 'jobs'])
    await model.loadTab('memory')
    const textContent = handle.text()
    expect(textContent).toContain('Prefers terse answers')
    expect(textContent).toContain('tsdown')
    expect(textContent).toContain('Room posts are capped')
    // Pending proposals render with both decision buttons.
    expect(handle.buttons().map(item => item.textContent)).toContain('Approve')
    expect(handle.buttons().map(item => item.textContent)).toContain('Reject')
    model.dispose()
  })

  it('an RPC error renders inline with a retry and never throws', async () => {
    const transport = createMockTransport({ missing: ['memory.list', 'pending.list'] })
    const model = createPanelModel(createCortexApi(transport.call))
    const handle = await mount(CortexPanel as never, { model })
    await model.loadTab('memory')
    expect(handle.queryOne('.cx-error')).not.toBeNull()
    expect(handle.text()).toContain('unknown cortex read endpoint')
    expect(handle.text()).toContain('unknown-endpoint')
    model.dispose()
  })

  it('a transport that rejects is still a rendered state', async () => {
    const transport = createMockTransport({ throwing: ['memory.list'] })
    const model = createPanelModel(createCortexApi(transport.call))
    const handle = await mount(CortexPanel as never, { model })
    await model.loadTab('memory')
    expect(handle.text()).toContain('blew up')
    model.dispose()
  })

  it('switching tabs fetches that tab on mount of its view', async () => {
    const transport = createMockTransport()
    const model = createPanelModel(createCortexApi(transport.call))
    const handle = await mount(CortexPanel as never, { model })
    await clickButton(handle, /^Todo$/)
    expect(transport.log()).toContain('/dsh-cortex-read todo.list')
    expect(handle.text()).toContain('Ship the cortex client panel')
    await clickButton(handle, /^Jobs$/)
    expect(transport.log()).toContain('/dsh-cortex-read jobs.list')
    expect(handle.text()).toContain('echo')
    model.dispose()
  })

  it('the Board tab is reachable: pick a room in Rooms, then a board, then a card moves', async () => {
    // The whole path a user takes. It was broken twice over and neither break
    // showed up in a test: the mount threw the registration away (so there was
    // no panel to click), and even mounted, nothing ever armed the board's room
    // — the Rooms tab's own empty state asks for a room and no control set one.
    const transport = createMockTransport()
    const model = createPanelModel(createCortexApi(transport.call))
    const handle = await mount(CortexPanel as never, { model })

    await clickButton(handle, /^Rooms$/)
    await model.selectRoom('standups')
    await settle()
    // Picking a room in the Rooms tab is what arms the Board tab.
    expect(model.state().board.roomId).toBe('standups')

    await clickButton(handle, /^Board$/)
    await settle()
    expect(transport.log()).toContain('/dsh-cortex-read boards.list')
    expect(handle.text()).toContain('Sprint Board')
    // A listed board is not an open board: the 3-column grid waits for a pick.
    expect(handle.queryOne('.cx-board')).toBeNull()

    await clickButton(handle, /Sprint Board/)
    await settle()
    expect(transport.log()).toContain('/dsh-cortex-read boards.get')
    const board = handle.queryOne('.cx-board')
    if (board === null) throw new Error('expected the 3-column board to be rendered')
    // All three columns, with the card that belongs to each.
    expect(handle.text()).toContain('backlog')
    expect(handle.text()).toContain('in-progress')
    expect(handle.text()).toContain('done')
    expect(handle.text()).toContain('Wire the slots seam')
    expect(handle.text()).toContain('Ship the board tools')
    expect(handle.text()).toContain('Verify in the GUI')
    // Comments are fetched with the board and rendered on their card.
    expect(handle.text()).toContain('blocked on the host seam')

    // A move button sends the write for ITS OWN card, not the first one that
    // happens to render a "→ done" label.
    const row = board.querySelector('[data-card="c-2"]')
    expect(row).not.toBeNull()
    const move = Array.from(row?.querySelectorAll('button') ?? []).find(item => item.textContent === '→ done')
    expect(move).toBeDefined()
    move?.dispatch(new MiniEvent('click'))
    await settle()
    expect(transport.last('boards.moveCard')?.payload).toEqual({ roomId: 'standups', boardId: 'b-sprint-1', cardId: 'c-2', status: 'done' })
    model.dispose()
  })

  it('switching rooms drops the board opened in the previous one', async () => {
    const model = createPanelModel(createCortexApi(createMockTransport().call))
    const handle = await mount(CortexPanel as never, { model })
    await clickButton(handle, /^Rooms$/)
    await model.selectRoom('standups')
    await settle()
    model.selectBoard('standups', 'b-sprint-1')
    await settle()
    expect(model.state().board.boardId).toBe('b-sprint-1')
    // A second room must not keep the first room's board id: boards.get would
    // then be asked for a board that does not exist in the new room.
    model.setBoardRoom('other-room')
    expect(model.state().board.roomId).toBe('other-room')
    expect(model.state().board.boardId).toBeNull()
    expect(handle.queryOne('.cx-board')).toBeNull()
    model.dispose()
  })

  it('a failing tab shows its own error line', async () => {
    const transport = createMockTransport({ missing: ['rooms.list', 'rooms.read', 'rooms.status', 'sessions.status'] })
    const model = createPanelModel(createCortexApi(transport.call))
    const handle = await mount(CortexPanel as never, { model })
    await clickButton(handle, /^Rooms$/)
    expect(handle.text()).toContain('rooms.list failed')
    expect(handle.text()).toContain('sessions.status failed')
    model.dispose()
  })

  it('prompts renders the wave-2 refusal honestly when the endpoint is absent', async () => {
    const transport = createMockTransport({ missing: ['prompts.list'] })
    const model = createPanelModel(createCortexApi(transport.call))
    const handle = await mount(CortexPanel as never, { model })
    await clickButton(handle, /^Prompts$/)
    expect(handle.text()).toContain('not mounted on this host yet')
    expect(handle.queryOne('.cx-error')).toBeNull()
    model.dispose()
  })

  it('renders hostile room text as text, with no html anywhere in the tree', async () => {
    const model = createPanelModel(createCortexApi(createMockTransport().call))
    const handle = await mount(CortexPanel as never, { model })
    await clickButton(handle, /^Rooms$/)
    await model.selectRoom('standups')
    await settle()
    expect(handle.text()).toContain('<img src=x onerror')
    const hostile = handle.text().match(/<script>/g) ?? []
    expect(hostile.length).toBeGreaterThan(0)
    // Nothing in the tree carries an html-ish attribute or property name: the
    // only escaping in play is React's own text-node escaping.
    const leaky = handle.root
      .elements()
      .flatMap(node => [...node.attributes.keys()])
      .filter(name => /html/i.test(name))
    expect(leaky).toEqual([])
    expect(handle.root.querySelectorAll('script')).toHaveLength(0)
    expect(handle.root.querySelectorAll('img')).toHaveLength(0)
    model.dispose()
  })

  it('the spawn button stays DISABLED with a reason when canSpawn is false', async () => {
    const transport = createMockTransport({ sessionsStatus: { canSpawn: false, reason: 'no agents service in this profile' } })
    const model = createPanelModel(createCortexApi(transport.call))
    const handle = await mount(CortexPanel as never, { model })
    await clickButton(handle, /^Rooms$/)
    await clickButton(handle, 'spawn form')
    const spawn = handle.buttons().find(item => item.textContent === 'Spawn into room')
    expect(spawn).toBeDefined()
    expect(spawn?.disabled).toBe(true)
    expect(spawn?.getAttribute('title')).toContain('no agents service')
    // The reason comes from the host answer, not from a UI invention.
    expect(handle.text()).toContain('no agents service in this profile')
    // A click cannot get past a disabled button: no write is ever sent.
    spawn?.dispatch(new MiniEvent('click'))
    await settle()
    expect(transport.log().filter(line => line.endsWith('rooms.spawn'))).toEqual([])
    model.dispose()
  })

  it('a host that answered canSpawn=true enables it, and the click sends rooms.spawn', async () => {
    const transport = createMockTransport({ sessionsStatus: { canSpawn: true } })
    const model = createPanelModel(createCortexApi(transport.call))
    const handle = await mount(CortexPanel as never, { model })
    await clickButton(handle, /^Rooms$/)
    await clickButton(handle, 'spawn form')
    const spawn = handle.buttons().find(item => item.textContent === 'Spawn into room')
    expect(spawn?.disabled).toBe(false)
    expect(spawn?.getAttribute('title')).toContain('agents.create')
    model.setRoomField('spawnLabel', 'reviewer-2')
    model.setRoomField('spawnPrompt', 'review the diff')
    await settle()
    await clickButton(handle, 'Spawn into room')
    const call = transport.last('rooms.spawn')
    expect(call?.channel).toBe('/dsh-cortex-write')
    expect(call?.payload).toEqual({ roomId: 'standups', label: 'reviewer-2', prompt: 'review the diff' })
    model.dispose()
  })

  it('a missing sessions.status answer keeps spawn disabled (never assumed)', async () => {
    const transport = createMockTransport({ missing: ['sessions.status'] })
    const model = createPanelModel(createCortexApi(transport.call))
    const handle = await mount(CortexPanel as never, { model })
    await clickButton(handle, /^Rooms$/)
    await clickButton(handle, 'spawn form')
    const spawn = handle.buttons().find(item => item.textContent === 'Spawn into room')
    expect(spawn?.disabled).toBe(true)
    expect(handle.text()).toContain('sessions.status failed')
    model.dispose()
  })

  it('every row button carries its own id, so a click cannot hit the wrong row', async () => {
    const model = createPanelModel(createCortexApi(createMockTransport().call))
    const handle = await mount(CortexPanel as never, { model })
    await model.loadTab('memory')
    await settle()
    const cards = handle.query('[data-entry]')
    expect(cards.map(card => card.getAttribute('data-entry'))).toEqual(['a1b2c3d4e5f60718', '0f1e2d3c4b5a6978'])
    const approve = handle.query('[data-pending]')
    expect(approve.map(card => card.getAttribute('data-pending'))).toEqual(['p-1001', 'p-1002'])
    model.dispose()
  })

  it('leaves no listeners behind after unmount', async () => {
    const model = createPanelModel(createCortexApi(createMockTransport().call))
    const root = createNode('div')
    const handle = await mount(CortexPanel as never, { model }, root)
    const before = handle.countListeners()
    expect(before).toBeGreaterThan(0)
    handle.unmount()
    expect(handle.countListeners()).toBe(0)
    model.dispose()
  })
})
