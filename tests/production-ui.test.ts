import { describe, expect, test } from 'bun:test';
import { snapshotContext } from '../src/core';
import { planRenderBatch } from '../src/core/h3';
import { SHORT_DRAMA_DEMO, shortDramaDemoShotList } from '../src/server/shortDramaDemo';
import type { Episode, Localization, ProjectBundle, RenderJob, Revision, ShotList } from '../src/types';
import { ProductionPanel, jobCounts, productionList, profileDraft, type ProductionContext, type PublicWorkerToken } from '../web/production';

const attack = '<img src=x onerror="alert(1)">';
const time = '2026-11-10T00:00:00.000Z';
const brief = {title: 'Last Order', premise: 'A rider.', characters: 'MAYA, LEO', worldRules: 'City.', authorRules: 'Reveal.', language: 'en', format: 'vertical_short_drama' as const};
function fixture(options: {adopted?: boolean; batch?: boolean} = {}) {
  const revision: Revision = {id: 'r1', episodeId: 'e1', parentId: null, ...structuredClone(SHORT_DRAMA_DEMO.en), language: 'en', kind: 'generated', instruction: '', mode: 'demo', createdAt: time, context: snapshotContext(brief, [])};
  const zh: Localization = {id: 'l1', sourceRevisionId: 'r1', language: 'zh-CN', parentId: null, mode: 'demo', glossary: '', createdAt: time, ...structuredClone(SHORT_DRAMA_DEMO.zh)};
  const list: ShotList = {...shortDramaDemoShotList('en'), id: 'v1', episodeId: 'e1', sourceRevisionId: 'r1', parentId: null, aspectRatio: '9:16', voiceLanguages: ['en', 'zh-CN'], adaptations: {'zh-CN': 'l1'}, mode: 'demo', createdAt: time};
  const episode: Episode = {id: 'e1', projectId: 'p1', ordinal: 1, title: 'Pilot', acceptedRevisionId: 'r1', needsReview: false, createdAt: time, ...(options.adopted === false ? {} : {productionShotListId: 'v1'})};
  const production = {style: 'Live-action, cinematic', music: 'N/A', characters: [{name: 'MAYA', appearance: `a rider ${attack}`.replace(/[<>]/gu, ''), voice: 'a dry voice'}]};
  const bundle: ProjectBundle = {project: {...brief, id: 'p1', createdAt: time, updatedAt: time, voiceLanguages: ['en', 'zh-CN'], production}, episodes: [episode], revisions: [revision], reviews: [], runs: [], localizations: [zh], shotLists: [list], renderBatches: [], renderJobs: []};
  if (options.batch) {
    const {batch, jobs} = planRenderBatch({batchId: 'b1', createdAt: time, episodeId: 'e1', list, revision, adaptations: {'zh-CN': zh}, profile: production});
    bundle.renderBatches = [batch];
    bundle.renderJobs = jobs.map((j, i): RenderJob => ({id: `j${i}`, batchId: 'b1', clipId: j.clipId, language: j.language, order: j.order, status: i === 0 ? 'succeeded' : i === 1 ? 'failed' : 'queued', attempts: i < 2 ? 1 : 0, updatedAt: time,
      ...(i === 0 ? {output: {file: 'ep01-c01-en.mp4', seconds: 12.25}} : {}), ...(i === 1 ? {error: `CUDA ${attack}`} : {})}));
  }
  const ctx: ProductionContext = {bundle, episode, revision, busy: false};
  return {ctx, list};
}
function panel(tokens: PublicWorkerToken[] = []) {
  const calls: {posts: [string, unknown][]; notices: string[]; failures: string[]} = {posts: [], notices: [], failures: []};
  const p = new ProductionPanel({run: async (_label, action) => { await action(); }, api: async <T>() => tokens as T, post: async <T>(path: string, body: unknown) => { calls.posts.push([path, body]); return ({token: 'sciepo_wk_once', tokens: [{id: 't1', label: 'Colab', createdAt: time}]}) as T; },
    upload: async <T>() => ({}) as T, setBundle: () => {}, render: () => {}, notice: m => { calls.notices.push(m); }, fail: m => { calls.failures.push(m); }, origin: () => 'https://studio.example.com'});
  return {p, calls};
}

