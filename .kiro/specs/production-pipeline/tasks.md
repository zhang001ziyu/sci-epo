# Implementation Plan

Status: milestones 1–3 implemented except the items left open below; milestone 4 is partly verified. Milestones 1–3 make the flow usable end to end; milestone 4 verifies it with a real run.

## Milestone 1 · Before the GPU

- [x] 1. Readiness
  - [x] 1.1 Add `Shot.screenText` (parsing, the storyboard prompt, CSV export) and the `screen_text_unreadable` warning with reading-speed settings. The shot editor has no toggle yet; a shot without marks falls back to its quoted non-dialogue lines.
    - _Requirements: 1.5, 1.6_
  - [x] 1.2 Add `src/core/readiness.ts` and the checklist on the production tab, with links to where each item is fixed.
    - _Requirements: 1.1, 1.2, 1.4_
  - [x] 1.3 Require passed or confirmed items when a batch is created, and store the readiness record with the batch.
    - _Requirements: 1.3_
  - [x] 1.4 Add the five short-drama review checks, `examples/last-order-draft.json` with its expected findings, and `scripts/review-fixture.ts`. Not yet run against a live model.
    - _Requirements: 1.7, 1.8_
- [x] 2. Media store
  - [x] 2.1 Add the `media_assets` table, the media folder, streaming uploads, hashing, signature checks and the quota.
    - _Requirements: 2.1, 2.2, 2.3, 2.5_
  - [x] 2.2 Add owner upload, serving with byte ranges, and deletion; exempt the binary routes from the JSON-only rule.
    - _Requirements: 2.3, 2.4, 2.6_
  - [x] 2.3 Test kinds, limits, signatures, quota, ranges and access.
    - _Requirements: 2.2–2.6_
- [ ] 3. Cast references
  - [x] 3.1 Add portrait and voice-sample assets and `usePortrait` to profile characters; upload them and show each portrait next to its appearance text.
    - _Requirements: 3.1, 3.2, 3.4_
  - [ ] 3.2 Add portrait jobs with candidates as takes, and approval of one portrait per character.
    - _Requirements: 3.3, 3.4_
  - [x] 3.3 Record references with SHA-256 in batches, and show on earlier batches that a reference changed.
    - _Requirements: 3.5, 3.6_
- [ ] 4. Render plan v2
  - [x] 4.1 Add presets, stack references and the music mode to batches; write `N/A` music in `bed` mode.
    - _Requirements: 4.1, 4.2_
  - [x] 4.2 Add picture keys, job keys, grouping by key and output names.
    - _Requirements: 4.3_
  - [x] 4.3 Add takes with per-take seeds, retakes and approval; keep v1 batches readable.
    - _Requirements: 4.4, 4.5, 8.2_
  - [ ] 4.4 Add carry-over of approved takes.
    - _Requirements: 4.6_
  - [x] 4.5 Add `render_rates`, the compute-unit rate setting and the estimate (`GET /api/render-batches/:id/estimate`, and on each session).
    - _Requirements: 4.7_
  - [x] 4.6 Test keys, grouping, seeds, estimates and reading v1 batches.
    - _Requirements: 4.1–4.7_

## Milestone 2 · Colab session

- [x] 5. Sessions on the server
  - [x] 5.1 Add `render_sessions` and session tokens: the code shown once, reissue, expiry and revocation.
    - _Requirements: 5.1, 5.2_
  - [x] 5.2 Add the session worker endpoints: session document, worker program, references, events, claim, heartbeat, file uploads, result and end.
    - _Requirements: 5.1, 5.4, 6.1, 6.4, 7.1–7.3_
  - [x] 5.3 Add the budget, stop, waiting for retakes, lost sessions, not-current batches and undelivered takes.
    - _Requirements: 6.3–6.9_
  - [x] 5.4 Add the session panel: estimate, budget, code and steps, live stages, stop and readings.
    - _Requirements: 4.7, 5.2, 6.2, 6.4, 10.1_
  - [x] 5.5 Add the worker-only listener (`SCIEPO_WORKER_PORT`) and `SCIEPO_WORKER_PUBLIC_URL` for a Sci-epo on the author's computer.
    - _Requirements: 5.8_
  - [x] 5.6 Test token scope, expiry, claim order, leases, budget, stop, lost sessions and uploads with a fake clock.
    - _Requirements: 5.1, 6.3–6.9_
