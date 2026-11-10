# Requirements Document

## Introduction

Every vertical short-drama episode is voiced in Chinese and English, for Chinese platforms and for YouTube. Today the script tab always shows the source script, and the other language appears only on the 语言与发布 (Languages and publication) tab, next to the source. Export always produces the source language.

This feature lets the author read and export either language of the same revision:

1. A manuscript language switch with two choices, 中文 and English.
2. The script tab, the languages tab and the shot-list tab follow the chosen language.
3. Export asks which language to write out.
4. Language pickers offer only English and Simplified Chinese for now.

The interface text itself stays in Simplified Chinese. Review, rewriting, scene locks and adoption keep working on the source script.

## Glossary

- **Script language**: the language a revision was written in.
- **Source script**: a revision in its script language.
- **Adaptation**: a localization of one revision into another language. Adaptations already exist and are immutable versions.
- **Current adaptation**: for one revision and one language, the newest adaptation of that revision in that language. For vertical short drama, only line-aligned adaptations count.
- **Manuscript language**: the language the author chose with the switch.
- **Manuscript**: the source script or the current adaptation shown or exported in the manuscript language.

## Requirements

### Requirement 1: Manuscript language switch

**User Story:** As an author who publishes in Chinese and English, I want one switch for the manuscript language, so that I can read the version I am working on without hunting for it.

#### Acceptance Criteria

1. WHEN a revision is open THEN the workspace header SHALL offer the choices 中文 and English.
2. WHEN the author picks a language THEN the system SHALL remember it in this browser across series, episodes, reloads and sign-outs.
3. IF the author has not picked a language THEN the system SHALL show the source script and mark its language as selected.
4. The switch SHALL NOT change any stored script, adaptation, shot list or production setting.

### Requirement 2: Script tab in the manuscript language

**User Story:** As an author, I want the script tab to show the manuscript in the language I chose, so that I can read the Chinese or the English version of the same revision.

#### Acceptance Criteria

1. WHEN the manuscript language equals the revision's script language THEN the script tab SHALL show the editable source script as before.
2. WHEN the manuscript language differs from the script language AND the revision has a current adaptation in that language THEN the script tab SHALL show that adaptation read-only, with its language, the source version number, its creation time and whether it is a model candidate, a prepared example or an author edit.
3. WHEN an adaptation is shown THEN the script tab SHALL state that review, rewriting, scene locks and adoption act on the source script, and SHALL offer to edit the adaptation on the languages tab.
4. IF the revision has no adaptation in the manuscript language THEN the script tab SHALL say so and offer to generate one: with the live model when it is configured, and with the prepared example when the revision is a demonstration.
5. IF only other revisions of the episode have adaptations in the manuscript language THEN the system SHALL describe them as belonging to other versions and SHALL NOT show them as the manuscript of the open revision.
6. WHILE the source script has unsaved edits the system SHALL disable generating an adaptation.

### Requirement 3: Other tabs follow the manuscript language

**User Story:** As an author, I want the languages tab and the shot list to start from the language I chose, so that the whole workspace stays in that language.

#### Acceptance Criteria

1. WHEN the manuscript language differs from the script language THEN the languages tab SHALL preselect it as the adaptation target.
2. WHEN a shot list covers the manuscript language THEN each line on the shot-list tab SHALL show the manuscript language first and the other voice language after it.
3. The review, comparison and history tabs SHALL keep showing the source script.

### Requirement 4: Export by language

**User Story:** As an author, I want to choose the language of an exported script, so that I can hand the Chinese or the English manuscript to a voice or video stage.

#### Acceptance Criteria

1. WHEN a revision is open THEN the export control SHALL offer the Chinese and the English manuscript of that revision.
2. WHEN the author exports the script language THEN the system SHALL export the source revision. WHEN the author exports the other language THEN the system SHALL export the current adaptation of the same revision.
3. IF the revision has no adaptation in the requested language THEN the export control SHALL be disabled with the reason, and the export API SHALL answer 404 with a message naming the language.
4. IF the requested language code is invalid THEN the export API SHALL answer 400.
5. WHEN a manuscript is exported THEN its provenance notes SHALL be written in the manuscript's language, SHALL state that export does not mean adoption or accepted quality, and, for an adaptation, SHALL name the source revision.
6. WHEN a manuscript is exported THEN the file name SHALL include the language code.

### Requirement 5: Chinese and English only, for now

**User Story:** As an author, I want the language lists to offer only the languages I produce in, so that I do not pick a language the production stages do not support yet.

#### Acceptance Criteria

1. The pickers for the script language, the adaptation target, the voice languages, the audio language and the subtitle languages SHALL offer English and Simplified Chinese.
2. IF a stored setting uses another language THEN its picker SHALL still show and keep that value.
3. The server SHALL keep accepting the languages it accepted before, so existing data needs no migration.
4. Model instructions SHALL NOT change; the episodic golden prompts stay identical.
