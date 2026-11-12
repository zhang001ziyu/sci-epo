# How other script and story projects keep the logic straight (2026-11-13)

Sci-epo is a script workspace first. Before changing how it checks and revises a script, we looked at what the best-known open projects and papers do. The content below is summarized in our own words; follow the links for the originals.

| Project | What it does | What Sci-epo takes from it |
|---|---|---|
| [DeepMind Dramatron](https://github.com/google-deepmind/dramatron) ([paper](https://arxiv.org/abs/2209.14958)) | Builds a screenplay top-down from a log line: characters, plot points, locations, then dialogue, so later text keeps to the structure above it. Writers in its study used it for world building and exploring alternatives, not as an autonomous writer. | The author stays in the loop; structure comes before dialogue. A beat outline step before the scene text is the next candidate change (see below). |
| [Dramaturge](https://arxiv.org/abs/2510.05188) | Revises a finished script in three stages: a global review for structural problems, a scene-level review for local flaws, then a coordinated revision across scenes so local edits do not contradict the whole. Iterates until no substantive change. | **Coordinated whole-script revision**: the open findings of the logic check are fixed together, in one plan across scenes, then checked again. Sci-epo's earlier one-scene rewrite could not fix a problem whose cause and effect sit in different scenes. |
| [Story Debugger](https://github.com/Rietaros/story_debugger) | An LLM extracts structured events, items, knowledge and causes; rule-based checks then flag problems such as an item used before it is acquired or a memory claim without a knowledge event. | **Ledger plus program**: Sci-epo's logic check has the model fill a ledger and lets the program decide the findings, instead of asking the model for a verdict. |
| [FlawedFictions](https://github.com/kabirahuja2431/FlawedFictions) ([paper](https://arxiv.org/abs/2504.11900)) | A benchmark of stories with planted plot holes. It reports that strong LLMs struggle to find plot holes, and that LLM-generated and summarized stories contain more of them than human-written originals. | A free-form model review is not enough evidence that a script holds; findings need structure, line references and an acceptance fixture (`examples/last-order-draft.json`). |
| [Re3](https://github.com/yangkevin2/emnlp22-re3-story-generation) and [DOC](https://github.com/yangkevin2/doc-story-generation) | Plan (premise, characters, outline), draft, rewrite, edit; DOC adds a detailed outline that the draft must follow. | Planning before prose, and an edit pass that compares the text with established facts. |
| [Sudowrite Story Bible](https://sudowrite.com/blog/how-sudowrite-works/) (commercial) | Braindump → synopsis → characters → worldbuilding → outline → scenes → draft; every layer feeds the next and the AI references all of them. | The episode bible for production, and the same order of work: settle the story before the scenes. |

## What changed in Sci-epo

1. **Script logic check** (ledger plus program, after Story Debugger and FlawedFictions): who knows what and from where, what the ending depends on and where it first appears, which setups pay off, unexplained instructions, sight lines, and the protagonist's costly choices. On the first real episode it found all six kinds of break that a manual reading had found, where the five-dimension review had found one.
2. **Script before video**: the episode bible, shot lists and render batches wait until every finding is fixed or kept with a reason.
3. **Coordinated whole-script revision** (after Dramaturge): one request takes all open findings, plans the fix across scenes, returns the whole script as a candidate revision, and the check runs again on it. Locked scenes stay as they are; the author compares and accepts.

## Next candidate

A **beat outline before the scene text** (Dramatron, DOC, Sudowrite): the model drafts beats with cause, who acts and what each character learns; the logic check runs on the beats, the author confirms them, and only then the scenes are written. This catches a break before any dialogue exists.
