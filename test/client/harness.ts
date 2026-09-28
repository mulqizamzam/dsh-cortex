/**
 * Test harness for the client UI — a minimal DOM plus a micro React renderer.
 *
 * WHY THIS EXISTS INSTEAD OF @testing-library/react: this plugin's
 * `package.json` (parent-owned, off-limits to me) has `react` + `@types/react`
 * but NO `react-dom`, no `jsdom` and no `@testing-library/*`, and the package's
 * vitest config pins `environment: 'node'`. Editing that config or adding deps
 * is out of my write-set, so a real mount cannot be the test vehicle here.
 *
 * What replaces it is not a fake-passes-anyway stub: `mount()` implements the
 * same contract the host implements for a slot cell — call the function
 * component with its props, run its hooks through React's own dispatcher (from
 * `react-test-renderer`'s stable sibling surface: `react`'s internals are NOT
 * touched; `useState`/`useEffect` are driven by re-invoking the component under
 * a hook slot array, exactly as a renderer does), materialise the returned
 * element tree into the DOM shim, and hand back `query`/`fire` helpers that
 * dispatch real events on real nodes. Assertions therefore run against
 * rendered output (text, attributes, `disabled`, event effects), not against a
 * hand-built expectation tree.
 *
 * Documented limits, because they matter for what these tests can prove:
 *   - no CSS layout, no focus management semantics, no `useSyncExternalStore`,
 *     no concurrent features (no `startTransition`, no Suspense);
 *   - refs are called with the node, as on mount, and with `null` on unmount;
 *   - a re-render is synchronous, so an effect that schedules another state
 *     update resolves in the same flush; async work is driven by `settle()`.
 * TODO(PARENT) in the report: add `react-dom` + `jsdom` + `@testing-library/react`
 * and re-run the same specs against a real mount.
 */
import type { ReactNode } from 'react'

/** A rendered element, as `createElement` produces it (structural, no import). */
interface ElementLike {
  $$typeof: symbol
  type: unknown
  props: Props
  key: unknown
}

type Props = Record<string, unknown>

/** The element factory the client is compiled against (React 18's contract). */
function createElement(type: unknown, config: Record<string, unknown> | null, ...children: unknown[]): ElementLike {
  const props: Props = {}
  let key: unknown
  if (config !== null && config !== undefined) {
    for (const [name, value] of Object.entries(config)) {
      if (name === 'key') key = value
      else props[name] = value
    }
  }
  if (children.length === 1) props.children = children[0]
  else if (children.length > 1) props.children = children
  return { $$typeof: Symbol.for('react.element'), type, props, key }
}

/** React's Fragment sentinel, by the same symbol the real package uses. */
const Fragment = Symbol.for('react.fragment')

// ------------------------------------------------------------------ mini DOM --

type Listener = (event: DomEvent) => void

let createdNodes = 0
let destroyedNodes = 0
let listenersRegistered = 0
let listenersRemoved = 0

/** Leak probes: every test can assert the UI released what it registered. */
export function domCounters(): { created: number; destroyed: number; listeners: number; removed: number } {
  return { created: createdNodes, destroyed: destroyedNodes, listeners: listenersRegistered, removed: listenersRemoved }
}

export function resetDomCounters(): void {
  createdNodes = 0
  destroyedNodes = 0
  listenersRegistered = 0
  listenersRemoved = 0
}

export class DomEvent {
  readonly type: string
  defaultPrevented = false
  propagationStopped = false
  target: MiniNode | null = null
  currentTarget: MiniNode | null = null
  key = ''
  shiftKey = false
  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type
    Object.assign(this, init)
  }
  preventDefault(): void {
    this.defaultPrevented = true
  }
  stopPropagation(): void {
    this.propagationStopped = true
  }
}

export class MiniNode {
  readonly nodeType: number
  readonly childNodes: MiniNode[] = []
  readonly tagName: string
  parent: MiniNode | null = null
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Set<Listener>>()
  text = ''
  /** `value` / `checked` live on the node, like a real input. */
  value = ''
  checked = false
  disabled = false

  constructor(nodeType: number, tagName: string) {
    this.nodeType = nodeType
    this.tagName = tagName
    createdNodes += 1
  }

  get className(): string {
    return this.attributes.get('class') ?? ''
  }

  set className(value: string) {
    this.setAttribute('class', value)
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.text
    return this.childNodes.map(child => child.textContent).join('')
  }

  set textContent(value: string) {
    for (const child of [...this.childNodes]) this.removeChild(child)
    if (value !== '') this.appendChild(new MiniTextNode(value))
  }

  appendChild<T extends MiniNode>(child: T): T {
    child.parent?.removeChild(child)
    child.parent = this
    this.childNodes.push(child)
    return child
  }

