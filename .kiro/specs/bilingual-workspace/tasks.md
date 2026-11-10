# Implementation Plan

- [x] 1. Core manuscript rules
  - [x] 1.1 Create `src/core/manuscripts.ts` with `currentAdaptation` and `otherVersionAdaptations`.
    - _Requirements: 2.2, 2.5, 4.2_
  - [x] 1.2 Add `WORKSPACE_LANGUAGES` and `notesLanguage` to `src/core/languages.ts`, and English notes to `exportLocalization` and `exportMarkdown` with the Chinese default unchanged.
    - _Requirements: 4.5, 5.1, 5.4_
  - [x] 1.3 Test the newest-adaptation rule, the short-drama alignment filter, other-version detection and both note languages.
    - _Requirements: 2.2, 2.5, 4.5_

- [x] 2. Export by language
  - [x] 2.1 Accept `?language=` on `GET /api/revisions/:id/export`, write notes in the manuscript language and include the language in the file name; write adaptation notes in the adaptation's language.
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.6_
  - [x] 2.2 Test the source export, the adaptation export, the 404 and the 400.
    - _Requirements: 4.2, 4.3, 4.4, 4.6_

- [x] 3. Workspace views
  - [x] 3.1 Create `web/manuscript.ts` with preference storage, the switch, the export control, the adaptation view and the missing panel.
    - _Requirements: 1.1, 1.2, 1.3, 2.2, 2.3, 2.4, 2.5, 2.6, 4.1, 4.3_
  - [x] 3.2 Wire the switch, the export control and the script-tab branches into `web/app.ts`; preselect the adaptation target; keep the script tab after generating from it.
    - _Requirements: 1.1, 1.4, 2.1, 2.4, 3.1, 3.3_
  - [x] 3.3 Put the preferred language first on shot-list cards.
    - _Requirements: 3.2_
  - [x] 3.4 Limit the language pickers to `WORKSPACE_LANGUAGES` while keeping stored values.
    - _Requirements: 5.1, 5.2, 5.3_
  - [x] 3.5 Add styles for the switch, the disabled export control and secondary shot-list lines.
    - _Requirements: 1.1, 3.2, 4.3_
  - [x] 3.6 Test escaping, the default selection, the missing panel, line order and the picker options.
    - _Requirements: 1.3, 2.3, 2.5, 3.2, 5.1, 5.2_

- [x] 4. Verify and document
  - [x] 4.1 Run `bun run typecheck`, `bun test ./tests` and `bun run build`, and check the episodic golden prompts.
    - _Requirements: 5.4_
  - [x] 4.2 Walk through the prepared short-drama example in a browser: switch languages, generate the missing manuscript, export both languages.
    - _Requirements: 1.1, 2.2, 2.4, 4.1_
  - [x] 4.3 Update the README feature list.
    - _Requirements: 4.1_

## Verification notes (2026-11-10)

- `bun run typecheck`, `bun test ./tests` (402 tests) and `bun run build` passed; the episodic golden prompts are unchanged.
- Browser walkthrough on a local server with a temporary database, using the prepared English short-drama example: with no preference the header marked English and offered only the English export. Choosing 中文 showed the missing-manuscript panel; loading the prepared Chinese version kept the script tab, showed the Chinese manuscript read-only with its provenance, and enabled the Chinese export, which downloaded `sci-epo-<revision>-zh-CN.md` with Chinese notes. On the shot-list tab, Chinese lines came first; switching back to English reversed the order and the script tab showed the editable English source. The choice survived a reload.
