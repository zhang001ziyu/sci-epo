import type { Brief, LengthCheck, LengthTarget, Scene } from '../types';

export function parseLengthTarget(value: unknown): LengthTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('篇幅目标格式无效。');
  const t = value as LengthTarget;
  if (!Number.isSafeInteger(t.min) || !Number.isSafeInteger(t.max) || t.min < 1 || t.max < t.min || t.max > 100_000 || !['words', 'characters'].includes(t.unit)) throw new Error('篇幅目标需为 1–100000 内的整数范围，上限不得小于下限。');
  return {min: t.min, max: t.max, unit: t.unit};
}

/** Count screenplay body including speaker labels, excluding headings/title/logline.
 * Words are whitespace-separated tokens containing a letter or number. Pure punctuation is not a word.
 * Characters are non-whitespace Unicode code points. No model-provided counts are trusted. */
export function countScript(scenes: Pick<Scene, 'content'>[], unit: LengthTarget['unit']): number {
  const body = scenes.map(s => s.content).join('\n');
  return unit === 'words' ? body.split(/\s+/u).filter(w => /[\p{L}\p{N}]/u.test(w)).length : [...body].filter(c => !/\s/u.test(c)).length;
}

export function resolveLengthTarget(brief: Brief): {target?: LengthTarget; source: LengthCheck['source']; ambiguous?: boolean} {
  if (brief.lengthTarget) return {target: parseLengthTarget(brief.lengthTarget), source: 'structured'};
  // Compatibility for explicit legacy episode ranges only. Conflicting or per-scene ranges require an explicit field.
  const text = `${brief.premise}\n${brief.authorRules}`;
  const matches = [...text.matchAll(/(?<![\d,.])(\d{1,6})\s*(?:[-–—~～]|至|到|to)\s*(\d{1,6})\s*(words?\b|词|字|characters?\b)/giu)];
  if (!matches.length) return {source: 'none'};
  const targets: LengthTarget[] = [];
  try { for (const m of matches) targets.push(parseLengthTarget({min: Number(m[1]), max: Number(m[2]), unit: /^(word|词)/iu.test(m[3]!) ? 'words' : 'characters'})); }
  catch { return {source: 'brief', ambiguous: true}; }
  if (targets.some(t => JSON.stringify(t) !== JSON.stringify(targets[0])) || /(?:per|each)\s+scene|每[一]?场/iu.test(text)) return {source: 'brief', ambiguous: true};
  return {target: targets[0], source: 'brief'};
}

export function checkLength(brief: Brief, scenes: Pick<Scene, 'content'>[]): LengthCheck {
  const resolved = resolveLengthTarget(brief), unit = resolved.target?.unit ?? (/^(zh|ja|ko)(-|$)/u.test(brief.language??'zh-CN') ? 'characters' : 'words');
  const count = countScript(scenes, unit), label = unit === 'words' ? '词' : '字（不含空白）';
  if (!resolved.target) return {status: resolved.ambiguous ? 'ambiguous' : 'not_set', count, unit, source: resolved.source, message: resolved.ambiguous ? `正文 ${count} ${label}；简报篇幅范围有歧义，请在系列设定中明确整集范围。` : `正文 ${count} ${label}；未设置可核对的篇幅范围。`};
  const target = resolved.target, status = count < target.min ? 'too_short' : count > target.max ? 'too_long' : 'within_range';
  return {status, count, unit, target, source: resolved.source, message: `正文 ${count} ${label} / 目标 ${target.min}–${target.max} ${label}${status === 'too_long' ? `，超出 ${count-target.max}` : status === 'too_short' ? `，不足 ${target.min-count}` : '，范围内'}。`};
}

export function lengthInstruction(brief: Brief, scenes?: Scene[], selectedId?: string): string {
  const {target, ambiguous} = resolveLengthTarget(brief);
  if (!target) return ambiguous ? '简报的整集篇幅有歧义，不得声称篇幅通过。' : '';
  const unit = target.unit === 'words' ? '空白分隔、含字母或数字的词' : '非空白 Unicode 字符';
  const goal = Math.floor((target.min + target.max) / 2);
  let message = `整集正文硬性目标：${target.min}–${target.max} ${unit}（包括人物名与舞台动作，不含标题、梗概和场景标题）。先按场次分配预算，目标约 ${goal}，留出余量；不要以模型自报字数代替程序检查。优先保留使选择成立的动作与限制，删去重复表达，不能删掉因果铺垫来凑篇幅。`;
  if (scenes && selectedId) {
    const other = countScript(scenes.filter(s => s.id !== selectedId), target.unit);
    message += ` 其他场景已占 ${other}，本场最多 ${Math.max(0, target.max-other)}、至少 ${Math.max(0, target.min-other)}。若仅改本场无法满足整体范围，不能越界改动其他场景。`;
  }
  return message;
}
