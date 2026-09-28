/**
 * M4 · the pending side of the prompt domain.
 *
 * `cortex_prompt_save` can only file a proposal (DESIGN §4), and the by-kind
 * dispatcher in `src/host/index.ts` decides who owns which kind. This file is
 * the piece that dispatcher needs to answer `pending.approve` for kind `prompt`
 * — exported, not mounted, because the shared entry is not in this module's
 * write-set (TODO(PARENT)). The rule it keeps: a model-authored workflow enters
 * the library only through a human click, and the audit row is kept (`approve`
 * marks the proposal decided, it does not delete it).
 */
import { neutralize } from '../../../lib/sanitize.ts'
import type { CortexStore } from '../../store.ts'
import type { PendingItem, PromptDoc } from '../../types.ts'

/** What the caller needs back: the row, or the honest sentence why not. */
export interface PendingPromptDecision {
  ok: boolean
  message: string
  doc?: PromptDoc
  pendingId?: string
}

/** Proposal → `addPrompt` argument, with the same clamps the store would apply. */
export function proposalToPrompt(proposal: PendingItem['proposal']): { title: string; body: string; category?: string } | null {
  const title = String(proposal.title ?? '').trim()
  const body = String(proposal.body ?? '')
  if (title === '' || body.trim() === '') return null
  const category = String(proposal.category ?? '').trim()
  return { title, body, ...(category === '' ? {} : { category }) }
}

/**
 * Approve one `kind: 'prompt'` proposal into the library. Every failure mode
 * answers with a sentence (this is a UI click, so the message is what the panel
 * shows); nothing throws, and a proposal that was not a prompt is not touched.
 */
export async function approvePendingPrompt(store: CortexStore, item: PendingItem): Promise<PendingPromptDecision> {
  if (item.kind !== 'prompt') {
    return { ok: false, message: `pending ${item.id} is a '${item.kind}' proposal, not a prompt` }
  }
  const input = proposalToPrompt(item.proposal)
  if (input === null) return { ok: false, message: `pending ${item.id} carries no usable title/body; reject it` }
  const added = await store.addPrompt(input)
  if (!added.ok) return { ok: false, message: `could not save the prompt: ${neutralize(added.error)}` }
  const decided = await store.approvePending(item.id)
  if (!decided.ok) {
    // The prompt IS in the library; pretending otherwise would be worse than
    // reporting the split state.
    return { ok: true, doc: added.data, pendingId: item.id, message: `saved prompt ${added.data.id}, but the proposal could not be marked decided (${neutralize(decided.error)})` }
  }
  return { ok: true, doc: added.data, pendingId: item.id, message: `saved prompt ${added.data.id} from proposal ${item.id}` }
}
