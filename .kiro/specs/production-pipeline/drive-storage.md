# Video storage in Google Drive

Status: decided by the author on 2026-11-12. This section replaces the earlier choice of keeping take and cut videos
in the Sci-epo media store for deployments that set `SCIEPO_VIDEO_STORAGE=drive`.

## Decision

- Video files (rendered takes and cuts) never reach the Sci-epo server. The Colab worker writes them to the Google
  Drive of the Colab account and Sci-epo keeps only metadata: the Drive file ID and name, SHA-256, size and length.
- Each video is shared as "anyone with the link can view", so the author can open it from any Google account,
  and it stays in the Colab account's Drive.
- Small files stay in the media store: QA contact sheets, keyframes, `qa.json`, reference images, voice samples,
  music and reports.
- Cuts run in the worker (ffmpeg on the Colab runtime), not on the host. Sci-epo still plans each cut and builds
  every ffmpeg argument list; the worker downloads the inputs, runs the commands Sci-epo gives it and reports the
  output. A cut needs no GPU, so a session that only has cuts skips the GPU check and the stack setup.
- `SCIEPO_VIDEO_STORAGE=media` (the default) keeps the earlier behaviour: videos in the media store, cuts on the host.

## Data

- `DriveFile {id, name}`. Links are built from the ID: `https://drive.google.com/file/d/<id>/view` and `/preview`.
- `Take.video {sha256, bytes, seconds, assetId?, drive?}`: one of `assetId` (media store) or `drive`.
- `CutClip {…, assetId?, drive?}`, `Cut.output {sha256, bytes, seconds, loudness, truePeak, assetId?, drive?}`.
- `Cut.sessionId`: the session that is cutting it while it runs.

## Worker protocol additions (session token, `/api/worker/v1/`)

Session document (`GET session`):
- `storage: {video: 'drive' | 'media'}`
- `work: {takes: <pending takes>, cuts: <queued cuts>}`. With `takes: 0` the worker skips the GPU check and setup.

Claimed take (`POST session/claim` → `{take}`), drive storage only:
- `drive: {folder: [names…], share: 'link'}`: the folder path under My Drive, created when missing.

Take result (`POST takes/:job/:n/result`), drive storage:
- `{status: 'rendered', video: {drive: {id, name}, sha256, bytes}, files: {contactSheet?, keyframes, qa?}, qa, seconds, timing}`.
  `files.video` must be absent. `PUT takes/:job/:n/files/video` answers 409.

Cuts, drive storage only. `POST session/claim` returns `{cut}` when no take is pending and a cut of the session's
batches is queued, or is running for a session that is no longer live:

```
{cut: {id, batchId, language, kind,
       inputs: [{name: 'clip-01.mp4', clipId, drive: {id, name}, sha256, bytes}],
       music: {name: 'music.<ext>', sha256, bytes} | null,
       captions: [{name: 'caption-001.txt', text}],
       output: {name, drive: {folder: [names…], share: 'link'}},
       timeoutSeconds}}
```

- `POST cuts/:id/heartbeat` every 30 s while cutting → `{stop: null | 'after_take' | 'now'}`.
- `GET cuts/:id/music` → the music file (checked against its SHA-256 by the worker).
- `POST cuts/:id/args {audio: {<input name>: boolean}, font: boolean}` → `{args}`: the first ffmpeg pass (loudness
  measurement), run in the cut's work folder that holds the inputs, music, caption files and, with `font: true`,
  the caption font as `caption-font.ttc`.
- `POST cuts/:id/args {audio, font, measured: <stderr tail of pass 1>}` → `{args, fallback, warnings}`: the render
  pass writing `cut.mp4`, and a fallback without captions (or null) to run when the render pass fails.
- `POST cuts/:id/result {status: 'done', drive: {id, name}, sha256, bytes, seconds, loudness: <stderr tail of the
  ebur128 measurement>, warnings: [..]}` or `{status: 'failed', error}`.

A session that ends, expires or is stopped returns its running cuts to the queue.

## Owner side

- The review panel plays a Drive video in an iframe (`/preview`) with a link to open it in Drive; the content
  security policy allows `frame-src https://drive.google.com`.
- Creating a cut needs no ffmpeg on the host. The cut waits in the queue until a session claims it; the page says so.
- A session can be started for batches that only have queued cuts.
- The delivery report and the publication manifest carry the Drive link of the cut.
