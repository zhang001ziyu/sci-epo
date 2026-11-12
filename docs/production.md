# From an accepted script to a delivered episode

This guide covers what happens after the script: the readiness checklist, cast references, render batches, a render session on Google Colab, review and retakes, the cut, and delivery. It applies to vertical short dramas rendered with MiniMax H3. The design is in [`.kiro/specs/production-pipeline/`](../.kiro/specs/production-pipeline/design.md).

Sci-epo plans and keeps the record; the GPU work happens in a worker that Sci-epo hands the jobs to. Every file the worker makes comes back to Sci-epo's media store, so the GPU runtime can be released as soon as the work ends.

| Step | Where | You | Sci-epo keeps |
|---|---|---|---|
| 1. Readiness | 制作 tab | fix or confirm each open item | the checklist and your confirmation, with the batch |
| 2. Cast | 制作 tab | upload a portrait per character, check it against the appearance text | references with SHA-256 |
| 3. Render batch | 制作 tab | choose size, steps, music mode | one job per distinct render, take 1 queued |
| 4. Render session | 制作 tab, then Colab | paste the session code into the notebook's one cell | progress, takes, QA files |
| 5. Review | 制作 tab | approve a take per clip, or ask for a retake | verdicts and reasons |
| 6. Cut | 制作 tab | choose music, check captions, sign off | the episode video, the report, the manifest |

## 1. Readiness

Above the batch form, the checklist shows each item as passed, warning or failed, with a link to the tab where you fix it:

- the accepted script, with no pending recheck;
- a complete live review of that revision, and each open issue it raised;
- a bound, line-aligned adaptation for every voice language;
- a current production shot list, and each of its warnings, including on-screen text that cannot be read in its shot;
- an appearance and a voice for every character, and an approved portrait for every character in frame.

A batch needs every item to pass, or your confirmation of each remaining item. The confirmation is stored with the batch and appears in the delivery report. The first real H3 run showed why: an unreviewed draft with logic gaps went straight into the video.

## 2. Cast references

Each character gets a portrait from the media store. H3's reference mode (R2V) keeps a character's face and clothes across clips, and it copies the picture closely: a hood in the portrait shows up in clips even when the appearance text says nothing about a hood. Upload a portrait that matches the appearance text. A character can opt out of using a portrait; a clip whose characters in frame have no portrait would need the text-to-video mode, which the current stack does not offer yet.

## 3. Render batches

