import { describe, expect, it } from 'vitest';
import { fastestRecord, sortRecords } from './history';
import { summarize } from './statistics';
import { defaults, type RecordEntry } from './types';
const record = (id: string, mean: number | null): RecordEntry => ({ id, name: id, startedAt: '2026-10-11T00:00:00Z', endedAt: '2026-10-11T00:00:20Z', target: { id: 'a', name: 'Apple', host: 'www.apple.com', port: 443 }, mode: 'tcp', label: 'auto', parameters: defaults, samples: [], actualInterfaces: ['wifi'], completion: 'complete', summary: { ...summarize([]), mean } });
describe('历史延迟排序', () => {
  it('支持低延迟优先与高延迟优先，不修改原列表', () => {
    const records = [record('中', 20), record('低', 10), record('高', 30)];
    expect(sortRecords(records, 'mean', 'asc').map(r => r.name)).toEqual(['低', '中', '高']);
    expect(sortRecords(records, 'mean', 'desc').map(r => r.name)).toEqual(['高', '中', '低']);
    expect(records[0].name).toBe('中');
  });
  it('无可用延迟永远排在末尾，也不会当选最低', () => {
    const records = [record('失败', null), record('成功', 10)];
    expect(sortRecords(records, 'mean', 'desc')[1].name).toBe('失败');
    expect(fastestRecord(records)?.name).toBe('成功');
    expect(fastestRecord([record('失败', null)])).toBeUndefined();
  });
});
