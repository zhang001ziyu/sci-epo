/** Media kinds of the store: accepted types, size limits and file signatures. Browser-safe. */
import type { MediaKind } from '../types';

export interface MediaType { contentType: string; extension: string; matches: (head: Uint8Array) => boolean }
export interface MediaKindRule { label: string; limitBytes: number; types: MediaType[] }

const MB = 1024 * 1024;
const ascii = (head: Uint8Array, offset: number, text: string) => [...text].every((c, i) => head[offset + i] === c.charCodeAt(0));
const PNG: MediaType = {contentType: 'image/png', extension: 'png', matches: h => h[0] === 0x89 && ascii(h, 1, 'PNG')};
const JPEG: MediaType = {contentType: 'image/jpeg', extension: 'jpg', matches: h => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff};
const WEBP: MediaType = {contentType: 'image/webp', extension: 'webp', matches: h => ascii(h, 0, 'RIFF') && ascii(h, 8, 'WEBP')};
const isM4a = (h: Uint8Array) => ascii(h, 4, 'ftyp') && (ascii(h, 8, 'M4A ') || ascii(h, 8, 'M4B '));
const MP4: MediaType = {contentType: 'video/mp4', extension: 'mp4', matches: h => ascii(h, 4, 'ftyp') && !isM4a(h)};
const M4A: MediaType = {contentType: 'audio/mp4', extension: 'm4a', matches: isM4a};
const WAV: MediaType = {contentType: 'audio/wav', extension: 'wav', matches: h => ascii(h, 0, 'RIFF') && ascii(h, 8, 'WAVE')};
const MP3: MediaType = {contentType: 'audio/mpeg', extension: 'mp3', matches: h => ascii(h, 0, 'ID3') || (h[0] === 0xff && ((h[1] ?? 0) & 0xe0) === 0xe0)};
const FLAC: MediaType = {contentType: 'audio/flac', extension: 'flac', matches: h => ascii(h, 0, 'fLaC')};
const firstNonSpace = (h: Uint8Array) => h.find(b => ![0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf].includes(b));
// JSON and Markdown get a full check after upload: JSON must parse, Markdown must be valid UTF-8.
const JSON_TYPE: MediaType = {contentType: 'application/json', extension: 'json', matches: h => [0x7b, 0x5b].includes(firstNonSpace(h) ?? 0)};
const MARKDOWN: MediaType = {contentType: 'text/markdown; charset=utf-8', extension: 'md', matches: () => true};

export const MEDIA_KINDS: Record<MediaKind, MediaKindRule> = {
  reference_image: {label: '参考图', limitBytes: 8 * MB, types: [PNG, JPEG, WEBP]},
  voice_sample: {label: '声音样本', limitBytes: 10 * MB, types: [WAV, MP3, FLAC]},
  music: {label: '配乐', limitBytes: 30 * MB, types: [WAV, MP3, FLAC, M4A]},
  take_video: {label: '渲染视频', limitBytes: 64 * MB, types: [MP4]},
  qa_image: {label: '质检图', limitBytes: 2 * MB, types: [JPEG, PNG]},
  qa_data: {label: '质检数据', limitBytes: 512 * 1024, types: [JSON_TYPE]},
  cut_video: {label: '成片', limitBytes: 256 * MB, types: [MP4]},
  report: {label: '报告', limitBytes: 1 * MB, types: [MARKDOWN]},
};
export const isMediaKind = (value: unknown): value is MediaKind => typeof value === 'string' && Object.hasOwn(MEDIA_KINDS, value);
/** Kinds the owner may upload; the others are written by workers or by Sci-epo itself. */
export const OWNER_KINDS: readonly MediaKind[] = ['reference_image', 'voice_sample', 'music'];

/** The type of a file of this kind, from its first bytes, or undefined when the signature does not match. */
export function sniffMedia(kind: MediaKind, head: Uint8Array): MediaType | undefined {
  return MEDIA_KINDS[kind].types.find(type => type.matches(head));
}

export const formatBytes = (bytes: number) => bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
