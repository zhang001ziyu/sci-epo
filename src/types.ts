export interface LengthTarget { min: number; max: number; unit: 'words' | 'characters' }
export interface LengthCheck { status: 'within_range' | 'too_short' | 'too_long' | 'not_set' | 'ambiguous'; count: number; unit: 'words' | 'characters'; target?: LengthTarget; source: 'structured' | 'brief' | 'none'; message: string }
/** Absent format means episodic, the original behavior. Only vertical short drama is stored. */
export type Format = 'vertical_short_drama' | 'episodic';
/** Whole seconds of screen time for one episode. */
export interface DurationTarget { min: number; max: number }
export interface Brief { title: string; premise: string; characters: string; worldRules: string; authorRules: string; language?: string; glossary?: string; lengthTarget?: LengthTarget; format?: Format; durationTarget?: DurationTarget }
export interface PublicationSettings { audioLanguage: string; subtitleLanguages: string[]; subtitleStyle: 'selectable'|'burned-bilingual'|'none'; platform: 'youtube'|'bilibili'|'general' }
/** How a series looks and sounds on screen. English free text, because H3 expects English prompt bodies. */
export interface ProductionCharacter { name: string; appearance: string; voice: string; image?: string; voiceSample?: string; usePortrait?: boolean; portrait?: AssetRef & {approvedAt: string}; voiceSampleAsset?: AssetRef }
export interface ProductionProfile { style: string; music: string; characters: ProductionCharacter[] }
/** voiceLanguages and production are settings outside the frozen brief: changing them never requires a story recheck. */
export interface Project extends Brief { id: string; createdAt: string; updatedAt: string; publication?: PublicationSettings; voiceLanguages?: string[]; production?: ProductionProfile; productionSettings?: ProductionSettings }
/** Production settings outside the frozen brief. The compute-unit rate is the one Colab shows for the chosen runtime. */
export interface ProductionSettings { computeUnitsPerHour?: number }
export interface Episode { id: string; projectId: string; ordinal: number; title: string; acceptedRevisionId: string | null; needsReview: boolean; createdAt: string; contextToken?: string; productionShotListId?: string; bible?: EpisodeBible }
/** A place of the episode. look is an English noun phrase for the video model; note is the author's own wording. */
export interface BibleLocation { id: string; name: string; look: string; note?: string }
/** An object the story uses, described so that it looks the same in every clip. */
export interface BibleProp { id: string; name: string; look: string; note?: string }
/** Where one scene happens and which props it shows. */
export interface BibleScene { sceneId: string; locationId: string; props: string[] }
export interface BibleContent { locations: BibleLocation[]; props: BibleProp[]; scenes: BibleScene[] }
/** The episode bible of one revision. Only a confirmed bible of the accepted revision reaches shot lists and clip prompts. */
export interface EpisodeBible extends BibleContent { revisionId: string; mode: ProviderMode; createdAt: string; confirmedAt?: string }
/** The model's ledger of a script's logic. Line references are `<sceneId>:<line>` among the scene's non-blank lines. */
export interface LogicLedger {
  protagonist: string;
  /** Characters who appear only through messages, calls or notes, and what each message shows they know. */
  offscreen: {character: string; messageRef: string; claims: {fact: string; sourceKind: 'self' | 'present' | 'told' | 'sees' | 'earlier' | 'brief' | 'none'; sourceRef: string | null}[]}[];
  ending: {ref: string; question: string; dependsOn: {thing: string; kind: 'prop' | 'rule' | 'relationship' | 'fact'; firstRef: string | null}[]};
  setups: {thing: string; ref: string; payoffRef: string | null; bearsOnEnding: boolean}[];
  instructions: {text: string; ref: string; reasonRef: string | null}[];
  sightings: {who: string; what: string; ref: string; visible: 'yes' | 'no' | 'unclear'; why: string}[];
  choices: {ref: string; choice: string; cost: string}[];
}
export type LogicKind = 'offscreen_knowledge' | 'ending_unstated' | 'ending_late' | 'dead_setup' | 'unexplained_instruction' | 'unseen' | 'no_choice';
/** A finding the program draws from the ledger, in plain words, with where it is and a way to fix it. */
export interface LogicFinding { id: string; kind: LogicKind; ref: string; title: string; detail: string; fix: string }
/** One logic check of one revision. A finding is settled by a new revision without it, or kept by the author with a reason. */
export interface LogicCheck { id: string; revisionId: string; episodeId: string; mode: ProviderMode; ledger: LogicLedger; findings: LogicFinding[]; kept?: Record<string, {reason: string; at: string}>; createdAt: string }
/** The author's shot-by-shot check of one shot list, keyed by the shot list ID.
 * Each confirmation records the bible confirmation it saw, so a changed bible asks for a new check. */
