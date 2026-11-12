# Requirements Document

Status: proposed. Builds on `h3-production-bridge`, whose render batches, jobs and worker modes keep working.

## Introduction

Sci-epo plans H3 render jobs from an adopted shot list and hands them to a worker. The first real H3 render of an episode, "The Last Order" in Chinese and English on a Colab G4 runtime in November 2026, produced two 79-second episodes with native dialogue. It used Sci-epo's planner and worker program but not its server flow, and it showed what the flow lacks after the script:

- The script reached the GPU without a review. Accepting a revision needs only a checkbox, and no later step reads reviews. The draft's logic problems went into the video.
- The reference portraits were made by hand outside Sci-epo. One had a hood that the character description did not mention, and the hood appeared in a clip.
- The run needed a hand-written Colab cell. The notebook installs an unpinned ComfyUI, needs a workflow exported by hand and reference files copied into Drive by hand, shows Sci-epo nothing about setup, time or cost, and never stops the runtime.
- The planner makes one job per clip and language, so the two clips without dialogue were removed from the second language by hand. One shot came out rotated by 90° in both languages, which share a seed. The only fix is a new batch, which changes every seed.
- Sci-epo never sees the videos, so the author could not find or review them, and nothing joins the clips into an episode. Music was faint or absent in most clips, and because each clip is a separate generation, any music restarts in every clip. Clip loudness ranged from −28.3 to −10.5 LUFS.
- H3 does not render reliable interface text. Text on a phone screen was partly garbled and stayed English in the Chinese episode, and a 24-word note was on screen for about 4.5 seconds.

This feature makes the steps after the script one flow, with a gate the author can see at each step:

1. **Readiness**: a checklist that keeps an unreviewed or inconsistent script away from the GPU unless the author confirms each remaining item.
2. **Cast references**: portraits and voice samples stored in Sci-epo, rendered by a worker or uploaded, and approved by the author.
3. **Render plans with job keys and takes**: identical renders happen once, a defective clip gets a retake with a new seed, and unchanged clips carry over to a new batch.
4. **Render sessions**: one Colab cell and one session code. The worker installs a pinned stack, reports progress, keeps to a time budget, can be stopped from Sci-epo, and releases the runtime when it is done.
5. **A media store** in Sci-epo for references, takes, QA images, cuts and reports.
6. **QA and review**: the same technical checks for every take, and the author's approval or retake.
7. **Cuts**: Sci-epo joins approved takes into an episode per language, with level matching, one music track, a loudness target and captions for on-screen text.
8. **Delivery**: a report and the publication manifest, which keep technical results apart from the author's verdict.

Later work, not in this feature: offline session packages for runtimes that cannot reach Sci-epo at all, push sessions to a worker behind a tunnel (the existing push mode keeps working), dialogue subtitles timed from the audio, voice references cut from approved takes, automatic visual checks, music generation, and a Google Drive mirror of the media.

## Glossary

- **Readiness checklist**: the items an episode must pass, or the author must confirm, before a render batch is created.
- **Stack profile**: a pinned set for one kind of render (H3 LITE R2V, H3 LITE T2VA, SDXL portrait): ComfyUI commit, model files, workflow, required node classes and tested GPUs.
- **Render preset**: the size, sampling steps and turbo switch of a batch, with its stack profile.
- **Job**: one render target of a batch. It serves one or more voice languages.
- **Job key**: the SHA-256 of everything that determines a job's render.
- **Picture key**: the job key without the spoken words. All languages of a clip share it.
- **Take**: one render of a job with one seed.
- **Render session**: one worker's work on one or more batches, with its own token, budget, timeline and end.
- **Session code**: the server address and the session token, shown once and pasted into the Colab cell.
- **Release**: ending the Colab runtime with `google.colab.runtime.unassign()`, so it stops using compute units.
- **Media store**: Sci-epo's folder of files named by SHA-256, with a record for each file.
- **Cut**: one batch edited in one language: one take per clip, audio and caption settings, and the resulting video. A draft cut uses the latest rendered takes; a final cut uses approved takes.
- **Sign-off**: the author's verdict that a final cut holds as content.
- **Rehearsal**: a session that renders placeholder takes without models, to check everything except H3.

## Requirements

### Requirement 1: Production readiness

**User Story:** As an author, I want to see whether an episode is ready to render and what is missing, so that an unreviewed or inconsistent script does not reach the GPU by accident.

#### Acceptance Criteria

