# First script workflow · implementation contract

Runtime: Bun + TypeScript + bun:sqlite. Frontend: accessible vanilla TypeScript, CSS; compiled by Bun. Single-user loopback app, no external deployment or video features. Shared types: src/types.ts (root owns changes).

HTTP JSON (errors {error:string}, success direct objects):
- GET /api/status -> {mode:'live'|'unconfigured', modelLabel:string}; no secrets or endpoint/model IDs.
- GET /api/projects -> Project[]
- POST /api/projects body Brief -> ProjectBundle
- GET /api/projects/:id -> ProjectBundle
- PUT /api/projects/:id body Brief -> ProjectBundle (future drafts use new brief; existing frozen context remains)
- POST /api/projects/:id/episodes body {title:string} -> ProjectBundle
- POST /api/episodes/:id/generate body {mode:'live'|'demo'} -> Revision
- POST /api/revisions/:id/review body {mode:'live'|'demo'} -> Review
- POST /api/revisions/:id/rewrite body {sceneId,instruction,mode:'live'|'demo'} -> Revision; original persists, only chosen unlocked scene may change
- POST /api/revisions/:id/edit body {title,logline,scenes:Scene[]} -> Revision; locked scenes protected (unlock via dedicated route)
- POST /api/revisions/:id/locks body {sceneId,locked:boolean} -> Revision (new revision)
- POST /api/episodes/:id/accept body {revisionId,expectedAcceptedRevisionId:string|null,expectedContextToken:string,acknowledgeReview:boolean} -> ProjectBundle; never silently replace newer acceptance; author explicitly accepts after review, manual override explicit
- GET /api/revisions/:id/export -> Markdown file

All expensive routes persist Run statuses; failures never return canned success. Demo explicitly chosen, predefined example only, never used as fallback for failed live model. Live requires server-only configuration. UI choose demonstration workflow separately, no provider/key settings.

Core agent owns src/core/*, tests/core.test.ts, docs/reuse-manifest.md. Export contracts:
- snapshotContext(brief:Brief, previousEpisodes:ContextSnapshot['previousEpisodes']):ContextSnapshot
- parseScript(raw:string):ScriptOutput (reject malformed/duplicate IDs, nonempty content)
- parseReview(raw:string,revision:Revision):Pick<Review,'status'|'assessments'|'errors'>
- buildModelMessages(request:ModelRequest):{role:'system'|'user';content:string}[]
- applySceneRewrite(base:Revision,sceneId:string,raw:string):ScriptOutput (raw JSON {scene:{id,heading,content}}; preserve others and locks)
- exportMarkdown(revision:Revision):string
- getReviewSources(revision:Revision):{id:string;text:string}[]
All exports from src/core/index.ts.

Frontend agent owns web/* only. index.html served root; JS /app.js; styles /style.css. Fetch same-origin. Selected project/episode persisted in localStorage; unsaved text preserved and navigation guard. Server stores all saved versions in SQLite. Demo action should load example via normal generate {mode:'demo'}; live main button disabled when not configured. Review view explicitly warns AI suggestions not author verdict. Compare parent vs selected candidate scenes. UI tests by root with ego-browser.

## 0.3 quality checks

Brief accepts optional `lengthTarget: {min,max,unit: words|characters}`. It participates in the frozen context and acceptance context token. Each real review makes two model requests, an independent causal pass and five-dimension review; saved Review includes `causality` and a program-computed `lengthCheck`. Partial causal evidence survives failure of the second request. Adoption outside the length range requires separate `acknowledgeLengthException:true`. See [quality behavior](script-quality.zh-CN.md).

## 0.5 vertical short drama and shot lists

Specified in [`.kiro/specs/vertical-short-drama/`](../.kiro/specs/vertical-short-drama/requirements.md).

Brief accepts optional `format: 'vertical_short_drama' | 'episodic'` and, for short drama, `durationTarget: {min,max}` in whole seconds (default 60–120). Only short drama is stored; an absent format means episodic, and episodic prompts are byte-identical to 0.4.6 (golden test `tests/fixtures/episodic-prompts.json`). Both fields are frozen in the context snapshot and the acceptance context token. Project gains `voiceLanguages` (default for short drama: script language, `en`, `zh-CN`), a production setting outside the frozen brief.

- PUT /api/projects/:id/voice-languages body {languages:string[]} -> ProjectBundle; must include the script language; no recheck, no token change
- POST /api/revisions/:id/localize and POST /api/localizations/:id/edit: for short drama, the adaptation must keep every scene's non-blank line count (502 for model output, 400 for edits)
- POST /api/revisions/:id/shot-lists body {mode:'live'|'demo'} -> ShotList; uses the writing role; binds the newest line-aligned adaptation per extra voice language; invalid output fails the run and saves nothing
- POST /api/shot-lists/:id/edit body {cast,shots,adaptations} -> ShotList; new immutable version with parentId, mode 'manual'
- POST /api/episodes/:id/production-shot-list body {shotListId,expectedShotListId:string|null} -> ProjectBundle; compare-and-swap; the list's source must be the accepted revision of an episode that does not need review
- GET /api/shot-lists/:id/export -> UTF-8 CSV with a byte order mark; formula-like cells are prefixed with an apostrophe

A shot references `firstLine`/`lastLine` positions among a scene's non-blank lines and never stores script text. Every line belongs to exactly one shot, in scene and line order. Warnings (over 15 seconds, too short for the dialogue in a bound language, several speakers, label mismatch, unassigned dialogue, misaligned adaptation line, total outside the target, missing or outdated adaptation) never block saving, adoption or export.
