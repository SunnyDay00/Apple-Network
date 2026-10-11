import { describe, expect, it } from 'vitest';
import { normalizeHost, parseBackup } from './validation';
import { toCSV } from './export';
const record = { id: 'record', startedAt: '2026-10-11T00:00:00Z', endedAt: '2026-10-11T00:00:20Z',
  target: { id: 'a', name: '=1+1', host: 'www.apple.com.cn', port: 443 }, mode: 'tcp', label: 'auto',
  parameters: { count: 1, interval: 1, timeout: 5 }, completion: 'complete',
  samples: [{ sequence: 1, at: '2026-10-11T00:00:01Z', status: 'success', durationMs: 12, elapsedMs: 12, interface: 'wifi', dnsIncluded: true }], summary: { mean: 999 }, actualInterfaces: ['cellular'] };
const backup = (records: unknown[]) => JSON.stringify({ version: 1, records });
describe('目标和备份校验', () => {
  it('双线路记录合并原始采样，同时保持分线路统计', () => {
    const wifi = {...record.samples[0], https: {...record.samples[0], dnsIncluded: false, durationMs: 80}};
    const cellular = {...wifi, interface: 'cellular', durationMs: 20, https: {...wifi.https, interface: 'cellular', durationMs: 100}};
    const rounds = [wifi, cellular].map(s => ({interface: s.interface, startedAt: record.startedAt, endedAt: record.endedAt, samples: [s], completion: 'complete'}));
    const saved = {...record, mode: 'combined', scope: 'both', rounds, samples: [wifi, {...cellular, sequence: 2}]};
    const parsed = parseBackup(backup([saved]))[0];
    expect(parsed.rounds).toHaveLength(2); expect(parsed.rounds?.[0].summary.mean).toBe(12);
    expect(parsed.rounds?.[1].httpsSummary.mean).toBe(100); expect(parsed.actualInterfaces).toEqual(['wifi','cellular']);
    expect(parsed.httpsSummary?.mean).toBe(90);
  });
  it('双项备份保留原始值并分别重算统计', () => {
    const combined = { ...record, mode: 'combined', samples: [{...record.samples[0], https: {...record.samples[0], durationMs: 80}}], httpsSummary: { mean: 999 } };
    const r = parseBackup(backup([combined]))[0];
    expect(r.summary.mean).toBe(12); expect(r.httpsSummary?.mean).toBe(80);
  });
  it('完整双项记录不能缺少 HTTPS；错误的 HTTPS 原始值拒绝导入', () => {
    expect(() => parseBackup(backup([{...record, mode: 'combined'}]))).toThrow();
    expect(() => parseBackup(backup([{...record, mode: 'combined', samples: [{...record.samples[0], https: {...record.samples[0], durationMs: -1}}]}]))).toThrow();
  });
  it('支持域名、IPv4、IPv6与国际化域名', () => {
    expect(normalizeHost(' WWW.Apple.Com.CN ')).toBe('www.apple.com.cn');
    expect(normalizeHost('192.168.1.1')).toBe('192.168.1.1');
    expect(normalizeHost('[2001:db8::1]')).toBe('2001:db8::1');
    expect(normalizeHost('例子.测试')).toContain('xn--');
  });
  it('拒绝带账号、路径、协议和错误主机', () => { for (const host of ['https://apple.com', 'a/b', 'u@apple.com', 'a b', '-bad.com']) expect(() => normalizeHost(host)).toThrow(); });
  it('导入重新计算统计和实际网络，不信任外部汇总', () => { const r = parseBackup(backup([record]))[0]; expect(r.summary.mean).toBe(12); expect(r.actualInterfaces).toEqual(['wifi']); });
  it('拒绝负数、错误端口和过多样本', () => {
    expect(() => parseBackup(backup([{ ...record, target: { ...record.target, port: 0 } }]))).toThrow();
    expect(() => parseBackup(backup([{ ...record, samples: [{ ...record.samples[0], durationMs: -1 }] }]))).toThrow();
    expect(() => parseBackup(backup([{ ...record, samples: [...record.samples, record.samples[0]] }]))).toThrow();
  });
  it('拒绝重复 ID 和不完整的完整记录', () => { expect(() => parseBackup(backup([record, record]))).toThrow(); expect(() => parseBackup(backup([{ ...record, samples: [] }]))).toThrow(); });
  it('CSV 导出防止公式注入，保留错误及空值', () => {
    const r = parseBackup(backup([record]))[0]; r.samples[0].error = '=SUM(1,2)';
    expect(toCSV([r])).toContain('"\'=SUM(1,2)"'); expect(toCSV([r])).toContain('"12"');
  });
});
