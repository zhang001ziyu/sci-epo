# Design Document

## Overview

The manuscript language is a browser preference, not series data. It decides which existing text the workspace shows and which text an export writes out. No new tables, no migrations and no model calls are added. The only new server behavior is an optional `language` query parameter on the existing revision export.

```
preference (localStorage) ──► shown language ──► script tab: source editor | adaptation (read-only) | missing panel
                                             ├─► languages tab: preselected adaptation target
                                             ├─► shot-list tab: line order
                                             └─► export links: /api/revisions/:id/export?language=…
```

## Core: `src/core/manuscripts.ts`

```ts
currentAdaptation(revision, localizations, language): Localization | undefined
otherVersionAdaptations(revision, revisions, localizations, language): Localization[]
```

`currentAdaptation` keeps adaptations whose `sourceRevisionId` is the revision and whose `language` matches, keeps only line-aligned ones when the frozen brief is vertical short drama, and returns the last one in storage order (the newest). This is the same rule the shot list already uses to bind adaptations, so the script tab, the export and a new shot list agree on what "current" means.

`otherVersionAdaptations` returns adaptations in that language that belong to other revisions of the same episode. The script tab mentions them as out of date and never shows their text as the open revision's manuscript.

The module imports `formats`, `scriptLines` and `languages`; none of them imports it back.

## Core: language list and export notes

`src/core/languages.ts` gains:

- `WORKSPACE_LANGUAGES`: English and Simplified Chinese, used by every picker. `LANGUAGES` stays for display names, so model instructions that name other stored languages do not change.
- `notesLanguage(code)`: `en` for English tags, otherwise `zh-CN`.
- `exportLocalization(source, target, notes = 'zh-CN')`: English notes name the language pair, the source revision and the adaptation, and say the adaptation is not yet approved by the author.

`exportMarkdown(revision, notes = 'zh-CN')` in `src/core/index.ts` gains English notes: provenance (model candidate, prepared example or author edit), language, revision and time; the length check in English; and the statement that an export is neither adoption nor accepted quality. The Chinese default is unchanged, so existing callers and tests keep their output.

## Server: export by language

`GET /api/revisions/:id/export` accepts `?language=`:

| Request | Response |
| --- | --- |
| no parameter, or the script language | the source revision, notes in the script language |
| another valid language with a current adaptation | that adaptation, notes in its language |
| another valid language without one | 404, `这一版还没有<language>稿。` |
| an invalid code | 400 |

The file name is `sci-epo-<revision>-<language>.md`. `GET /api/localizations/:id/export` keeps its path and name and writes its notes in the adaptation's language. Both routes stay behind the existing owner login.

## Web: `web/manuscript.ts`

Pure functions returning escaped HTML, plus preference storage:

- `readManuscriptPreference()` / `saveManuscriptPreference(language)` use the key `sciepo-pref:manuscript-language`. The `sciepo-pref:` prefix keeps the preference outside the `sci-epo-` keys that sign-out clears, because it holds no private content.
- `manuscriptSwitch(selected, scriptLanguage, disabled)`: two buttons with `aria-pressed`; without a preference the script language is pressed.
- `exportControl(revision, localizations)`: one link per workspace language. A language without a current adaptation renders as a disabled control whose title gives the reason.
- `adaptationView(...)`: the read-only manuscript paper with a provenance line, the note that review, rewriting, locks and adoption act on the source, and links to edit or export the adaptation.
- `missingAdaptationView(...)`: says the revision has no adaptation in that language, offers live generation (disabled without a model or with unsaved edits) and the prepared example for demonstration revisions, and mentions adaptations of other versions without showing them.

## Web: `web/app.ts` changes

- State `manuscriptLanguage` (null until chosen) and `shownLanguage()`.
- `header()` adds the switch and the export control.
- `scriptView()` shows the source editor when the shown language is the script language, otherwise the adaptation or the missing panel. The inspector stays and keeps acting on the source.
- `chooseLocalization()` preselects the shown language as the adaptation target when it differs from the script language.
- The `localize` action accepts `data-origin="script"` and stays on the script tab, so the new manuscript appears where it was requested.
- `shotContext()` passes `preferredLanguage`; `ShotListPanel.card()` lists that language first and marks the others as secondary.
- `languageOptions`, the voice-language checklist and the subtitle checklist read `WORKSPACE_LANGUAGES` and add any stored value outside it.

## Error handling

- The export link for a missing adaptation is not a link, so the browser never downloads an error body. A hand-typed URL still gets the 404 message.
- If loading an adaptation fails, the existing `run()` error banner applies; the switch itself performs no request.

## Testing

- Core: `currentAdaptation` picks the newest, ignores other revisions and, for short drama, ignores misaligned adaptations; English and Chinese notes for both export functions.
- Routes: export by language returns the adaptation with the language in the file name, 404 without an adaptation, 400 for an invalid code, and the source for the script language.
- Web: the switch marks the script language without a preference; the adaptation view escapes model text and states that review acts on the source; the missing view never shows text from another version; the shot-list card puts the preferred language first; pickers list only English and Simplified Chinese plus a stored value.
- The episodic golden prompts stay identical.
