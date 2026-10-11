import type { RecordEntry } from './types';
export type SortKey = 'mean' | 'p95' | 'min' | 'max' | 'stddev' | 'failureRate' | 'date';
export function sortRecords(records: RecordEntry[], key: SortKey, order: 'asc' | 'desc') {
  return [...records].sort((a, b) => {
    const av = key === 'date' ? Date.parse(a.startedAt) : a.summary[key];
    const bv = key === 'date' ? Date.parse(b.startedAt) : b.summary[key];
    if (av === null) return bv === null ? 0 : 1;
    if (bv === null) return -1;
    return (av - bv) * (order === 'asc' ? 1 : -1);
  });
}
export function fastestRecord(records: RecordEntry[]) {
  return sortRecords(records.filter(r => r.summary.mean !== null), 'mean', 'asc')[0];
}
export function renameHistoryRecord(records: RecordEntry[], id: string, name: string) {
  const normalized = name.trim();
  if (!normalized || normalized.length > 80) throw new Error('名称需要 1–80 个字符。');
  if (!records.some(r => r.id === id)) throw new Error('记录已不存在，请返回历史列表。');
  return records.map(record => record.id === id ? {...record, name: normalized} : record);
}
