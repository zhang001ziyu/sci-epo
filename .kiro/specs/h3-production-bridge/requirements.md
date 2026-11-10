# Requirements Document

## Introduction

After the author adopts a shot list, each vertical short-drama episode still needs video with voices in Chinese and English. The author renders with MiniMax H3, an open-weight model that generates 24 fps video with native stereo audio, including dialogue, in clips of about 4–15 seconds. The author runs H3 on Google Colab today and may later run it on a GPU machine of their own. Sci-epo does not run H3 itself.

This feature connects the adopted shot list to H3:

1. A production profile for each series: visual style, background music, and an appearance and voice for each character, with optional reference files.
2. Render batches: an immutable plan that groups shots into clips and writes one H3 prompt for each clip and voice language.
3. Three ways to hand jobs to a worker, sharing one job format: a job package file, a worker that pulls jobs with a token, and a worker URL that Sci-epo pushes to.
4. A Python worker and a Colab notebook that render the jobs with ComfyUI or a custom command and report the results.
5. Result tracking for each clip and language. Video files stay where the worker wrote them, for example in Google Drive.

H3 itself has two voices for the same clip: each language is a separate generation with its own native dialogue and lip movement. Model-written prompts, 2K regeneration, editing clips into an episode, timed subtitles and storing video files in Sci-epo are later work.

## Glossary

- **Production shot list**: the shot list the author adopted for an episode, while its source revision is still the accepted one.
- **Clip**: consecutive shots of one scene rendered by one H3 generation.
- **Clip limit**: the longest planned clip, 15 seconds by default.
- **Render batch**: an immutable plan of clips and prompts made from one production shot list.
- **Render job**: one clip in one voice language.
- **Worker**: a program outside Sci-epo that renders jobs, in Colab or on the author's own machine.
- **Worker token**: a secret that lets a worker claim and report jobs, and nothing else.
- **Job package**: a JSON file holding every job of one batch.
- **T2VA**: H3 text-to-video-and-audio, prompted with `integrated_multimodal_description`, `overall_soundscape` and `non_diegetic_music`.
- **R2V**: H3 reference-to-video, prompted with six sections starting with `subject_definitions`, using reference images and audio.

## Requirements

### Requirement 1: Production profile

**User Story:** As an author, I want to describe the look and voices of a series once, so that every clip of every episode uses the same style and characters.

#### Acceptance Criteria

1. The production tab SHALL let the author edit, for each series: a visual style, a background-music description, and for each character an appearance, a voice description, an optional reference image file name and an optional voice sample file name.
2. The system SHALL offer the cast of the production shot list as the characters to describe, matched by name.
3. The system SHALL store the profile outside the frozen brief, so saving it SHALL NOT mark any episode for recheck.
4. IF a file name contains a path separator or lacks an image extension (`.png`, `.jpg`, `.jpeg`, `.webp`) or an audio extension (`.wav`, `.mp3`, `.flac`) for its field THEN the system SHALL reject it.
5. The production tab SHALL state that descriptions are written in English, because H3 expects English prompt bodies.

### Requirement 2: Clip plan

**User Story:** As an author, I want shots grouped into clips H3 can generate, so that each generation stays within the model's length.

#### Acceptance Criteria

1. WHEN the author creates a render batch THEN the system SHALL require the episode's production shot list to be current.
2. WHEN planning clips THEN the system SHALL group consecutive shots of the same scene while their estimated total stays within the clip limit, which the author can set from 5 to 15 seconds.
3. IF one shot is longer than the clip limit THEN the system SHALL plan it as its own clip with a warning, and IF it is longer than H3's longest clip THEN the warning SHALL say that the clip ends there.
4. WHEN planning a clip THEN the system SHALL convert its estimated seconds at 24 fps to H3's frame grid of 17k+5 frames, rounding up, with at least 107 and at most 362 frames.
5. The system SHALL use 768×1344 pixels for 9:16 shot lists and 1344×768 for 16:9.
6. Every language of one clip SHALL use the same seed, derived from the batch and clip IDs.

### Requirement 3: H3 prompts

**User Story:** As an author, I want each clip's prompt to follow MiniMax's prompt format and carry the exact lines of my script, so that H3 speaks the dialogue I wrote.

#### Acceptance Criteria

1. WHEN no character in a clip has a reference image THEN the system SHALL write a T2VA prompt with `integrated_multimodal_description`, `overall_soundscape` and `non_diegetic_music`, in that order.
2. WHEN a character in a clip has a reference image THEN the system SHALL write an R2V prompt with `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape` and `non_diegetic_music`, in that order, number reference images and voice samples in the order they are passed to the worker, and use at most 9 images and 3 audio clips.
3. WHEN a clip has several shots THEN every shot after the first SHALL start with `[Shot N] At MM:SS.mmm,` where the time is the sum of the earlier shots' estimates.
4. WHEN a shot has a spoken line THEN the prompt SHALL name the speaker with a stable ID `(S1)`, `(S2)`, … in order of first speech within the clip, describe the voice at the speaker's first line, and put the words inside `<d>[English] …</d>` or `<d>[Chinese] …</d>`.
5. The words inside `<d>` SHALL be the bound script line of that language without its speaker label and parenthetical, and the system SHALL verify each prompt against the script before saving the batch.
6. WHEN an English version of the script exists, as the source or as the bound adaptation, THEN the system SHALL write action lines and speaker names in every language's prompt from the English version, so the two languages describe the same picture.
7. IF no English version exists, or the shot list's composition and sound notes are not in English, THEN the system SHALL use the available text and show a warning, because H3 expects English prompt bodies.
8. The system SHALL describe framing and camera moves with the camera vocabulary of the H3 guide and SHALL NOT add negative prompts.
9. IF a script line contains `<`, `>` or `[Shot` THEN the system SHALL refuse to create the batch and name the scene and line, because these characters carry meaning in H3 prompts.