1. The production tab SHALL show a readiness checklist with these items: the accepted revision and whether the episode needs recheck; a live review of the accepted revision without errors; each open issue of that review; a bound, line-aligned adaptation for every voice language of the batch; a current production shot list and each of its warnings; an appearance for every character in frame and a voice for every speaker; and an approved portrait for every character marked to use one.
2. The checklist SHALL show each item as passed, warning or failed, with a link to the place where the author fixes it.
3. WHEN the author creates a render batch THEN the system SHALL require every item to pass, or the author to confirm the remaining items as listed. The system SHALL store the items, the confirmation and its time with the batch.
4. An open issue SHALL be an assessment with status `issue`, or a causal check or pressure with verdict `gap`, in the newest review of the accepted revision. A newer accepted revision SHALL need its own review.
5. A shot SHALL be able to mark which of its lines carry on-screen text, by line position, without copying the text.
6. WHEN the on-screen text of a shot needs more reading time than the shot lasts, in any voice language, THEN the shot list SHALL warn `screen_text_unreadable`. Reading time SHALL use 17 characters per second for Latin scripts and 9 for Chinese and Japanese, and both speeds SHALL be settings. The text measured SHALL be the quoted part of the line, or the whole line when it has no quote.
7. The short-drama review rules SHALL also check that what an off-screen character knows has a source in the text; that the props and relationships the ending relies on are shown or stated before the ending; that each clue introduced in the middle bears on the ending's question or is resolved; that what a character sees can be seen from where they are; and that key information is not carried by on-screen text alone.
8. The repository SHALL keep the 2026-11-08 generated draft of "The Last Order" as a second acceptance fixture, with the problems a review should find. The live smoke check SHALL report which of them the review found.

### Requirement 2: Media store

**User Story:** As an author, I want the references, takes and cuts of my series in Sci-epo, so that I can find, review and assemble them in one place.

#### Acceptance Criteria

1. The system SHALL store media files in a folder next to the database (`SCIEPO_MEDIA_DIR`, default `data/media`), named by SHA-256, with a record of project, kind, content type, size, SHA-256, origin and time.
2. The system SHALL accept these kinds, types and size limits: reference image (PNG, JPEG, WebP; 8 MB), voice sample (WAV, MP3, FLAC; 10 MB), music (WAV, MP3, FLAC, M4A; 30 MB), take video (MP4; 64 MB), QA image (JPEG, PNG; 2 MB), QA data (JSON; 512 KB), cut video (MP4; 256 MB) and report (Markdown; 1 MB).
3. WHEN a file is uploaded THEN the system SHALL check its kind, size and file signature, compute its SHA-256 and name the file itself. IF the signature does not match the kind THEN the system SHALL reject the file.
4. The system SHALL serve media only to the signed-in owner, and to a worker only the references of its session's batches. Responses SHALL have a fixed content type and `X-Content-Type-Options: nosniff`, and video SHALL support byte ranges.
5. The system SHALL keep the total under a quota (`SCIEPO_MEDIA_QUOTA_MB`, default 5120) and show the usage. IF an upload would exceed the quota THEN the system SHALL reject it and state the usage and the limit.
6. The author SHALL be able to delete media that no approved take, signed-off cut, approved reference or report uses.

### Requirement 3: Cast references

**User Story:** As an author, I want to choose how each character looks before any clip is rendered, so that the picture does not drift from my description.

#### Acceptance Criteria

1. A character of the production profile SHALL be able to hold an approved portrait and a voice sample from the media store, besides its appearance and voice descriptions, and a switch for whether its clips use the portrait.
2. The author SHALL be able to upload a portrait or a voice sample for a character.
3. The author SHALL be able to queue portrait candidates, 4 per character by default, from a portrait description that starts as the appearance text plus a fixed framing (waist-up, facing the camera, plain background, even light). A worker SHALL render them with the SDXL stack profile, each candidate as a take with its own seed.
4. The production tab SHALL show each candidate or uploaded portrait next to its appearance text, and the author SHALL approve one portrait per character.
5. A render batch SHALL record the name and SHA-256 of every reference it uses. The worker SHALL receive the references from Sci-epo and SHALL verify each SHA-256 before using the file.
6. WHEN a character's approved portrait or voice sample changes THEN earlier batches SHALL keep their recorded references, and their view SHALL say that the series now uses a different reference.

### Requirement 4: Render presets, job keys and takes

**User Story:** As an author paying for GPU time, I want each distinct render done once and each defect fixed on its own, so that I never render the same clip twice or a whole episode again for one shot.

#### Acceptance Criteria

