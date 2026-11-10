# Requirements Document

## Introduction

Sci-epo writes episodic sci-fi animation scripts today. Episodes are long, a quiet ending is allowed, and there is no shot breakdown. The next target is vertical short drama: episodes of one to two minutes in a 9:16 frame, in series of dozens of episodes. Each episode opens on a hook and ends on an open question. Every episode is voiced in Chinese and English, for Chinese platforms and for YouTube. One script must work for both animated and live-action-style production, so the visual style can be chosen later. Voice comes before video, so a script must be broken into a shot list that later voice and video stages can process one shot at a time.

This feature adds four things:

1. A format setting for each series. Vertical short drama is the first new format. Existing series keep today's behavior as the episodic format.
2. Short-drama writing and review rules. They do not assume a genre, work for any visual style, and are written for a vertical frame.
3. Chinese and English versions on one shot plan. The second language comes from an adaptation that keeps the script's lines one-to-one.
4. A versioned shot list bound to one exact script revision and its adaptations, with program checks, explicit adoption and CSV export.

Voice, video generation (MiniMax H3 or other models), character reference images, visual style selection and series memory are later work.

## Glossary

- **Format**: a series setting that selects writing rules, review criteria, aspect ratio and the episode duration target. Values: `vertical_short_drama` and `episodic`.
- **Episodic format**: the current behavior, unchanged by this feature.
- **Revision**: an immutable saved script version. Revisions already exist.
- **Adaptation**: a localization of a revision into another language. Adaptations already exist.
- **Script line**: a non-blank line of a scene's content, addressed by scene ID and its position among that scene's non-blank lines, counting from 1. Scene headings are not script lines.
- **Line-aligned adaptation**: an adaptation in which every scene has the same number of script lines as the source scene, each translated in place.
- **Voice languages**: the languages a series is voiced in.
- **Shot list**: an immutable, versioned breakdown of one revision into shots.
- **Shot**: consecutive script lines from one scene, with framing, camera, characters in frame, speakers and an estimated duration.
- **Cast list**: the shot list's characters who appear or speak, each with a stable cast ID (C1, C2 and so on).
- **Production shot list**: the shot list the writer has adopted for an episode.

## Decisions

Confirmed by the author on 2026-11-07:

- The default episode duration is 60–120 seconds.
- The per-shot warning limit is 15 seconds, the longest H3 clip.
- Every vertical short-drama episode gets Chinese and English voice tracks, for Chinese platforms and for YouTube.

## Requirements

### Requirement 1: Series format and duration target

**User Story:** As a writer, I want to choose a format for each series, so that drafts, reviews and shot lists follow that format's rules.

#### Acceptance Criteria

1. WHEN the writer creates or edits a series THEN the system SHALL offer the formats "vertical short drama" and "episodic series".
2. WHEN the writer creates a series in the workspace THEN the system SHALL preselect vertical short drama.
3. IF a stored series or an API request has no format THEN the system SHALL treat it as episodic and SHALL send exactly the same model instructions as before this feature.
4. WHEN a series uses vertical short drama THEN the system SHALL store an episode duration target in seconds that the writer can change, with a default of 60–120 seconds.
5. WHEN a draft is generated THEN the system SHALL freeze the format and duration target into the revision's context snapshot, and later review, rewrite, adaptation and shot-list operations on that revision SHALL use the frozen values.
6. WHEN the writer changes a series' format or duration target THEN the system SHALL change the acceptance context token and SHALL mark episodes that have revisions for recheck, as it does for other series changes.

### Requirement 2: Short-drama writing rules

**User Story:** As a writer, I want short-drama drafts to start fast, turn, and end on an open question, so that each episode makes viewers want the next one.

#### Acceptance Criteria

1. WHEN the system generates or rewrites a vertical short drama THEN the instructions SHALL require an opening beat that sets up a conflict, goal or question within the first lines, at least one turn or payoff, and a final beat that leaves a concrete open question leading into the next episode.
2. WHEN the system generates or rewrites a vertical short drama THEN the instructions SHALL target the frozen duration target, and SHALL ask for short scenes and for dialogue lines that can each be spoken in a few seconds.
3. WHEN the system generates or rewrites a vertical short drama THEN the instructions SHALL require each action beat and each spoken line on its own line, with an inline speaker label at the start of each spoken line.
4. The short-drama instructions SHALL keep the existing rules on causality, character agency, character knowledge, prop setup and continuity.
5. The short-drama instructions SHALL NOT assume a genre. The genre comes from the series brief.
6. WHEN the writer sets a word or character length target THEN the existing length check SHALL also apply to vertical short drama.
7. WHEN the writer chooses the demonstration path in a vertical short drama series THEN the system SHALL load a prepared short-drama example episode in English or Simplified Chinese, labeled as a demonstration. When vertical short drama is selected, the series form's example brief SHALL be a short-drama example.

### Requirement 3: Style-neutral, vertical-first scripts

**User Story:** As a writer, I want one script that works for animated and live-action-style production and reads on a phone screen, so that I can choose the visual style later without rewriting.