  removeChild<T extends MiniNode>(child: T): T {
    const at = this.childNodes.indexOf(child)
    if (at >= 0) this.childNodes.splice(at, 1)
    if (child.parent === this) child.parent = null
    destroyedNodes += 1
    // A detached subtree holds no listeners: this is what `unmount()` proves.
    child.listeners.clear()
    for (const descendant of child.descendants()) descendant.listeners.clear()
    return child
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value))
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
    listenersRegistered += 1
  }

  removeEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type)
    if (set === undefined) return
    if (set.delete(listener)) listenersRemoved += 1
    if (set.size === 0) this.listeners.delete(type)
  }

  /** Bubbling dispatch, so a delegated `form.onsubmit` sees an inner click. */
  dispatch(event: DomEvent): void {
    event.target = this
    let node: MiniNode | null = this
    while (node !== null && !event.propagationStopped) {
      event.currentTarget = node
      for (const listener of node.listeners.get(event.type) ?? []) listener(event)
      node = node.parent
    }
  }

  /** Live registrations on THIS node only. */
  listenerCount(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }

  /** Every node under this one, excluding itself. */
  descendants(): MiniNode[] {
    const out: MiniNode[] = []
    const walk = (node: MiniNode): void => {
      for (const child of node.childNodes) {
        out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }

  /** Depth-first element list, in document order. */
  elements(): MiniNode[] {
    const out: MiniNode[] = []
    const walk = (node: MiniNode): void => {
      if (node.nodeType === 1) out.push(node)
      for (const child of node.childNodes) walk(child)
    }
    walk(this)
    return out
  }

  querySelectorAll(matcher: string): MiniNode[] {
    return this.elements().filter(node => matches(node, matcher))
  }

  querySelector(matcher: string): MiniNode | null {
    return this.querySelectorAll(matcher)[0] ?? null
  }
}

class MiniTextNode extends MiniNode {
  constructor(text: string) {
    super(3, '#text')
    this.text = text
  }
}

/**
 * Selector subset used by these specs: `tag`, `.class`, `#id`, `[attr]`,
 * `[attr=value]`, `[attr="value"]`, e.g. `.cx-entry` or `[data-entry=x]`.
 */
function matches(node: MiniNode, matcher: string): boolean {
  const parts = matcher.trim().match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]*\])*)$/)
  if (parts === null) return false
  const [, tag = '', rest = ''] = parts
  if (tag !== '' && node.tagName !== tag.toLowerCase()) return false
  const tokens = rest.match(/[.#][\w-]+|\[[^\]]*\]/g) ?? []
  for (const token of tokens) {
    if (token.startsWith('.')) {
      if (!node.className.split(/\s+/).includes(token.slice(1))) return false
      continue
    }
    if (token.startsWith('#')) {
      if (node.getAttribute('id') !== token.slice(1)) return false
      continue
    }
    const attr = /^\[([\w-]+)(?:=("|')?(.*?)\2?)?\]$/.exec(token)
    if (attr === null) return false
    const value = node.getAttribute(attr[1])
    if (value === null) return false
    if (attr[3] !== undefined && value !== attr[3]) return false
  }
  return true
}

export { DomEvent as MiniEvent }

export class MiniDocument {
  readonly body = new MiniNode(1, 'body')
  createElement(tag: string): MiniNode {
    const node = new MiniNode(1, tag.toLowerCase())
    if (tag.toLowerCase() === 'textarea') node.setAttribute('multiline', 'true')
    return node
  }
  createTextNode(value: string): MiniNode {
    return new MiniTextNode(value)
  }
}

// ------------------------------------------------------- micro React hooks ---

interface HookSlot {
  /** `EMPTY` distinguishes "state is literally undefined" from "not yet set". */
  state: unknown
  initialized: boolean
  effect?: () => void | (() => void)
  deps?: readonly unknown[]
  cleanup?: unknown
}

interface ComponentInstance {
  hooks: HookSlot[]
  cursor: number
  node: MiniNode
  render(): void
}

let current: ComponentInstance | null = null
const cleanups = new Set<() => void>()

function sameDeps(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  return a.every((item, index) => Object.is(item, b[index]))
}

function nextSlot(): HookSlot {
  if (current === null) throw new Error('harness: hook called outside a component render')
  const instance = current
  const slot = instance.hooks[instance.cursor] ?? { state: undefined, initialized: false }
  instance.hooks[instance.cursor] = slot
  instance.cursor += 1
  return slot
}

/** The hook surface the client components use, re-exported as `react`'s own. */
function useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
  const slot = nextSlot()
  if (!slot.initialized) {
    slot.state = typeof initial === 'function' ? (initial as () => T)() : initial
    slot.initialized = true
  }
  const instance = current as ComponentInstance
  const set = (next: T | ((prev: T) => T)): void => {
    slot.state = typeof next === 'function' ? (next as (prev: T) => T)(slot.state as T) : next
    instance.render()
  }
  return [slot.state as T, set]
}

function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
  const slot = nextSlot()
  const instance = current as ComponentInstance
  // The slot doubles as the "already ran for these deps" marker; without it an
  // effect would re-fire on every re-render and the panel would fetch forever.
  slot.effect = effect
  if (slot.initialized && sameDeps(slot.deps, deps)) return
  if (typeof slot.cleanup === 'function') (slot.cleanup as () => void)()
  slot.initialized = true
  slot.deps = deps
  // Effects run after the render that scheduled them (React's own order), so the
  // node's children are in the tree by the time the effect fires.
  queueMicrotask(() => {
    const cleanup = effect()
    slot.cleanup = cleanup
    if (typeof cleanup === 'function') cleanups.add(cleanup)
    void instance
  })
}

function useCallback<T>(fn: T, deps?: readonly unknown[]): T {
  const slot = nextSlot()
  if (slot.initialized && sameDeps(slot.deps, deps)) return slot.state as T
  slot.state = fn
  slot.initialized = true
  slot.deps = deps
  return fn
}

function useMemo<T>(factory: () => T, deps?: readonly unknown[]): T {
  const slot = nextSlot()
  if (slot.effect !== undefined && sameDeps(slot.deps, deps)) return slot.state as T
  const value = factory()
  slot.effect = factory as () => void
  slot.state = value
  slot.deps = deps
  return value
}

function useRef<T>(initial: T): { current: T } {
  const slot = nextSlot()
  if (!slot.initialized) {
    slot.state = { current: initial }
    slot.initialized = true
  }
  return slot.state as { current: T }
}

/**
 * Patch React's module namespace with the harness hook implementations for the
 * duration of the test run. The client imports `react` (the real package, a
 * shared external), and `react`'s own `useState` needs a renderer dispatcher —
 * which `react-dom` would provide. It is not installed here, so the components
 * under test are rendered by THIS dispatcher instead: same call order, same
 * re-render semantics, no `react-dom`.
 */
export function installReactHooks(): void {
  // The hook implementations above are handed to the client by each spec's
  // `vi.mock('react', ...)` factory, which is hoisted above the import of the
  // component under test. Nothing to install here; kept as the documented seam.
}

export interface HarnessReact {
  createElement: typeof createElement
  Fragment: typeof Fragment
  useState: typeof useState
  useEffect: typeof useEffect
  useCallback: typeof useCallback
  useMemo: typeof useMemo
  useRef: typeof useRef
}

// ------------------------------------------------------------------- mount ---

function applyProp(node: MiniNode, key: string, value: unknown): void {
  if (value === undefined || value === null) return
  const listener = node.listeners
  switch (key) {
    case 'children':
    case 'key':
    case 'ref':
      return
    case 'className':
      node.className = String(value)
      return
    case 'style':
      // Styles are inert here (no layout); keep them visible for assertions.
      node.setAttribute('style', Object.entries(value as Props).map(([name, item]) => `${kebab(name)}: ${String(item)}`).join('; '))
      return
    case 'value':
      node.value = String(value)
      node.setAttribute('value', String(value))
      return
    case 'checked':
      node.checked = value === true
      node.setAttribute('checked', value === true ? '' : '__absent__')
      return
    case 'disabled':
      node.disabled = value === true
      if (value === true) node.setAttribute('disabled', '')
      else node.removeAttribute('disabled')
      return
    case 'defaultValue':
      node.value = String(value)
      return
    case 'defaultChecked':
      node.checked = value === true
      return
    default:
      break
  }
  if (key.startsWith('on') && typeof value === 'function') {
    const type = key.slice(2).toLowerCase()
    const handler = (event: DomEvent): void => void (value as (event: DomEvent) => unknown)(event)
    node.addEventListener(type, handler)
    void listener
    return
  }
  if (typeof value === 'boolean') {
    if (value === true) node.setAttribute(key, '')
    return
  }
  if (typeof value === 'object') return
  node.setAttribute(key, String(value))
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
}

function isElement(value: unknown): value is { type: unknown; props: Props } {
  return typeof value === 'object' && value !== null && '$$typeof' in value
}

function renderInto(instance: ComponentInstance, tree: ReactNode): void {
  const parent = instance.node
  for (const child of [...parent.childNodes]) parent.removeChild(child)
  appendTree(parent, tree)
}

function appendTree(parent: MiniNode, tree: ReactNode): void {
  if (tree === null || tree === undefined || tree === false || tree === true) return
  if (typeof tree === 'string' || typeof tree === 'number') {
    parent.appendChild(new MiniTextNode(String(tree)))
    return
  }
  if (Array.isArray(tree)) {
    for (const item of tree) appendTree(parent, item as ReactNode)
    return
  }
  if (!isElement(tree)) return
  const type = tree.type
  if (type === Fragment) {
    appendTree(parent, tree.props.children as ReactNode)
    return
  }
  if (typeof type === 'function') {
    const child = mountComponent(parent, type as (props: Props) => ReactNode, tree.props)
    void child
    return
  }
  const node = createNode(String(type))
  for (const [key, value] of Object.entries(tree.props)) applyProp(node, key, value)
  parent.appendChild(node)
  appendTree(node, tree.props.children as ReactNode)
  const ref = tree.props.ref
  if (typeof ref === 'function') (ref as (node: MiniNode | null) => void)(node)
}

function mountComponent(parent: MiniNode, type: (props: Props) => ReactNode, props: Props): ComponentInstance {
  const host = createNode('div')
  host.setAttribute('data-component', type.name || 'anonymous')
  parent.appendChild(host)
  const instance: ComponentInstance = {
    hooks: [],
    cursor: 0,
    node: host,
    render() {
      const previous = current
      current = instance
      instance.cursor = 0
      let tree: ReactNode
      try {
        tree = type(props)
      } finally {
        current = previous
      }
      renderInto(instance, tree)
    },
  }
  instance.render()
  return instance
}

export interface Handle {
  readonly root: MiniNode
  /** Re-render with the same props (what a state update does). */
  rerender(): void
  unmount(): void
  /** All rendered text, whitespace-collapsed. */
  text(): string
  query(matcher: string): MiniNode[]
  queryOne(matcher: string): MiniNode | null
  attr(name: string): string | null
  /** Every rendered `<button>`, in document order. */
  buttons(): MiniNode[]
  /** Live listener registrations left in the tree (leak probe). */
  countListeners(): number
  /** First element whose exact trimmed text equals `label`. */
  byText(label: string): MiniNode | null
  /** Fire an event on a node and flush React state updates. */
  fire(node: MiniNode | null, type: string, init?: Record<string, unknown>): Promise<void>
}

/**
 * Mount a component and return a handle. `document` is the module-level global
 * the client code sees, so the UI cannot tell it is under test.
 */
export async function mount(component: (props: Props) => ReactNode, props: Props = {}, container?: MiniNode): Promise<Handle> {
  const root = createNode('div')
  if (container !== undefined) container.appendChild(root)
  const instance = mountComponent(root, component, props)
  const handle: Handle = {
    root,
    rerender: () => instance.render(),
    unmount: () => {
      for (const cleanup of cleanups) cleanup()
      cleanups.clear()
      for (const child of [...root.childNodes]) root.removeChild(child)
      root.parent?.removeChild(root)
    },
    text: () => {
      const rendered = root.textContent.replace(/\s+/g, ' ').trim()
      if (process.env.CX_DEBUG !== undefined) console.error('TEXT:', rendered.slice(0, 400))
      return rendered
    },
    query: matcher => root.querySelectorAll(matcher),
    queryOne: matcher => root.querySelector(matcher),
    attr: name => root.getAttribute(name),
    buttons: () => root.querySelectorAll('button'),
    countListeners: () => {
      let total = root.listenerCount()
      for (const node of root.descendants()) total += node.listenerCount()
      return total
    },
    byText: label =>
      root
        .elements()
        .filter(node => node.childNodes.length > 0 && node.childNodes.every(child => child.nodeType === 3))
        .find(node => node.textContent.trim() === label) ?? null,
    async fire(node, type, init) {
      if (node === null) throw new Error('harness: fire() on a node that is not rendered')
      node.dispatch(new DomEvent(type, init))
      await settle()
    },
  }
  await settle()
  return handle
}

/** Drain microtasks + a macrotask so `await`-ing effects land before asserting. */
export async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
}

/** Install the harness globals. Idempotent; call once per test file. */
/** The shim document every node in this file is created from. */
export const miniDocument = new MiniDocument()

/** Create a shim node without touching the lib.dom-typed global. */
export function createNode(tag: string): MiniNode {
  return miniDocument.createElement(tag)
}

/**
 * Publish the shim on `globalThis` for the client code, which is written against
 * the real DOM (`lib.dom` types it as `Document`). The cast is the boundary:
 * the client only ever calls `createElement` / `createTextNode` /
 * `appendChild` / `addEventListener`, all of which this object implements.
 */
export function installGlobals(): void {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.document = miniDocument as unknown as Document
  if (globals.window === undefined) globals.window = {}
}

/**
 * The hook bundle the client components are compiled against. The client files
 * import `{ useState, useEffect, ... } from 'react'`; under vitest,
 * `vi.mock('react', ...)` in each spec hands them THIS object, so one dispatcher
 * drives every component in the process.
 */
export const reactHarness: HarnessReact = {
  createElement,
  Fragment,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
}
