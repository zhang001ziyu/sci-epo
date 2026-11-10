# Production bridge: MiniMax H3 from Colab or your own GPU

Sci-epo turns an adopted shot list into MiniMax H3 render jobs and keeps track of them. It does not run H3. A worker program renders the jobs with ComfyUI, in Google Colab or on a GPU machine you run, writes the videos to its own folder, and reports which jobs succeeded.

```
adopted shot list + Chinese/English scripts + production profile
        │  制作 tab: 生成渲染任务 (no model call)
        ▼
render batch ── one job per clip and voice language, each with its H3 prompt
        │
        ├─ A  job package file ─► worker `package` ─► results.json ─► upload on the 制作 tab
        ├─ B  worker token ─────► worker `pull` claims jobs from Sci-epo and reports each result
        └─ C  worker URL + key ─► worker `serve` behind a tunnel; Sci-epo sends the package and fetches results
```

## Before you start

1. Adopt the episode's script, then adopt a shot list on the 分镜 tab. Only the current production shot list can be rendered.
2. For a second voice language, the shot list needs a bound line-aligned adaptation (语言与发布 tab).
3. On the 制作 tab, fill in the production profile once per series: the visual style, background music, and for each character an appearance and a voice in English. H3 expects English prompt bodies, so the descriptions are in English even for a Chinese release.
4. Optional reference files: a reference image (`.png`, `.jpg`, `.jpeg`, `.webp`) per character for a stable look, and a voice sample (`.wav`, `.mp3`, `.flac`) per character for a stable voice. Write only the file name in the profile, using ASCII letters, digits, dots, dashes and underscores. Put the files in the worker's reference folder (`--refs`; in Colab, `SciEpo/refs` in Drive).
5. A ComfyUI with the H3 models. The Colab notebook can install it, or use the one you already run.

## How the jobs are planned

- **Clips.** Consecutive shots of one scene share a clip while their estimated length stays within the clip limit (15 seconds by default, 5–15). A longer shot gets its own clip and a warning.
- **Frames and size.** H3 renders 24 fps. The estimate is rounded up to H3's frame grid of 17k+5 frames, from 107 (4.46 s) to 362 (15.08 s). 9:16 shot lists render at 768×1344, 16:9 at 1344×768.
- **One generation per language.** H3 creates the picture and the dialogue audio together, so every clip is rendered once for English and once for Chinese. Both use the same seed, so the two versions start from the same noise, but they are separate generations and will differ in detail.
- **Prompts.** Without reference files a job uses H3's text-to-video-and-audio format (T2VA: `integrated_multimodal_description`, `overall_soundscape`, `non_diegetic_music`). When a character in the clip has a reference image, or a speaker has a voice sample, the job uses the reference format (R2V: `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music`) with numbered `<Picture N>` and `<Audio N>` references.
- **Text sources.** Actions and speaker names come from the English version of the script, so the Chinese and English jobs describe the same picture. Spoken words come from the script of the job's language and go inside `<d>[English] …</d>` or `<d>[Chinese] …</d>`, without the speaker label. Shots after the first start with `[Shot N] At MM:SS.mmm, the camera cuts to …`.
- **Checks.** Before a batch is saved, the program reads every prompt back and compares its `<d>` lines with the script, its shot markers and cut times with the plan, and its section headers with the format. A script line or note containing `<`, `>` or `[Shot` is refused, because those characters have meaning in H3 prompts.

Prompts are built by the program, not by a model. You can read every prompt on the 制作 tab before rendering. The prompts follow MiniMax's published structure but are plainer than a hand-written or model-expanded prompt; the official guide recommends rich visual detail, so expect to refine the style, appearance and composition notes after the first renders.

## Prepare the workflows once

The worker queues a ComfyUI workflow in API format with placeholders:

| Placeholder | Value |
| --- | --- |
| `{{PROMPT}}` | the job's H3 prompt |
| `{{WIDTH}}`, `{{HEIGHT}}` | 768×1344 or 1344×768 |
| `{{FRAMES}}` | the `length` in frames |
| `{{SEED}}` | the clip's seed |
| `{{OUTPUT_PREFIX}}` | `sciepo/<output name>` for the save node |
| `{{IMAGE_1}}` … `{{IMAGE_9}}` | reference images, uploaded to ComfyUI first |
| `{{AUDIO_1}}` … `{{AUDIO_3}}` | voice samples |

1. In ComfyUI, open the **MiniMax H3 T2V** template (and **MiniMax H3 R2V** if you use reference images) and choose **Workflow → Export (API)**.
2. Run `python sciepo_worker.py prepare-workflow --input exported.json --output h3_t2v_api.json`. It finds ComfyUI's native H3 node (`MiniMaxH3ImageToVideo` in the T2V template, `MiniMaxH3ReferenceToVideo` in the R2V template) and puts `{{PROMPT}}`, `{{WIDTH}}`, `{{HEIGHT}}` and `{{FRAMES}}` straight on it, so the template's prompt box, resolution selector and duration formula no longer apply. It also sets `noise_seed` to `{{SEED}}` and the save node's `filename_prefix` to `{{OUTPUT_PREFIX}}`, and prints every change.
3. Add `--turbo` to turn on the template's Lightning LoRA switch: 4 sampling steps for R2V and 8 for T2V instead of 20. Test renders get faster and cheaper; motion and audio come out slightly softer.
4. In an R2V workflow, reference slot `ref_image_0` is `<Picture 1>` in the prompt and `ref_audio_0` is `<Audio 1>`, the same order as the job's file lists. `prepare-workflow` gives each load node in the template the matching `{{IMAGE_n}}`, following links through resize nodes, and adds load nodes until there are 9 image slots and 3 voice-sample slots. Before queuing a job, the worker removes the slots that job does not use, with their links.
5. A workflow without the native H3 nodes gets its placeholders guessed from input names (the longest text input, `width`, `height`, `length`, load nodes). Check those changes, and edit the JSON by hand where a guess is wrong.