#### Acceptance Criteria

1. WHEN the system generates or rewrites a vertical short drama THEN the instructions SHALL ask for action that works in both animated and live-action-style footage. They SHALL forbid gags that depend on one medium, such as cartoon-only physics, and SHALL forbid style or rendering terms in the script text.
2. WHEN the system generates or rewrites a vertical short drama THEN the instructions SHALL favor beats that read with one or two characters in frame, close and medium shots, and visible reactions. They SHALL avoid beats whose meaning depends on wide horizontal staging.
3. The system SHALL NOT store a visual style on scripts or series in this feature.

### Requirement 4: Short-drama review criteria

**User Story:** As a writer, I want reviews of short dramas to check the opening hook, the turn and the ending, so that feedback matches the format.

#### Acceptance Criteria

1. WHEN the system reviews a vertical short drama THEN the review SHALL keep the same five dimensions and stored structure, and SHALL apply format criteria within them:
   - story checks the opening hook, the turn or payoff, and the ending's open question;
   - dialogue checks line length and whether each line can be spoken;
   - filmability checks vertical readability and whether the action works in any visual style.
2. WHEN the system reviews a vertical short drama whose ending leaves no open question THEN the review SHALL report it as a craft issue the writer can override.
3. Existing reviews, the verification pipeline and the authorization of review suggestions SHALL work unchanged for both formats.

### Requirement 5: Chinese and English versions

**User Story:** As a writer who publishes on Chinese platforms and on YouTube, I want every short-drama episode in Chinese and English on one shot plan, so that the same storyboard can be voiced in both languages.

#### Acceptance Criteria

1. WHEN the writer creates a vertical short drama series THEN the system SHALL set its voice languages to the script language, English and Simplified Chinese, without duplicates.
2. WHEN the writer changes a series' voice languages THEN the system SHALL keep the script language among them, and SHALL NOT change the acceptance context token or mark episodes for recheck.
3. WHEN the system adapts a vertical short drama revision THEN the instructions SHALL require one translated line for each script line in the same order, an inline speaker label on each spoken line, and a speaking time close to that of the source line.
4. IF a generated or edited adaptation of a vertical short drama revision is not line-aligned THEN the system SHALL reject it and report the first scene whose line count differs, with both counts.
5. The system SHALL keep today's adaptation rules and instructions for episodic series.
6. WHEN the system creates a shot list or saves a new version THEN it SHALL record the series' voice languages. For each voice language other than the script language, it SHALL bind at most one line-aligned adaptation of the source revision.
7. The workspace and the export SHALL show each shot's lines in every bound language, read from the bound revision and adaptations, and SHALL name the voice languages that still have no bound adaptation.
8. WHEN a newer line-aligned adaptation of the source revision exists in a bound language THEN the system SHALL show that the bound adaptation is not the newest.

### Requirement 6: Shot list generation

**User Story:** As a writer, I want to turn a saved script revision into a shot list, so that later voice and video tools receive one shot at a time with clear speakers and timing.

#### Acceptance Criteria

1. WHEN the writer requests a shot list for a saved revision THEN the system SHALL create a shot list bound to that revision's ID and SHALL leave the revision unchanged.
2. Each shot SHALL contain:
   - a shot ID that is unique within the shot list;
   - its scene ID;
   - the first and last script lines it covers;
   - a shot size and a camera movement, each from a fixed list;
   - the cast IDs of the characters in frame;
   - the cast ID of the speaker of each spoken line it covers;
   - an estimated duration in seconds;
   - an optional composition note and an optional sound note.
3. The shot list SHALL contain a cast list that gives each character who appears or speaks a stable cast ID, and every shot SHALL refer to characters by those IDs.
4. The shot list SHALL record the aspect ratio of the revision's frozen format: 9:16 for vertical short drama and 16:9 for episodic series.
5. WHEN the system generates a shot list with a live model THEN it SHALL use the existing writing model role and SHALL record the model snapshot and attempts in a run. A failed run SHALL keep its failure record and SHALL NOT save a shot list.
6. IF a live model call fails THEN the system SHALL NOT substitute demonstration output.
7. WHEN the writer chooses the demonstration path for the prepared short-drama example THEN the system SHALL load its prepared shot list, labeled as a demonstration.

### Requirement 7: Shot list integrity

**User Story:** As a writer, I want the program to verify the shot list against the script, so that no line is lost, duplicated or rewritten before voice and video.

#### Acceptance Criteria

1. The system SHALL accept a shot list only if:
   - every script line of every scene is covered by exactly one shot;
   - shots follow scene order and line order;
   - each shot covers consecutive lines of one scene.
2. Shots SHALL reference script lines and SHALL NOT store their own copy of script text. Displayed and exported text SHALL be read from the bound revision and adaptations.
3. The system SHALL accept a shot list only if each spoken line lies inside its shot and each cast ID exists in the cast list.
4. IF a generated or edited shot list fails these checks THEN the system SHALL reject it, keep all earlier versions, and report which scene, line or shot failed.

