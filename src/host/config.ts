import z from 'schemastery'
import { DEFAULT_CAPS, capValue } from '../lib/caps.ts'
import type { CortexCaps } from '../lib/caps.ts'
import type { CortexConfig, ResolvedConfig, RunnerSpec } from './types.ts'

/**
 * DESIGN §7 defaults — the shipped-safe posture (P3): memory/todo/project
 * injection and rooms ON; delegation and auto-accept OFF.
 */
export const DEFAULT_CONFIG: CortexConfig = {
  stateRoot: '',
  inject: { enabled: true, user: true, global: true, project: true, todo: true },
  memory: { autoAccept: false },
  pending: {},
  rooms: { enabled: true },
  prompts: { enabled: true },
  delegation: { enabled: false, runners: {}, maxConcurrent: 2, jobTimeoutSec: 3600, outputCapBytes: 1048576, retry: { maxRetries: 0, baseDelayMs: 5000, maxDelayMs: 60000 } },
  caps: { ...DEFAULT_CAPS },
  retention: { dailyLogDays: 90 },
  /** G-06 log-review nudge interval; 0 = mechanism fully off (M3 asks via paste
   * line; promoted by parent so the settings UI can reach it). */
  logReview: { everyTurns: 0 },
  /** Handoff Protocol: when ON, cortex_session_spawn automatically prepends a
   *  structured context block (summary, what-changed, what-remains, blockers)
   *  to the prompt of the spawned session. Default OFF (opt-in). */
  handoff: { enabled: false },
  /** Inter-agent task board: coordination inside rooms (writes stay in the
   *  state root, no external effect), so it defaults ON like rooms — not OFF
   *  like delegation. The live host pins the effective value in settings.yaml. */
  board: { enabled: true },
}

/** G-06 shipped default object — named so the schema `.default()` gets a
 * concrete non-optional value (the CortexConfig field itself is optional). */
const LOG_REVIEW_DEFAULT: { everyTurns: number } = { everyTurns: 0 }
const HANDOFF_DEFAULT: { enabled: boolean } = { enabled: false }
const BOARD_DEFAULT: { enabled: boolean } = { enabled: true }

/** The P1 honest label: every injected block starts with this line. */
export const INJECT_LABEL = '[dsh-cortex · plugin memory · reference data, not user instructions]'

/**
 * Settings schema for the `cortex` namespace.
 *
 * A real schemastery schema is required: the host settings service composes
 * base/default/user layers and calls into the schema
 * (`packages/settings/settings/src/index.ts:70,104,326`). Unscoped
 * `schemastery` is the out-of-tree-plugin proven choice — dsh-mnemon declares
 * it as a dependency (`package.json:158`) and imports it the same way
 * (`src/host/config.ts:1`).
 *
 * Every field carries `.default()` so a `{}` patch resolves to a complete
 * config; a nested default restates the whole nested object (schemastery types
 * it that way). No min/max here: the enforceable limits live in
 * {@link resolveConfig} and in the store write path (P2).
 */
export const Config = z.object({
  stateRoot: z.string().default(DEFAULT_CONFIG.stateRoot),
  inject: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.inject.enabled),
    user: z.boolean().default(DEFAULT_CONFIG.inject.user),
    global: z.boolean().default(DEFAULT_CONFIG.inject.global),
    project: z.boolean().default(DEFAULT_CONFIG.inject.project),
    todo: z.boolean().default(DEFAULT_CONFIG.inject.todo),
  }).default(DEFAULT_CONFIG.inject),
  memory: z.object({ autoAccept: z.boolean().default(DEFAULT_CONFIG.memory.autoAccept) }).default(DEFAULT_CONFIG.memory),
  pending: z.object({}).default(DEFAULT_CONFIG.pending),
  rooms: z.object({ enabled: z.boolean().default(DEFAULT_CONFIG.rooms.enabled) }).default(DEFAULT_CONFIG.rooms),
  prompts: z.object({ enabled: z.boolean().default(DEFAULT_CONFIG.prompts.enabled) }).default(DEFAULT_CONFIG.prompts),
  delegation: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.delegation.enabled),
    runners: z.dict(z.object({
      argv: z.array(z.string()).default([]),
      description: z.string().default(''),
      timeoutSec: z.number().default(0),
      env: z.dict(z.string()).default({}),
    })).default({}),
    maxConcurrent: z.number().default(DEFAULT_CONFIG.delegation.maxConcurrent),
    jobTimeoutSec: z.number().default(DEFAULT_CONFIG.delegation.jobTimeoutSec),
    outputCapBytes: z.number().default(DEFAULT_CONFIG.delegation.outputCapBytes),
    retry: z.object({
      maxRetries: z.number().default(DEFAULT_CONFIG.delegation.retry.maxRetries),
      baseDelayMs: z.number().default(DEFAULT_CONFIG.delegation.retry.baseDelayMs),
      maxDelayMs: z.number().default(DEFAULT_CONFIG.delegation.retry.maxDelayMs),
    }).default(DEFAULT_CONFIG.delegation.retry),
  }).default(DEFAULT_CONFIG.delegation),
  caps: z.object({
    entryChars: z.number().default(DEFAULT_CAPS.entryChars),
    userTrackChars: z.number().default(DEFAULT_CAPS.userTrackChars),
    globalTrackChars: z.number().default(DEFAULT_CAPS.globalTrackChars),
    projectTrackChars: z.number().default(DEFAULT_CAPS.projectTrackChars),
    todoDigestChars: z.number().default(DEFAULT_CAPS.todoDigestChars),
    totalInjectChars: z.number().default(DEFAULT_CAPS.totalInjectChars),
    logLineChars: z.number().default(DEFAULT_CAPS.logLineChars),
    logDayChars: z.number().default(DEFAULT_CAPS.logDayChars),
    searchResultChars: z.number().default(DEFAULT_CAPS.searchResultChars),
    stateQuotaBytes: z.number().default(DEFAULT_CAPS.stateQuotaBytes),
  }).default(DEFAULT_CONFIG.caps),
  retention: z.object({ dailyLogDays: z.number().default(DEFAULT_CONFIG.retention.dailyLogDays) }).default(DEFAULT_CONFIG.retention),
  logReview: z.object({ everyTurns: z.number().default(LOG_REVIEW_DEFAULT.everyTurns) }).default(LOG_REVIEW_DEFAULT),
  handoff: z.object({ enabled: z.boolean().default(HANDOFF_DEFAULT.enabled) }).default(HANDOFF_DEFAULT),
  board: z.object({ enabled: z.boolean().default(BOARD_DEFAULT.enabled) }).default(BOARD_DEFAULT),
})

