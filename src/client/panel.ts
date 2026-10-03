/**
 * Conversation-view panel — `conversation.view`, id `cortex`.
 *
 * A tab strip (Memory | Todo | Rooms | Prompts | Jobs) over the
 * `/dsh-cortex-read` + `/dsh-cortex-write` channels. Rules this file is written
 * to:
 *
 *   - It renders. All decisions (what to fetch, when a write is allowed, what
 *     `canSpawn` means) live in `panel-model.ts`; every view here is a pure
 *     function of a snapshot plus the model, so it can be called directly in a
 *     test without a React tree.
 *   - Nothing here contains a string of markup. Every untrusted value goes
 *     through `text()` / `textSpan()` / `codeText()` (`text.ts`), so a memory
 *     entry that says `<script>` shows `<script>` (SECURITY.md).
 *   - An RPC failure is a rendered state, never a crash: `Load.error` prints
 *     inline with a retry, and a whole-tab throw is caught by `PanelErrorEdge`.
 *   - Destructive or host-mutating actions are explicit clicks on labelled
 *     buttons. Spawn is DISABLED with a reason unless the last
 *     `sessions.status` answer said `canSpawn === true`.
 *
 * Styling: inline `style` props and `cx-*` class names only. No CSS file is
 * imported — a client bundle that imports CSS is a build-story question
 * (`dsh.client` ships JS), so v1 carries its own minimal inline styles.
 */
