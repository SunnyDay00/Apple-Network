import { describe, expect, it } from 'vitest';
import { normalizeHost, parseBackup } from './validation';
import { toCSV } from './export';
const record = { id: 'record', startedAt: '2026-10-11T00:00:00Z', endedAt: '2026-10-11T00:00:20Z',
  target: { id: 'a', name: '=1+1', host: 'www.apple.com.cn', port: 443 }, mode: 'tcp', label: 'auto',
  parameters: { count: 1, interval: 1, timeout: 5 }, completion: 'complete',
  samples: [{ sequence: 1, at: '2026-10-11T00:00:01Z', status: 'success', durationMs: 12, elapsedMs: 12, interface: 'wifi', dnsIncluded: true }], summary: { mean: 999 }, actualInterfaces: ['cellular'] };
const backup = (records: unknown[]) => JSON.stringify({ version: 1, records });
describe('目标和备份校验', () => {
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
