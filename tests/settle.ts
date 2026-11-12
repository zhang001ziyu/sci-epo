import { shortDramaDemoLedger } from '../src/server/shortDramaDemo';
import type { Store } from '../src/server/store';
import type { LogicCheck } from '../src/types';

/** Script before video: records a passing live logic check for an accepted revision, so tests can reach shot lists,
 * the bible and render batches without a model. The ledger is the prepared example's; the gate only reads findings. */
export function settleScript(store: Store, episodeId: string, revisionId: string): LogicCheck {
  return store.insert('logic_checks', {id: crypto.randomUUID(), revisionId, episodeId, mode: 'live', ledger: shortDramaDemoLedger('en'), findings: [], createdAt: new Date().toISOString()});
}
