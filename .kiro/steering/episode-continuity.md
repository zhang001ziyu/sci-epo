---
inclusion: always
---

# Writing and revision conventions

- Develop the script before video. Write visible action and playable, speaker-labelled dialogue; episode length and scene count follow the author's brief rather than a fixed running time.
- Default new original scripts to English. Preserve the selected script language across revision; Chinese author notes do not require Chinese dialogue. Keep story adaptation, audio language and subtitle language separate.
- Bind every localized script to an immutable source revision and preserve its scene IDs and order. Use the frozen glossary; source changes require a new adaptation or explicit comparison. Never label an old translation as current.
- Video, dubbing and timed subtitles remain later production work. Publication settings alone are not rendered media or verified subtitle timings.
- Establish the world rule and each prop the ending depends on before the payoff. Let the gag change when the writer revises a scene.
- Give each scene a stable ID. Preserve the full text and ID of every locked scene across a revision. Show a replacement to the writer before accepting it.
- For the first prototype, track a finite resource by scene. Attach each use to the action that spends it. The checker should name the earlier scene that exhausted it and the later action that asks for another use.
- Keep the model's draft separate from the accepted script. If its annotations disagree with the prose, surface the mismatch for the writer.
- Use `examples/one-puff-left.json` as the first acceptance fixture. Its invalid ending tries to spend an empty jetpack charge. Its reference ending reuses the lid established in scene 1.
- Vertical short drama: open on a hook, include a turn, end on a concrete open question. Put each action beat and each spoken line on its own line, with an inline speaker label (`NAME: line`, `名字：台词`). Keep scripts style-neutral (no medium-only gags or rendering terms) and readable in a 9:16 frame.
- A shot list binds to one immutable revision and references its script lines by position. Never copy or rewrite script text into shots; every script line belongs to exactly one shot, in order.
- Short-drama adaptations translate line by line, so one shot plan serves every voice language. Reject an adaptation whose line counts differ from the source.
- Adopt a shot list only from the accepted script revision. When the accepted revision changes, show the old production shot list as not current.
- Episodic prompts are locked by `tests/fixtures/episodic-prompts.json`; a change there means episodic behavior changed and needs an explicit decision.
