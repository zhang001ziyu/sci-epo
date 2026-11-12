import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHORT_DRAMA_REVIEW_RULES } from '../src/core/formatPrompts';
import { dialoguePositions, scriptLines } from '../src/core/scriptLines';
import { DIMENSIONS } from '../src/types';

const fixture = JSON.parse(readFileSync(join(import.meta.dir, '..', 'examples', 'last-order-draft.json'), 'utf8')) as {
  brief: Record<string, unknown>; scenes: {id: string; heading: string; content: string}[];
  expected_findings: {id: string; dimensions: string[]; scene: string; quote: string; problem: string; keywords: string[]}[];
};

describe('the flawed Last Order draft', () => {
  test('is a playable short-drama script with labelled dialogue on its own lines', () => {
    expect(fixture.brief.format ?? 'vertical_short_drama').toBe('vertical_short_drama');
    for (const scene of fixture.scenes) {
      const lines = scriptLines(scene.content);
      expect(lines.length).toBeGreaterThan(3);
      expect(dialoguePositions(scene.content).size).toBeGreaterThan(0);
      for (const line of lines) expect(line).not.toMatch(/^[A-Z]{2,}$/u);
    }
  });

  test('every expected finding quotes the draft and names review dimensions', () => {
    const ids = new Set<string>();
    for (const finding of fixture.expected_findings) {
      expect(ids.has(finding.id)).toBe(false);
      ids.add(finding.id);
      const scene = fixture.scenes.find(s => s.id === finding.scene)!;
      expect(scene.content).toContain(finding.quote);
      expect(finding.dimensions.length).toBeGreaterThan(0);
      for (const d of finding.dimensions) expect(DIMENSIONS as readonly string[]).toContain(d);
      expect(finding.keywords.length).toBeGreaterThan(0);
    }
    expect([...ids]).toEqual(expect.arrayContaining(['offscreen_knowledge', 'ending_prop_late', 'relationship_unstated', 'unseen_sight_line', 'screen_text_only']));
  });

  test('the short-drama review rules ask for each kind of problem the draft has', () => {
    for (const phrase of ['场外人物', '有来源', '结尾依赖的道具', '只写在作者设定或梗概里不算', '线索', '看得到', '屏幕文字']) expect(SHORT_DRAMA_REVIEW_RULES).toContain(phrase);
  });
});