export interface ShotReview { id: string; episodeId: string; shots: Record<string, {at: string; bible: string | null}> }
export interface Scene { id: string; heading: string; content: string; locked: boolean }
export interface ContextSnapshot { brief: Brief; previousEpisodes: { episodeId: string; ordinal: number; revisionId: string; title: string; scenes: Scene[] }[]; hash: string }
export type ProviderMode = 'live' | 'demo' | 'manual';
export interface ReviewSuggestionSource { reviewId: string; targetId: string }
export interface Revision { id: string; episodeId: string; parentId: string | null; title: string; logline: string; scenes: Scene[]; context: ContextSnapshot; kind: 'generated' | 'rewrite' | 'manual'; instruction: string; mode: ProviderMode; createdAt: string; language?: string; reviewSource?: ReviewSuggestionSource }
export interface Localization extends ScriptOutput { id: string; sourceRevisionId: string; language: string; parentId: string|null; mode: ProviderMode; glossary: string; createdAt: string }
export const DIMENSIONS = ['story','character','dialogue','continuity','filmability'] as const;
export type Dimension = typeof DIMENSIONS[number];
export interface Evidence { sourceId: string; sourceQuote: string; sceneId: string; draftQuote: string; sourceRef?: string; draftRef?: string }
export interface Assessment { dimension: Dimension; status: 'no_issue' | 'issue' | 'uncertain' | 'not_applicable'; explanation: string; issueType?: 'fact_conflict' | 'craft_preference'; suggestedFix?: string; suggestedSceneId?: string; evidence: Evidence[] }
export interface CausalCheck { sceneId: string; state: string; choice: string; obstacleKind: 'physical' | 'emotional' | 'both' | 'none'; alternative: string; verdict: 'supported' | 'gap' | 'uncertain' | 'not_applicable'; explanation: string; evidence: Evidence[]; constraintEvidence: {sourceId: string; quote: string}[]; suggestedFix?: string; suggestedSceneId?: string }
export interface CausalPressure { sceneId: string; trigger: string; threatenedOutcome: string; currentState: string; directAlternative: string; verdict: 'binding' | 'gap' | 'uncertain' | 'background'; explanation: string; evidence: Evidence[]; blockingEvidence: {sourceId:string;quote:string}[]; suggestedFix?: string; suggestedSceneId?: string }
export interface CausalAudit { status: 'completed' | 'needs_review'; checks: CausalCheck[]; errors: string[]; pressures?: CausalPressure[] }
export interface Review { id: string; revisionId: string; status: 'completed' | 'needs_review'; assessments: Assessment[]; errors: string[]; mode: ProviderMode; createdAt: string; lengthCheck?: LengthCheck; causality?: CausalAudit; verification?: import('./core/reviewVerification').ReviewVerification; verificationOfReviewId?: string }
export interface ModelAttempt { callId: number; sequence: number; stage: 'generate' | 'review' | 'causality' | 'facts' | 'verification' | 'rewrite' | 'localize' | 'storyboard' | 'bible' | 'logic'; batch?: number; targetIds?: string[]; attempt: 1 | 2; status: 'running' | 'succeeded' | 'failed'; errorCode?: string; validationErrors?: string[]; startedAt: string; finishedAt?: string; elapsedMs?: number; retryScheduled?: boolean; retryStoppedReason?: 'call_limit' | 'run_limit' | 'review_stopped' | 'not_eligible' }
export interface Run { id: string; episodeId: string; kind: 'generate' | 'review' | 'rewrite' | 'localize' | 'storyboard' | 'bible' | 'logic'; status: 'running' | 'succeeded' | 'failed'; mode: ProviderMode; resultId: string | null; error: string | null; createdAt: string; finishedAt: string | null; modelSnapshot?: import('./providerTypes').ModelSnapshot; modelAttempts?: ModelAttempt[] }
export const SHOT_SIZES = ['extreme_close_up','close_up','medium_close_up','medium','medium_wide','wide','insert'] as const;
export const CAMERA_MOVES = ['static','push_in','pull_out','pan','tilt','track','handheld'] as const;
export interface CastMember { id: string; name: string }
/** Lines are positions among a scene's non-blank lines, counting from 1. Shots never store script text.
 * screenText lists the lines whose readable text appears on a phone, note, sign or document; an empty list means none,
 * and a shot without the field falls back to its non-dialogue lines with quoted text. */
