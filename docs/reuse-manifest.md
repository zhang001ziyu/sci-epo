# Reuse manifest

Sci-epo reuses code and methods from AINovel, the author's earlier private web application for long-form fiction (private repository, fixed commit `77b0494b94fea1003d93b515d34b8cc56c80493d`, read on 2026-11-05). The author asked for this reuse explicitly. AINovel itself was not changed, and no AINovel production data, novels, credentials or services were copied. This manifest is the disclosure of pre-existing code in this repository.

## Development history

- Versions up to 0.4.6 were developed in a private repository without Kiro.
- Version 0.5.0 (vertical short drama, line-aligned adaptations, shot lists) was specified and built with the Kiro spec in [`.kiro/specs/vertical-short-drama/`](../.kiro/specs/vertical-short-drama/requirements.md).
- On 2026-11-10 the source was imported into this public repository as one curated commit, without the private history. Development continues here.
- Operational scripts used only by the author's private deployment are not part of this repository. The public application does not need them.

## Reused AINovel components

| Sci-epo file or function | AINovel component | How it was reused |
| --- | --- | --- |
| `src/core/canonicalJson.ts` | Canonical JSON serializer | Copied unchanged. Dependency-free: stable key order, newline and Unicode normalization, rejection of values JSON cannot represent. |
| `src/core/index.ts`: `snapshotContext` | Chapter-memory snapshot | Reimplemented for screenplay data: a frozen copy of the context the draft actually used, plus a content hash. History accepts only the adopted earlier episodes chosen by the caller. |
| `src/core/index.ts`: `getReviewSources`, `parseReview` | Writing-craft review parser | Adapted exact two-way quotation checks, full dimension coverage, and the rule that unknown or invalid results never pass. Added scene binding and blocking of self-certified facts; the dimensions were rewritten for screenplay review. |
| `src/core/writingGuidance.ts` | Writing-craft guidance and a quality-loop design note | Rewritten for action, dialogue, subtext and playability. Kept the principles of character agency, limited knowledge, costs of world rules and no repeated explanation. |
| `src/server/provider.ts` | Model provider transport | Rewritten as a standalone transport for four protocols. Kept role configuration, stream completion checks, truncation rejection and redaction of upstream errors. No production service or billing module was imported. |
| `applySceneRewrite` | Boundary rules of partial rewriting | New deterministic single-scene replacement: the original revision is unchanged, unselected scenes are copied by the program, and locked scenes refuse rewrites. |
| `src/providerTypes.ts`, `src/server/providerManager.ts`, `web/providers.ts` (0.4.0) | Provider administration | Adapted the separation of connections and models, compare-and-swap configuration revisions, test-before-use qualification, immutable role assignment, per-task snapshots and keys that are never echoed. Encryption uses an independent random 256-bit key with AES-GCM, bound to the connection ID and revision; no AINovel key material was copied. The page was rewritten in Sci-epo's plain TypeScript UI without React, plans, user assignment or billing. |

## Limits

The quality-loop design was a proposal in the source project. Sci-epo adopts its review principles only and does not claim to inherit a mature quality engine. Quotation matching is a structural check; it does not prove that the model's interpretation is right. The literary quality of drafts and reviews still depends on real model output and on the author reading it.