### Requirement 8: Shot list warnings

**User Story:** As a writer, I want warnings about timing, speakers and alignment, so that I can fix problems before spending voice and video generation on them.

#### Acceptance Criteria

1. WHEN a shot's estimated duration exceeds 15 seconds THEN the system SHALL warn that the shot is longer than one video generation.
2. WHEN a shot's estimated duration is shorter than its spoken lines need in any bound language, at that language's reference speaking rate, THEN the system SHALL warn, naming the language and the estimated minimum.
3. WHEN a shot has more than one speaker THEN the system SHALL warn that video models can put a line in the wrong character's mouth.
4. WHEN the speaker label written in the source script for a spoken line names a different character than its assigned cast ID THEN the system SHALL warn about the mismatch.
5. WHEN a line that the source script marks as dialogue has no assigned speaker THEN the system SHALL warn.
6. WHEN a script line is spoken in the source script but not in a bound adaptation, or the reverse, THEN the system SHALL warn that the adaptation may be misaligned at that line.
7. The system SHALL show the total estimated duration against the frozen duration target, and SHALL label all durations as estimates until measured audio exists.
8. Warnings SHALL NOT block saving, adoption or export.

### Requirement 9: Shot list versions and adoption

**User Story:** As a writer, I want shot lists versioned, tied to the exact script revision and explicitly adopted, so that I never use an outdated shot list after the script changes.

#### Acceptance Criteria

1. WHEN the writer edits a shot list THEN the system SHALL save a new immutable version that passes the same integrity checks, SHALL keep shot IDs for unchanged shots, and SHALL keep earlier versions.
2. WHEN the writer adopts a shot list THEN the system SHALL record it as the episode's production shot list only if its source revision is the episode's accepted revision and the episode does not need review.
3. WHEN the episode's accepted revision changes or the episode needs review THEN the system SHALL show the adopted shot list as not current and SHALL NOT present it as current.
4. WHEN the writer views a shot list whose source revision differs from the selected revision THEN the system SHALL list the scenes whose heading or content differ between the two revisions.
5. WHEN two browser tabs adopt different shot lists THEN the system SHALL reject the stale adoption instead of silently replacing the newer one.

### Requirement 10: Shot list export

**User Story:** As a writer, I want to export a shot list as a spreadsheet, so that I can run voice and video tests by hand before integrations exist.

#### Acceptance Criteria

1. WHEN the writer exports a shot list THEN the system SHALL produce a CSV file with one row per shot. Each row SHALL include:
   - the shot ID, scene ID and order;
   - the shot size and camera;
   - the characters and speakers;
   - the covered lines in each bound language;
   - the estimated duration;
   - the composition and sound notes;
   - the aspect ratio;
   - the source revision ID, the bound adaptation IDs and the shot-list version ID.
2. The export SHALL display Chinese and English text correctly when opened in common spreadsheet software.
3. The export SHALL neutralize any cell value that spreadsheet software would run as a formula.
4. The export SHALL state whether the shot list is the current production shot list and that durations are estimates.

### Requirement 11: Shot list workspace

**User Story:** As a writer, I want a shot-list tab next to the script, so that I can create, read, edit, adopt and export shots without leaving the episode.

#### Acceptance Criteria

1. The episode workspace SHALL add a shot-list tab. It SHALL show shots in order, grouped by scene, each with its covered lines in every bound language, framing, camera, speakers, estimated duration and warnings.
2. Each shot card SHALL show a frame placeholder in the shot list's aspect ratio.
3. The tab SHALL show whether the shot list is the current production shot list. It SHALL offer generation, manual editing, adoption and CSV export.
4. The system SHALL escape every displayed shot-list value, as it does for other model output.
5. The workspace title and descriptions SHALL present a screenwriting workspace without limiting it to science fiction.

### Requirement 12: Compatibility

**User Story:** As the owner of the deployed workspace, I want this feature to keep existing data and deployment working, so that I can deploy it without data migrations or model reconfiguration.

#### Acceptance Criteria

1. Existing projects, episodes, revisions, reviews, runs and adaptations SHALL load and behave as before.
2. The feature SHALL NOT require changes to the model role assignment or provider configuration.
3. The full test suite SHALL pass on Windows, macOS and Linux.

## Out of scope

- Voice: voice casting, text-to-speech, per-line audio, measured durations and per-shot audio tracks.
- Video: MiniMax H3 or other model integration, H3 prompt export, shot chaining and character reference sheets.
- Video in two languages. The video spec will decide between generating video once per language and generating it once, then re-syncing the lips for the second language.
- Choosing a visual style, animated or live-action style.
- Model review of shot lists. This feature checks shot lists with program rules only.
- Series memory. Generation still includes the full text of every accepted earlier episode, which will not scale to dozens of episodes.
- Reusing shots from an earlier shot list for scenes that did not change.
- Making the default review cheaper.
- Publication settings for several releases, such as a Chinese release for domestic platforms and an English release for YouTube.
