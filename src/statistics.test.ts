import { describe, expect, it } from 'vitest';
import { actualInterfaces, comparable, comparisonConclusion, lineMatches, summarize, summarizeHTTPS } from './statistics';
import { defaults, type RecordEntry, type Sample } from './types';
const sample = (v: number, i: number): Sample => ({ sequence: i + 1, at: '2026-10-11T00:00:00Z', status: 'success', durationMs: v, elapsedMs: v, interface: 'wifi', dnsIncluded: true });
const record = (values: Sample[]): RecordEntry => ({ id: 'test', target: { id: 'target', name: '目标', host: 'www.apple.com.cn', port: 443 }, startedAt: '2026-10-11T00:00:00Z', endedAt: '2026-10-11T00:00:10Z', mode: 'tcp', parameters: defaults, label: 'auto', actualInterfaces: actualInterfaces(values), samples: values, summary: summarize(values), completion: 'complete' });
describe('统计定义', () => {
  it('两项延迟及失败率分别计算，网络切换证据不能忽略 HTTPS 路径', () => {
    const values = [{...sample(10, 0), https: {...sample(80, 0), interface: 'cellular' as const}}, {...sample(20, 1), https: {...sample(0, 1), status: 'timeout' as const, durationMs: undefined}}];
    expect(summarize(values).mean).toBe(15); expect(summarizeHTTPS(values)).toMatchObject({mean: 80, failureRate: .5});
    expect(actualInterfaces(values)).toEqual(['wifi', 'cellular']);
  });
  it('空样本不伪造零延迟或零失败率', () => { expect(summarize([])).toMatchObject({ mean: null, p95: null, stddev: null, failureRate: null, success: 0 }); });
  it('正确计算最近秩百分位和总体标准差', () => {
    const s = summarize([10, 20, 30, 40].map(sample));
    expect(s).toMatchObject({ mean: 25, min: 10, max: 40, p50: 20, p95: 40, p99: 40 });
    expect(s.stddev).toBeCloseTo(Math.sqrt(125));
  });
  it('使用排序后的成功采样计算 P95 / P99', () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => 100 - i).map(sample));
    expect(s.p50).toBe(50); expect(s.p95).toBe(95); expect(s.p99).toBe(99);
  });
  it('超时计失败，取消不计分母，失败不当作零耗时', () => {
    const values = [sample(20, 0), { ...sample(0, 1), status: 'timeout' as const, durationMs: undefined }, { ...sample(0, 2), status: 'cancelled' as const, durationMs: undefined }];
    expect(summarize(values)).toMatchObject({ mean: 20, failed: 1, cancelled: 1, failureRate: .5 });
  });
  it('全部失败时保留失败率，耗时不可用', () => { expect(summarize([{ ...sample(0, 0), status: 'failed' }])).toMatchObject({ success: 0, mean: null, failureRate: 1 }); });
  it('单个零耗时样本合法', () => { expect(summarize([sample(0, 0)])).toMatchObject({ mean: 0, p99: 0, stddev: 0 }); });
  it('少量样本不能给出线路优劣结论', () => { expect(comparisonConclusion(summarize([sample(1, 0)]), summarize([sample(100, 0)]))).toContain('较少'); });
  it('不单凭平均耗时忽略尾延迟或失败', () => {
    const a = summarize(Array.from({ length: 20 }, (_, i) => i === 19 ? 300 : 1).map(sample));
    const b = summarize(Array.from({ length: 20 }, () => 30).map(sample));
    expect(a.mean!).toBeLessThan(b.mean!); expect(comparisonConclusion(a, b)).toContain('各有优势');
  });
  it('手动 5G 标签不能覆盖 Wi-Fi 原生路径', () => { const r = record([sample(3, 0)]); r.label = '5g'; expect(lineMatches(r, 'cellular')).toBe(false); });
  it('混合网络及中断测试排除对比', () => {
    const r = record([sample(3, 0), { ...sample(4, 1), interface: 'cellular' }]); expect(lineMatches(r, 'wifi')).toBe(false);
    r.actualInterfaces = ['wifi']; r.completion = 'interrupted'; expect(lineMatches(r, 'wifi')).toBe(false);
  });
  it('条件不同不允许直接比较', () => { const a = record([]), b = record([]); b.parameters = { ...defaults, timeout: 10 }; expect(comparable(a, b)).toBe(false); });
});