export interface Shot { id: string; sceneId: string; firstLine: number; lastLine: number; size: typeof SHOT_SIZES[number]; camera: typeof CAMERA_MOVES[number]; characters: string[]; spoken: { line: number; castId: string }[]; durationSeconds: number; composition?: string; sound?: string; screenText?: number[] }
export interface ShotListContent { cast: CastMember[]; shots: Shot[] }
/** An immutable shot-list version bound to one revision and, per extra voice language, one line-aligned adaptation. */
export interface ShotList extends ShotListContent { id: string; episodeId: string; sourceRevisionId: string; parentId: string | null; aspectRatio: '9:16' | '16:9'; voiceLanguages: string[]; adaptations: Record<string, string>; mode: ProviderMode; createdAt: string }
/** One H3 prompt of one clip in one voice language, with reference files in the order the worker passes them. */
export interface RenderPrompt { mode: 't2va' | 'r2v'; text: string; images: string[]; audio: string[] }
export interface RenderClip { id: string; sceneId: string; shotIds: string[]; plannedSeconds: number; frames: number; seed: number; warnings: string[]; prompts: Record<string, RenderPrompt>; pictureKey?: string }
/** An immutable render plan made from one production shot list.
 * Version 1 batches hand file names to workers; version 2 batches render through sessions into the media store. */
