# Design Document

## Overview

Sci-epo plans and tracks; a worker renders. A render batch is computed deterministically from the production shot list, its bound adaptations and the series production profile. No model is called to write prompts, so the same inputs always give the same prompts, and the program can check every prompt against the script before it is saved.

```
production shot list ─┐
bound adaptations ────┼─► planRenderBatch() ─► render batch (immutable) ─► render jobs (clip × language)
production profile ───┘                                                        │
                                       ┌───────────────────────────────────────┼───────────────────────────┐
                                       ▼                                       ▼                           ▼
                              job package file                         pull: worker token          push: worker URL + key
                       (download, render anywhere,              (Colab or own GPU polls the     (Sci-epo server sends the
                        upload results.json)                     server's /api/worker/v1)        package to a tunnelled worker)
                                       └──────────────► worker/sciepo_worker.py ◄──────────────────┘
                                                        backends: comfyui | command | dry-run
```

Video files never pass through Sci-epo. The worker writes them to its output folder (Google Drive in Colab) and reports the file name, duration, size and SHA-256.

## Data model

New types in `src/types.ts`:

```ts
interface ProductionCharacter { name: string; appearance: string; voice: string; image?: string; voiceSample?: string }
interface ProductionProfile { style: string; music: string; characters: ProductionCharacter[] }
// Project.production?: ProductionProfile  (outside the frozen brief, like voiceLanguages)

interface RenderPrompt { mode: 't2va' | 'r2v'; text: string; images: string[]; audio: string[] }
interface RenderClip { id: string; sceneId: string; shotIds: string[]; plannedSeconds: number; frames: number; seed: number; warnings: string[]; prompts: Record<string, RenderPrompt> }
interface RenderBatch { id; episodeId; shotListId; sourceRevisionId; adaptations: Record<string, string>; languages: string[];
  width: number; height: number; fps: 24; clipLimitSeconds: number; profile: ProductionProfile; clips: RenderClip[]; warnings: string[]; createdAt }
interface RenderJob { id; batchId; clipId; language; order: number; status: 'queued' | 'claimed' | 'succeeded' | 'failed'; attempts: number;
  workerTokenId?; workerLabel?; leaseExpiresAt?; output?: {file: string; seconds?: number; bytes?: number; sha256?: string}; error?; updatedAt }
interface WorkerToken { id; label; hash; createdAt; lastUsedAt?; revokedAt? }
```

`Store` gains the tables `render_batches` (insert only), `render_jobs` and `worker_tokens` (updatable). `bundle()` includes the episode's batches and jobs. Tokens are listed by a separate owner endpoint and never include the hash.

## Core: `src/core/h3.ts`

### Constants and frames

`H3_FPS = 24`, `H3_MIN_FRAMES = 107` (4.46 s, the first grid point above H3's 4-second minimum), `H3_MAX_FRAMES = 362` (15.08 s). `h3Frames(seconds)` takes `ceil(seconds × 24)`, rounds up to `17k + 5` and clamps to that range. Sizes: 9:16 → 768×1344, 16:9 → 1344×768 (H3's 768-pixel short side, multiples of 32).

### Clip plan

`planClips(shots, limit)` walks the shots in order. A shot joins the open clip when it is in the same scene and the clip's estimate stays within the limit; otherwise it opens a new clip. A shot longer than the limit gets its own clip and a warning; beyond H3's 15.08 seconds the warning says the clip will be cut there. Clip IDs are `c01`, `c02`, … Seeds are a 32-bit FNV-1a hash of `batchId:clipId`, so every language of a clip shares one seed; the module stays free of Node.js APIs so the browser can import it.

### Text sources

For each shot line the builder needs, per language: the spoken words for `<d>` and, for the picture, an English description.

- Spoken words come from the bound script of that language at the same position: `inlineLabel(line).text`, or the line itself when the label stands on the previous line. A parenthetical (`MAYA (whispering): …`) becomes delivery outside `<d>`.
- Action lines come from the English version: the source when it is English, otherwise the bound English adaptation. With neither, the source text is used and the batch carries a warning.
- Speaker names come from the English version's labels at the speaker's lines, so the body names `MAYA` even when the source is Chinese. Composition and sound notes are shot fields written in the script language; when that language is not English, the batch warns.
- Label-only lines are skipped. A script line containing `<` or `>` or `[Shot` would break the prompt structure, so batch creation rejects it with the scene and line.

### Prompt formats

T2VA (no references):

