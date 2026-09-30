/**
 * FROZEN ORACLE — the pre-sprint-2 renderer, copied verbatim from
 * `src/host/modules/memory/render.ts` at commit 9053341 (branch
 * perf/sprint1-c1-c2), before H1 changed `fitLines` and the ceiling loop.
 *
 * It exists for ONE reason: to prove the faster implementation is
 * behaviour-identical instead of merely plausible. `h1-render-equivalence.spec.ts`
 * runs both over randomised inputs and compares every output field.
 *
 * Do NOT "keep it in sync" with the module under test — that would delete the
 * comparison. Update it only on purpose, with the new commit named here.
 */
import { neutralize } from '../../src/lib/sanitize.ts'
import { orderForRender, selectForBranch } from '../../src/host/store.ts'
import type { Entry, Track } from '../../src/host/types.ts'
import { INJECT_FOOTER, RENDER_TRACKS, memoryHeader } from '../../src/host/modules/memory/render.ts'
import type { AssembleInput, AssembleResult, TrackLoad } from '../../src/host/modules/memory/render.ts'

interface Section {
  track: Track
  title: string
  budget: number
  lines: string[]
  kept: string[]
  omitted: number
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length
}

function entryLine(entry: Entry): string {
  const bits = [`i${entry.importance}`]
  if (Array.isArray(entry.branches) && entry.branches.length > 0) bits.push(`branch:${entry.branches.map(item => neutralize(String(item))).join(',')}`)
  if (entry.origin !== undefined && entry.origin !== 'user') bits.push(`from:${neutralize(String(entry.origin))}`)
  if (Array.isArray(entry.tags) && entry.tags.length > 0) bits.push(entry.tags.map(item => `#${neutralize(String(item))}`).join(' '))
  return `- [${neutralize(String(entry.id))}] (${bits.join(' · ')}) ${neutralize(String(entry.content ?? ''))}`
}

function sectionTitle(track: Track, tracks: TrackLoad): string {
  if (track !== 'project') return `### ${track}`
  const pid = typeof tracks.pid === 'string' ? `${tracks.pid.slice(0, 8)}…` : 'no project'
  const branch = tracks.branch === null ? 'branch unknown' : `branch ${neutralize(tracks.branch)}`
  return `### project (${pid}, ${branch})`
}

function omissionLine(count: number): string {
  return `[… ${count} more entries omitted — see Cortex panel]`
}

export function legacyFitLines(lines: readonly string[], budget: number): { kept: string[]; omitted: number } {
  if (lines.length === 0) return { kept: [], omitted: 0 }
  if (budget <= 0) return { kept: [], omitted: lines.length }
  if (lines.join('\n').length <= budget) return { kept: [...lines], omitted: 0 }
  for (let count = lines.length - 1; count >= 0; count -= 1) {
    const kept = lines.slice(0, count)
    if ([...kept, omissionLine(lines.length - count)].join('\n').length <= budget) return { kept, omitted: lines.length - count }
  }
  return { kept: [], omitted: lines.length }
}

/** Byte-identical to the pre-H1 `assembleBlock`, renamed only. */
export function legacyAssembleBlock(input: AssembleInput): AssembleResult {
  const { config, tracks } = input
  const caps = config.caps
  const label = neutralize(String(config.injectLabel))
  const enabled = input.enabled ?? { user: true, global: true, project: true }
  const budgetOf: Record<Track, number> = {
    user: caps.userTrackChars,
    global: caps.globalTrackChars,
    project: caps.projectTrackChars,
  }
  const sections: Section[] = RENDER_TRACKS
    .filter(track => enabled[track] === true)
    .map(track => {
      const entries = orderForRender(selectForBranch(tracks[track], tracks.branch))
      return {
        track,
        title: sectionTitle(track, tracks),
        budget: Math.max(0, Math.floor(budgetOf[track])),
        lines: entries.map(entryLine),
        kept: [],
        omitted: 0,
      }
    })
  for (const section of sections) {
    const fitted = legacyFitLines(section.lines, section.budget)
    section.kept = fitted.kept
    section.omitted = fitted.omitted
  }

  const notices: string[] = []
  if (tracks.error !== undefined) notices.push(`[…] memory read failed: ${neutralize(tracks.error)} — some tracks may be missing.`)
  if (tracks.truncated && (input.listCap ?? 0) > 0) {
    notices.push(`[…] a track listing hit the ${input.listCap}-entry read cap, so more entries exist than were read — narrow with cortex_memory_search`)
  }

  const compose = (): { body: string; included: number; omitted: number } => {
    const parts: string[] = [...notices]
    let included = 0
    let omitted = 0
    for (const section of sections) {
      included += section.kept.length
      omitted += section.omitted
      if (section.kept.length === 0 && section.omitted === 0) continue
      parts.push(section.title)
      parts.push(...section.kept)
      if (section.omitted > 0) parts.push(omissionLine(section.omitted))
    }
    return { body: parts.length === 0 ? '(no memories stored yet)' : parts.join('\n'), included, omitted }
  }

  const build = (): { text: string; included: number; omitted: number } => {
    const composed = compose()
    const header = memoryHeader(composed.included, bytesOf(composed.body))
    return { text: [label, header, composed.body, INJECT_FOOTER].join('\n'), included: composed.included, omitted: composed.omitted }
  }

  const ceiling = Math.max(0, Math.floor(caps.totalInjectChars))
  let current = build()
  for (let guard = 0; current.text.length > ceiling && guard < 10000; guard += 1) {
    const donor = [...sections].reverse().find(section => section.kept.length > 0)
    if (donor === undefined) break
    donor.kept.pop()
    donor.omitted += 1
    current = build()
  }
  let block = current.text
  if (block.length > ceiling) block = ceiling <= 1 ? '' : `${block.slice(0, ceiling - 1)}…`
  return {
    block,
    included: current.included,
    omitted: current.omitted,
    truncated: tracks.truncated || current.omitted > 0,
    bytes: bytesOf(block),
  }
}