export interface RenderBatch { id: string; episodeId: string; shotListId: string; sourceRevisionId: string; adaptations: Record<string, string>; languages: string[]; width: number; height: number; fps: 24; clipLimitSeconds: number; profile: ProductionProfile; clips: RenderClip[]; warnings: string[]; createdAt: string; version?: 2; preset?: RenderPreset; musicMode?: 'bed' | 'native'; references?: BatchReference[]; readiness?: ReadinessRecord }
/** A file in Sci-epo's media store, named by its SHA-256. */
/** A file in the Google Drive of the worker's Colab account; Sci-epo keeps only its ID and name. */
export interface DriveFile { id: string; name: string }
/** A rendered take's video: in the media store (assetId) or in Google Drive (drive). */
export interface TakeVideo { sha256: string; bytes: number; seconds: number; assetId?: string; drive?: DriveFile }
export type MediaKind = 'reference_image' | 'voice_sample' | 'music' | 'take_video' | 'qa_image' | 'qa_data' | 'cut_video' | 'report';
export interface MediaAsset { id: string; projectId: string; kind: MediaKind; contentType: string; bytes: number; sha256: string; origin: 'owner' | 'worker' | 'sciepo'; sessionId?: string; label?: string; license?: string; createdAt: string }
export interface AssetRef { assetId: string; sha256: string }
/** A pinned worker stack (ComfyUI commit, model files, workflows), named by worker/stacks/<id>.json. */
export interface StackRef { id: string; version: string }
export interface RenderPreset { width: number; height: number; steps: number; turbo: boolean; stack: StackRef }
export interface BatchReference extends AssetRef { name: string; kind: 'image' | 'audio'; character: string }
/** One item of the readiness checklist, with the tab where the author fixes it. */
export interface ReadinessItem { id: string; status: 'passed' | 'warning' | 'failed'; message: string; link: {tab: 'script' | 'review' | 'languages' | 'shots' | 'production'; target?: string} }
/** The checklist as it was when the batch was created, and the items the author confirmed. */
export interface ReadinessRecord { items: ReadinessItem[]; confirmed: string[]; confirmedAt?: string }
export type RetakeReason = 'picture_broken' | 'character_drift' | 'line_wrong' | 'lip_sync' | 'garbled_text' | 'other';
export interface QaCheck { id: string; status: 'pass' | 'warning' | 'failure'; message: string; value?: number }
export interface SpeechLine { sceneId: string; position: number; language: string; expected: string; heard: string; score: number }
export interface TakeQa { checks: QaCheck[]; loudness?: {integrated: number; truePeak: number; range?: number}; contactSheet?: string; keyframes: {shotId: string; assetId: string}[]; dataAssetId?: string; speech?: {language?: string; lines: SpeechLine[]} }
/** One render of a v2 job with one seed. */
export interface Take { n: number; seed: number; status: 'queued' | 'claimed' | 'rendered' | 'failed'; sessionId?: string; leaseExpiresAt?: string; startedAt?: string; finishedAt?: string; renderSeconds?: number; video?: TakeVideo; qa?: TakeQa; verdict?: {decision: 'approved' | 'retake'; reasons: RetakeReason[]; note?: string; at: string}; rehearsal?: boolean; error?: string }
/** One render target of a v2 batch. Jobs with the same key are one job, so a clip without dialogue serves every language. */
export interface RenderJobV2 { id: string; batchId: string; clipId: string; key: string; languages: string[]; order: number; outputName: string; takes: Take[]; approvedTake?: number; updatedAt: string }
export type SessionEnd = 'queue_empty' | 'budget' | 'stopped' | 'not_current' | 'failures' | 'error' | 'lost' | 'expired';
export interface SessionEvent { at: string; stage: string; message?: string; data?: Record<string, string | number | boolean> }
export interface SessionEstimate { setupMinutes: number; renderMinutes: number; takes: number; frames: number; measured: boolean }
/** One worker's work on one or more v2 batches, with a token that works only for them. */
export interface RenderSession {
  id: string; projectId: string; batchIds: string[]; mode: 'pull' | 'rehearsal'; tokenHash: string | null;
  status: 'waiting' | 'connected' | 'setting_up' | 'rendering' | 'finishing' | 'ended' | 'lost' | 'expired';
  settings: {budgetMinutes: number; allowUntestedGpu: boolean; waitForRetakesMinutes: number};
  estimate: SessionEstimate; createdAt: string; expiresAt: string; lastSeenAt?: string; startedAt?: string; lastResultAt?: string; endedAt?: string; end?: SessionEnd;
  worker?: {gpu?: string; vramGb?: number; workerSha256?: string; comfyCommit?: string};
  events: SessionEvent[]; stopRequest?: {when: 'after_take' | 'now'; at: string};
  summary?: {minutes: number; computeUnits?: number; takesRendered: number; takesFailed: number; undelivered: number; message?: string};
  readings?: {before?: number; after?: number};
}
export type PublicRenderSession = Omit<RenderSession, 'tokenHash'>;
/** Output size of a cut: as rendered, or scaled to cover the frame and cropped. */
export type CutSize = 'native' | '720x1280' | '1080x1920' | '1280x720' | '1920x1080';
/** How a cut is levelled, scored and normalized. Levels in dB, loudness in LUFS, fades in milliseconds. */
export interface CutSettings { musicAssetId: string | null; noMusic?: boolean; musicLevelDb: number; dialogueLufs: number; ambienceLufs: number; maxGainDb: number; targetLufs: number; truePeakDb: number; fadeMs: number; size: CutSize }
/** A caption for the on-screen text of one shot, timed in cut seconds. */
export interface Caption { shotId: string; start: number; end: number; text: string; enabled: boolean }
/** One clip of a cut: the take it uses, where it starts in the cut and the gain that levels it. */
export interface CutClip { clipId: string; jobId: string; take: number; sha256: string; assetId?: string; drive?: DriveFile; offset: number; seconds: number; gainDb: number; dialogue: boolean }
/** One v2 batch edited in one language. A draft uses the latest rendered takes, a final cut the approved ones. */
export interface Cut {
  id: string; batchId: string; projectId: string; language: string; kind: 'draft' | 'final';
  clips: CutClip[]; settings: CutSettings; captions: Caption[];
  status: 'queued' | 'running' | 'done' | 'failed';
  output?: {assetId?: string; drive?: DriveFile; sha256: string; bytes: number; seconds: number; loudness: number | null; truePeak: number | null};
  /** The session whose worker is cutting it, while it runs there (Drive storage). */
  sessionId?: string;
  signOff?: {decision: 'signed_off' | 'rejected'; note?: string; at: string; reportAssetId?: string};
  rehearsal?: boolean; warnings?: string[]; error?: string; startedAt?: string; finishedAt?: string; createdAt: string; updatedAt: string;
}
/** Measured seconds per frame for one stack, size, step count, turbo switch and GPU. */
export interface RenderRate { id: string; samples: number[]; updatedAt: string }
export interface RenderOutput { file: string; seconds?: number; bytes?: number; sha256?: string }
export interface RenderJob { id: string; batchId: string; clipId: string; language: string; order: number; status: 'queued' | 'claimed' | 'succeeded' | 'failed'; attempts: number; workerTokenId?: string; workerLabel?: string; leaseExpiresAt?: string; output?: RenderOutput; error?: string; updatedAt: string }
/** Only the SHA-256 of a worker token is stored. */
export interface WorkerToken { id: string; label: string; hash: string; createdAt: string; lastUsedAt?: string; revokedAt?: string }
export interface ProjectBundle { project: Project; episodes: Episode[]; revisions: Revision[]; reviews: Review[]; runs: Run[]; localizations: Localization[]; shotLists?: ShotList[]; renderBatches?: RenderBatch[]; renderJobs?: RenderJob[]; renderJobsV2?: RenderJobV2[]; renderSessions?: PublicRenderSession[]; media?: MediaAsset[]; cuts?: Cut[]; shotReviews?: ShotReview[]; logicChecks?: LogicCheck[] }
export interface ScriptOutput { title: string; logline: string; scenes: Scene[] }
export interface ModelRequest { kind: 'generate' | 'review' | 'rewrite' | 'localize' | 'storyboard' | 'bible' | 'logic'; context: ContextSnapshot; bible?: BibleContent; revision?: Revision; sceneId?: string; instruction?: string; episodeTitle: string; targetLanguage?: string; reviewPass?: 'causality' | 'facts' | 'verification'; draftReview?: Pick<Review, 'assessments' | 'causality'>; draftFacts?: import('./core/reviewVerification').VerificationFacts; auditTargetIds?: string[] }
export interface ModelProvider { mode: 'live' | 'demo'; complete(request: ModelRequest): Promise<string> }
