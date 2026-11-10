import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { episodicPromptCases } from './fixtures/episodic-prompt-cases';

test('episodic series receive exactly the instructions captured before format presets existed', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/episodic-prompts.json', import.meta.url), 'utf8'));
  expect(episodicPromptCases()).toEqual(golden);
});