```
integrated_multimodal_description: [Shot 1] <style>, a close-up in a vertical 9:16 frame. MAYA is <appearance>. <composition> <action lines> MAYA (S1), <voice>, says: <d>[English] Singing costs extra.</d> The camera pushes in with small amplitude at slow speed. [Shot 2] At 00:04.000, the camera cuts to a medium shot. …

overall_soundscape: <shot sound notes, or a quiet location ambience>

non_diegetic_music: <profile music, or N/A>
```

R2V (a character in the clip has a reference image, or a speaker has a voice sample):

```
subject_definitions:
<Subject 1> is MAYA, the person shown in <Picture 1>, <appearance>.
<Audio 1> is the voice-timbre reference for <Subject 1> (S1).

summary:
[reference generation + audio reference] A 2-shot vertical clip in INT. ELEVATOR - NIGHT with <Subject 1>. …

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - the identity, face, hair and clothing of MAYA from <Picture 1> are retained.
<Audio 1>: reference - the voice of <Subject 1> follows the timbre of <Audio 1> without copying the original signal.

detailed_description:
The target video uses <style>.
[Shot 1] … <Subject 1> MAYA (S1) says: <d>[English] Singing costs extra.</d> …

overall_soundscape:
…

non_diegetic_music:
…
```

Pictures are numbered by the subject's first appearance in the clip and audio by the speaker's first line; the job lists the files in the same order, which is the order of ComfyUI's `ref_image_N` and audio inputs. At most 9 images and 3 audio clips are used; the rest are dropped with a warning.

Camera moves map to the guide's vocabulary: static → "holds a static shot", push in → "pushes in with small amplitude at slow speed", pull out → "pulls out …", pan → "pans right …", tilt → "tilts up …", track → "tracking shot that follows …", handheld → "shakes slightly". Language tags use the canonical English language name (`[English]`, `[Chinese]`).

### Self-check

`verifyPrompt(prompt, expected)` extracts every `<d>[Tag] …</d>` in order and compares it with the expected lines of that language, checks that the shot markers run `[Shot 1]…[Shot n]` with strictly increasing cut times inside the clip, and that the T2VA or R2V section headers appear once, in order. `planRenderBatch` runs it on every prompt and throws on any difference, so a builder bug cannot reach a worker.

## Server

Owner endpoints (existing login, CSRF and origin rules):

| Endpoint | Purpose |
| --- | --- |
| `PUT /api/projects/:id/production` | validate and save the profile |
| `POST /api/shot-lists/:id/render-batches` | `{clipLimitSeconds?, languages?}`; requires the current production shot list; inserts the batch and its jobs in one transaction |
| `GET /api/render-batches/:id/package` | job package attachment |
| `POST /api/render-batches/:id/results` | apply a results file |
| `POST /api/render-jobs/:id/requeue` | failed → queued |
| `GET/POST /api/worker-tokens`, `POST /api/worker-tokens/:id/revoke` | list, create (token shown once), revoke |
| `POST /api/render-batches/:id/push`, `POST /api/render-batches/:id/sync` | `{url, key}`; send the package to a worker, fetch its results |

Worker endpoints (`/api/worker/v1/`), bearer token only:

| Endpoint | Purpose |
| --- | --- |
| `GET hello` | check the token; returns the token label |
| `POST claim` | oldest claimable job of a current batch, with a 60-minute lease; 204 when none |
| `POST jobs/:id/heartbeat` | extend the lease |
| `POST jobs/:id/result` | `{status, output?, error?}` |

The request handler routes `/api/worker/v1/` before the owner check: no session, no CSRF, and an `Origin` header (a browser) must still match the site. Tokens are `sciepo_wk_` plus 32 random bytes in base64url and are looked up by SHA-256. A claim runs in one SQLite transaction. A job is claimable when it is queued, or claimed with an expired lease, and its batch's shot list is still the current production shot list.

Push and sync use `fetch` with `redirect: 'error'`, a 20-second timeout and a 2 MB response limit. The key travels only in the `Authorization` header of that request; error messages name the HTTP status, never the key or the response body.

## Job package and results

