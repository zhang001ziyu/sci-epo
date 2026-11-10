/** Which text is "the manuscript" of a revision in a given language.
 * Shared by the script tab, the export route and new shot lists, so all three agree. */
import type { Localization, Revision } from '../types';
import { isShortDrama } from './formats';
import { isLineAligned } from './scriptLines';

/** The newest adaptation of this exact revision in this language; for short drama, only line-aligned ones count. */
export function currentAdaptation(revision: Revision, localizations: Localization[], language: string): Localization | undefined {
  const shortDrama = isShortDrama(revision.context.brief);
  return localizations.filter(l => l.sourceRevisionId === revision.id && l.language === language && (!shortDrama || isLineAligned(revision, l))).at(-1);
}

/** Adaptations in this language that belong to other revisions of the same episode: out of date for this one. */
export function otherVersionAdaptations(revision: Revision, revisions: Revision[], localizations: Localization[], language: string): Localization[] {
  const siblings = new Set(revisions.filter(r => r.episodeId === revision.episodeId && r.id !== revision.id).map(r => r.id));
  return localizations.filter(l => l.language === language && siblings.has(l.sourceRevisionId));
}
