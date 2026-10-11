import { Preferences } from '@capacitor/preferences';
import { parseBackup, validateRecord, validateTarget } from './validation';
import { defaults, type RecordEntry, type Settings, type Target } from './types';
const historyKey = 'probe.history.v1';
let writeQueue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => undefined);
  return next;
}
export async function readHistory(): Promise<RecordEntry[]> {
  const { value } = await Preferences.get({ key: historyKey });
  return value ? parseBackup(value) : [];
}
export async function updateHistory(change: (current: RecordEntry[]) => RecordEntry[]) {
  return exclusive(async () => {
    const next = change(await readHistory());
    if (next.length > 2000) throw new Error('已达到 2000 条记录上限，请先导出并清理历史。');
    await Preferences.set({ key: historyKey, value: JSON.stringify({ version: 1, records: next }) });
    return next;
  });
}
export function saveRecord(record: RecordEntry) {
  return updateHistory(current => [record, ...current.filter(r => r.id !== record.id)]);
}
export async function readDraft(): Promise<RecordEntry | null> {
  const { value } = await Preferences.get({ key: 'probe.draft.v1' });
  return value ? validateRecord(JSON.parse(value)) : null;
}
export async function saveDraft(record: RecordEntry | null) {
  if (record) await Preferences.set({ key: 'probe.draft.v1', value: JSON.stringify(record) });
  else await Preferences.remove({ key: 'probe.draft.v1' });
}
export async function readTargets(): Promise<Target[]> {
  const { value } = await Preferences.get({ key: 'probe.targets.v1' });
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length > 100) throw new Error('自定义目标数据无效。');
  return parsed.map(v => validateTarget(v as Target));
}
export async function saveTargets(targets: Target[]) {
  if (targets.length > 100) throw new Error('最多保存 100 个自定义目标。');
  await Preferences.set({ key: 'probe.targets.v1', value: JSON.stringify(targets) });
}
export async function readSettings(): Promise<Settings> {
  const { value } = await Preferences.get({ key: 'probe.settings.v1' });
  if (!value) return { theme: 'system', parameters: defaults };
  const parsed = JSON.parse(value) as Settings;
  if (!['system', 'light', 'dark'].includes(parsed.theme)) throw new Error('主题配置无效。');
  const p = parsed.parameters;
  if (!p || ![1, 5, 10, 20, 50, 100].includes(p.count) || ![1, 2, 3, 5].includes(p.interval) || ![2, 3, 5, 10].includes(p.timeout))
    throw new Error('测试参数配置无效。');
  return parsed;
}
export async function saveSettings(settings: Settings) {
  await Preferences.set({ key: 'probe.settings.v1', value: JSON.stringify(settings) });
}
