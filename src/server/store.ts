import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { canonicalJsonBytes } from '../core/canonicalJson';
import type { Project, Episode, Revision, Review, Run, ProjectBundle, Localization, ShotList, RenderBatch, RenderJob, WorkerToken, MediaAsset, RenderJobV2, RenderSession, RenderRate, Cut, ShotReview } from '../types';

type Tables = {projects: Project; episodes: Episode; revisions: Revision; reviews: Review; runs: Run; localizations: Localization; shot_lists: ShotList; render_batches: RenderBatch; render_jobs: RenderJob; worker_tokens: WorkerToken; media_assets: MediaAsset; render_jobs_v2: RenderJobV2; render_sessions: RenderSession; render_rates: RenderRate; cuts: Cut; shot_reviews: ShotReview};
const TABLES = ['projects','episodes','revisions','reviews','runs','localizations','shot_lists','render_batches','render_jobs','worker_tokens','media_assets','render_jobs_v2','render_sessions','render_rates','cuts','shot_reviews'] as const;
type Mutable = 'projects'|'episodes'|'runs'|'render_jobs'|'worker_tokens'|'render_jobs_v2'|'render_sessions'|'render_rates'|'cuts';
export class Store {
 readonly db: Database;
 constructor(path = ':memory:') {
  this.db = new Database(path, {create:true, strict:true});
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  for (const table of TABLES) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS active_run ON runs (json_extract(data,'$.episodeId')) WHERE json_extract(data,'$.status')='running'");
 }
 get<T extends keyof Tables>(table:T,id:string):Tables[T] | undefined {
  const row=this.db.query(`SELECT data FROM ${table} WHERE id=?`).get(id) as {data:string}|null;
  return row ? JSON.parse(row.data) : undefined;
 }
 all<T extends keyof Tables>(table:T):Tables[T][] {
  return (this.db.query(`SELECT data FROM ${table} ORDER BY rowid`).all() as {data:string}[]).map(r=>JSON.parse(r.data));
 }
 insert<T extends keyof Tables>(table:T,value:Tables[T]):Tables[T] { this.db.query(`INSERT INTO ${table}(id,data) VALUES(?,?)`).run(value.id,JSON.stringify(value)); return value; }
 update<T extends Mutable>(table:T,value:Tables[T]):void {this.db.query(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value),value.id);}
 /** Upsert for tables keyed by a computed ID, such as render rates. */
 put<T extends 'render_rates'|'shot_reviews'>(table:T,value:Tables[T]):void {this.db.query(`INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id,JSON.stringify(value));}
 /** Only media records are ever deleted, after the file itself is removed. */
 remove(table:'media_assets',id:string):void {this.db.query(`DELETE FROM ${table} WHERE id=?`).run(id);}
 contextToken(episode:Episode):string {
  const project=this.get('projects',episode.projectId);if(!project)throw new Error('Episode project is missing');
  const {title,premise,characters,worldRules,authorRules,language,glossary,lengthTarget,format,durationTarget}=project;
  const previous=this.all('episodes').filter(e=>e.projectId===episode.projectId&&e.ordinal<episode.ordinal).sort((a,b)=>a.ordinal-b.ordinal)
   .map(e=>({id:e.id,acceptedRevisionId:e.acceptedRevisionId,needsReview:e.needsReview}));
  // Format fields are present only for vertical short drama, so tokens of existing series are unchanged.
  return createHash('sha256').update(canonicalJsonBytes({projectId:project.id,episodeId:episode.id,brief:{title,premise,characters,worldRules,authorRules,...(language?{language}:{}),...(glossary!==undefined?{glossary}:{}),...(lengthTarget?{lengthTarget}:{}),...(format?{format}:{}),...(durationTarget?{durationTarget}:{})},previous})).digest('hex');
 }
 bundle(id:string):ProjectBundle | undefined {
  const project=this.get('projects',id);if(!project)return;
  const episodes=this.all('episodes').filter(e=>e.projectId===id).sort((a,b)=>a.ordinal-b.ordinal).map(e=>({...e,contextToken:this.contextToken(e)})), ids=new Set(episodes.map(e=>e.id));
  const revisions=this.all('revisions').filter(r=>ids.has(r.episodeId)), revIds=new Set(revisions.map(r=>r.id));
  const renderBatches=this.all('render_batches').filter(b=>ids.has(b.episodeId)), batchIds=new Set(renderBatches.map(b=>b.id));
  const renderSessions=this.all('render_sessions').filter(s=>s.projectId===id).map(({tokenHash:_hash,...s})=>s);
  return {project,episodes,revisions,reviews:this.all('reviews').filter(r=>revIds.has(r.revisionId)),runs:this.all('runs').filter(r=>ids.has(r.episodeId)),localizations:this.all('localizations').filter(r=>revIds.has(r.sourceRevisionId)),shotLists:this.all('shot_lists').filter(l=>revIds.has(l.sourceRevisionId)),renderBatches,renderJobs:this.all('render_jobs').filter(j=>batchIds.has(j.batchId)),
   renderJobsV2:this.all('render_jobs_v2').filter(j=>batchIds.has(j.batchId)),renderSessions,media:this.all('media_assets').filter(m=>m.projectId===id),cuts:this.all('cuts').filter(c=>batchIds.has(c.batchId)),shotReviews:this.all('shot_reviews').filter(r=>ids.has(r.episodeId))};
 }
 recoverInterrupted() {for(const run of this.all('runs').filter(r=>r.status==='running')) this.update('runs',{...run,status:'failed',error:'服务重启中断了任务；请检查已有版本后重试。',finishedAt:new Date().toISOString()});}
 close(){this.db.close();}
}
