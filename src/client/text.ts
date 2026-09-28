/**
 * THE ONE TEXT-SAFE RENDERING LAYER.
 *
 * Everything the panel shows comes from disk or from another session: memory
 * content, todo text, room posts, job stderr, prompt bodies. Untrusted text can
 * contain markup or a URL shaped like chrome, so the rule here is structural
 * rather than advisory:
 *
 *   a string reaches the tree ONLY through `text(...)` / `renderParts(...)`,
 *   which produce React children — text nodes React escapes at render time.
 *
 * No HTML-injection sink exists in this directory: nothing sets inner HTML,
 * outer HTML, adjacent HTML or a contextual fragment, and no React set-HTML prop
 * is ever constructed. The exact patterns (spelled out so a grep can find them)
 * live in `test/client/security.spec.ts`, which scans every file here — and
 * therefore scans this comment — so the built bundle stays sink-free by
 * construction, not by convention.
 *
 * Interpolation keeps that property while allowing emphasis:
 *
 *   text('Archived {0}', name)   // => <>{'Archived '}<b>{name}</b></>
 *
 * `{0}` addresses an argument as DATA, never as markup, so a literal `{` inside
 * hostile content is only a character and cannot open a new hole. `renderParts`
 * is the single place a URL becomes an attribute, behind a scheme allow-list:
 * `javascript:` and over-long hrefs degrade to plain text, and the visible
 * label is still a text node.
 */
import { Fragment, createElement as h } from 'react'
import type { ReactNode } from 'react'

/** A run of untrusted text, optionally rendered as a link. */
export interface TextPart {
  text: string
  href?: string
}

/** Schemes a rendered `href` may carry; anything else degrades to plain text. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:|#|\/(?!\/))/i

/** Bound the attribute and the label: one URL must not blow out a row. */
const MAX_HREF = 2_048
const LINK_LABEL_CAP = 120

/** Bare URLs and scheme-prefixed ones, up to whitespace or a quote. */
const URL_PATTERN = /(?:https?:\/\/|mailto:|www\.)[^\s<>"']+/gi

/** `{0}`-style interpolation slot. */
const SLOT_PATTERN = /\{(\d+)\}/g

export function asString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/** Split untrusted text into parts, promoting bare URLs into link parts. */
export function textParts(input: unknown): TextPart[] {
  const raw = asString(input)
  if (raw === '') return []
  const out: TextPart[] = []
  let cursor = 0
  URL_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URL_PATTERN.exec(raw)) !== null) {
    const candidate = match[0]
    const href = /^www\./i.test(candidate) ? `https://${candidate}` : candidate
    if (!SAFE_HREF.test(href) || href.length > MAX_HREF) continue
    if (match.index > cursor) out.push({ text: raw.slice(cursor, match.index) })
    out.push({
      text: candidate.length > LINK_LABEL_CAP ? `${candidate.slice(0, LINK_LABEL_CAP)}…` : candidate,
      href,
    })
    cursor = match.index + candidate.length
  }
  if (cursor === 0) return [{ text: raw }]
  if (cursor < raw.length) out.push({ text: raw.slice(cursor) })
  return out
}

/** A safe href, or undefined. Exported so tests can probe the allow-list. */
export function safeHref(value: unknown): string | undefined {
  const raw = asString(value).trim()
  if (raw === '' || raw.length > MAX_HREF) return undefined
  return SAFE_HREF.test(raw) ? raw : undefined
}

/** Parts to children: one `<a>` per linked part, every other part a text node. */
export function renderParts(parts: readonly TextPart[]): ReactNode {
  const children: ReactNode[] = []
  for (const part of parts) {
    if (part.text === '') continue
    children.push(
      part.href === undefined
        ? part.text
        : h('a', { href: part.href, rel: 'noopener noreferrer', target: '_blank', className: 'cx-link' }, part.text),
    )
  }
  if (children.length === 0) return null
  return children.length === 1 ? children[0] : h(Fragment, null, ...children)
}

/**
 * Untrusted string (+ optional `{n}` arguments) to React children. Arguments
 * render inside `<b>` as text nodes, never as markup.
 */
export function text(value: unknown, ...interpolations: readonly unknown[]): ReactNode {
  const template = asString(value)
  if (interpolations.length === 0) return renderParts(textParts(template))
  const children: ReactNode[] = []
  let cursor = 0
  SLOT_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SLOT_PATTERN.exec(template)) !== null) {
    if (match.index > cursor) children.push(renderParts(textParts(template.slice(cursor, match.index))))
    const arg = interpolations[Number(match[1])]
    if (arg !== undefined && arg !== null && asString(arg) !== '') {
      children.push(h('b', { className: 'cx-em' }, renderParts(textParts(arg))))
    }
    cursor = match.index + match[0].length
  }
  if (cursor < template.length) children.push(renderParts(textParts(template.slice(cursor))))
  if (children.length === 0) return null
  return children.length === 1 ? children[0] : h(Fragment, null, ...children)
}

/** A `<span>` whose content went through the one path. */
export function textSpan(value: unknown, ...interpolations: readonly unknown[]): ReactNode {
  return h('span', { className: 'cx-span' }, text(value, ...interpolations))
}

/** A `<code>` whose content is still a text node. */
export function codeText(value: unknown): ReactNode {
  return h('code', { className: 'cx-code' }, text(value))
}

/** Display truncation. Full text may still go into a `title` ATTRIBUTE. */
export function clip(value: unknown, max = 400): string {
  const raw = asString(value)
  return raw.length <= max ? raw : `${raw.slice(0, max)}…`
}

/** Collapse whitespace for one-line summaries of arbitrary content. */
export function summarize(value: unknown, max = 160): string {
  return clip(asString(value).replace(/\s+/g, ' ').trim(), max)
}