- [ ] 6. Worker
  - [ ] 6.1 Write the stack profiles and workflows for H3 LITE R2V (done), H3 LITE T2VA and the SDXL portrait at the pinned ComfyUI commit, and compare their wiring with the official templates.
    - _Requirements: 5.4_
  - [x] 6.2 Add setup: GPU check, pinned ComfyUI, the model files of the stacks in use, node check and progress events.
    - _Requirements: 5.4, 5.5, 5.6, 6.1_
  - [x] 6.3 Add the session loop: claim, render, heartbeats, stop and interrupt, budget, the two-failure rule, uploads with retry, and the end.
    - _Requirements: 6.3–6.6, 6.8, 6.9_
  - [x] 6.4 Add QA: probes, loudness, silences, contact sheet, keyframes, and speech recognition with line scores.
    - _Requirements: 7.1–7.4_
  - [ ] 6.5 Add portrait rendering with SDXL (open), and rehearsal takes (done).
    - _Requirements: 3.3, 11.1_
  - [x] 6.6 Add token scrubbing; test against fake Sci-epo and ComfyUI servers, and run QA on synthetic clips when ffmpeg is installed.
    - _Requirements: 5.7, 6.5, 6.6_
- [x] 7. Add `worker/colab/sciepo_session.ipynb` with one cell, and keep the old notebook as the advanced path.
  - _Requirements: 5.3, 5.9_
- [x] 8. Add review to the production tab: the job panel with video, contact sheet, keyframes, checks and lines; approve and retake; separate counts.
  - _Requirements: 8.1–8.3_

## Milestone 3 · Cut and delivery

- [x] 9. Cuts
  - [x] 9.1 Add `src/core/cut.ts`: cut lists, gains, caption extraction and wrapping, and ffmpeg arguments.
    - _Requirements: 9.1, 9.4, 9.6, 9.7_
  - [x] 9.2 Add the cut runner on the Sci-epo host: ffmpeg detection, the queue, automatic draft cuts, final cuts, not-current cuts and recovery after a restart.
    - _Requirements: 9.2, 9.3, 9.5, 9.8_
  - [x] 9.3 Add the cut view: player, caption editor, music choice, output size and sign-off.
    - _Requirements: 9.5–9.8_
  - [x] 9.4 Test argument building with hostile caption text, gains, the queue with a fake ffmpeg, and one real cut of synthetic clips when ffmpeg is installed.
    - _Requirements: 9.1–9.8_
- [x] 10. Add session summaries, the cut report and publication manifest schema 2 with delivered languages.
  - _Requirements: 10.1–10.3, 11.2_
- [x] 11. Add `docs/production.md` as the production guide (the bridge guide stays for v1 modes); add ffmpeg, fonts, the media folder, backups and body limits to `docs/self-hosting.md` and the deploy templates; update the README. The steering note that calls video later work is left to the author.
  - _Requirements: 5.2, 5.3_

## Milestone 4 · Verification

- [ ] 12.1 Rehearse end to end on a local server (done 2026-11-12: a real episode of 10 jobs, every QA check passed) and on a Colab CPU runtime (open).
  - _Requirements: 11.1, 11.2_
- [ ] 12.2 Run one live session on G4 with a reviewed episode. Check the estimate, clips without music under `N/A`, the release and 0 compute units per hour afterwards, and compare time and compute units with the first run.
  - _Requirements: 4.2, 4.7, 6.5_

## Later

- Offline session packages for runtimes with no network path to Sci-epo: package with references and the worker program, and upload of the output folder.
- Push sessions: the worker behind a quick tunnel, Sci-epo polling and fetching files, and release after Sci-epo confirms receipt.
- Standing sessions for global worker tokens, so always-on GPU machines upload takes too.
- Dialogue subtitles timed from speech recognition of the cut.
- Voice references cut from approved takes.
- Visual checks: rotation, garbled text, likeness to the portrait.
- Music generation, a Google Drive mirror of the media, and several looks per character.
