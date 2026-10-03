/**
 * Panel state model (`conversation.view` tab strip), framework-free.
 *
 * Why a plain store and not React state spread through the components: the
 * rules worth testing — fetch-on-mount, refresh-per-tab, a write followed by a
 * re-read, spawn gating on `sessions.status.canSpawn`, message paging by seq,
 * "an RPC failure becomes an inline state, never a throw" — are all in here,
 * and they are testable by calling the model with the mock transport. The React
 * layer (`panel.ts`) then has exactly one job: render a snapshot and forward
 * clicks.
 *
 * Every action is `async`, every async action ends in a state transition, and
 * no path leaves the model in a state where a tab shows a stale `ready` value
 * with a live error.
 */
import type {
  ActionResult,
  BoardCard,
  BoardComment,
  BoardStatus,
  BoardRow,
  BoardsGetValue,
  BoardsListValue,
  CortexApi,
  CortexError,
  JobDetail,
  JobLogsValue,
  JobsListValue,
  MemoryEntry,
  MemoryListValue,
  MemorySearchValue,
  PendingItem,
  PendingListValue,
  PromptRow,
  PromptsListValue,
  RoomsListValue,
  RoomsReadValue,
  RoomMember,
  RoomMemberState,
  RoomsStatusValue,
  SessionsStatusValue,
  TodoItem,
  TodoListValue,
  TodoTrack,
  Track,
  CortexResult,
  CortexScope,
  MemoryFilter,
  DecisionsListValue,
  DecisionsSearchValue,
} from './api.ts'
import { memoryFilterArgs, nestedScope, roomStateOf, scopeFields } from './api.ts'

/** One async slot. `error` wins over an older `value` on purpose. */
export type Load<T> = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error'; error: CortexError; value?: T }

export type TabId = 'memory' | 'todo' | 'rooms' | 'board' | 'decisions' | 'prompts' | 'jobs'

export const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'memory', label: 'Memory' },
  { id: 'todo', label: 'Todo' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'board', label: 'Board' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'jobs', label: 'Jobs' },
]

export interface MemoryState {
  list: Load<MemoryListValue>
  pending: Load<PendingListValue>
  search: Load<MemorySearchValue>
  filter: MemoryFilter
  query: string
  busyId: string | null
  /** ID of the entry whose deletion is pending user confirmation. */
  confirmDeleteId: string | null
}

export interface TodoState {
  list: Load<TodoListValue>
  openOnly: boolean
  busyId: string | null
  /** The track the next added todo goes to. */
  track: TodoTrack
  /** The add box. Controlled: the view has no refs, so a test can read it back. */
  draft: string
}

export interface RoomsState {
  list: Load<RoomsListValue>
  status: Load<SessionsStatusValue>
  selectedId: string | null
  /** Page 0 is the newest; later pages are older, by seq. */
  messages: Load<RoomsReadValue>
  pages: RoomsReadValue['messages'][]
  earliestSeq: number | null
  loadingOlder: boolean
  members: Load<RoomsStatusValue>
  busy: string | null
  /** The spawn form is a disclosure; the GATE is `sessions.status.canSpawn`. */
  showSpawn: boolean
  newRoomTitle: string
  postDraft: string
  spawnLabel: string
  spawnPrompt: string
}

export interface PromptsState {
  list: Load<PromptsListValue>
  detail: Load<PromptRow>
  selectedId: string | null
}

export interface DecisionsState {
  list: Load<DecisionsListValue>
  searchHits: Load<DecisionsSearchValue>
  query: string
  selectedId: string | null
}

export interface JobsState {
  list: Load<JobsListValue>
  selectedId: string | null
  detail: Load<JobDetail>
  logs: Load<JobLogsValue>
}

export interface BoardState {
  /** Lists of boards per room — keyed by roomId. */
  boardsByRoom: Record<string, Load<BoardsListValue>>
  /** The currently active board view. */
  active: Load<BoardsGetValue>
  /** Which room+board combo is being viewed. */
  roomId: string | null
  boardId: string | null
  /** The card add form. */
  draftTitle: string
  draftDescription: string
  draftStatus: BoardStatus
  busy: string | null
}

export interface PanelState {
  tab: TabId
  /** One-shot notice line under the tab strip; a write result or a refusal. */
  flash: { tone: 'ok' | 'error'; text: string } | null
  memory: MemoryState
  todo: TodoState
  rooms: RoomsState
  prompts: PromptsState
  board: BoardState
  decisions: DecisionsState
  jobs: JobsState
}

