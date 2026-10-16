/**
 * One place that owns the plugin's RPC error vocabulary.
 *
 * The host parses every reply with `serverResponseSchema.parse(...)`
 * (packages/client/connection/src/client/rpc.ts:47) — a THROW, not a soft
 * failure. Its `error.code` is a discriminated union of exactly 40 members
 * (packages/host/apiproxy/src/api/rpc.schema.ts:34), and that strictness is
 * deliberate: the same file notes that `value` is kept wide on purpose so a
 * plugin can return any shape it likes ("business layer does the second
 * parse", rpc.schema.ts:92), while the code is not.
 *
 * The host's 40 codes are all session / workspace / agent / attachment
 * vocabulary. It has no slot for a plugin's own domain errors, so this plugin
 * must project onto it. Emitting a code outside the list does not degrade
 * gracefully — the whole reply fails to parse, and the caller sees a zod dump
 * instead of the message. That is how a plain `not-wired` refusal once reached
 * the browser as ~2 kB of schema noise.
 *
 * So: the plugin keeps its own small vocabulary (it is more informative), and
 * this module maps it onto the host's. The plugin's own code is preserved in
 * the message, which the host does not police, so nothing is lost.
 */
import type { RpcResult } from './dsh.ts'

/**
 * The codes this plugin uses internally, mapped to a host `RpcErrorCode`.
 *
 * SECOND attempt; the first was wrong in a way only a live refusal could show.
 * The schema's discriminator is `code`, but every branch also REQUIRES a
 * `details` object with a PER-CODE shape ("details is required",
 * rpc.schema.ts:32). 36 of the 40 codes demand specific keys — `bad-request`
 * wants `issues: ZodIssue[]`, which a domain refusal has no honest form for —
 * so `bad-request` is unusable here even though it reads as the right code.
 *
 * Four codes accept an EMPTY details object and are the only ones a plugin can
 * fill without inventing host-shaped data. Two of them are ours:
 *
 *   `command-error`  the request named something that cannot be done; the
 *                    least-wrong home for a domain refusal
 *   `internal`       WE are at fault — the module never started, the handler
 *                    threw. Blaming the caller for our broken wiring sends
 *                    them looking in the wrong place
 *
 * `cancelled` and `unknown-command` fit neither and stay unused.
 */
const HOST_CODE_BY_PLUGIN_CODE: Readonly<Record<string, string>> = {
  // The arguments are wrong. Still not the HOST's `bad-request`: that branch
  // demands `details.issues`, and inventing a ZodIssue[] to satisfy it would be
  // fabricating host-shaped data. Same meaning, a code we can actually fill.
  'bad-request': 'command-error',
  // Domain refusals: the thing asked for is absent, off, or not allowed.
  'not-found': 'command-error',
  'disabled': 'command-error',
  'disabled-prompt': 'command-error',
  'refused': 'command-error',
  'unknown-endpoint': 'command-error',
  'unsupported-kind': 'command-error',
  'bad-confirm': 'command-error',
  'confirm-required': 'command-error',
  'no-session': 'command-error',
  // Our own faults.
  'no-approver': 'internal',
  'not-wired': 'internal',
  'handler-failed': 'internal',
  'approve-failed': 'internal',
  'purge-failed': 'internal',
  'write-failed': 'internal',
}

/** Codes the host accepts. Transcribed from rpcErrorSchema; see the tests that pin it. */
export const HOST_RPC_ERROR_CODES: readonly string[] = [
  'bad-request', 'cancelled', 'session-not-found', 'model-unavailable', 'session-conflict',
  'invalid-time-zone', 'workspace-attach-failed', 'workspace-not-found', 'workspace-invalid-path',
  'workspace-name-conflict', 'workspace-move-invalid', 'directory-unreadable', 'directory-exists',
  'directory-create-failed', 'directory-picker-unavailable', 'agent-preset-read-only',
  'agent-preset-locked', 'agent-preset-conflict', 'agent-preset-not-found', 'agent-preset-invalid',
  'agent-busy', 'attachment-error', 'queue-item-not-found', 'steer-unavailable', 'command-error',
  'unknown-command', 'credential-rejected',
  'model-discovery-failed', 'title-invalid', 'fork-unavailable', 'subagent-parent-unavailable',
  'subagent-not-found', 'subagent-catalog-diagnostic', 'subagent-not-resumable',
  'subagent-unauthorized', 'subagent-delivery-unavailable', 'internal',
]

/** The plugin's own vocabulary, for tests that assert no call site invents another. */
export const PLUGIN_RPC_ERROR_CODES: readonly string[] = Object.keys(HOST_CODE_BY_PLUGIN_CODE)

/**
 * The ONLY host codes this plugin may send: the four whose `details` schema is
 * the empty object, so there is nothing to invent. Transcribed from
 * rpcErrorSchema — the other 36 require per-code keys, and picking one of those
 * means fabricating host-shaped data to satisfy a validator.
 */
export const HOST_CODES_WITH_EMPTY_DETAILS: readonly string[] = [
  'cancelled', 'command-error', 'unknown-command', 'internal',
]

/**
 * Resolve a plugin code to one the host will accept. An unmapped code is a bug
 * in the caller, so it is reported as `internal` rather than shipped raw.
 */
export function hostErrorCode(pluginCode: string): string {
  return HOST_CODE_BY_PLUGIN_CODE[pluginCode] ?? 'internal'
}

/**
 * Build a refusal the host can actually deliver.
 *
 * @param message - what went wrong, already neutralized/clamped by the caller.
 * @param pluginCode - this plugin's code for the situation.
 * @returns an `RpcResult` whose `error.code` is in the host's set AND whose
 *          `error.details` satisfies that code's branch.
 */
export function refuse<T = unknown>(message: string, pluginCode = 'refused'): RpcResult<T> {
  const host = hostErrorCode(pluginCode)
  // The host code says WHO is at fault; the message still says WHAT happened,
  // so a refusal keeps its diagnostic value after the projection. The leading
  // `[code]` is a CONTRACT, not decoration: the client branches on
  // `unknown-endpoint` in three places (the prompts tab and both settings
  // health lines), and `error.code` can no longer carry it. Read it back with
  // the client's `pluginErrorCode` helper, never by reading `error.code`.
  const text = `[${pluginCode}] ${message}`
  // `details` is REQUIRED on every branch (rpc.schema.ts:32). Omitting it was
  // the second way this reply failed to parse: the code matched, then
  // `error.details` was missing and the whole envelope was thrown away.
  return { ok: false, error: { code: host, message: text, details: {} } }
}