```json
{"format": "sciepo-render-package", "version": 1,
 "batch": {"id": "…", "series": "…", "episode": 1, "episodeTitle": "…", "sourceRevisionId": "…", "shotListId": "…", "languages": ["en", "zh-CN"], "createdAt": "…"},
 "model": {"name": "MiniMax H3", "fps": 24, "width": 768, "height": 1344},
 "references": {"images": ["maya.png"], "audio": []},
 "jobs": [{"id": "…", "clipId": "c01", "language": "en", "mode": "t2va", "prompt": "…", "frames": 124, "seconds": 5.17,
           "width": 768, "height": 1344, "seed": 123, "images": [], "audio": [], "output": "ep01-c01-en.mp4", "shotIds": ["sh1", "sh2"]}]}
```

```json
{"format": "sciepo-render-results", "version": 1, "batchId": "…",
 "results": [{"jobId": "…", "status": "succeeded", "file": "ep01-c01-en.mp4", "seconds": 5.17, "bytes": 1234567, "sha256": "…", "error": null}]}
```

Applying results is idempotent: a result that matches the job's stored state changes nothing, and results for unknown jobs are counted as ignored.

## Worker: `worker/sciepo_worker.py`

Standard library only, Python 3.10+.

- `package --package FILE --out DIR`: render every job not already succeeded in `DIR/results.json`, rewriting the file after each job.
- `pull --server URL --token TOKEN --out DIR [--wait]`: claim, render with a heartbeat thread, report; exit when nothing is queued unless `--wait`.
- `serve --port 8765 --key KEY --out DIR`: `POST /v1/batches` accepts a package, `GET /v1/batches/<id>/results` returns the results file, `GET /v1/health`; jobs render one at a time in a background thread.
- `prepare-workflow --input API.json --output OUT.json`: replace the longest text input of a text-encode or H3 node with `{{PROMPT}}`, and `width`, `height`, `length`, `seed`/`noise_seed`, `filename_prefix` and the image or audio inputs of load nodes with their placeholders; print each change.

Backends:

- `comfyui --comfy-url URL --workflow T2V.json [--r2v-workflow R2V.json] [--refs DIR]`: substitute placeholders (`{{PROMPT}}`, `{{WIDTH}}`, `{{HEIGHT}}`, `{{FRAMES}}`, `{{SEED}}`, `{{OUTPUT_PREFIX}}`, `{{IMAGE_1}}`–`{{IMAGE_9}}`, `{{AUDIO_1}}`–`{{AUDIO_3}}`; a value that is exactly a numeric placeholder becomes a number), upload reference files with `/upload/image`, queue with `POST /prompt`, poll `/history/<id>`, and download the first video output with `/view`.
- `command --command TEMPLATE`: run a template with `{prompt_file}`, `{output}`, `{frames}`, `{width}`, `{height}`, `{seed}`, `{images}`, `{audio}`, each value shell-quoted, and require the output file to exist.
- `dry-run`: write `<output>.prompt.txt` and record `dry_run`; it never reports success to a server.

The Colab notebook `worker/colab/sciepo_h3_worker.ipynb` mounts Drive, optionally installs ComfyUI and the official H3 model files, downloads the worker from this repository, and has one cell per mode. For mode 3 it starts a Cloudflare quick tunnel and prints the URL and key to paste into Sci-epo.

## Web: production tab

A `制作` tab (`web/production.ts`, a `ProductionPanel` class like `ShotListPanel`):

1. The production shot list's state; without a current one, a pointer to the shot-list tab.
2. The profile form: style (with presets), music, and one row per cast member.
3. New batch: clip limit and languages.
4. Batches, newest first: current or not, job counts, package download, results upload, push and sync to a worker URL, and a table of clips with each language's status, file, duration, error, requeue and the prompt in a `<details>` block.
5. Worker tokens: create (shown once), list, revoke; and the three connection modes with commands to copy.

## Testing

- Core: frame grid and clamps; grouping by scene and limit; the oversize warning; deterministic seeds; T2VA and R2V layouts against fixtures; English action lines and `[Chinese]` dialogue for the Chinese job; parenthetical delivery; rejection of `<`, `>` and `[Shot`; `verifyPrompt` catching a changed line, a missing shot and decreasing cut times.
- Server: batch creation requires the current production shot list; package and results round trip and idempotence; token creation, hashing, revocation; worker endpoints refuse cookies, accept bearer tokens, skip CSRF, enforce claim ownership, expire leases and skip non-current batches; push and sync against a local fake worker, without leaking the key.
- Worker (`python -m unittest discover -s worker/tests`): placeholder substitution, `prepare-workflow`, the ComfyUI backend against a fake ComfyUI server, resumable package mode, serve mode, and pull mode against a fake Sci-epo server.