A batch freezes the plan: clips of consecutive shots of one scene up to the clip limit, one H3 prompt per clip and language, the render size (480×864 to save compute, or H3's 768×1344), the sampling steps and the music mode.

- **One job per distinct render.** Sci-epo hashes everything that determines a render. A clip without dialogue has the same prompt in every language, so it renders once and serves all languages.
- **Takes.** A job holds takes. Take *n* has its own seed, shared by all languages of the clip. A retake queues the next take in the same batch; nothing else is rendered again.
- **Music mode.** `bed` (the default) asks H3 for no background music, and the cut lays one continuous track under the episode. Each H3 clip is a separate generation, so music made inside clips cannot continue across a cut.

## 4. Render sessions

Start a session under the batch. Sci-epo shows a session code once, with the steps:

1. Open the [one-cell Colab notebook](https://colab.research.google.com/github/zhang001ziyu/sci-epo/blob/main/worker/colab/sciepo_session.ipynb) and choose the runtime the page names (G4 for the H3 LITE stack; a CPU runtime for a rehearsal).
2. Run the cell and paste the code into its hidden prompt.
3. Keep the tab open and watch the progress on Sci-epo.

The cell downloads the worker program from your Sci-epo server and runs it only when its SHA-256 matches. The worker then:

- checks the GPU against the stack's tested GPUs and the ComfyUI nodes the workflow needs, and ends at once when either does not match;
- installs the pinned ComfyUI commit and only the model files the session needs (`worker/stacks/h3-lite.json`), with the workflow that ships with the stack;
- downloads the references and checks their SHA-256;
- renders take by take, checks each take (duration, size, frame rate, audio, loudness, silences, a contact sheet, a keyframe per shot, and the spoken lines with speech recognition), and uploads the video and the QA files;
- follows the time budget (1.5 times the estimate by default) and the stop buttons on Sci-epo;
- ends when the queue is empty, the budget is reached, you stop it, the batch stops being current, or two takes fail in a row. It never ends while a rendered take exists only on the runtime's disk.

When the worker ends, the cell calls `google.colab.runtime.unassign()`, which releases the runtime and stops compute-unit use, also after an error or an interrupt. Check the balance under 代码执行程序 → 查看资源 and enter it on the session if you want it in the report.

The session token works only for the session's batches, expires after six hours and is revoked when the session ends. Sci-epo stores only its hash.

### A Sci-epo on your own computer

Colab cannot reach `127.0.0.1`. Start Sci-epo with a second listener that answers only the worker API, and put a tunnel in front of that port:

```sh
SCIEPO_WORKER_PORT=4318 SCIEPO_WORKER_PUBLIC_URL=https://<tunnel-name>.trycloudflare.com bun run start
cloudflared tunnel --url http://127.0.0.1:4318
```

Start the tunnel first, copy its address into `SCIEPO_WORKER_PUBLIC_URL`, then start Sci-epo; session codes then carry the tunnel address. The owner interface stays on `127.0.0.1` and is never tunnelled. A quick tunnel gets a new address every time it starts. On networks that block QUIC, add `--protocol http2` to the tunnel.

### Rehearsal

A rehearsal session installs no models and renders placeholder takes of the planned length: a test picture, a tone and the expected lines as text. Everything else runs as in a real session: the code, uploads, QA, review, cuts and the release. Run one on a CPU runtime before the first GPU session. Rehearsal takes and cuts are marked and can never be signed off.

## 5. Review and retakes

The batch shows clips by language. Open a job to see the latest take: the video, the contact sheet, the keyframes, the checks and the expected lines next to what speech recognition heard. Approve one take per job, or ask for a retake with one or more reasons (picture broken or rotated, character looks different, line wrong, lip sync off, garbled text, other) and a note. A running session renders retakes if its budget allows; otherwise start another session. Technical results (rendered, failed checks) are counted apart from your verdicts (approved, retakes asked).

## 6. Cuts and delivery

Sci-epo cuts on its own host with ffmpeg, without GPU time.

- **Drafts.** When the last clip of a language has a rendered take, Sci-epo cuts a draft from the latest takes, so you can watch the episode at once.
- **Final cuts** use only approved takes of the current production version. Choose a music track (upload WAV, MP3, FLAC or M4A with a license note, or choose no music), its level and the output size, and check the captions.
- **Sound.** Each take is levelled (clips with dialogue to −16 LUFS, without to −22, at most ±9 dB), the clips are joined with 20 ms fades, the music runs under the whole episode with fades and ducks under the clip sound, and the cut is normalized to −14 LUFS with a true peak of at most −1 dBTP.
- **Captions.** A shot list marks the lines whose text appears on a phone, note or sign. The cut shows that text as a caption in the cut's language for the length of the shot: H3 does not render reliable interface text, and a Chinese episode should not show an English phone. Captions in the language the picture is described in start switched off. You can edit, shorten, move or switch off each caption.
- **Sign-off.** Watch the final cut and sign it off, or reject it with a reason. A signed-off cut stores its delivery report in the media store: the source chain from revision to takes, the settings, the sessions with minutes and compute units, the files with SHA-256, the QA results, the retakes with reasons, the readiness items you confirmed, and the technical result and your verdict in separate sections. The publication manifest (schema 2) then lists that language as delivered. When an approved take changes, the cut is no longer current and the language goes back to planning.

## Storage

Media lives in `SCIEPO_MEDIA_DIR` (by default `data/media` next to the database), named by SHA-256, under a quota (`SCIEPO_MEDIA_QUOTA_MB`, 5120 by default). At 480×864, one episode in two languages with every take and both cuts is about 60 MB. Back the folder up with the database. See [self-hosting](self-hosting.md) for ffmpeg, request size limits and fonts on a server.

## Limits

- The H3 LITE stack has only the reference workflow (R2V) and is tested on Colab's G4 runtime (RTX PRO 6000 Blackwell). Its text encoder uses NVFP4, a Blackwell format; other GPUs need your override until they are tested.
- Portraits are uploaded. Rendering portrait candidates with SDXL in a session, carrying approved takes over to a new batch, and offline session packages for runtimes that cannot reach Sci-epo are planned.
- Speech-recognition scores are hints: names and short lines are often misheard.
- The older worker modes (job package, worker token, push) still render version 1 batches; see the [production bridge guide](production-bridge.md).