import { createElement as h, useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { TodoTrack } from '../host/types.ts'
import type {
  BoardCard,
  BoardComment,
  BoardStatus,
  BoardRow,
  BoardsGetValue,
  BoardsListValue,
  JobRow,
  MemoryEntry,
  MemoryFilter,
  PendingItem,
  PromptRow,
  RoomMember,
  RoomMessage,
  RoomRow,
  RoomsStatusValue,
  SessionsStatusValue,
  TodoItem,
} from './api.ts'
import { pluginErrorCode } from './api.ts'
import type { Load, PanelModel, PanelState, TabId } from './panel-model.ts'
import { TABS } from './panel-model.ts'
import { clip, codeText, summarize, text, textSpan } from './text.ts'

// ------------------------------------------------------------------ tokens --

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

const S = {
  panel: { display: 'grid', gap: 10, padding: '10px 12px', fontSize: 13, lineHeight: 1.45 } as const,
  strip: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' } as const,
  tab: { padding: '3px 9px', borderRadius: 6, border: '1px solid transparent', background: 'transparent', cursor: 'pointer', fontSize: 12 } as const,
  tabOn: { borderColor: 'currentColor', background: 'rgba(127,127,127,0.14)' } as const,
  row: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline' } as const,
  card: { border: '1px solid rgba(127,127,127,0.28)', borderRadius: 8, padding: '6px 8px' } as const,
  muted: { opacity: 0.65, fontSize: 12 } as const,
  badge: { fontSize: 11, padding: '1px 5px', borderRadius: 999, border: '1px solid rgba(127,127,127,0.4)' } as const,
  error: { border: '1px solid rgba(200,90,60,0.5)', borderRadius: 8, padding: '5px 8px' } as const,
  ok: { opacity: 0.8, fontSize: 12 } as const,
  input: { font: 'inherit', padding: '3px 6px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.4)', minWidth: 0, flex: '1 1 140px' } as const,
  button: { font: 'inherit', padding: '3px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.4)', background: 'rgba(127,127,127,0.08)', cursor: 'pointer' } as const,
  pre: { fontFamily: MONO, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, maxHeight: 220, overflow: 'auto' } as const,
}

/** A small labelled button. `label` is untrusted-safe (goes through `text`). */
function button(label: string, onClick: () => void, options: { disabled?: boolean; title?: string; kind?: 'primary' | 'ghost' | 'danger' } = {}): ReactNode {
  return h(
    'button',
    {
      type: 'button',
      className: 'cx-btn',
      style: { ...S.button, ...(options.kind === 'danger' ? { borderColor: 'rgba(200,90,60,0.6)' } : {}) },
      disabled: options.disabled === true,
      title: options.title,
      onClick,
    },
    label,
  )
}

function muted(value: unknown): ReactNode {
  return h('span', { style: S.muted }, textSpan(value))
}

/**
 * Badge tone → colour, merged into `S.badge` at render time.
 *
 * This bundle ships NO stylesheet, so the `cx-badge-<tone>` class carried no
 * rule anywhere — not in the plugin, not in `lib/client.js`, not in the host.
 * Every status therefore rendered identically (grey border, transparent fill),
 * which left the Jobs tab with no visual signal at all. The colours below are
 * inline for that reason; the className is kept for selectors and tests.
 *
 * Tuned against the host's measured panel background `rgb(21,21,23)`, each text
 * colour clears WCAG AA (4.5:1) on its own translucent fill:
 * danger ≈7.7:1, warn ≈8.8:1, ok ≈9.3:1, track ≈10.9:1.
 */
const BADGE_TONE: Record<string, Record<string, string>> = {
  ok: { color: '#8fe0b0', background: 'rgba(80,180,120,0.14)', borderColor: 'rgba(80,180,120,0.5)' },
  warn: { color: '#f2c777', background: 'rgba(210,160,60,0.16)', borderColor: 'rgba(210,160,60,0.55)' },
  danger: { color: '#ff9d8a', background: 'rgba(200,90,60,0.18)', borderColor: 'rgba(200,90,60,0.65)' },
  track: { color: '#c3c9d1', borderColor: 'rgba(127,127,127,0.45)' },
}

function badge(value: unknown, tone?: string): ReactNode {
  const key = tone ?? 'plain'
  return h('span', { className: `cx-badge cx-badge-${key}`, style: { ...S.badge, ...BADGE_TONE[key] } }, textSpan(value))
}

/** One `Load<T>` slot: idle / loading / error (with retry) / ready (with view). */
function loadView<T>(load: Load<T>, render: (value: T) => ReactNode, retry: () => void, what: string): ReactNode {
  if (load.kind === 'idle') return muted(`${what}: not loaded yet`)
  if (load.kind === 'loading') return muted(`${what}: loading…`)
  if (load.kind === 'error') {
    return h(
      'div',
      { className: 'cx-error', style: S.error, role: 'alert' },
      text('{0} failed — {1}: {2}', what, pluginErrorCode(load.error), load.error.message),
      ' ',
      button('retry', retry),
      load.value === undefined ? null : h('div', { style: { marginTop: 6 } }, render(load.value)),
    )
  }
  return render(load.value)
}

// ------------------------------------------------------------------ memory --

const FILTERS: ReadonlyArray<{ id: MemoryFilter; label: string }> = [
  { id: 'all', label: 'all' },
  { id: 'user', label: 'user' },
  { id: 'global', label: 'global' },
  { id: 'project', label: 'project' },
  { id: 'archived', label: 'archived' },
]

function memoryRow(entry: MemoryEntry, model: PanelModel, state: PanelState['memory']): ReactNode {
  const { busyId, confirmDeleteId } = state
  const archived = entry.archivedAt !== undefined && entry.archivedAt !== null && entry.archivedAt !== ''
  const confirming = confirmDeleteId === entry.id
  const actions: ReactNode[] = []
  if (confirming) {
    // Destructive arming state: the entry is named, the promise is short, and
    // Cancel is the same distance from the button as Confirm.
    actions.push(muted('delete permanently? not reversible'))
    actions.push(button('Confirm', () => void model.deleteMemory(entry.id), {
      disabled: busyId === entry.id,
      kind: 'danger',
      title: 'memory.delete — permanently removes this entry',
    }))
    actions.push(button('Cancel', () => model.cancelDelete(), {
      kind: 'ghost',
      title: 'leave the entry alone',
    }))
  } else {
    actions.push(button(archived ? 'Restore' : 'Archive', () => void (archived ? model.restoreMemory(entry.id) : model.archiveMemory(entry.id)), {
      disabled: busyId === entry.id,
      title: archived ? 'move this entry back to the live track' : 'move this entry to the archive',
    }))
    if (!archived) {
      actions.push(button('Delete', () => void model.deleteMemory(entry.id), {
        disabled: busyId === entry.id,
        kind: 'danger',
        title: 'ask first, then memory.delete — this cannot be undone',
      }))
    }
  }
  return h(
    'div',
    { className: 'cx-entry', style: S.card, key: entry.id, 'data-entry': entry.id },
    h(
      'div',
      { style: S.row },
      badge(entry.track, 'track'),
      muted(`i${String(entry.importance)}`),
      archived ? badge('archived', 'warn') : null,
      Array.isArray(entry.branches) && entry.branches.length > 0 ? muted(entry.branches.join(', ')) : muted('any branch'),
      Array.isArray(entry.tags) && entry.tags.length > 0 ? muted(`#${entry.tags.join(' #')}`) : null,
    ),
    h('div', { className: 'cx-entry-content' }, text(entry.content)),
    h(
      'div',
      { style: S.row },
      codeText(entry.id),
      muted(entry.origin ?? 'no origin'),
      muted(entry.updatedAt),
      h('span', { style: { flex: '1 1 auto' } }),
      ...actions,
    ),
  )
}

function pendingRow(item: PendingItem, model: PanelModel, busyId: string | null): ReactNode {
  const body = item.proposal?.content ?? item.proposal?.text ?? item.proposal?.body ?? item.proposal?.title ?? ''
  return h(
    'div',
    { className: 'cx-pending', style: S.card, key: item.id, 'data-pending': item.id },
    h('div', { style: S.row }, badge(item.kind ?? 'unknown', 'track'), muted(item.createdAt), item.fromSessionId === undefined ? null : muted(`from ${clip(item.fromSessionId, 24)}`)),
    h('div', null, text(body)),
    item.reason === undefined ? null : h('div', { style: S.muted }, text('why: {0}', item.reason)),
    h(
      'div',
      { style: S.row },
      codeText(item.id),
      h('span', { style: { flex: '1 1 auto' } }),
      button('Approve', () => void model.approvePending(item.id), {
        disabled: busyId === item.id,
        title: 'writes the proposal to the store (pending.approve, routed by kind)',
      }),
      button('Reject', () => void model.rejectPending(item.id), {
        disabled: busyId === item.id,
        kind: 'danger',
        title: 'marks the proposal rejected; nothing is written',
      }),
    ),
  )
}

export function MemoryTab(props: { state: PanelState['memory']; model: PanelModel }): ReactNode {
  const { state, model } = props
  const list = state.list
  const entries = list.kind === 'ready' || list.kind === 'error' ? list.value?.entries ?? [] : []
  const search = state.search
  const hits = search.kind === 'ready' ? search.value?.hits ?? [] : []
  const pending = state.pending
  const items = pending.kind === 'ready' || pending.kind === 'error' ? pending.value?.items ?? [] : []
  const retry = () => void model.loadTab('memory')
  return h(
    'div',
    { className: 'cx-tab cx-tab-memory' },
    h(
      'div',
      { style: S.row, className: 'cx-filters' },
      h('span', { style: S.muted }, 'track'),
      ...FILTERS.map(filter =>
        h(
          'button',
          {
            key: filter.id,
            type: 'button',
            className: 'cx-chip',
            style: { ...S.tab, ...(state.filter === filter.id ? S.tabOn : {}) },
            'aria-pressed': state.filter === filter.id,
            onClick: () => void model.setMemoryFilter(filter.id),
          },
          filter.label,
        ),
      ),
      button('refresh', retry),
    ),
    h(
      'form',
      {
        className: 'cx-search',
        style: S.row,
        onSubmit: (event: { preventDefault(): void; currentTarget: HTMLFormElement }) => {
          event.preventDefault()
          void model.runMemorySearch()
          event.currentTarget.querySelector<HTMLInputElement>('[name="q"]')?.focus()
        },
      },
      h('input', { name: 'q', className: 'cx-input', style: S.input, placeholder: 'search memory…', defaultValue: state.query, 'aria-label': 'memory search query' }),
      button('Search', () => void model.runMemorySearch()),
      search.kind === 'loading' ? muted('searching…') : null,
    ),
    search.kind === 'error'
      ? h('div', { className: 'cx-error', style: S.error, role: 'alert' }, text('search failed — {0}: {1}', pluginErrorCode(search.error), search.error.message))
      : hits.length > 0
        ? h(
            'div',
            { className: 'cx-hits' },
            h('div', { style: S.muted }, text('{0} hit(s) of {1} candidates', String(search.kind === 'ready' ? search.value?.shown ?? hits.length : hits.length), String(search.kind === 'ready' ? search.value?.candidates ?? '?' : '?'))),
            ...hits.map(hit =>
              h('div', { key: hit.id, style: { ...S.card, marginBottom: 4 } }, h('div', { style: S.row }, badge(hit.track, 'track'), muted(`score ${String(hit.score)}`), hit.archived === true ? badge('archived', 'warn') : null), h('div', null, text(hit.snippet)), codeText(hit.id)),
            ),
          )
        : null,
    loadView(
      list,
      () =>
        entries.length === 0
          ? muted(state.filter === 'archived' ? 'nothing archived in this scope' : 'no entries in this scope yet')
          : h(
              'div',
              { className: 'cx-entries' },
              ...entries.map(entry => memoryRow(entry, model, state)),
            ),
      retry,
      'memory.list',
    ),
    list.kind === 'ready' && list.value?.truncated === true ? muted('listing truncated — narrow with the track filter or a search') : null,
    h('h4', { className: 'cx-subhead' }, 'Pending approvals'),
    loadView(
      pending,
      () => (items.length === 0 ? muted('nothing waiting for a decision') : h('div', { className: 'cx-pendings' }, ...items.map(item => pendingRow(item, model, state.busyId)))),
      retry,
      'pending.list',
    ),
  )
}

// -------------------------------------------------------------------- todo --

const TODO_TRACK_OPTIONS: readonly TodoTrack[] = ['life', 'work', 'daily', 'project']

function todoRow(item: TodoItem, model: PanelModel, busyId: string | null): ReactNode {
  return h(
    'div',
    { key: item.id, style: S.card, className: 'cx-todo', 'data-todo': item.id },
    h(
      'div',
      { style: S.row },
      h('input', {
        type: 'checkbox',
        checked: item.done === true,
        disabled: busyId === item.id,
        'aria-label': item.done === true ? 'reopen this todo' : 'complete this todo',
        onChange: () => void (item.done === true ? model.uncompleteTodo(item.id) : model.completeTodo(item.id)),
      }),
      h('span', { style: item.done === true ? { textDecoration: 'line-through', opacity: 0.6 } : {} }, text(item.text)),
      badge(item.track, 'track'),
      item.due === null || item.due === undefined ? null : badge(item.overdue === true ? `overdue ${item.due}` : `due ${item.due}`, item.overdue === true ? 'warn' : 'plain'),
      item.important === true ? badge('important') : null,
      item.urgent === true ? badge('urgent') : null,
      h('span', { style: { flex: '1 1 auto' } }),
      button('Remove', () => void model.removeTodo(item.id), { disabled: busyId === item.id, kind: 'danger', title: 'todo.remove deletes the row' }),
    ),
  )
}

export function TodoTab(props: { state: PanelState['todo']; model: PanelModel }): ReactNode {
  const { state, model } = props
  const items = state.list.kind === 'ready' || state.list.kind === 'error' ? state.list.value?.items ?? [] : []
  const retry = () => void model.loadTab('todo')
  const submit = (): void => void model.addTodo()
  return h(
    'div',
    { className: 'cx-tab cx-tab-todo' },
    h(
      'form',
      {
        className: 'cx-add',
        style: S.row,
        onSubmit: (event: { preventDefault(): void }) => {
          event.preventDefault()
          submit()
        },
      },
      h(
        'select',
        {
          name: 'track',
          className: 'cx-select',
          style: S.input,
          'aria-label': 'track for a new todo',
          value: state.track,
          onChange: (event: { currentTarget: { value: string } }) => model.setTodoTrack(event.currentTarget.value as TodoTrack),
        },
        ...TODO_TRACK_OPTIONS.map(track => h('option', { key: track, value: track }, track)),
      ),
      h('input', {
        name: 'text',
        className: 'cx-input',
        style: S.input,
        placeholder: 'add a todo — the human path writes immediately, no pending queue',
        'aria-label': 'new todo text',
        value: state.draft,
        onChange: (event: { currentTarget: { value: string } }) => model.setTodoDraft(event.currentTarget.value),
      }),
      button('Add', submit, { title: 'todo.add on /dsh-cortex-write' }),
      h(
        'label',
        { className: 'cx-check', style: S.muted },
        h('input', { type: 'checkbox', checked: state.openOnly, onChange: () => void model.setTodoOpenOnly(!state.openOnly) }),
        ' open only',
      ),
      button('refresh', retry),
    ),
    loadView(
      state.list,
      () =>
        items.length === 0
          ? muted(state.openOnly ? 'nothing open in these tracks' : 'no todos in these tracks yet')
          : h('div', { className: 'cx-todos' }, ...items.map(item => todoRow(item, model, state.busyId))),
      retry,
      'todo.list',
    ),
    state.list.kind === 'ready' && state.list.value?.truncated === true ? muted('the host capped this list') : null,
  )
}

// ------------------------------------------------------------------- rooms --

/** `rooms.status` rows carry their own live fields; merge them onto the list. */
function mergedMembers(row: RoomRow | undefined, status: Load<RoomsStatusValue>): RoomMember[] {
  const rows: RoomMember[] = status.kind === 'ready' || status.kind === 'error' ? status.value?.members ?? [] : []
  const bySession = new Map(rows.map(item => [String(item.sessionId ?? item.label), item]))
  const base = row?.members ?? []
  if (base.length === 0) return rows.map(member => ({ ...member, status: member.status ?? 'unknown' }))
  return base.map(member => {
    const live = bySession.get(String(member.sessionId ?? member.label))
    return { ...member, ...(live ?? {}), status: live?.status ?? member.status ?? 'unknown' }
  })
}

function memberLine(member: RoomMember): ReactNode {
  const status = member.status ?? 'unknown'
  const tone = status === 'running' ? 'ok' : status === 'gone' ? 'warn' : 'plain'
  return h(
    'div',
    { key: `${member.label}-${String(member.sessionId ?? 'none')}`, className: 'cx-member', style: S.row },
    badge(status, tone),
    textSpan(member.label),
    member.sessionId === null || member.sessionId === undefined || member.sessionId === ''
      ? muted('label only — no session bound')
      : codeText(member.sessionId),
    member.model === null || member.model === undefined ? null : muted(`model ${clip(member.model, 40)}`),
    member.cwd === null || member.cwd === undefined ? null : muted(`cwd ${clip(member.cwd, 60)}`),
    member.unread !== undefined && member.unread > 0 ? badge(`${String(member.unread)} unread`, 'warn') : null,
  )
}

function messageRow(message: RoomMessage): ReactNode {
  return h(
    'div',
    { key: message.seq, className: 'cx-msg', style: { ...S.card, marginBottom: 4 }, 'data-seq': String(message.seq) },
    h('div', { style: S.row }, muted(`seq ${String(message.seq)}`), badge(message.from, 'track'), muted(message.at ?? 'no stamp')),
    h('div', { className: 'cx-msg-body' }, text(message.text)),
    Array.isArray(message.images) && message.images.length > 0 ? muted(`${String(message.images.length)} image(s)`) : null,
  )
}

export function RoomsTab(props: { state: PanelState['rooms']; model: PanelModel }): ReactNode {
  const { state, model } = props
  const rooms = state.list.kind === 'ready' || state.list.kind === 'error' ? state.list.value?.rooms ?? [] : []
  const active: RoomRow | undefined = rooms.find(room => room.id === state.selectedId)
  const shown = state.pages.flat().slice().sort((a, b) => a.seq - b.seq)
  const gate = model.spawnGate()
  const newest = shown.length > 0 ? shown[shown.length - 1].seq : 0
  const retryRooms = () => void model.loadTab('rooms')
  return h(
    'div',
    { className: 'cx-tab cx-tab-rooms' },
    h(
      'div',
      { style: S.row, className: 'cx-room-pick' },
      loadView(
        state.list,
        () =>
          rooms.length === 0
            ? muted('no rooms yet — create one below')
            : h(
                'div',
                { style: S.strip, role: 'tablist', 'aria-label': 'rooms' },
                ...rooms.map(room =>
                  h(
                    'button',
                    {
                      key: room.id,
                      type: 'button',
                      role: 'tab',
                      className: 'cx-chip',
                      'data-room': room.id,
                      'aria-selected': room.id === state.selectedId,
                      style: { ...S.tab, ...(room.id === state.selectedId ? S.tabOn : {}) },
                      onClick: () => void model.selectRoom(room.id),
                      title: `${String(room.members.length)} member(s), last seq ${String(room.lastSeq)}`,
                    },
                    `${clip(room.title, 28)} · ${String(room.lastSeq)}`,
                  ),
                ),
              ),
        retryRooms,
        'rooms.list',
      ),
      button('refresh', retryRooms),
    ),
    h(
      'form',
      {
        style: S.row,
        className: 'cx-create',
        onSubmit: (event: { preventDefault(): void }) => {
          event.preventDefault()
          void model.createRoom()
        },
      },
      h('input', {
        style: S.input,
        placeholder: 'new room title…',
        'aria-label': 'new room title',
        value: state.newRoomTitle,
        onChange: (event: { currentTarget: { value: string } }) => model.setRoomField('newRoomTitle', event.currentTarget.value),
      }),
      button('Create room', () => void model.createRoom(), {
        disabled: state.busy === 'create' || state.newRoomTitle.trim() === '',
        title: 'rooms.create',
      }),
    ),
    active === undefined && state.selectedId !== null ? h('h4', { className: 'cx-subhead' }, text('{0}', state.selectedId)) : null,
    active !== undefined ? h('h4', { className: 'cx-subhead' }, text('{0}', active.title)) : null,
    state.selectedId === null
      ? null
      : loadView(
          state.messages,
          () =>
            h(
              'div',
              { className: 'cx-messages' },
              shown.length === 0 ? muted('no messages in this room yet') : null,
              ...shown.map(messageRow),
              h(
                'div',
                { style: S.row },
                button('Load older', () => void model.loadOlderMessages(), {
                  // The host answers a WIDER window, not a cursor: nothing older
                  // exists locally once seq 1 is on screen or the page is full.
                  disabled: state.loadingOlder || state.earliestSeq === null || state.earliestSeq <= 1,
                  title: 'rooms.read with a bigger limit; older rows are what is not already shown',
                }),
                state.loadingOlder ? muted('loading older…') : null,
                muted(`showing ${String(shown.length)} latest (seq ${String(state.earliestSeq ?? '?')}→${String(newest)})`),
              ),
            ),
          () => void model.selectRoom(state.selectedId ?? ''),
          'rooms.read',
        ),
    state.selectedId === null
      ? null
      : h(
          'div',
          { className: 'cx-post', style: S.row },
          h('textarea', {
            style: { ...S.input, minHeight: 44, resize: 'vertical' },
            placeholder: 'post to this room…',
            'aria-label': 'room message',
            value: state.postDraft,
            onChange: (event: { currentTarget: { value: string } }) => model.setRoomField('postDraft', event.currentTarget.value),
            onKeyDown: (event: { key: string; shiftKey: boolean; preventDefault(): void }) => {
              if (event.key === 'Enter' && event.shiftKey !== true) {
                event.preventDefault()
                void model.postToRoom()
              }
            },
          }),
          button('Post', () => void model.postToRoom(), {
            disabled: state.busy !== null || state.postDraft.trim() === '',
            title: 'rooms.post — the author is this UI unless a session is bound',
          }),
        ),
    state.selectedId === null ? null : h('h4', { className: 'cx-subhead' }, 'Members'),
    state.selectedId === null
      ? null
      : (() => {
          const members = mergedMembers(active, state.members)
          if (state.members.kind === 'error') {
            return h(
              'div',
              { style: S.row, className: 'cx-members' },
              h('span', { style: S.muted }, text('rooms.status failed — {0}; showing the last known members', state.members.error.message)),
              ...members.map(memberLine),
            )
          }
          return members.length === 0
            ? muted('this room has no members')
            : h('div', { className: 'cx-members' }, ...members.map(memberLine))
        })(),
    h(
      'div',
      { className: 'cx-spawn', style: S.card },
      h(
        'div',
        { style: S.row },
        h('strong', null, 'Spawn a member'),
        button(state.showSpawn ? 'hide' : 'spawn form', () => model.setSpawnVisible(state.showSpawn !== true)),
      ),
      // Honest gate line, before anyone wonders why the button looks dead.
      h('div', { style: S.muted }, text(gate.reason)),
      state.showSpawn
        ? h(
            'div',
            { style: { display: 'grid', gap: 6, marginTop: 6 } },
            h('input', {
              style: S.input,
              placeholder: 'label — who this session is in the room',
              'aria-label': 'spawn label',
              value: state.spawnLabel,
              onChange: (event: { currentTarget: { value: string } }) => model.setRoomField('spawnLabel', event.currentTarget.value),
            }),
            h('textarea', {
              style: { ...S.input, minHeight: 60, resize: 'vertical' },
              placeholder: 'first prompt for the new session…',
              'aria-label': 'spawn prompt',
              value: state.spawnPrompt,
              onChange: (event: { currentTarget: { value: string } }) => model.setRoomField('spawnPrompt', event.currentTarget.value),
            }),
            button('Spawn into room', () => void model.spawnMember(), {
              // The ONLY thing that enables this: the host said canSpawn === true.
              disabled: gate.allowed !== true || state.busy === 'spawn' || state.selectedId === null,
              title: gate.allowed === true ? 'rooms.spawn runs host-side agents.create' : gate.reason,
            }),
          )
        : null,
    ),
  )
}

// ------------------------------------------------------------------ board ---

const BOARD_STATUSES: readonly BoardStatus[] = ['backlog', 'in-progress', 'done']

const STATUS_TONE: Record<BoardStatus, string> = {
  'backlog': 'plain',
  'in-progress': 'warn',
  'done': 'ok',
}

function boardCardRow(card: BoardCard, comments: BoardComment[], model: PanelModel, roomId: string, boardId: string, busyId: string | null): ReactNode {
  const myComments = comments.filter(c => c.cardId === card.id)
  return h(
    'div',
    { key: card.id, style: { ...S.card, marginBottom: 4 }, className: 'cx-board-card', 'data-card': card.id },
    h(
      'div',
      { style: S.row },
      badge(card.status, STATUS_TONE[card.status]),
      textSpan(card.title),
      card.owner !== null && card.owner !== undefined ? muted(`owner: ${clip(card.owner, 20)}`) : null,
      card.dependencies.length > 0 ? muted(`deps: ${card.dependencies.map(d => clip(d, 8)).join(', ')}`) : null,
    ),
    card.description !== undefined ? h('div', { style: S.muted }, text(card.description)) : null,
    myComments.length > 0
      ? h(
          'div',
          { style: { marginTop: 4, display: 'grid', gap: 2 } },
          ...myComments.map(comment =>
            h(
              'div',
              { key: comment.id, style: S.muted },
              h('span', null, text(comment.author ?? 'unknown')),
              h('span', null, ' — ' + comment.text),
            ),
          ),
        )
      : null,
    h(
      'div',
      { style: { ...S.row, marginTop: 4 } },
      ...BOARD_STATUSES.filter(s => s !== card.status).map(status =>
        h(
          'button',
          {
            key: status,
            type: 'button',
            className: 'cx-btn',
            style: S.button,
            onClick: () => void model.moveBoardCard(roomId, boardId, card.id, status),
            disabled: busyId === card.id,
          },
          `→ ${status}`,
        ),
      ),
      button('refresh', () => model.selectBoard(roomId, boardId), { kind: 'ghost', title: 're-fetch this card' }),
    ),
  )
}

export function BoardTab(props: { state: PanelState['board']; model: PanelModel }): ReactNode {
  const { state, model } = props
  const active = state.active
  const cards: BoardCard[] = active.kind === 'ready' || active.kind === 'error' ? active.value?.cards ?? [] : []
  const comments: BoardComment[] = active.kind === 'ready' ? active.value?.comments ?? [] : []
  const byStatus: Record<BoardStatus, BoardCard[]> = { 'backlog': [], 'in-progress': [], 'done': [] }
  for (const card of cards) byStatus[card.status].push(card)
  const retry = () => { if (state.roomId !== null && state.boardId !== null) void model.selectBoard(state.roomId, state.boardId) }
  const roomId = state.roomId
  const boardId = state.boardId
  const listLoad: Load<BoardsListValue | undefined> = roomId === null
    ? { kind: 'idle' }
    : state.boardsByRoom[roomId] ?? { kind: 'idle' }
  const retryList = () => { if (roomId !== null) void model.selectRoom(roomId) }
  // A room, then a board, then the board. The middle step used to be missing
  // entirely: boardsByRoom was fetched on every tab entry and rendered nowhere,
  // so with a room chosen the tab said "no board selected" and offered no way
  // to change that.
  const body = roomId === null
    ? muted('no room selected — pick one in the Rooms tab')
    : boardId === null
      ? loadView(
          state.boardsByRoom[roomId] ?? { kind: 'idle' },
          value => {
            const boards = value?.boards ?? []
            if (boards.length === 0) return muted('this room has no boards yet — create one with the cortex_board_create tool')
            return h(
              'div',
              { className: 'cx-board-list', style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              ...boards.map(board =>
                h(
                  'button',
                  {
                    key: board.id,
                    type: 'button',
                    className: 'cx-chip',
                    'data-board': board.id,
                    onClick: () => void model.selectBoard(roomId, board.id),
                    title: `${String(board.cardCount)} card(s)`,
                  },
                  text('{0} · {1} card', clip(board.title, 32), board.cardCount),
                ),
              ),
            )
          },
          retryList,
          'boards.list',
        )
      : loadView(
          active,
          () =>
            h(
              'div',
              { className: 'cx-board' },
              h(
                'div',
                {
                  style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 },
                },
                ...BOARD_STATUSES.map(status =>
                  h(
                    'div',
                    { key: status, style: { border: '1px solid rgba(127,127,127,0.28)', borderRadius: 8, padding: 6 } },
                    h('h4', { style: S.muted }, text(status)),
                    byStatus[status].length === 0
                      ? muted('empty')
                      : byStatus[status].map(card => boardCardRow(card, comments, model, roomId, boardId, state.busy)),
                  ),
                ),
              ),
              h('h4', { className: 'cx-subhead' }, 'Add a card'),
              h(
                'form',
                {
                  style: S.row,
                  onSubmit: (event: { preventDefault(): void }) => {
                    event.preventDefault()
                    void model.addBoardCard(roomId, boardId)
                  },
                },
                h('input', {
                  style: S.input,
                  placeholder: 'card title…',
                  'aria-label': 'new card title',
                  value: state.draftTitle,
                  onChange: (event: { currentTarget: { value: string } }) => model.setBoardDraftTitle(event.currentTarget.value),
                }),
                h('input', {
                  style: S.input,
                  placeholder: 'description (optional)',
                  'aria-label': 'new card description',
                  value: state.draftDescription,
                  onChange: (event: { currentTarget: { value: string } }) => model.setBoardDraftDescription(event.currentTarget.value),
                }),
                h('select', {
                  style: S.input,
                  'aria-label': 'new card status',
                  value: state.draftStatus,
                  onChange: (event: { currentTarget: { value: string } }) => model.setBoardDraftStatus(event.currentTarget.value as BoardStatus),
                },
                  ...BOARD_STATUSES.map(s => h('option', { key: s, value: s }, s)),
                ),
                button('Add card', () => void model.addBoardCard(roomId, boardId), {
                  disabled: state.busy === 'add-card' || state.draftTitle.trim() === '',
                }),
              ),
            ),
          retry,
          'boards.get',
        )
  return h(
    'div',
    { className: 'cx-tab cx-tab-board' },
    h(
      'div',
      { style: S.row },
      roomId !== null
        ? h(
            'span',
            { style: S.muted },
            text('room {0}', clip(roomId, 16)),
          )
        : muted('select a room from the Rooms tab first, then pick a board'),
      button('refresh', retry, { disabled: roomId === null || boardId === null }),
    ),
    body,
  )
}

// ----------------------------------------------------------------- prompts --

export function PromptsTab(props: { state: PanelState['prompts']; model: PanelModel }): ReactNode {
  const { state, model } = props
  const rows = state.list.kind === 'ready' || state.list.kind === 'error' ? state.list.value?.prompts ?? [] : []
  const detail = state.detail.kind === 'ready' ? state.detail.value : null
  const retry = () => void model.loadTab('prompts')
  const missing = state.list.kind === 'error' && pluginErrorCode(state.list.error) === 'unknown-endpoint'
  return h(
    'div',
    { className: 'cx-tab cx-tab-prompts' },
    h('div', { style: S.row }, button('refresh', retry), state.list.kind === 'loading' ? muted('loading…') : null),
    missing
      ? h('div', { style: S.error, role: 'status' }, 'prompts.list is not mounted on this host yet (wave-2 module not wired). Nothing to show — this is not an error in your data.')
      : loadView(
          state.list,
          () =>
            rows.length === 0
              ? muted('the prompt library is empty in this scope')
              : h(
                  'div',
                  { className: 'cx-prompts' },
                  ...rows.map(row =>
                    h(
                      'div',
                      { key: row.id, style: { ...S.card, marginBottom: 4 } },
                      h(
                        'div',
                        { style: S.row },
                        button(row.title ?? row.id, () => void model.selectPrompt(row.id), { kind: 'ghost' }),
                        row.category === undefined || row.category === null ? null : badge(row.category, 'track'),
                        badge(row.enabled === true ? 'enabled' : 'disabled', row.enabled === true ? 'ok' : 'warn'),
                        muted(`${String(row.bodyChars ?? row.body?.length ?? 0)} chars`),
                      ),
                      detail?.id === row.id && detail.body !== undefined ? h('pre', { style: S.pre }, detail.body) : null,
                    ),
                  ),
                ),
          retry,
          'prompts.list',
        ),
    state.detail.kind === 'error' ? h('div', { style: S.error, role: 'alert' }, text('prompts.get failed — {0}', state.detail.error.message)) : null,
  )
}

// -------------------------------------------------------------------- jobs --

function jobStatusTone(status: string): string {
  if (status === 'completed' || status === 'succeeded') return 'ok'
  if (status === 'failed' || status === 'lost' || status === 'cancelled') return 'warn'
  if (status === 'dead-letter') return 'danger'
  return 'plain'
}

/** The one honest failure reason for a row, or null when there is nothing to
 * show. `lastError` wins because it is the field that survives the `queued`
 * backoff window; a terminal job also carries the host's `error`. */
function jobFailure(job: JobRow): string | null {
  const reason = job.lastError ?? job.error ?? null
  if (typeof reason !== 'string') return null
  const trimmed = reason.trim()
  return trimmed === '' ? null : summarize(trimmed, 60)
}

export function JobsTab(props: { state: PanelState['jobs']; model: PanelModel }): ReactNode {
  const { state, model } = props
  const jobs = state.list.kind === 'ready' || state.list.kind === 'error' ? state.list.value?.jobs ?? [] : []
  const detail = state.detail.kind === 'ready' ? state.detail.value : null
  const retry = () => void model.loadTab('jobs')
  const live = (job: JobRow): boolean => job.status === 'running' || job.status === 'queued' || job.status === 'dispatched'
  return h(
    'div',
    { className: 'cx-tab cx-tab-jobs' },
    h('div', { style: S.row }, button('refresh', retry), state.list.kind === 'loading' ? muted('loading…') : null),
    loadView(
      state.list,
      () =>
        jobs.length === 0
          ? muted('no delegated jobs in this state directory')
          : h(
              'table',
              { className: 'cx-jobs', style: { borderCollapse: 'collapse', width: '100%' } },
              h(
                'tbody',
                null,
                ...jobs.map(job =>
                  h(
                    'tr',
                    { key: job.id, 'data-job': job.id },
                    h('td', null, button(job.runner, () => void model.selectJob(job.id), { kind: 'ghost' })),
                    h('td', null, badge(job.status, jobStatusTone(job.status))),
                    h('td', null, muted(`exit ${String(job.exitCode ?? '—')}`)),
                    h('td', null, muted(summarize(job.startedAt ?? '', 32))),
                    h('td', null, job.retryCount !== undefined && job.retryCount > 0
                      ? muted(`retry ${String(job.retryCount)}/${String(job.maxRetries ?? '?')}`)
                      : null),
                    // Why the last attempt died. This is the only place the
                    // reason is visible while the job sits `queued` in backoff
                    // — `error` is cleared for that window, and the `failed`
                    // transition itself lasts under a millisecond.
                    h('td', null, jobFailure(job) === null ? null : h('span', { style: { color: '#ff9d8a' } }, jobFailure(job) as string)),
                    h('td', null, live(job)
                      ? button('Cancel', () => void model.cancelJob(job.id), { kind: 'danger', title: 'jobs.cancel' })
                      : (job.status === 'dead-letter' || job.status === 'failed' || job.status === 'timeout')
                        ? button('Retry', () => void model.retryJob(job.id), { title: 'jobs.retry — creates a new job with the same runner/task' })
                        : null),
                  ),
                ),
              ),
            ),
      retry,
      'jobs.list',
    ),
    state.detail.kind === 'loading' ? muted('jobs.get loading…') : null,
    state.detail.kind === 'error' ? h('div', { style: S.error, role: 'alert' }, text('jobs.get failed — {0}', state.detail.error.message)) : null,
    detail === null ? null : h(
      'div',
      { className: 'cx-job-detail', style: S.card },
      h('div', { style: S.row }, codeText(detail.id), badge(detail.status, jobStatusTone(detail.status)), muted(detail.runner)),
      detail.task === undefined ? null : h('div', null, text(detail.task)),
      detail.error === null || detail.error === undefined ? null : h('div', { style: S.error }, text('error: {0}', detail.error)),
      jobFailure(detail) === null ? null : h('div', { style: { color: '#ff9d8a', fontSize: 12 } }, text('last failure: {0}', jobFailure(detail) as string)),
      detail.writeBack === null || detail.writeBack === undefined ? null : h('div', { style: S.muted }, text('write-back: {0}', detail.writeBack)),
      detail.retryCount !== undefined && detail.retryCount > 0 ? h('div', { style: S.muted }, text('retry {0}/{1}', String(detail.retryCount), String(detail.maxRetries ?? '?'))) : null,
      detail.nextRetryAt !== undefined ? h('div', { style: S.muted }, text('next retry: {0}', detail.nextRetryAt)) : null,
      (detail.status === 'dead-letter' || detail.status === 'failed' || detail.status === 'timeout')
        ? h('div', { style: { marginTop: 4 } }, button('Retry (new job)', () => void model.retryJob(detail.id), { title: 'jobs.retry — creates a new job with the same runner/task' }))
        : null,
    ),
    state.logs.kind === 'loading' ? muted('jobs.logs loading…') : null,
    state.logs.kind === 'error' ? h('div', { style: S.error, role: 'alert' }, text('jobs.logs failed — {0}', state.logs.error.message)) : null,
    state.logs.kind === 'ready'
      ? h(
          'div',
          { className: 'cx-logs', style: S.card },
          h('div', { style: S.row }, muted('stdout'), state.logs.value.truncated === true ? badge('truncated', 'warn') : null),
          h('pre', { style: S.pre }, state.logs.value.stdout),
          h('div', { style: S.muted }, 'stderr'),
          h('pre', { style: S.pre }, state.logs.value.stderr),
          button('reload logs', retry),
        )
      : null,
  )
}

// ---------------------------------------------------------------- decisions --

export function DecisionsTab(props: { state: PanelState['decisions']; model: PanelModel }): ReactNode {
  const { state, model } = props
  const retry = () => void model.loadTab('decisions')
  const listRows = state.list.kind === 'ready' ? state.list.value.decisions ?? [] : []
  const searchRows = state.searchHits.kind === 'ready' ? state.searchHits.value.hits ?? [] : []
  const showSearch = state.query.trim() !== ''
  const rows = showSearch ? searchRows : listRows

  return h(
    'div',
    { className: 'cx-tab cx-tab-decisions' },
    h(
      'div',
      { style: S.row },
      button('refresh', retry),
      state.list.kind === 'loading' || state.searchHits.kind === 'loading' ? muted('loading…') : null,
      h('input', {
        type: 'text',
        className: 'cx-search',
        style: { ...S.input, flex: 1, minWidth: 0 },
        placeholder: 'search decisions…',
        value: state.query,
        onInput: (e: React.FormEvent) => { void model.runDecisionSearch((e.target as HTMLInputElement).value) },
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter') { void model.runDecisionSearch((e.currentTarget as HTMLInputElement).value) }
        },
      }),
    ),
    showSearch && state.searchHits.kind === 'error'
      ? h('div', { style: S.error, role: 'alert' }, `search failed: ${state.searchHits.error.message}`)
      : null,
    !showSearch && state.list.kind === 'error'
      ? h('div', { style: S.error, role: 'alert' }, `decisions.list failed: ${state.list.error.message}`)
      : null,
    rows.length === 0
      ? muted(showSearch ? 'no decisions matched the search' : 'no decisions recorded yet — [decision] lines in project logs are indexed by cortex_decision_index_logs')
      : h(
          'div',
          { className: 'cx-decisions' },
          ...rows.map((row: any) =>
            h(
              'div',
              {
                key: row.id,
                style: { ...S.card, marginBottom: 4, cursor: 'pointer' },
                onClick: () => void model.selectDecision(row.id),
              },
              h(
                'div',
                { style: S.row },
                badge(row.timestamp?.slice(0, 10) ?? row.id.slice(0, 8), 'plain'),
                button(row.context ?? row.id, () => {}, { kind: 'ghost' }),
                row.chosen ? badge(row.chosen, 'ok') : null,
                row.owner ? muted(`by ${row.owner}`) : null,
              ),
              row.rationale ? h('div', { style: { ...S.muted, marginTop: 2 } }, row.rationale) : null,
              (row.linkedEntries ?? []).length > 0
                ? h('div', { style: { ...S.muted, marginTop: 2 } }, `linked to ${String(row.linkedEntries.length)} memory entr${row.linkedEntries.length === 1 ? 'y' : 'ies'}`)
                : null,
            ),
          ),
        ),
  )
}

