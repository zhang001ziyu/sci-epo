# Implementation Plan

- [x] 1. Lock the episodic prompts before changing them
  - Capture `buildModelMessages` output for episodic generate, rewrite, localize, causality and five-dimension review requests in `tests/fixtures/episodic-prompts.json`.
  - Add a test asserting that the current output equals the fixture.
  - _Requirements: 1.3, 12.1_

- [x] 2. Series format and duration target
  - [x] 2.1 Add `Format`, `DurationTarget` and the optional `Brief` fields, and create `src/core/formats.ts` with parsing, defaults and the aspect ratio.
    - _Requirements: 1.1, 1.4, 6.4_
  - [x] 2.2 Freeze `format` and `durationTarget` in `snapshotContext`, include them in `contextToken` only when present, and accept them in the `brief()` validator.
    - _Requirements: 1.3, 1.5, 1.6_
  - [x] 2.3 Apply the defaults in `POST /api/projects` and `PUT /api/projects/:id`, treating a missing format as episodic.
    - _Requirements: 1.3, 1.4, 1.6_
  - [x] 2.4 Test parsing, freezing, unchanged tokens for existing series, and token changes after a format or duration edit.
    - _Requirements: 1.3, 1.5, 1.6, 12.1_

- [x] 3. Short-drama writing and review instructions
  - [x] 3.1 Write `SHORT_DRAMA_CRAFT_GUIDANCE`, the short-drama intro and `durationInstruction`, and route generation and rewriting through `studioIntro` and `craftGuidance`.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2_
  - [x] 3.2 Write `SHORT_DRAMA_REVIEW_RULES` and route the five-dimension review through `reviewGuidance`.
    - _Requirements: 4.1, 4.2, 4.3_
  - [x] 3.3 Test that short-drama prompts carry each rule, that the episodic golden prompts are unchanged, and that the word or character length check still applies.
    - _Requirements: 1.3, 2.6, 4.3_

- [x] 4. Voice languages and line-aligned adaptations
  - [x] 4.1 Create `src/core/scriptLines.ts` with script lines, inline and label-only speaker labels, dialogue positions, `requireLineAlignment` and `minimumSpeechSeconds`.
    - _Requirements: 5.4, 8.2, 8.4, 8.5, 8.6_
  - [x] 4.2 Add `voiceLanguages` to projects, with creation defaults and `PUT /api/projects/:id/voice-languages`.
    - _Requirements: 5.1, 5.2_
  - [x] 4.3 Add `SHORT_DRAMA_ADAPTATION_RULES` and numbered lines to short-drama adaptation requests, and enforce alignment in the localize and localization-edit routes for short drama only.
    - _Requirements: 5.3, 5.4, 5.5_
  - [x] 4.4 Test label detection, alignment errors, speech estimates, the voice-language route without recheck marking, and unchanged episodic adaptations.
    - _Requirements: 5.2, 5.4, 5.5_

- [x] 5. Shot-list core
  - [x] 5.1 Add the shot-list types and `parseShotList` with every integrity rule.
    - _Requirements: 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4_
  - [x] 5.2 Add `shotTexts`, `shotListWarnings`, `shotListStatus`, `splitShot` and `mergeWithNext`.
    - _Requirements: 5.7, 5.8, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 9.1, 9.3_
  - [x] 5.3 Add `exportShotListCsv`.
    - _Requirements: 10.1, 10.2, 10.3, 10.4_
  - [x] 5.4 Add `buildStoryboardMessages` and the `storyboard` branch in `buildModelMessages`.
    - _Requirements: 3.1, 3.2, 6.2, 6.3_
  - [x] 5.5 Test acceptance, each rejection rule, each warning kind, split and merge keeping IDs, and the CSV encoding.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 9.1, 10.1, 10.2, 10.3_

- [x] 6. Server storage and routes
  - [x] 6.1 Add the `shot_lists` table, `shotLists` in bundles, and the `storyboard` kind in requests, runs and attempts, and map that kind to the writing role.
    - _Requirements: 6.5, 12.1, 12.2_
  - [x] 6.2 Add `POST /api/revisions/:id/shot-lists`, which binds adaptations.
    - _Requirements: 5.6, 6.1, 6.5, 6.6_
  - [x] 6.3 Add `POST /api/shot-lists/:id/edit`.
    - _Requirements: 5.6, 9.1_
  - [x] 6.4 Add `POST /api/episodes/:id/production-shot-list` with compare-and-swap.
    - _Requirements: 9.2, 9.3, 9.5_
  - [x] 6.5 Add `GET /api/shot-lists/:id/export`.
    - _Requirements: 10.1, 10.2, 10.3, 10.4_
  - [x] 6.6 Test generation, failed runs without demo substitution, edit versions, adoption conflicts and currency, export headers, and writing-role routing.
    - _Requirements: 6.1, 6.5, 6.6, 9.1, 9.2, 9.3, 9.5, 10.1, 12.2_

- [x] 7. Demonstration example
  - [x] 7.1 Write the short-drama example in English and line-aligned Simplified Chinese, its prepared shot list, and the short-drama example brief.
    - _Requirements: 2.7, 6.7_
  - [x] 7.2 Extend the demo provider for short-drama generation, adaptation and storyboard, and test that the prepared shot list passes `parseShotList` in both languages.
    - _Requirements: 2.7, 5.4, 6.7_

- [x] 8. Browser
  - [x] 8.1 Add the format and duration fields, the format-specific example brief, the short-drama default for new series, and genre-neutral titles.
    - _Requirements: 1.1, 1.2, 1.4, 2.7, 11.5_
  - [x] 8.2 Add the voice-language checklist to the languages tab.
    - _Requirements: 5.2_
  - [x] 8.3 Create `web/shotList.ts` with the read view:
    - scene groups and shot cards with aspect-ratio frames;
    - lines in each language, warnings and totals;
    - status, generation, version select, adoption and export.
    - _Requirements: 5.7, 5.8, 8.7, 9.3, 9.4, 11.1, 11.2, 11.3, 11.4_
  - [x] 8.4 Add edit mode:
    - field edits, split and merge, and cast edits;
    - the choice of bound adaptation;
    - validated local drafts and saving a new version.
    - _Requirements: 9.1, 11.3_
  - [x] 8.5 Add the 分镜表 labels for the new stage and run kind, and the card styles.
    - _Requirements: 11.1_
  - [x] 8.6 Test that the view escapes model text and renders the right aspect ratio.
    - _Requirements: 11.2, 11.4_

- [x] 9. Documentation and final checks
  - [x] 9.1 Update the README positioning and `docs/implementation-contract.md` with the new routes and rules, and add the shot-list conventions to `.kiro/steering/episode-continuity.md`.
    - _Requirements: 11.5_
  - [x] 9.2 Run `typecheck`, the full test suite and `build` on Windows, and record the counts.
    - _Requirements: 12.3_
