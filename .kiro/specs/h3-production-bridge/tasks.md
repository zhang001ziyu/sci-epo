# Implementation Plan

- [x] 1. Core planning and prompts
  - [x] 1.1 Add the production, render and worker-token types, and `Project.production`.
    - _Requirements: 1.1, 1.3, 4.1, 6.2_
  - [x] 1.2 Create `src/core/h3.ts` with `parseProductionProfile`, `h3Frames`, `h3Size`, `planClips` and clip seeds.
    - _Requirements: 1.4, 2.2, 2.3, 2.4, 2.5, 2.6_
  - [x] 1.3 Add the line sources, the T2VA and R2V builders, `verifyPrompt` and `planRenderBatch`.
    - _Requirements: 3.1–3.9_
  - [x] 1.4 Add `renderPackage`, `parseRenderResults` and output file names.
    - _Requirements: 5.1, 5.2, 5.3_
  - [x] 1.5 Test frames, grouping, seeds, both prompt layouts, line sources, rejection rules and the self-check.
    - _Requirements: 2.2–2.6, 3.1–3.9_

- [x] 2. Server
  - [x] 2.1 Add the `render_batches`, `render_jobs` and `worker_tokens` tables, and batches and jobs in project bundles.
    - _Requirements: 4.1, 4.2, 9.1_
  - [x] 2.2 Add the profile, batch, package, results, requeue and token endpoints.
    - _Requirements: 1.1, 1.3, 2.1, 4.1–4.5, 5.1–5.4, 6.1, 6.2_
  - [x] 2.3 Add the worker endpoints with bearer authentication, claim leases and ownership checks, routed before the owner session check.
    - _Requirements: 4.3, 4.5, 6.3–6.7_
  - [x] 2.4 Add push and sync to a worker URL.
    - _Requirements: 7.1–7.4_
  - [x] 2.5 Test the endpoints, the token boundary, leases, idempotent results and push and sync against a fake worker.
    - _Requirements: 4.3–4.5, 5.3, 5.4, 6.2–6.7, 7.2–7.4_

- [x] 3. Production tab
  - [x] 3.1 Create `web/production.ts` with the profile form, batch creation, the batch table, results upload, push and sync, and token management.
    - _Requirements: 1.1, 1.2, 1.5, 6.1, 7.1, 7.3, 9.1, 9.2, 9.3_
  - [x] 3.2 Add the `制作` tab to `web/app.ts` and styles.
    - _Requirements: 9.1_
  - [x] 3.3 Test escaping, the empty state, counts and the one-time token display.
    - _Requirements: 6.1, 9.1, 9.2_

- [x] 4. Worker and notebook
  - [x] 4.1 Write `worker/sciepo_worker.py` with the three modes, the three backends and `prepare-workflow`.
    - _Requirements: 8.1–8.6_
  - [x] 4.2 Write `worker/tests/` with fake ComfyUI and Sci-epo servers.
    - _Requirements: 8.2–8.5_
  - [x] 4.3 Write the Colab notebook.
    - _Requirements: 8.7_

- [x] 5. Documentation and verification
  - [x] 5.1 Write `docs/production-bridge.md` for Colab and self-hosted workers, and update the README.
    - _Requirements: 8.8_
  - [x] 5.2 Run the Bun and Python checks, and walk through the prepared example: profile, batch, package, a dry-run render, results upload, a pull worker and a pushed batch on a local server.
    - _Requirements: 5.3, 6.5, 7.1, 9.1_
  - [ ] 5.3 Render the prepared example with the real H3 model in Colab and adjust prompts and `prepare-workflow` from the result.
    - _Requirements: 3.1, 3.2, 8.4_

## Verification notes (2026-11-10)

- `bun run typecheck`, `bun test ./tests` and `bun run build` passed; `python -m unittest discover -s worker/tests` passed with Python 3.14 (the command-backend test runs only on POSIX shells and was skipped on Windows).
- End to end on a local server with a temporary database and the prepared English short drama with its Chinese adaptation: one batch of 6 clips and 12 jobs. Mode A: the downloaded package rendered with `dry-run` wrote 12 prompt files, and uploading its results applied nothing, as dry runs must. Mode B: a real worker token and `pull` rendered 6 jobs through a simulated ComfyUI, uploading `maya.png` for the R2V clips, and Sci-epo recorded 6 successes. Mode C: `serve` accepted the pushed package, skipped the 6 jobs already done, rendered the other 6, and two syncs brought the batch to 12 of 12; a wrong key returned an HTTP 401 message without the key.
- The 制作 tab showed the profile rows for MAYA and LEO, the batch as current with 12 done, file names and durations per language, the worker token with its last use, and the R2V prompt of clip c01.
- Not verified: a render with the real H3 model (task 5.3).
- 2026-11-10, later: the R2V template open in the author's Colab ComfyUI was exported read-only from the browser (its runtime had stopped), and the official T2V and R2V templates and `comfy_extras/nodes_minimax_h3.py` were read. The templates feed the H3 node from a prompt box, a resolution selector and a duration formula, and the T2V template wraps the node in a subgraph; the first `prepare-workflow` would have missed all three. It now targets the H3 node directly, maps and adds reference slots, and has `--turbo`; tests use the templates' wiring.
