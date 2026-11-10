# Sci-epo

Sci-epo is a script-development workspace for vertical short dramas and episodic series. It takes a premise to an accepted script and then to a shot list that voice and video generation can use. Scripts stay style-neutral, so the same script can be produced as animation or in a live-action style.

The writing comes first. A model drafts and reviews; the author decides. Every draft, review and rewrite is an immutable version, and nothing becomes series canon until the author adopts it.

## What works today

- **Drafting, review and revision.** Generate an episode from the series premise, characters and world rules. Review it on five writing dimensions plus a separate cause-and-effect check. Every review claim has to quote the frozen script exactly; claims the program cannot match are shown but held back from rewriting. Rewrite one scene: the program copies every other scene unchanged and refuses to touch locked scenes. Compare the candidate with the original and adopt it explicitly.
- **Two series formats.** *Vertical short drama* (9:16, 60–120 seconds per episode by default) asks for an opening hook, a turn and a concrete open question at the end, with one action beat or spoken line per line (`NAME: line`). *Episodic* series keep the earlier behavior; their model instructions are locked by a golden test.
- **Two voice languages.** A short-drama script can be adapted into English or Simplified Chinese line by line. The program rejects an adaptation whose scene or line counts differ from the source, so one shot plan serves both voice tracks.
- **Chinese or English manuscript.** A switch in the header shows the Chinese or the English manuscript of the open version, and the shot list lists that language first. Export asks for the language and writes the source script or the current adaptation of that exact version; an adaptation of an older version is never offered as the current one.
- **Shot lists.** A shot list binds to one saved revision and references script lines by position instead of copying them. The program rejects gaps, overlaps and out-of-order shots. It warns about shots over 15 seconds (the longest MiniMax H3 clip), durations too short for the dialogue in any bound language, several speakers in one shot, and speaker labels that disagree with the script. Shot lists are versioned, adopted with compare-and-swap, and exported as CSV.
- **Series continuity.** Each draft freezes the context it was written with. Only adopted earlier episodes feed later drafts, and changes upstream ask the author to recheck.
- **Model services.** An owner-only page manages OpenAI-compatible (Chat Completions or Responses), Anthropic Messages and Google Gemini connections. Generation, review and revision can use different models. API keys are encrypted at rest and never sent back to the browser. Model errors never fall back to example text.
- **MiniMax H3 production bridge.** The 制作 (Production) tab turns the adopted shot list into render jobs: clips of up to 15 seconds, one job per clip and voice language, each with an H3 prompt in MiniMax's published format that the program checks against the script line by line. A Python worker renders them with ComfyUI in Google Colab or on your own GPU, reached in three ways: a job package file, a worker that pulls jobs with a token, or a worker URL that Sci-epo pushes to. Videos stay in the worker's folder; Sci-epo records status, file names and durations. See the [production bridge guide](docs/production-bridge.md) and the [Colab notebook](worker/colab/sciepo_h3_worker.ipynb).
- **Self-hosting.** One Bun process and one SQLite file. A public deployment has a single owner account with an Argon2id password, `__Host-` secure cookies and CSRF checks.

The interface text is currently Simplified Chinese.

## Try it

You need [Bun](https://bun.sh) 1.4 or later.

```sh
bun install --frozen-lockfile
bun run start
```

Open <http://127.0.0.1:4317>. Without a configured model, the workspace offers a clearly labeled example path that runs the whole flow without any model call: create a series and an episode, generate the example draft, review it, rewrite the last scene, compare and adopt. For a vertical short drama, the example also adapts the script into the second voice language on the 语言与发布 (Languages and publication) tab and builds, edits, adopts and exports a shot list on the 分镜 (Shot list) tab.

To use a real model, open **模型服务** (Model services), add a connection and a model, run its test, and assign it to the writing, review and revision roles. See [model setup (中文)](docs/provider-setup.md). Saved work lives in `data/sci-epo.sqlite`.

## The pilot

Pip has one jetpack burst. She spends it saving a birthday cake in a zero-gravity mailroom. When the writer asks for a funnier ending, firing the pack again would contradict the fuel gauge going dark in scene 2. The loose metal lid from scene 1 gives her another way home.

- [The 75-second pilot script, *One Puff Left*](examples/one-puff-left.md)
- [Its continuity fixture](examples/one-puff-left.json): two locked scenes, one rewritable scene, a rejected ending that spends an empty charge, and the reference ending that throws the lid.

## Checks

```sh
bun run typecheck
bun test ./tests
bun run build
```

The render worker has its own tests, run with Python 3.10 or later and no extra packages:

```sh
python -m unittest discover -s worker/tests
```

The tests run offline against simulated model responses and simulated ComfyUI and Sci-epo servers. They do not prove that a real model service works or that a script is good. Real-model runs are recorded separately, for example in the [short-drama verification (中文)](docs/short-drama-verification-2026-11-08.md).

## How Kiro is used

- **Specs.** Each feature is planned as requirements, design and tasks in `.kiro/specs/` and implemented task by task: [vertical short drama](.kiro/specs/vertical-short-drama/requirements.md) (formats, line-aligned adaptations, shot lists) and the [bilingual workspace](.kiro/specs/bilingual-workspace/requirements.md) (manuscript language switch, export by language).
- **Steering.** [`episode-continuity.md`](.kiro/steering/episode-continuity.md) holds the writing and revision rules: stable scene IDs, locked scenes preserved byte for byte, line-aligned adaptations, shot lists that never copy script text. [`public-repo.md`](.kiro/steering/public-repo.md) keeps credentials and private deployment details out of this repository. [`communication.md`](.kiro/steering/communication.md) sets the working language with the author.
- **Golden test.** `tests/fixtures/episodic-prompts.json` locks the model instructions for episodic series, so the short-drama work could not change them silently.

## Pre-existing work

Versions up to 0.4.6 were developed in a private repository without Kiro, and parts of the code are adapted from the author's earlier private project AINovel. The [reuse manifest](docs/reuse-manifest.md) lists every reused component and the development history.

## Status and limits

- Sci-epo does not run H3. The bridge and the worker are tested offline; a render with the real H3 model has not been verified yet, and the program-built prompts are plainer than hand-written ones.
- A deployment has one owner. Public registration and multi-user workspaces are not implemented.
- Review quotation checks are structural. The model still makes the semantic judgments, and the author has to read the result.

## Next

- First real H3 renders of the prepared example in Colab, and prompt changes from what they show.
- A public demo site with prepared examples and no model calls, for judges.

## Documentation

- [Self-hosting on a Linux server](docs/self-hosting.md)
- [Model setup (中文)](docs/provider-setup.md) · [Model services page (中文)](docs/provider-management.zh-CN.md)
- [Script quality: length and cause-and-effect checks (中文)](docs/script-quality.zh-CN.md)
- [Multilingual content and publication choices (中文)](docs/multilingual-publication.zh-CN.md)
- [Current priority: script development and revision (中文)](docs/script-first-plan.zh-CN.md)
- [Long-term production direction (中文)](docs/production-plan.zh-CN.md)
- [Implementation contract](docs/implementation-contract.md)
- [Related projects, 2026-11-05 (中文)](docs/research-2026-11-05.md)

## Kiroween 2026

The proposed category is **Frankenstein**: Sci-epo stitches a generative writing model to deterministic checks (exact quotation, scene locks, line-aligned adaptations, shot coverage) so the author can see where a proposed change breaks the script.

## License

[MIT](LICENSE)
