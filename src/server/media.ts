/** The media store: files named by SHA-256 in one folder, with one record per project and file. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaAsset, MediaKind } from '../types';
import { MEDIA_KINDS, formatBytes, sniffMedia } from '../core/mediaKinds';
import type { Store } from './store';

type Fail = (status: number, message: string) => never;
export interface IngestOptions { origin: MediaAsset['origin']; sessionId?: string; label?: string; license?: string; declaredLength?: number }
class TooLarge extends Error {}

export class MediaStore {
  constructor(private store: Store, readonly dir: string, readonly quotaBytes: number, private fail: Fail, private id: () => string, private now: () => string) {
    mkdirSync(dir, {recursive: true});
  }

  path(sha256: string): string { return join(this.dir, sha256.slice(0, 2), sha256); }

  /** Bytes on disk: each file counts once, however many records point at it. */
  usage(): number {
    const sizes = new Map<string, number>();
    for (const asset of this.store.all('media_assets')) sizes.set(asset.sha256, asset.bytes);
    return [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
  }

  /** Stream a body into the store: size limit while reading, signature, full check for JSON and Markdown, quota. */
  async ingest(projectId: string, kind: MediaKind, body: ReadableStream<Uint8Array> | null, options: IngestOptions): Promise<MediaAsset> {
    const rule = MEDIA_KINDS[kind];
    if (!body) return this.fail(400, '没有收到文件内容。');
    if (options.declaredLength !== undefined && options.declaredLength > rule.limitBytes) return this.fail(413, `${rule.label}不能超过 ${formatBytes(rule.limitBytes)}。`);
    mkdirSync(this.dir, {recursive: true});
    const tmp = join(this.dir, `upload-${randomUUID()}.part`), hash = createHash('sha256'), writer = Bun.file(tmp).writer();
    const head = new Uint8Array(16);
    let bytes = 0, headLength = 0;
    try {
      const reader = body.getReader();
      for (;;) {
        const {done, value: chunk} = await reader.read();
        if (done) break;
        bytes += chunk.byteLength;
        if (bytes > rule.limitBytes) throw new TooLarge();
        if (headLength < head.length) { const take = Math.min(head.length - headLength, chunk.byteLength); head.set(chunk.subarray(0, take), headLength); headLength += take; }
        hash.update(chunk);
        writer.write(chunk);
      }
      await writer.end();
    } catch (error) {
      try { await writer.end(); } catch { /* already closed */ }
      rmSync(tmp, {force: true});
      if (error instanceof TooLarge) return this.fail(413, `${rule.label}不能超过 ${formatBytes(rule.limitBytes)}。`);
      return this.fail(400, '文件没有完整上传，请重试。');
    }
    const discard = (status: number, message: string): never => { rmSync(tmp, {force: true}); return this.fail(status, message); };
    if (!bytes) return discard(400, '文件是空的。');
    const type = sniffMedia(kind, head.subarray(0, headLength));
    if (!type) return discard(415, `文件内容不是${rule.label}支持的格式（${rule.types.map(t => t.extension).join('、')}）。`);
    if (kind === 'qa_data') { try { JSON.parse(await Bun.file(tmp).text()); } catch { return discard(415, '质检数据不是有效的 JSON。'); } }
    if (kind === 'report') { try { new TextDecoder('utf-8', {fatal: true}).decode(await Bun.file(tmp).arrayBuffer()); } catch { return discard(415, '报告不是 UTF-8 文本。'); } }
    const sha256 = hash.digest('hex'), target = this.path(sha256);
    if (existsSync(target)) rmSync(tmp, {force: true});
    else {
      const used = this.usage();
      if (used + bytes > this.quotaBytes) return discard(507, `媒体库已用 ${formatBytes(used)}，上限 ${formatBytes(this.quotaBytes)}；这个文件 ${formatBytes(bytes)} 放不下。请先删除不用的文件。`);
      mkdirSync(join(this.dir, sha256.slice(0, 2)), {recursive: true});
      renameSync(tmp, target);
    }
    const existing = this.store.all('media_assets').find(a => a.projectId === projectId && a.sha256 === sha256 && a.kind === kind);
    if (existing) return existing;
    return this.store.insert('media_assets', {id: this.id(), projectId, kind, contentType: type.contentType, bytes, sha256, origin: options.origin,
      ...(options.sessionId ? {sessionId: options.sessionId} : {}), ...(options.label ? {label: options.label.slice(0, 200)} : {}), ...(options.license ? {license: options.license.slice(0, 300)} : {}), createdAt: this.now()});
  }

  /** Copy a file that Sci-epo made itself, such as a cut, into the store. */
  ingestFile(projectId: string, kind: MediaKind, path: string, options: IngestOptions): Promise<MediaAsset> {
    return this.ingest(projectId, kind, Bun.file(path).stream(), options);
  }

  extension(asset: Pick<MediaAsset, 'kind' | 'contentType'>): string {
    return MEDIA_KINDS[asset.kind].types.find(t => t.contentType === asset.contentType)?.extension ?? 'bin';
  }

  /** The file with its stored type; byte ranges for seeking in video. */
  serve(req: Request, asset: MediaAsset): Response {
    const path = this.path(asset.sha256);
    if (!existsSync(path)) return this.fail(404, '媒体库里找不到这个文件。');
    const size = asset.bytes, file = Bun.file(path);
    const headers: Record<string, string> = {'content-type': asset.contentType, 'accept-ranges': 'bytes',
      'content-disposition': `${asset.kind === 'report' ? 'attachment' : 'inline'}; filename="${asset.id}.${this.extension(asset)}"`};
    const range = req.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range.trim());
      let start = -1, end = size - 1;
      if (match && (match[1] || match[2])) {
        if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), size - 1); }
        else start = Math.max(0, size - Number(match[2]));
      }
      if (start < 0 || start > end || start >= size) return new Response(null, {status: 416, headers: {...headers, 'content-range': `bytes */${size}`}});
      return new Response(file.slice(start, end + 1), {status: 206, headers: {...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1)}});
    }
    return new Response(file, {headers: {...headers, 'content-length': String(size)}});
  }

  async json(asset: MediaAsset): Promise<unknown> { return JSON.parse(await Bun.file(this.path(asset.sha256)).text()); }

  /** Remove a record, and the file when no other record uses it. Callers check that nothing depends on it. */
  delete(asset: MediaAsset): void {
    this.store.remove('media_assets', asset.id);
    if (!this.store.all('media_assets').some(a => a.sha256 === asset.sha256)) rmSync(this.path(asset.sha256), {force: true});
  }
}