### Requirement 4: Render batches and jobs

**User Story:** As an author, I want a frozen plan with a status for every clip and language, so that I know what is left to render.

#### Acceptance Criteria

1. WHEN a batch is created THEN the system SHALL freeze the shot list ID, the source revision, the adaptations used, the languages, the production profile, the clips and the prompts.
2. WHEN a batch is created THEN the system SHALL create one queued job for each clip and voice language of the shot list that has text.
3. A job SHALL be queued, claimed, succeeded or failed. A claimed job SHALL carry a lease; WHEN the lease has expired THEN the job SHALL be claimable again.
4. WHEN the author requeues a failed job THEN the system SHALL make it queued again and keep its attempt count.
5. WHEN a batch's shot list is no longer the current production shot list THEN the workspace SHALL show the batch as not current, and workers SHALL NOT receive its jobs.

### Requirement 5: Job package

**User Story:** As an author, I want to download all jobs as one file, so that I can render them in any environment, even without a connection to Sci-epo.

#### Acceptance Criteria

1. WHEN the author downloads a batch's package THEN the system SHALL return JSON with a format name and version, the batch, the reference files the jobs need, and every job with its ID, clip, language, mode, prompt, frames, width, height, seed, reference files and output file name.
2. Output file names SHALL have the form `ep<episode>-c<clip>-<language>.mp4`.
3. WHEN the author uploads a results file THEN the system SHALL accept only results for jobs of that batch, with the status `succeeded` or `failed` and a plain output file name, and SHALL report how many results it applied.
4. Uploading the same results file twice SHALL leave the jobs unchanged.

### Requirement 6: Pull worker

**User Story:** As an author with Sci-epo online, I want a Colab notebook to fetch jobs by itself, so that rendering continues without me moving files.

#### Acceptance Criteria

1. The production tab SHALL let the owner create a worker token with a label, show it once, and revoke it.
2. The system SHALL store only a SHA-256 hash of each worker token.
3. Worker endpoints under `/api/worker/v1/` SHALL accept only `Authorization: Bearer <worker token>`, SHALL NOT accept the owner's session cookie, and SHALL NOT require a CSRF token.
4. A worker token SHALL NOT grant access to any other endpoint.
5. WHEN a worker claims a job THEN the system SHALL return the oldest queued job of a current batch with a 60-minute lease, or no content when nothing is queued.
6. WHEN a worker sends a heartbeat or a result THEN the system SHALL accept it only from the token that claimed the job.
7. The worker endpoints SHALL work on a deployment with owner login and on a local server.

### Requirement 7: Push to a worker URL

**User Story:** As an author running Sci-epo on my laptop, I want to send jobs to a Colab worker reached through a tunnel, so that I do not have to expose my laptop to the internet.

#### Acceptance Criteria

1. The production tab SHALL let the author enter a worker URL and the worker's key, send a batch to it, and fetch its results.
2. The system SHALL accept an `https` worker URL, or `http` only for `127.0.0.1` and `localhost`.
3. The system SHALL NOT store the worker key; the page SHALL keep it only while it is open.
4. Requests to the worker SHALL not follow redirects, SHALL time out, SHALL limit the response size, and their errors SHALL NOT contain the key.

### Requirement 8: Worker program and Colab notebook

**User Story:** As an author, I want one worker program for Colab and for my own machine, so that the same jobs render the same way everywhere.

#### Acceptance Criteria

1. The repository SHALL include `worker/sciepo_worker.py`, which runs on Python 3.10 or later with the standard library only.
2. The worker SHALL offer the modes `package` (render a job package), `pull` (claim jobs from a Sci-epo server) and `serve` (accept pushed batches over HTTP with a key).
3. The worker SHALL offer the backends `comfyui` (an API-format workflow with placeholders), `command` (a command template) and `dry-run` (write prompts only and never report success).
4. The worker SHALL offer `prepare-workflow`, which inserts placeholders into a workflow exported from ComfyUI and lists every change.
5. WHEN a package is rendered again THEN the worker SHALL skip jobs that already succeeded in its results file.
6. The worker SHALL write videos and a results file to the chosen output folder.
7. The repository SHALL include a Colab notebook that mounts Google Drive, optionally installs ComfyUI with the H3 models, downloads the worker and runs one of the three modes.
8. The documentation SHALL explain each mode for Colab and for a self-hosted GPU machine.

### Requirement 9: Results in the workspace

**User Story:** As an author, I want to see every clip's status in each language, so that I know which files to collect and what to retry.

#### Acceptance Criteria

1. The production tab SHALL list each batch of the episode with its clips, the status of each language, the output file name, the reported duration, the error and the last update.
2. The production tab SHALL show how many jobs succeeded, failed and remain.
3. The production tab SHALL show every prompt read-only before and after rendering.
