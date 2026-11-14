# Keeping the scene state straight from script to clip (2026-11-14)

The first rendered episode of *The Last Order* broke in two places:

- **Script:** Leo sits in the armchair, heaves himself up, strikes a match and holds the flame to the blue envelope, which is taped to the kitchen fridge. The script never moves him to the kitchen. The logic check asked whether a character can *see* a thing, not whether he can *reach* it.
- **Clips:** each clip is a separate video request. The clip after the match strike said only "firelight lights his face". The bible described the red matchbox, so the model put the box on the table and left Leo empty-handed. The next clip said "Leo freezes" with no position, and the setting text begins with the armchair, so he sat down again.

We asked how other script, storyboard and short-drama tools keep "who is where, sitting or standing, holding what, fire lit or not" consistent. Below is what we could confirm, in our own words, with links. "Not confirmed" means we found no public description, not that the product lacks it.

## What other tools and papers do

| Source | What it records and passes on | Confirmed? |
|---|---|---|
| [StateAgent / StateBench](https://arxiv.org/abs/2609.03673) ([code](https://github.com/AMAP-ML/StateAgent)) | Treats "remembering earlier pixels" and "knowing the current world state" as different tasks. Keeps entity states across video segments and plans the end state of the next segment. 200 cross-segment tasks, including changes that happen while hidden. | Yes, paper and repo |
| [CANVAS](https://arxiv.org/abs/2604.13452) | Plans character appearance, location and prop-state changes shot by shot; a prop that a character carries away must leave the background too. | Yes, paper |
| [SEAM](https://arxiv.org/abs/2608.22725) | Short-drama per-shot state memory, injected by rewriting each shot prompt. Reports continuity recall rising from 0.700 to 0.946. | Yes, paper |
| [CineCrew / FilmDSL](https://arxiv.org/html/2609.07720v1) | Keeps three layers apart: narrative action, staging (camera, blocking, props) and the generator prompt; production memory keeps accepted keyframes and locked props. | Yes, paper |
| [TRIP](https://arxiv.org/abs/2109.04947) | Physical-commonsense benchmark built on preconditions and effects of each action, with the conflicting sentence pair as evidence. | Yes, paper |
| [PhyEvolve](https://arxiv.org/pdf/2610.30717.pdf) | Physical plausibility of generated video actions. | Yes, paper |
| [Novelcrafter Progressions](https://docs.novelcrafter.com/en/articles/8675593-progression-additions) | Codex entries change from a given scene onward; earlier scenes don't see later changes. Meant for big changes (injury, a lost item), not per-action state. | Yes, docs |
| [drama-skills storyboard skill](https://skillsmp.com/creators/worldwonderer/drama-skills/skills-short-drama-storyboard) | A short-drama storyboard skill whose stated scope includes checking axis, blocking, eyelines and held-prop continuity. | Yes, listing only |
| [MiniMax H3](https://docs.oxen.ai/inference-api/reference/models/minimax-h3) | First/last-frame input and reference input are mutually exclusive in one request. | Yes, third-party API docs |
| Dramatron, Sudowrite Story Bible | Layered context and a story bible; no public sign of per-action state or reach rules. | Partly (see [earlier note](research-script-logic-2026-11-13.md)) |
| Jimeng "short-drama director stage", Katalist, LTX Studio Elements, 白日梦 AI | Reported to keep 3D blocking, asset references or position edits. | Not confirmed by us; GitHub only shows similar open tools ([kunpeng-director](https://github.com/pengfeiqiao/kunpeng-director), [director-stage](https://github.com/yzsp-studio/director-stage)) |

Common pattern in the confirmed sources: the model extracts events with evidence, a program applies each event's preconditions and effects to a state, and every shot or segment receives the state it starts from. Asset descriptions say what a thing looks like, never where it is now.

## What Sci-epo changes

1. **Blocking in the logic check.** The ledger records each character's start position and posture, each move, and every action on a fixed object. The program flags an action on an object in another zone when no move gets the character there, and an action while seated that needs standing.
2. **Per-line scene state.** After the script is accepted, the program folds the ledger into a table: for each script line, each character's zone, posture and what they hold, and each prop's place and condition. Reaction lines change nothing. The author reviews it before the shot list.
3. **Clip opening state.** Each clip prompt opens with the state at its first line, and the bible lists only the props on screen in that clip. A prop description no longer implies the prop is visible.
4. **Hard actions.** The shot list warns when a shot asks the video model for fine hand-and-flame contact, and suggests splitting it into action and result shots.

Content was rephrased for compliance with licensing restrictions.
