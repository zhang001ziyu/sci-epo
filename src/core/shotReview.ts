/** The author's shot-by-shot check before rendering. Browser-safe, so the shot tab and the server count the same way. */
import type { EpisodeBible, ShotList, ShotReview } from '../types';

/** The bible confirmation a shot confirmation must have seen to count; null without a confirmed bible. */
export const bibleStamp = (bible: EpisodeBible | undefined): string | null => bible?.confirmedAt ?? null;

/** Shots the author has confirmed against the current bible, and the ones still open, in shot order. */
export function reviewProgress(list: Pick<ShotList, 'shots'>, review: ShotReview | undefined, bible: EpisodeBible | undefined): {confirmed: string[]; open: string[]; outdated: string[]} {
  const stamp = bibleStamp(bible), confirmed: string[] = [], open: string[] = [], outdated: string[] = [];
  for (const shot of list.shots) {
    const entry = review?.shots[shot.id];
    if (entry && entry.bible === stamp) confirmed.push(shot.id);
    else { open.push(shot.id); if (entry) outdated.push(shot.id); }
  }
  return {confirmed, open, outdated};
}