/** The scope the panel asks the host with: the session this view belongs to. */
export interface PanelScopeSource {
  current(): CortexScope
}

export interface PanelModel {
  state(): PanelState
  subscribe(listener: () => void): () => void
  selectTab(tab: TabId): void
  refresh(): Promise<void>
  /** Fetch what the currently visible tab needs. Safe to call twice. */
  loadTab(tab?: TabId): Promise<void>

  setMemoryFilter(filter: MemoryFilter): Promise<void>
  setMemoryQuery(query: string): void
  runMemorySearch(): Promise<void>
  archiveMemory(id: string): Promise<void>
  restoreMemory(id: string): Promise<void>
  /** Request deletion — second call with the same id confirms it. */
  deleteMemory(id: string): Promise<void>
  cancelDelete(): void
  approvePending(id: string): Promise<void>
  rejectPending(id: string): Promise<void>

  setTodoOpenOnly(openOnly: boolean): Promise<void>
  setTodoTrack(track: TodoTrack): void
  setTodoDraft(draft: string): void
  addTodo(draft?: string): Promise<void>
  completeTodo(id: string): Promise<void>
  uncompleteTodo(id: string): Promise<void>
  removeTodo(id: string): Promise<void>

  selectRoom(roomId: string): Promise<void>
  loadOlderMessages(): Promise<void>
  setSpawnVisible(visible: boolean): void
  setRoomField(field: 'newRoomTitle' | 'postDraft' | 'spawnLabel' | 'spawnPrompt', value: string): void
  createRoom(title?: string): Promise<void>
  postToRoom(roomId?: string, message?: string): Promise<void>
  spawnMember(input?: { roomId: string; label: string; prompt: string }): Promise<void>
  /** Whether the spawn button may be enabled, and WHY not — from the host answer. */
  spawnGate(): { allowed: boolean; reason: string }
  spawnMember(input: { roomId: string; label: string; prompt: string }): Promise<void>

  selectPrompt(id: string): Promise<void>

  runDecisionSearch(query: string): Promise<void>
  selectDecision(id: string): Promise<void>

  selectJob(jobId: string): Promise<void>
  cancelJob(jobId: string): Promise<void>
  retryJob(jobId: string): Promise<void>

  setBoardRoom(roomId: string): void
  selectBoard(roomId: string, boardId: string): void
  setBoardDraftTitle(title: string): void
  setBoardDraftDescription(desc: string): void
  setBoardDraftStatus(status: BoardStatus): void
  addBoardCard(roomId: string, boardId: string): Promise<void>
  moveBoardCard(roomId: string, boardId: string, cardId: string, status: BoardStatus): Promise<void>
  commentBoardCard(roomId: string, boardId: string, cardId: string): Promise<void>
  deleteBoard(roomId: string, boardId: string): Promise<void>

  dispose(): void
}

const MEMORY_FILTERS: readonly MemoryFilter[] = ['all', 'user', 'global', 'project', 'archived']
const TODO_TRACKS: readonly TodoTrack[] = ['life', 'work', 'daily', 'project']

function errorOf<T>(error: CortexError, previous?: T): Load<T> {
  return { kind: 'error', error, ...(previous === undefined ? {} : { value: previous }) }
}

function valueOf<T>(load: Load<T>): T | undefined {
  return load.kind === 'ready' ? load.value : load.kind === 'error' ? load.value : undefined
}

export const filterArgs = memoryFilterArgs
/**
 * The page the host answers with is the newest `limit` messages after
 * `sinceSeq`; paging "older" therefore asks for a WIDER window and keeps what
 * precedes what is already shown (no `beforeSeq` exists on the endpoint).
 */
const MESSAGE_PAGE = 50