// ------------------------------------------------------------------ shell ----

/** The tab strip + the one visible tab + the flash line. */
export function CortexPanelView(props: { state: PanelState; model: PanelModel }): ReactNode {
  const { state, model } = props
  const tabs: Record<TabId, ReactNode> = {
    memory: h(MemoryTab, { key: 'memory', state: state.memory, model }),
    todo: h(TodoTab, { key: 'todo', state: state.todo, model }),
    rooms: h(RoomsTab, { key: 'rooms', state: state.rooms, model }),
    board: h(BoardTab, { key: 'board', state: state.board, model }),
    decisions: h(DecisionsTab, { key: 'decisions', state: state.decisions, model }),
    prompts: h(PromptsTab, { key: 'prompts', state: state.prompts, model }),
    jobs: h(JobsTab, { key: 'jobs', state: state.jobs, model }),
  }
  return h(
    'section',
    { className: 'cx-panel', style: S.panel, 'data-cortex': 'panel' },
    h(
      'div',
      { style: S.strip, className: 'cx-tabs', role: 'tablist' },
      ...TABS.map(tab =>
        h(
          'button',
          {
            key: tab.id,
            type: 'button',
            role: 'tab',
            className: 'cx-tab-btn',
            'data-tab': tab.id,
            'aria-selected': state.tab === tab.id,
            style: { ...S.tab, ...(state.tab === tab.id ? S.tabOn : {}) },
            onClick: () => model.selectTab(tab.id),
          },
          tab.label,
        ),
      ),
    ),
    state.flash === null ? null : h(
      'div',
      { className: `cx-flash cx-flash-${state.flash.tone}`, style: state.flash.tone === 'error' ? S.error : S.ok, role: 'status' },
      text(state.flash.text),
    ),
    tabs[state.tab],
  )
}

/**
 * Hook glue: one subscription, one fetch on mount, and an error boundary below
 * so a throw inside a view becomes a line instead of a dead conversation tab.
 */
export function CortexPanel(props: { model: PanelModel }): ReactNode {
  const [snapshot, setSnapshot] = useState<PanelState>(props.model.state())
  const [crash, setCrash] = useState<string | null>(null)
  const resubscribe = useCallback(() => props.model.subscribe(() => setSnapshot(props.model.state())), [props.model])
  useEffect(() => {
    const unsubscribe = resubscribe()
    void props.model.loadTab().catch(error => setCrash(error instanceof Error ? error.message : String(error)))
    return () => {
      unsubscribe()
    }
  }, [props.model, resubscribe])
  if (crash !== null) {
    return h('section', { className: 'cx-panel', style: S.panel }, h('div', { style: S.error, role: 'alert' }, text('cortex panel failed to render: {0}', crash)))
  }
  try {
    return h(CortexPanelView, { state: snapshot, model: props.model })
  } catch (error) {
    return h('section', { className: 'cx-panel', style: S.panel }, h('div', { style: S.error, role: 'alert' }, text('cortex panel failed to render: {0}', error instanceof Error ? error.message : String(error))))
  }
}