## Mode A: job package

Works with any Sci-epo, local or online, and any worker, even without a network path between them.

1. On the 制作 tab, **下载任务包** for the batch.
2. Render it:
   ```sh
   python worker/sciepo_worker.py package --package sciepo-render-<batch>.json --out renders/ep01 \
     --workflow h3_t2v_api.json --r2v-workflow h3_r2v_api.json --refs refs/
   ```
3. Upload `renders/ep01/results.json` with **上传结果**.

The worker rewrites `results.json` after every job and skips jobs that already succeeded, so you can stop and run the same command again. `--backend dry-run` writes each prompt to `<output>.prompt.txt` without rendering, for checking or for pasting into ComfyUI by hand; dry runs are never reported as success.

## Mode B: the worker pulls jobs

For a Sci-epo deployment the worker can reach over HTTPS, such as a self-hosted server.

1. On the 制作 tab, **新建工作机令牌**. The token is shown once; Sci-epo stores only its SHA-256 hash. Revoke it there when you no longer need it.
2. Give the token to the worker as `SCIEPO_WORKER_TOKEN` (in Colab: Secrets, the key icon).
3. Run:
   ```sh
   SCIEPO_WORKER_TOKEN=... python worker/sciepo_worker.py pull --server https://studio.example.com \
     --out renders --workflow h3_t2v_api.json --r2v-workflow h3_r2v_api.json --refs refs/ --wait
   ```

The worker claims the oldest queued job, renders it, sends a heartbeat every five minutes, and reports the result. A claim is a 60-minute lease; if a worker disappears, the job becomes claimable again when the lease ends. Videos go to `renders/<batch>/`.

The token works only under `/api/worker/v1/` and opens nothing else. Worker requests carry the token in the `Authorization` header, not a cookie, so they need no CSRF token. The worker refuses plain `http` except for `127.0.0.1`, and never follows redirects, so the token cannot be sent to another host.

## Mode C: Sci-epo pushes to the worker

For a Sci-epo on your own computer, which Colab cannot reach. Sci-epo makes the requests, so nothing on your computer is exposed.

1. In the notebook, run cell **C**. It starts `sciepo_worker.py serve` on port 8765 with a random key and a Cloudflare quick tunnel, and prints the tunnel URL and the key.
2. On the 制作 tab, paste both into the batch and click **发送到工作机**. Sci-epo sends the job package.
3. When the worker has rendered, click **同步结果**. Sci-epo fetches the worker's results.

Sci-epo accepts an `https` worker URL, or `http` for `127.0.0.1` and `localhost` only. The key is kept in the open page and sent only with these two requests; Sci-epo does not store it. A quick tunnel URL changes every time the notebook restarts.

## Your own GPU machine

The worker is the same program with the same modes. Install ComfyUI and the H3 models as in [ComfyUI's H3 guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native), start ComfyUI, and run mode B with `--wait` as a long-running service, or mode C behind your own HTTPS reverse proxy instead of a quick tunnel. The `command` backend runs any other renderer:

```sh
python worker/sciepo_worker.py package --package job.json --out renders --backend command \
  --command "python my_h3.py --prompt-file {prompt_file} --out {output} --frames {frames} --width {width} --height {height} --seed {seed}"
```

Values are quoted for a POSIX shell. The command must write the file named by `{output}`.

## Results, retries and current batches

- Each job is 排队中 (queued), 渲染中 (claimed), 完成 (succeeded) or 失败 (failed). A failed job can be put back in the queue on the 制作 tab.
- Results are idempotent: uploading or syncing the same results again changes nothing, and a late failure report never replaces a success.
- When the production shot list changes, or the accepted script changes, older batches are shown as not current. Workers stop receiving their jobs, and a heartbeat for one of them tells the worker that the batch is no longer current.
- Sci-epo records the file name, duration, size and SHA-256 that the worker reports. The video files stay in the worker's folder.

## File formats

Job package (`sciepo-render-package`, version 1): `batch` (ID, series, episode, source revision, shot list, languages), `model` (H3, 24 fps, size), `references` (all image and audio file names the jobs need) and `jobs` (`id`, `clipId`, `language`, `mode`, `prompt`, `frames`, `seconds`, `width`, `height`, `seed`, `images`, `audio`, `output`, `shotIds`, and the `status` when the package was made). Output names are `ep<episode>-c<clip>-<language>.mp4`.

Results (`sciepo-render-results`, version 1): `batchId` and `results`, each with `jobId`, `status` (`succeeded`, `failed`, or `dry_run`, which Sci-epo skips), `file`, `seconds`, `bytes`, `sha256` and `error`.

## Status and limits

- The planner, the server endpoints and the worker are covered by offline tests, the worker against simulated ComfyUI and Sci-epo servers. A render with the real H3 model has not been verified yet; the first real runs may need changes to the prompts or to `prepare-workflow`'s guesses.
- `prepare-workflow` was checked against the wiring of ComfyUI's official H3 T2V and R2V templates and the H3 node definitions, offline. Workflows built differently fall back to guesses by input name.
- H3 can assign a line to the wrong speaker when several people talk in one clip. The shot list already warns about shots with more than one speaker; voice samples make the voices more stable.

## Sources

The prompt structure follows MiniMax's official guides for the [base modes](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md) and the [full-reference mode](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md), and ComfyUI's [H3 prompt guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide) and [workflow guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native) (frame grid, resolutions, reference limits, model files). The model card lists the [supported output range and dialogue languages](https://huggingface.co/MiniMaxAI/MiniMax-H3). These sources are summarized here in our own words.