describe('production tab', () => {
  test('without a current production shot list it points to the shot-list tab and offers no batch', () => {
    const {ctx} = fixture({adopted: false});
    const html = panel().p.view(ctx);
    expect(html).toContain('本集还没有制作版本的分镜表');
    expect(html).not.toContain('production-create-batch');
    expect(productionList(ctx.bundle, ctx.episode).current).toBe(false);
  });

  test('the profile lists every cast member and the batch form the bound languages', () => {
    const {ctx, list} = fixture();
    expect(profileDraft(ctx.bundle.project.production, list).characters.map(c => c.name)).toEqual(['MAYA', 'LEO']);
    const html = panel().p.view(ctx);
    expect(html).toContain('data-production-character="1" data-field="appearance"');
    expect(html).toContain('data-production-language="en" checked');
    expect(html).toContain('data-production-language="zh-CN" checked');
    expect(html).toContain('data-action="production-create-batch" data-id="v1" ');
    expect(html).toContain('>生成渲染任务</button>');
    expect(html).toContain('<h3>开拍清单</h3>');
  });

  test('batches show escaped status, errors, counts, prompts and the three connection modes', () => {
    const {ctx} = fixture({batch: true});
    const html = panel().p.view(ctx);
    expect(html).not.toContain('<img');
    expect(html).toContain('CUDA &lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('完成 1 · 失败 1 · 渲染中 0 · 排队 10');
    expect(html).toContain('ep01-c01-en.mp4 · 12.25 秒');
    expect(html).toContain('data-action="production-requeue" data-id="j1"');
    expect(html).toContain('&lt;d&gt;[English] Singing costs extra.&lt;/d&gt;');
    expect(html).toContain('href="/api/render-batches/b1/package" download');
    expect(html).toContain('当前制作版本');
    expect(html).toContain('--server https://studio.example.com');
    expect(html).toContain('colab.research.google.com/github/zhang001ziyu/sci-epo');
    expect(jobCounts(ctx.bundle.renderJobs!)).toEqual({succeeded: 1, failed: 1, claimed: 0, queued: 10});
  });

  test('a batch of an older shot list is marked as not current and cannot be pushed', () => {
    const {ctx} = fixture({batch: true});
    ctx.episode.productionShotListId = 'v2';
    const html = panel().p.view(ctx);
    expect(html).toContain('不是当前制作版本 · 工作机不会再领取');
    expect(html).toMatch(/data-action="production-push" data-id="b1" disabled/);
  });

  test('a new token is shown once, and push needs a URL and key', async () => {
    const {ctx} = fixture({batch: true}), {p, calls} = panel();
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    p.click('production-create-token', {dataset: {}}, ctx);
    await flush();
    expect(p.view(ctx)).toContain('value="sciepo_wk_once"');
    p.click('production-hide-token', {dataset: {}}, ctx);
    expect(p.view(ctx)).not.toContain('sciepo_wk_once');
    p.click('production-push', {dataset: {id: 'b1'}}, ctx);
    expect(calls.failures).toEqual(['先填写工作机地址和密钥。']);
    p.input({dataset: {productionWorker: 'url'}, value: 'https://w.trycloudflare.com', id: ''} as unknown as HTMLInputElement);
    p.input({dataset: {productionWorker: 'key'}, value: 'secret-key-1', id: ''} as unknown as HTMLInputElement);
    p.click('production-push', {dataset: {id: 'b1'}}, ctx);
    await flush();
    expect(calls.posts.at(-1)).toEqual(['/api/render-batches/b1/push', {url: 'https://w.trycloudflare.com', key: 'secret-key-1'}]);
    p.reset();
    expect(p.view(ctx)).not.toContain('secret-key-1');
  });

  test('an unsaved profile blocks a new batch', () => {
    const {ctx} = fixture(), {p, calls} = panel();
    p.view(ctx);
    p.input({dataset: {productionField: 'style'}, value: '2D-animated', id: ''} as unknown as HTMLInputElement);
    expect(p.changed).toBe(true);
    p.click('production-create-batch', {dataset: {id: 'v1'}}, ctx);
    expect(calls.failures[0]).toContain('先保存');
  });
});
