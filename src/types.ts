export interface LengthTarget { min: number; max: number; unit: 'words' | 'characters' }
export interface LengthCheck { status: 'within_range' | 'too_short' | 'too_long' | 'not_set' | 'ambiguous'; count: number; unit: 'words' | 'characters'; target?: LengthTarget; source: 'structured' | 'brief' | 'none'; message: string }
/** Absent format means episodic, the original behavior. Only vertical short drama is stored. */
export type Format = 'vertical_short_drama' | 'episodic';
/** Whole seconds of screen time for one episode. */
export interface DurationTarget { min: number; max: number }
export interface Brief { title: string; premise: string; characters: string; worldRules: string; authorRules: string; language?: string; glossary?: string; lengthTarget?: LengthTarget; format?: Format; durationTarget?: DurationTarget }
export interface PublicationSettings { audioLanguage: string; subtitleLanguages: string[]; subtitleStyle: 'selectable'|'burned-bilingual'|'none'; platform: 'youtube'|'bilibili'|'general' }
/** How a series looks and sounds on screen. English free text, because H3 expects English prompt bodies. */
export interface ProductionCharacter { name: string; appearance: string; voice: string; image?: string; voiceSample?: string }
export interface ProductionProfile { style: string; music: string; characters: ProductionCharacter[] }
/** voiceLanguages and production are settings outside the frozen brief: changing them never requires a story recheck. */
export interface Project extends Brief { id: string; createdAt: string; updatedAt: string; publication?: PublicationSettings; voiceLanguages?: string[]; production?: ProductionProfile }
export interface Episode { id: string; projectId: string; ordinal: number; title: string; acceptedRevisionId: string | null; needsReview: boolean; createdAt: string; contextToken?: string; productionShotListId?: string }
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
export interface ModelAttempt { callId: number; sequence: number; stage: 'generate' | 'review' | 'causality' | 'facts' | 'verification' | 'rewrite' | 'localize' | 'storyboard'; batch?: number; targetIds?: string[]; attempt: 1 | 2; status: 'running' | 'succeeded' | 'failed'; errorCode?: string; validationErrors?: string[]; startedAt: string; finishedAt?: string; elapsedMs?: number; retryScheduled?: boolean; retryStoppedReason?: 'call_limit' | 'run_limit' | 'review_stopped' | 'not_eligible' }
export interface Run { id: string; episodeId: string; kind: 'generate' | 'review' | 'rewrite' | 'localize' | 'storyboard'; status: 'running' | 'succeeded' | 'failed'; mode: ProviderMode; resultId: string | null; error: string | null; createdAt: string; finishedAt: string | null; modelSnapshot?: import('./providerTypes').ModelSnapshot; modelAttempts?: ModelAttempt[] }
export const SHOT_SIZES = ['extreme_close_up','close_up','medium_close_up','medium','medium_wide','wide','insert'] as const;
export const CAMERA_MOVES = ['static','push_in','pull_out','pan','tilt','track','handheld'] as const;
export interface CastMember { id: string; name: string }
/** Lines are positions among a scene's non-blank lines, counting from 1. Shots never store script text. */
export interface Shot { id: string; sceneId: string; firstLine: number; lastLine: number; size: typeof SHOT_SIZES[number]; camera: typeof CAMERA_MOVES[number]; characters: string[]; spoken: { line: number; castId: string }[]; durationSeconds: number; composition?: string; sound?: string }
export interface ShotListContent { cast: CastMember[]; shots: Shot[] }
/** An immutable shot-list version bound to one revision and, per extra voice language, one line-aligned adaptation. */
export interface ShotList extends ShotListContent { id: string; episodeId: string; sourceRevisionId: string; parentId: string | null; aspectRatio: '9:16' | '16:9'; voiceLanguages: string[]; adaptations: Record<string, string>; mode: ProviderMode; createdAt: string }
/** One H3 prompt of one clip in one voice language, with reference files in the order the worker passes them. */
export interface RenderPrompt { mode: 't2va' | 'r2v'; text: string; images: string[]; audio: string[] }
export interface RenderClip { id: string; sceneId: string; shotIds: string[]; plannedSeconds: number; frames: number; seed: number; warnings: string[]; prompts: Record<string, RenderPrompt> }
/** An immutable render plan made from one production shot list. Video files stay with the worker. */
export interface RenderBatch { id: string; episodeId: string; shotListId: string; sourceRevisionId: string; adaptations: Record<string, string>; languages: string[]; width: number; height: number; fps: 24; clipLimitSeconds: number; profile: ProductionProfile; clips: RenderClip[]; warnings: string[]; createdAt: string }
export interface RenderOutput { file: string; seconds?: number; bytes?: number; sha256?: string }
export interface RenderJob { id: string; batchId: string; clipId: string; language: string; order: number; status: 'queued' | 'claimed' | 'succeeded' | 'failed'; attempts: number; workerTokenId?: string; workerLabel?: string; leaseExpiresAt?: string; output?: RenderOutput; error?: string; updatedAt: string }
/** Only the SHA-256 of a worker token is stored. */
export interface WorkerToken { id: string; label: string; hash: string; createdAt: string; lastUsedAt?: string; revokedAt?: string }
export interface ProjectBundle { project: Project; episodes: Episode[]; revisions: Revision[]; reviews: Review[]; runs: Run[]; localizations: Localization[]; shotLists?: ShotList[]; renderBatches?: RenderBatch[]; renderJobs?: RenderJob[] }
export interface ScriptOutput { title: string; logline: string; scenes: Scene[] }
export interface ModelRequest { kind: 'generate' | 'review' | 'rewrite' | 'localize' | 'storyboard'; context: ContextSnapshot; revision?: Revision; sceneId?: string; instruction?: string; episodeTitle: string; targetLanguage?: string; reviewPass?: 'causality' | 'facts' | 'verification'; draftReview?: Pick<Review, 'assessments' | 'causality'>; draftFacts?: import('./core/reviewVerification').VerificationFacts; auditTargetIds?: string[] }
export interface ModelProvider { mode: 'live' | 'demo'; complete(request: ModelRequest): Promise<string> }