1. A render batch SHALL record a render preset: the size (480×864 or 768×1344 for 9:16; 864×480 or 1344×768 for 16:9), the sampling steps (20 by default), whether the turbo LoRA is on, and the stack profile with its version.
2. A render batch SHALL record a music mode: `bed`, where clip prompts ask for no non-diegetic music and the cut adds one music track, or `native`, where each clip's prompt describes music as it does today. `bed` SHALL be the default.
3. The system SHALL give each job a key: the SHA-256 of its mode, prompt, frames, size, steps, turbo switch, stack profile and version, and of each reference's SHA-256 in order. Jobs of one batch with the same key SHALL be planned as one job serving all their languages, so a clip without dialogue renders once. A job that serves every voice language of the batch SHALL have an output name without a language, such as `ep01-c01.mp4`.
4. A job SHALL hold a list of takes. Take n SHALL use a seed derived from the clip's picture key and n, so all languages of a clip use the same seed for the same take number.
5. The author SHALL be able to ask for a retake of a job, and the system SHALL queue the next take in the same batch.
6. WHEN a new batch of an episode has a job whose key equals the key of a job with an approved take in an earlier batch of that episode THEN the system SHALL offer to carry that take over, so the job counts as approved without rendering.
7. Before a batch is created and before a session starts, the system SHALL show the number of takes to render, their total frames, and estimated setup minutes, render minutes and, when the author has set a compute-unit rate per hour, compute units. The estimate SHALL use the measured seconds per frame for the stack profile, preset and GPU from earlier sessions, and SHALL say when it uses a default instead.

### Requirement 5: Render sessions

**User Story:** As an author, I want to hand a batch to Colab with one cell and one code, so that I install, export and copy nothing by hand.

#### Acceptance Criteria

1. The author SHALL be able to start a render session for one or more current batches and portrait jobs of a project. The system SHALL create a session token that works only for those batches and jobs, expires after a set time (6 hours by default) and is revoked when the session ends. The system SHALL store only its SHA-256.
2. The system SHALL show the session code once, as the server address and the token (`https://studio.example.com#sciepo_ss_…`), with a copy button, a link to the Colab notebook, the runtime type to choose, and the steps. While no worker has connected, the author SHALL be able to reissue the code, which revokes the old one.
3. The repository SHALL include a Colab notebook with one cell. The cell SHALL ask for the session code with a hidden prompt, so the code is not saved in the notebook; download the worker program from the Sci-epo server and check the SHA-256 that the server states; run the session; and then release the runtime, whether the session ended normally or with an error, unless the author ticked "keep the runtime".
4. The worker SHALL install only what the session's jobs need: the ComfyUI commit and the model files of each stack profile in use. It SHALL use the workflow that ships with the stack profile and SHALL NOT need a workflow exported by hand.
5. IF the GPU is not one that the stack profile was tested on THEN the worker SHALL report the GPU and end, unless the author allowed untested GPUs for the session.
6. IF ComfyUI lacks a node class that the stack profile's workflow uses THEN the worker SHALL report the missing classes and end.
7. The worker SHALL NOT print the session token, and SHALL replace anything that looks like a Sci-epo token in the log lines it reports.
8. WHEN Sci-epo runs on the author's computer THEN the system SHALL be able to serve the worker endpoints, and nothing else, on a separate port (`SCIEPO_WORKER_PORT`), so that a tunnel to that port exposes no other part of Sci-epo. The session code SHALL then use the tunnel address set in `SCIEPO_WORKER_PUBLIC_URL`.
9. Global worker tokens and the `pull`, `package` and `serve` modes SHALL keep working, and the worker SHALL keep reading job packages of version 1.

### Requirement 6: Session progress, budget and release

**User Story:** As an author paying for GPU time, I want to see what the runtime is doing and know that it stops by itself, so that I never pay for an idle runtime.

#### Acceptance Criteria

1. The worker SHALL report each stage with its time: connected, GPU checked, installing, downloading model files (bytes done and total), starting ComfyUI, ready, rendering (job, take, index and count), checking, uploading and finishing; and every error with the stage it happened in.
2. The production tab SHALL show a running session's stages, elapsed time, estimated time left and estimated compute units, refreshed at least every 10 seconds.
3. The author SHALL set a time budget for each session, 1.5 times the estimate by default. The worker SHALL NOT start a take that is expected to end after the budget, and SHALL interrupt a take that is still running 5 minutes after the budget.
4. The author SHALL be able to stop a session after the current take or at once, and the worker SHALL receive the request within 30 seconds.
5. WHEN no job of the session is claimable, the budget is reached, the author stops the session, a batch of the session is no longer current, two takes in a row fail, or a fatal error happens THEN the worker SHALL upload what it holds, report a summary with the reason, and end. The notebook SHALL then release the runtime.
6. The worker SHALL NOT end while a rendered take exists only on the runtime's disk. It SHALL retry uploads for up to 10 minutes, then report the takes it could not deliver, and the system SHALL queue those takes again.
7. WHEN the system receives no message from a session's worker for 3 minutes THEN it SHALL show the session as lost, and the takes it claimed SHALL become claimable when their 15-minute leases end.
8. WHEN the author asks for a retake while a session for its batch is running THEN the worker SHALL render it in that session if the budget allows.
9. The author SHALL be able to make a session wait a set number of minutes for retakes after the queue is empty, 0 by default.