export function createPanelModel(api: CortexApi, scope: PanelScopeSource = { current: () => ({}) }): PanelModel {
  const listeners = new Set<() => void>()
  let state: PanelState = {
    tab: 'memory',
    flash: null,
    memory: {
      list: { kind: 'idle' },
      pending: { kind: 'idle' },
      search: { kind: 'idle' },
      filter: 'all',
      query: '',
      busyId: null,
      confirmDeleteId: null,
    },
    todo: { list: { kind: 'idle' }, openOnly: true, busyId: null, track: 'project', draft: '' },
    rooms: {
      list: { kind: 'idle' },
      status: { kind: 'idle' },
      selectedId: null,
      messages: { kind: 'idle' },
      pages: [],
      earliestSeq: null,
      loadingOlder: false,
      members: { kind: 'idle' },
      busy: null,
      showSpawn: false,
      newRoomTitle: '',
      postDraft: '',
      spawnLabel: '',
      spawnPrompt: '',
    },
    prompts: { list: { kind: 'idle' }, detail: { kind: 'idle' }, selectedId: null },
    decisions: { list: { kind: 'idle' }, searchHits: { kind: 'idle' }, query: '', selectedId: null },
    board: {
      boardsByRoom: {},
      active: { kind: 'idle' },
      roomId: null,
      boardId: null,
      draftTitle: '',
      draftDescription: '',
      draftStatus: 'backlog',
      busy: null,
    },
    jobs: { list: { kind: 'idle' }, selectedId: null, detail: { kind: 'idle' }, logs: { kind: 'idle' } },
  }
  let disposed = false
  const loaded = new Set<TabId>()

  function emit(): void {
    if (disposed) return
    for (const listener of listeners) listener()
  }

  function patch(next: Partial<PanelState>): void {
    // After `dispose()` an in-flight reply has nowhere to go: dropping it here
    // (rather than mutating a state nobody reads) is what makes an unmount
    // actually stop the model.
    if (disposed) return
    state = { ...state, ...next }
    emit()
  }

  function flash(tone: 'ok' | 'error', message: string): void {
    patch({ flash: { tone, text: message } })
  }

  // In-flight guards: two clicks must not interleave two writes for one row.
  function busy<T>(run: () => Promise<T>): Promise<T | undefined> {
    return run().catch(error => {
      // A transport that THREW (not answered) is still just a state transition.
      patch({ flash: { tone: 'error', text: error instanceof Error ? error.message : String(error) } })
      return undefined
    })
  }

  // ------------------------------------------------------------- memory ----

  async function loadMemory(): Promise<void> {
    const filter = state.memory.filter
    patch({ memory: { ...state.memory, list: { kind: 'loading' }, pending: { kind: 'loading' } } })
    const scopeNow = scope.current()
    const list = await api.memoryList({ ...memoryFilterArgs(filter), ...scopeFields(scopeNow) })
    const pending = await api.pendingList('pending')
    patch({
      memory: {
        ...state.memory,
        list: list.ok ? { kind: 'ready', value: list.value } : errorOf(list.error, valueOf(state.memory.list)),
        pending: pending.ok ? { kind: 'ready', value: pending.value } : errorOf(pending.error, valueOf(state.memory.pending)),
      },
    })
    loaded.add('memory')
  }

  async function runMemorySearch(): Promise<void> {
    const query = state.memory.query.trim()
    if (query === '') {
      patch({ memory: { ...state.memory, search: { kind: 'idle' } } })
      return
    }
    patch({ memory: { ...state.memory, search: { kind: 'loading' } } })
    const scopeNow = scope.current()
    const result = await api.memorySearch({ query, includeArchive: state.memory.filter === 'archived', ...scopeFields(scopeNow) })
    patch({ memory: { ...state.memory, search: result.ok ? { kind: 'ready', value: result.value } : errorOf(result.error) } })
  }

  async function archiveMemory(id: string): Promise<void> {
    await setEntryBusy(id, () => api.memoryArchive(id), 'archived')
  }

  async function restoreMemory(id: string): Promise<void> {
    await setEntryBusy(id, () => api.memoryRestore(id), 'restored')
  }

  async function deleteMemory(id: string): Promise<void> {
    if (state.memory.confirmDeleteId !== id) {
      // First click: arm the confirmation state so the UI can show the confirm bar.
      patch({ memory: { ...state.memory, confirmDeleteId: id } })
      return
    }
    // Second click: the confirm button fires — call the API to delete.
    patch({ memory: { ...state.memory, busyId: id, confirmDeleteId: null } })
    const result = await api.memoryDelete(id)
    patch({ memory: { ...state.memory, busyId: null } })
    if (result.ok === false) {
      flash('error', result.error.message)
      return
    }
    flash('ok', `deleted ${id}`)
    await loadMemory()
  }

  function cancelDelete(): void {
    patch({ memory: { ...state.memory, confirmDeleteId: null } })
  }

  async function setEntryBusy(id: string, action: () => Promise<CortexResult<ActionResult>>, verb: string): Promise<void> {
    patch({ memory: { ...state.memory, busyId: id } })
    const result = await action()
    patch({ memory: { ...state.memory, busyId: null } })
    if (result.ok === false) {
      flash('error', result.error.message)
      return
    }
    flash('ok', `${verb} ${id}`)
    await loadMemory()
  }

  async function decidePending(id: string, kind: 'approve' | 'reject'): Promise<void> {
    patch({ memory: { ...state.memory, busyId: id } })
    const result = kind === 'approve' ? await api.pendingApprove(id) : await api.pendingReject(id)
    patch({ memory: { ...state.memory, busyId: null } })
    if (result.ok === false) {
      flash('error', result.error.message)
      return
    }
    const decided = result.value
    flash('ok', `${kind === 'approve' ? 'approved' : 'rejected'} ${decided.kind ?? 'proposal'} ${id}${decided.entryId === undefined ? '' : ` → ${decided.entryId}`}`)
    await loadMemory()
  }

  // ---------------------------------------------------------------- todo ----

  async function loadTodo(): Promise<void> {
    patch({ todo: { ...state.todo, list: { kind: 'loading' } } })
    const scopeNow = scope.current()
    const result = await api.todoList(nestedScope({ openOnly: state.todo.openOnly }, scopeNow))
    patch({ todo: { ...state.todo, list: result.ok ? { kind: 'ready', value: result.value } : errorOf(result.error, valueOf(state.todo.list)) } })
    loaded.add('todo')
  }

  async function addTodo(override?: string): Promise<void> {
    const trimmed = (override ?? state.todo.draft).trim()
    if (trimmed === '') {
      flash('error', 'nothing to add')
      return
    }
    patch({ todo: { ...state.todo, draft: '' } })
    const scopeNow = scope.current()
    const result = await api.todoAdd(nestedScope({ track: state.todo.track, text: trimmed }, scopeNow))
    if (result.ok === false) {
      flash('error', result.error.message)
      return
    }
    flash('ok', `added to ${result.value.track ?? state.todo.track}`)
    await loadTodo()
  }

  async function setTodoDone(id: string, done: boolean): Promise<void> {
    const scopeNow = scope.current()
    patch({ todo: { ...state.todo, busyId: id } })
    const result = done ? await api.todoComplete(id, scopeNow) : await api.todoUncomplete(id, scopeNow)
    patch({ todo: { ...state.todo, busyId: null } })
    if (result.ok === false) {
      flash('error', result.error.message)
      return
    }
    await loadTodo()
  }

  async function removeTodo(id: string): Promise<void> {
    patch({ todo: { ...state.todo, busyId: id } })
    const result = await api.todoRemove(id, scope.current())
    patch({ todo: { ...state.todo, busyId: null } })
    if (result.ok === false) {
      flash('error', result.error.message)
      return
    }
    flash('ok', `removed ${id}`)
    await loadTodo()
  }

  // --------------------------------------------------------------- rooms ----

  async function loadRooms(): Promise<void> {
    patch({ rooms: { ...state.rooms, list: { kind: 'loading' }, status: { kind: 'loading' } } })
    const [list, status] = await Promise.all([api.roomsList(), api.sessionsStatus()])
    patch({
      rooms: {
        ...state.rooms,
        list: list.ok ? { kind: 'ready', value: list.value } : errorOf(list.error, valueOf(state.rooms.list)),
        status: status.ok ? { kind: 'ready', value: status.value } : errorOf(status.error, valueOf(state.rooms.status)),
      },
    })
    loaded.add('rooms')
    const selected = state.rooms.selectedId
    const rooms = list.ok === true ? list.value.rooms : []
    if (rooms.length === 0) {
      patch({ rooms: { ...state.rooms, selectedId: null, messages: { kind: 'idle' }, pages: [], earliestSeq: null } })
      return
    }
    const keep = selected !== null && rooms.some(room => room.id === selected) ? selected : rooms[0].id
    await openRoom(keep)
  }

  function roomMembersOf(roomId: string | null): RoomMember[] {
    if (roomId === null) return []
    const rooms = valueOf(state.rooms.list)
    const room = rooms?.rooms.find(item => item.id === roomId)
    return room === undefined ? [] : room.members.map(member => ({ ...member, status: roomStateOf(member.status) }))
  }

  async function loadRoomStatus(roomId: string): Promise<void> {
    const result = await api.roomsStatus(roomId)
    patch({ rooms: { ...state.rooms, members: result.ok ? { kind: 'ready', value: result.value } : errorOf(result.error) } })
  }

  async function openRoom(roomId: string): Promise<void> {
    patch({ rooms: { ...state.rooms, selectedId: roomId, messages: { kind: 'loading' }, pages: [], earliestSeq: null, members: { kind: 'idle' } } })
    const result = await api.roomsRead(roomId, undefined, MESSAGE_PAGE)
    if (result.ok === false) {
      patch({ rooms: { ...state.rooms, messages: errorOf(result.error), loadingOlder: false } })
      return
    }
    const messages = result.value.messages
    patch({
      rooms: {
        ...state.rooms,
        messages: { kind: 'ready', value: result.value },
        pages: [messages],
        earliestSeq: messages.length > 0 ? messages[0].seq : null,
        loadingOlder: false,
      },
    })
    await loadRoomStatus(roomId)
  }

  /**
   * Point the Board tab at `roomId`, dropping any board opened in another one:
   * a board id is only meaningful inside its own room, and carrying it across
   * would have `boards.get` ask for a board the new room does not have. A
   * re-select of the SAME room is a no-op, so refreshing never closes the board
   * the user is looking at.
   */
  function armBoardRoom(roomId: string): void {
    if (state.board.roomId === roomId) return
    patch({ board: { ...state.board, roomId, boardId: null, active: { kind: 'idle' } } })
  }

  async function selectRoom(roomId: string): Promise<void> {
    // The Board tab is a second view onto the same room, and its empty state
    // asks the user to pick one here first — this is where that comes from.
    // The board LIST is fetched when the Board tab is opened, not on every
    // room click, so switching rooms costs no extra round trip.
    armBoardRoom(roomId)
    await busy(() => openRoom(roomId))
  }

  async function loadOlderMessages(): Promise<void> {
    const roomId = state.rooms.selectedId
    const earliest = state.rooms.earliestSeq
    if (roomId === null || earliest === null || earliest <= 1 || state.rooms.loadingOlder) return
    patch({ rooms: { ...state.rooms, loadingOlder: true } })
    const wanted = state.rooms.pages.flat().length + MESSAGE_PAGE
    const result = await api.roomsRead(roomId, undefined, Math.min(100, wanted))
    if (result.ok === false) {
      patch({ rooms: { ...state.rooms, loadingOlder: false } })
      flash('error', result.error.message)
      return
    }
    const known = new Set(state.rooms.pages.flat().map(message => message.seq))
    const older = result.value.messages.filter(message => !known.has(message.seq) && message.seq < earliest)
    if (older.length === 0) {
      patch({ rooms: { ...state.rooms, loadingOlder: false } })
      flash('ok', 'no older messages — the endpoint returns the newest window only')
      return
    }
    const sorted = [...older].sort((a, b) => a.seq - b.seq)
    patch({
      rooms: {
        ...state.rooms,
        pages: [...state.rooms.pages, sorted],
        earliestSeq: sorted[0].seq,
        loadingOlder: false,
      },
    })
  }

  async function createRoom(override?: string): Promise<void> {
    const trimmed = (override ?? state.rooms.newRoomTitle).trim()
    if (trimmed === '') {
      flash('error', 'a room needs a title')
      return
    }
    patch({ rooms: { ...state.rooms, newRoomTitle: '' } })
    patch({ rooms: { ...state.rooms, busy: 'create' } })
    const result = await api.roomsCreate(trimmed)
    patch({ rooms: { ...state.rooms, busy: null } })
    if (result.ok === false) {
      flash('error', result.error.message)
      return
    }
    flash('ok', result.value.message ?? 'room created')
    await loadRooms()
  }

  async function postToRoom(roomId?: string, message?: string): Promise<void> {
    const target = roomId ?? state.rooms.selectedId
    const trimmed = (message ?? state.rooms.postDraft).trim()
    if (target === null || target === undefined || trimmed === '') return
    patch({ rooms: { ...state.rooms, postDraft: '' } })
    patch({ rooms: { ...state.rooms, busy: `post:${roomId}` } })
    const result = await api.roomsPost(target, trimmed)
    patch({ rooms: { ...state.rooms, busy: null } })
    if (result.ok === false) {
      flash('error', result.error.message)
      return
    }
    await openRoom(target)
  }

  /**
   * Spawn is gated on the host, never on a guess: the button is disabled unless
   * the LAST `sessions.status` answer said `canSpawn === true` (a client plugin
   * cannot create sessions — `rooms.spawn` is a host-side `agents.create`).
   */
  function spawnGate(): { allowed: boolean; reason: string } {
    const status = state.rooms.status
    if (status.kind === 'loading') return { allowed: false, reason: 'checking whether this host can spawn…' }
    if (status.kind === 'error') return { allowed: false, reason: `sessions.status failed: ${status.error.message}` }
    if (status.kind === 'idle') return { allowed: false, reason: 'sessions.status has not answered yet' }
    if (status.value.canSpawn !== true) {
      return { allowed: false, reason: status.value.reason ?? 'this host does not expose an agent-spawn service to plugins' }
    }
    return { allowed: true, reason: '' }
  }

  async function spawnMember(override?: { roomId: string; label: string; prompt: string }): Promise<void> {
    const gate = spawnGate()
    if (!gate.allowed) {
      flash('error', gate.reason)
      return
    }
    const input = override ?? { roomId: state.rooms.selectedId ?? '', label: state.rooms.spawnLabel, prompt: state.rooms.spawnPrompt }
    if (input.roomId === '' || input.label.trim() === '' || input.prompt.trim() === '') {
      flash('error', 'spawn needs a room, a label and a prompt')
      return
    }
    patch({ rooms: { ...state.rooms, busy: 'spawn' } })
    const result = await api.roomsSpawn({ roomId: input.roomId, label: input.label.trim(), prompt: input.prompt })
    patch({ rooms: { ...state.rooms, busy: null, showSpawn: false } })
    if (result.ok === false) {
      flash('error', result.error.message)
      return
    }
    flash('ok', result.value.message ?? `spawned ${result.value.sessionId ?? 'session'}`)
    patch({ rooms: { ...state.rooms, spawnLabel: '', spawnPrompt: '' } })
    await loadRooms()
  }

  // ------------------------------------------------------------- prompts ----

  async function loadPrompts(): Promise<void> {
    patch({ prompts: { ...state.prompts, list: { kind: 'loading' } } })
    const result = await api.promptsList()
    patch({ prompts: { ...state.prompts, list: result.ok ? { kind: 'ready', value: result.value } : errorOf(result.error, valueOf(state.prompts.list)) } })
    loaded.add('prompts')
  }

  async function selectPrompt(id: string): Promise<void> {
    patch({ prompts: { ...state.prompts, selectedId: id, detail: { kind: 'loading' } } })
    const result = await api.promptsGet(id)
    patch({ prompts: { ...state.prompts, detail: result.ok ? { kind: 'ready', value: result.value } : errorOf(result.error) } })
  }

  // ---------------------------------------------------------------- jobs ----

  async function loadJobs(): Promise<void> {
    patch({ jobs: { ...state.jobs, list: { kind: 'loading' } } })
    const result = await api.jobsList()
    patch({ jobs: { ...state.jobs, list: result.ok ? { kind: 'ready', value: result.value } : errorOf(result.error, valueOf(state.jobs.list)) } })
    loaded.add('jobs')
    const selected = state.jobs.selectedId
    const jobs = result.ok === true ? result.value.jobs : []
    if (jobs.length === 0) {
      patch({ jobs: { ...state.jobs, selectedId: null, detail: { kind: 'idle' }, logs: { kind: 'idle' } } })
      return
    }
    if (selected === null || !jobs.some(job => job.id === selected)) await openJob(jobs[0].id)
  }

  async function openJob(jobId: string): Promise<void> {
    patch({ jobs: { ...state.jobs, selectedId: jobId, detail: { kind: 'loading' }, logs: { kind: 'loading' } } })
    const [detail, logs] = await Promise.all([api.jobsGet(jobId), api.jobsLogs(jobId)])
    patch({
      jobs: {
        ...state.jobs,
        detail: detail.ok ? { kind: 'ready', value: detail.value } : errorOf(detail.error),
        logs: logs.ok ? { kind: 'ready', value: logs.value } : errorOf(logs.error),
      },
    })
  }

  async function cancelJob(jobId: string): Promise<void> {
    patch({ jobs: { ...state.jobs, selectedId: jobId } })
    const result = await api.jobsCancel(jobId)
    if (result.ok === false) {
      flash('error', result.error.message)
      return
    }
    flash('ok', result.value.message ?? `cancelled ${jobId}`)
    await loadJobs()
  }

  async function retryJob(jobId: string): Promise<void> {
    patch({ jobs: { ...state.jobs, selectedId: jobId } })
    const result = await api.jobsRetry(jobId)
    if (result.ok === false) {
      flash('error', result.error.message)
      return
    }
    flash('ok', result.value.message ?? `retried ${jobId}`)
    await loadJobs()
  }

  // ---------------------------------------------------------------- board --

  async function loadBoard(): Promise<void> {
    const roomId = state.board.roomId
    if (roomId === null) return
    const prev = state.board.boardsByRoom[roomId] ?? { kind: 'idle' }
    patch({ board: { ...state.board, boardsByRoom: { ...state.board.boardsByRoom, [roomId]: { kind: 'loading' } } } })
    const result = await api.boardsList(roomId)
    patch({
      board: {
        ...state.board,
        boardsByRoom: { ...state.board.boardsByRoom, [roomId]: result.ok ? { kind: 'ready', value: result.value } : errorOf(result.error, valueOf(prev)) },
      },
    })
    loaded.add('board')
  }

  async function openBoard(roomId: string, boardId: string): Promise<void> {
    patch({
      board: {
        ...state.board, roomId, boardId,
        active: { kind: 'loading' },
        draftTitle: '', draftDescription: '', draftStatus: 'backlog',
      },
    })
    const result = await api.boardsGet(roomId, boardId, { includeComments: true })
    patch({
      board: { ...state.board, active: result.ok ? { kind: 'ready', value: result.value } : errorOf(result.error) },
    })
  }

  async function addBoardCard(roomId: string, boardId: string): Promise<void> {
    const title = (state.board.draftTitle ?? '').trim()
    if (title === '') { flash('error', 'a card needs a title'); return }
    patch({ board: { ...state.board, busy: 'add-card' } })
    const result = await api.boardsAddCard({
      roomId,
      boardId,
      title,
      description: state.board.draftDescription?.trim() || undefined,
      status: state.board.draftStatus,
    })
    patch({ board: { ...state.board, busy: null, draftTitle: '' } })
    if (result.ok === false) { flash('error', result.error.message); return }
    flash('ok', `card ${result.value?.id ?? 'added'}`)
    await openBoard(roomId, boardId)
  }

  async function moveBoardCard(roomId: string, boardId: string, cardId: string, status: BoardStatus): Promise<void> {
    const result = await api.boardsMoveCard({ roomId, boardId, cardId, status })
    if (result.ok === false) { flash('error', result.error.message); return }
    flash('ok', `card moved to ${status}`)
    await openBoard(roomId, boardId)
  }

  async function commentBoardCard(roomId: string, boardId: string, cardId: string): Promise<void> {
    const text = (state.board.draftDescription ?? '').trim()
    if (text === '') { flash('error', 'a comment needs text'); return }
    const result = await api.boardsComment({ roomId, boardId, cardId, text })
    if (result.ok === false) { flash('error', result.error.message); return }
    flash('ok', 'comment added')
    await openBoard(roomId, boardId)
  }

  async function deleteBoard(roomId: string, boardId: string): Promise<void> {
    const result = await api.boardsDelete({ roomId, boardId })
    if (result.ok === false) { flash('error', result.error.message); return }
    flash('ok', `board ${boardId} deleted`)
    await loadBoard()
    patch({ board: { ...state.board, roomId: null, boardId: null, active: { kind: 'idle' } } })
  }

  // ----------------------------------------------------------- decisions ----

  async function loadDecisions(): Promise<void> {
    patch({ decisions: { ...state.decisions, list: { kind: 'loading' } } })
    const query = state.decisions.query.trim()
    if (query === '') {
      patch({ decisions: { ...state.decisions, searchHits: { kind: 'idle' } } })
      const result = await api.decisionsList()
      patch({ decisions: { ...state.decisions, list: result.ok ? { kind: 'ready', value: result.value } : errorOf(result.error, valueOf(state.decisions.list)) } })
    } else {
      patch({ decisions: { ...state.decisions, searchHits: { kind: 'loading' } } })
      const result = await api.decisionsSearch(query)
      patch({ decisions: { ...state.decisions, searchHits: result.ok ? { kind: 'ready', value: result.value } : errorOf(result.error) } })
    }
    loaded.add('decisions')
  }

  async function runDecisionSearch(query: string): Promise<void> {
    patch({ decisions: { ...state.decisions, query } })
    await loadDecisions()
  }

  async function selectDecision(id: string): Promise<void> {
    patch({ decisions: { ...state.decisions, selectedId: id } })
  }

  // ------------------------------------------------------------ dispatch ----

  async function loadTab(tab: TabId = state.tab): Promise<void> {
    if (tab === 'memory') return loadMemory()
    if (tab === 'todo') return loadTodo()
    if (tab === 'rooms') return loadRooms()
    if (tab === 'board') return loadBoard()
    if (tab === 'decisions') return loadDecisions()
    if (tab === 'prompts') return loadPrompts()
    return loadJobs()
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    selectTab(tab) {
      if (tab === state.tab && loaded.has(tab)) return
      patch({ tab })
      void loadTab(tab)
    },
    refresh() {
      loaded.add(state.tab)
      return loadTab(state.tab)
    },
    loadTab,

    async setMemoryFilter(filter) {
      const next = MEMORY_FILTERS.includes(filter) ? filter : 'all'
      patch({ memory: { ...state.memory, filter: next } })
      await loadMemory()
    },
    setMemoryQuery(query) {
      patch({ memory: { ...state.memory, query } })
    },
    runMemorySearch: () => busy(runMemorySearch),
    archiveMemory: id => busy(() => archiveMemory(id)),
    restoreMemory: id => busy(() => restoreMemory(id)),
    deleteMemory: id => busy(() => deleteMemory(id)),
    cancelDelete,
    approvePending: id => busy(() => decidePending(id, 'approve')),
    rejectPending: id => busy(() => decidePending(id, 'reject')),

    async setTodoOpenOnly(openOnly) {
      patch({ todo: { ...state.todo, openOnly } })
      await loadTodo()
    },
    setTodoDraft(draft) {
      patch({ todo: { ...state.todo, draft } })
    },
    setRoomField(field, value) {
      patch({ rooms: { ...state.rooms, [field]: value } })
    },
    setTodoTrack(track) {
      patch({ todo: { ...state.todo, track: TODO_TRACKS.includes(track) ? track : state.todo.track } })
    },
    addTodo: textValue => busy(() => addTodo(textValue)),
    completeTodo: id => busy(() => setTodoDone(id, true)),
    uncompleteTodo: id => busy(() => setTodoDone(id, false)),
    removeTodo: id => busy(() => removeTodo(id)),

    setBoardRoom(roomId: string): void { armBoardRoom(roomId); void loadBoard() },
    selectBoard(roomId: string, boardId: string): void { openBoard(roomId, boardId) },
    setBoardDraftTitle(title: string): void { patch({ board: { ...state.board, draftTitle: title } }) },
    setBoardDraftDescription(desc: string): void { patch({ board: { ...state.board, draftDescription: desc } }) },
    setBoardDraftStatus(status: BoardStatus): void { patch({ board: { ...state.board, draftStatus: status } }) },
    addBoardCard: (roomId, boardId) => busy(() => addBoardCard(roomId, boardId)),
    moveBoardCard: (roomId, boardId, cardId, status) => busy(() => moveBoardCard(roomId, boardId, cardId, status)),
    commentBoardCard: (roomId, boardId, cardId) => busy(() => commentBoardCard(roomId, boardId, cardId)),
    deleteBoard: (roomId, boardId) => busy(() => deleteBoard(roomId, boardId)),

    spawnGate,
    selectRoom,
    createRoom: title => busy(() => createRoom(title)),
    postToRoom: (roomId, message) => busy(() => postToRoom(roomId, message)),
    loadOlderMessages: () => busy(loadOlderMessages),
    setSpawnVisible(visible) {
      patch({ rooms: { ...state.rooms, showSpawn: visible } })
    },
    spawnMember: input => busy(() => spawnMember(input)),

    selectPrompt,

    runDecisionSearch,
    selectDecision,

    async selectJob(jobId) {
      await busy(() => openJob(jobId))
    },
    cancelJob: jobId => busy(() => cancelJob(jobId)),
    retryJob: jobId => busy(() => retryJob(jobId)),

    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}

export function memberStatus(member: { status?: unknown; state?: unknown }): RoomMemberState {
  return roomStateOf(member.status ?? member.state)
}

export type { MemoryEntry, PendingItem, TodoItem }
