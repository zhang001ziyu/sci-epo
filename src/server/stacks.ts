/** Stack profiles (worker/stacks/<id>.json) and the worker program this server hands to sessions. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RenderPreset, ShotList } from '../types';

export interface StackFile { repo: string; path: string; target?: string; gb?: number }
export interface TestedGpu { name: string; minVramGb: number; colabRuntime?: string; modes: string[] }
export interface StackProfile {
  id: string; version: string; label: string;
  comfyui: {repo: string; commit: string};
  /** Files by mode, plus `common` for every mode. Paths are relative to ComfyUI's models folder. */
  files: Record<string, StackFile[]>;
  workflows: Record<string, string>;
  requiredNodes: Record<string, string[]>;
  turboSteps: Record<string, number>;
  testedGpus: TestedGpu[];
  setupMinutes: number;
  defaultSecondsPerFrame: Record<string, number>;
}

export const RENDER_SIZES: Record<ShotList['aspectRatio'], {width: number; height: number}[]> = {
  '9:16': [{width: 480, height: 864}, {width: 768, height: 1344}],
  '16:9': [{width: 864, height: 480}, {width: 1344, height: 768}],
};
export const DEFAULT_STACK_ID = 'h3-lite';

export class Stacks {
  constructor(private root: string) {}
  private dir() { return join(this.root, 'worker', 'stacks'); }

  get(id: string): StackProfile | undefined {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(id)) return undefined;
    const path = join(this.dir(), `${id}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as StackProfile : undefined;
  }

  /** The profile with its workflow graphs, as sent to a session's worker. */
  document(id: string): (StackProfile & {workflowGraphs: Record<string, unknown>}) | undefined {
    const profile = this.get(id);
    if (!profile) return undefined;
    const workflowGraphs: Record<string, unknown> = {};
    for (const [mode, file] of Object.entries(profile.workflows)) {
      const path = join(this.dir(), file);
      if (/^[a-z0-9][a-z0-9.-]*\.json$/u.test(file) && existsSync(path)) workflowGraphs[mode] = JSON.parse(readFileSync(path, 'utf8'));
    }
    return {...profile, workflowGraphs};
  }

  defaultPreset(ratio: ShotList['aspectRatio']): RenderPreset | undefined {
    const stack = this.get(DEFAULT_STACK_ID);
    return stack ? {...RENDER_SIZES[ratio][0]!, steps: 20, turbo: false, stack: {id: stack.id, version: stack.version}} : undefined;
  }

  /** The worker program shipped with this server, read on every call so a session always gets the file on disk. */
  workerProgram(): {bytes: Uint8Array<ArrayBuffer>; sha256: string} | undefined {
    const path = join(this.root, 'worker', 'sciepo_worker.py');
    if (!existsSync(path)) return undefined;
    const bytes = new Uint8Array(readFileSync(path));
    return {bytes, sha256: createHash('sha256').update(bytes).digest('hex')};
  }
}