### Requirement 7: Technical QA

**User Story:** As an author, I want every take checked the same way, so that I review content and not file problems.

#### Acceptance Criteria

1. For each take the worker SHALL check and report: duration against the planned frames, within one frame; size and frame rate against the preset; an audio stream; integrated loudness and true peak; and silences longer than 2 seconds.
2. For each take the worker SHALL make and upload a contact sheet with one frame per second and the shot cuts marked, and a keyframe from the middle of each shot.
3. WHEN speech recognition is available THEN the worker SHALL report the recognized text with times, the detected language, and for each expected line a match score from 0 to 1. A line below 0.6 SHALL be a warning, and a line not found SHALL be a failure.
4. Each check SHALL be pass, warning or failure. A take with failures SHALL still be shown and SHALL still be approvable.

### Requirement 8: Review and retakes

**User Story:** As an author, I want to watch each take next to its checks and decide, so that only clips I accepted go into the episode.

#### Acceptance Criteria

1. For each job the production tab SHALL show the latest take with its video, contact sheet, keyframes, QA results, expected and recognized lines, and the earlier takes.
2. The author SHALL approve one take per job, or ask for a retake with one or more reasons (picture rotated or broken, character looks different, line missing or wrong, lip sync off, garbled text, other) and a note.
3. The production tab SHALL count technical results (takes rendered, takes with failed checks) apart from the author's verdicts (approved, retakes asked).

### Requirement 9: Cuts

**User Story:** As an author, I want Sci-epo to join the approved takes into an episode with continuous music and even loudness, so that the result is a deliverable and not a folder of clips.

#### Acceptance Criteria

1. For each language of a batch the system SHALL build a cut: one take per clip in order, the approved take for a final cut and the latest rendered take for a draft cut.
2. WHEN every clip of a language has a rendered take THEN the system SHALL make a draft cut without being asked.
3. The system SHALL make cuts on the Sci-epo host with ffmpeg. IF ffmpeg is not found THEN the production tab SHALL say so and how to install it.
4. The system SHALL match the level of each take, with separate targets for clips with and without dialogue and a gain between −9 and +9 dB; join the clips with 20 ms audio fades at each boundary; lay the chosen music track under the whole cut, with fades and ducking under the clip sound; and normalize the cut to −14 LUFS integrated with a true peak of at most −1 dBTP. The targets SHALL be settings.
5. WHEN a batch uses music mode `bed` THEN a final cut SHALL need a music track from the media store or the author's explicit choice of no music.
6. For each shot that marks on-screen text, the cut SHALL show a caption in the cut's language for the duration of the shot, taken from the quoted part of that line in the script or adaptation. The author SHALL be able to edit, shorten, move or turn off each caption before a final cut. In the language that the picture is described in, captions SHALL be off by default.
7. The author SHALL choose the output size: as rendered, 720×1280 or 1080×1920 for 9:16, and 1280×720 or 1920×1080 for 16:9.
8. The author SHALL sign off a final cut, or reject it with a note. WHEN a take of a final cut is no longer the approved take of its job THEN the cut SHALL be shown as not current.

### Requirement 10: Delivery report and manifest

**User Story:** As an author, I want a record of how each episode was made and what it cost, so that I can compare runs and trust what I deliver.

#### Acceptance Criteria

1. For each session the system SHALL keep a summary: GPU, stack profiles, start and end, minutes, estimated compute units, takes rendered and failed, and the reason it ended. The author SHALL be able to add the compute-unit balance read before and after.
2. For each final cut the system SHALL produce a Markdown report with the source chain (revision, adaptation, shot list, batch, takes), the settings, the sessions with their minutes and compute units, the files with SHA-256, the QA results, the retakes with reasons, the readiness items the author confirmed, the technical result and the author's verdict in separate sections, and open problems.
3. The publication manifest SHALL list the signed-off cut of each language with its SHA-256 and source chain, and SHALL report that language as `delivered`. Other languages SHALL stay `planning_only`.

### Requirement 11: Rehearsal

**User Story:** As an author, I want to try the whole hand-off without GPU cost, so that a setup problem does not cost compute units.

#### Acceptance Criteria

1. A session SHALL be able to run as a rehearsal on a Colab CPU runtime or on the author's computer. The worker installs no models and renders placeholder takes of the planned length (a test picture, a tone and the expected lines as text), so that the session, uploads, QA, review, cuts and release run as in a real session.
2. Rehearsal takes and cuts SHALL be marked as rehearsal wherever they appear, and SHALL NOT be signed off or delivered.