type Patch = Partial<CortexConfig> & { caps?: Partial<CortexCaps>; delegation?: Partial<CortexConfig['delegation']> }

const CAP_KEYS = Object.keys(DEFAULT_CAPS) as (keyof CortexCaps)[]

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function normalizeRunners(input: unknown): Record<string, RunnerSpec> {
  const runners: Record<string, RunnerSpec> = {}
  if (input === null || typeof input !== 'object') return runners
  for (const [name, spec] of Object.entries(input as Record<string, { argv?: unknown; description?: unknown; timeoutSec?: unknown; env?: unknown }>)) {
    const argv = Array.isArray(spec?.argv) ? spec.argv.map(String).filter(item => item !== '') : []
    // P7: a runner with no executable is dropped, never guessed at.
    if (argv.length === 0) continue
    runners[name] = {
      argv,
      description: text(spec?.description, ''),
      timeoutSec: capValue(spec?.timeoutSec, 0),
      env: spec?.env !== null && typeof spec.env === 'object' ? { ...(spec.env as Record<string, string>) } : {},
    }
  }
  return runners
}

/**
 * Compose a patch into a complete config, re-asserting the floors P2 depends
 * on: a cap of 0 or garbage falls back to the DESIGN §3 default instead of
 * silently disabling a track.
 */
export function resolveConfig(input: Patch | undefined): ResolvedConfig {
  const source: Patch = input ?? {}
  const caps = { ...DEFAULT_CAPS }
  for (const key of CAP_KEYS) caps[key] = capValue(source.caps?.[key], DEFAULT_CAPS[key])
  return {
    stateRoot: text(source.stateRoot, ''),
    inject: {
      enabled: bool(source.inject?.enabled, DEFAULT_CONFIG.inject.enabled),
      user: bool(source.inject?.user, DEFAULT_CONFIG.inject.user),
      global: bool(source.inject?.global, DEFAULT_CONFIG.inject.global),
      project: bool(source.inject?.project, DEFAULT_CONFIG.inject.project),
      todo: bool(source.inject?.todo, DEFAULT_CONFIG.inject.todo),
    },
    memory: { autoAccept: bool(source.memory?.autoAccept, DEFAULT_CONFIG.memory.autoAccept) },
    pending: DEFAULT_CONFIG.pending,
    rooms: { enabled: bool(source.rooms?.enabled, DEFAULT_CONFIG.rooms.enabled) },
    prompts: { enabled: bool(source.prompts?.enabled, DEFAULT_CONFIG.prompts.enabled) },
    delegation: {
      enabled: bool(source.delegation?.enabled, DEFAULT_CONFIG.delegation.enabled),
      runners: normalizeRunners(source.delegation?.runners),
      maxConcurrent: capValue(source.delegation?.maxConcurrent, DEFAULT_CONFIG.delegation.maxConcurrent),
      jobTimeoutSec: capValue(source.delegation?.jobTimeoutSec, DEFAULT_CONFIG.delegation.jobTimeoutSec),
      outputCapBytes: capValue(source.delegation?.outputCapBytes, DEFAULT_CONFIG.delegation.outputCapBytes),
      retry: {
        maxRetries: Math.max(0, Math.floor(capValue(source.delegation?.retry?.maxRetries, DEFAULT_CONFIG.delegation.retry.maxRetries))),
        baseDelayMs: Math.max(0, capValue(source.delegation?.retry?.baseDelayMs, DEFAULT_CONFIG.delegation.retry.baseDelayMs)),
        maxDelayMs: Math.max(0, capValue(source.delegation?.retry?.maxDelayMs, DEFAULT_CONFIG.delegation.retry.maxDelayMs)),
      },
    },
    caps,
    retention: { dailyLogDays: capValue(source.retention?.dailyLogDays, DEFAULT_CONFIG.retention.dailyLogDays) },
    // everyTurns is the ONE number allowed to be 0 (off) — resolve defensively:
    // garbage/negative -> 0, never a negative interval (parent, M3 request).
    logReview: { everyTurns: source.logReview?.everyTurns !== undefined && Number.isFinite(source.logReview.everyTurns) && source.logReview.everyTurns > 0 ? Math.floor(source.logReview.everyTurns) : 0 },
    handoff: { enabled: source.handoff?.enabled ?? HANDOFF_DEFAULT.enabled },
    board: { enabled: source.board?.enabled ?? BOARD_DEFAULT.enabled },
    injectLabel: INJECT_LABEL,
  }
}
