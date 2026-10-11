import { describe, expect, it, vi } from 'vitest';
import { executeSession } from './runner';
import type { ProbeResult } from './types';
const result: ProbeResult = { status: 'success', durationMs: 10, elapsedMs: 10, interface: 'wifi', dnsIncluded: true };
const target = { id: 'a', name: '测试', host: 'example.com', port: 443 };
describe('串行调度与取消', () => {
  it('每次自动测 TCP 再测 HTTPS，分别保存且最后不额外等待', async () => {
    const order: string[] = [], checkpoints: number[] = [];
    const wait = vi.fn(async () => undefined);
    const samples = await executeSession({ target, mode: 'combined', parameters: { count: 5, interval: 1, timeout: 3 }, signal: new AbortController().signal,
      probe: async mode => { order.push(mode); return { ...result, durationMs: mode === 'tcp' ? 10 : 80 }; },
      onProgress: () => undefined, onSample: async values => { checkpoints.push(values.filter(s => s.https).length); }, wait });
    expect(order).toEqual(Array.from({length: 5}, () => ['tcp', 'https']).flat());
    expect(samples).toHaveLength(5); expect(samples[0].durationMs).toBe(10); expect(samples[0].https?.durationMs).toBe(80);
    expect(checkpoints).toHaveLength(10); expect(wait).toHaveBeenCalledTimes(4);
  });
  it('TCP 失败仍测 HTTPS，不把两项状态合并', async () => {
    const samples = await executeSession({ target, mode: 'combined', parameters: { count: 1, interval: 1, timeout: 3 }, signal: new AbortController().signal,
      probe: async mode => mode === 'tcp' ? { ...result, status: 'failed', durationMs: undefined, error: 'TCP 拒绝连接' } : result,
      onProgress: () => undefined, onSample: async () => undefined });
    expect(samples[0].status).toBe('failed'); expect(samples[0].https?.status).toBe('success');
  });
  it('TCP 完成后的取消不能再创建 HTTPS 连接', async () => {
    const abort = new AbortController(), probe = vi.fn(async () => result);
    const samples = await executeSession({ target, mode: 'combined', parameters: { count: 5, interval: 1, timeout: 3 }, signal: abort.signal,
      probe, onProgress: () => undefined, onSample: async () => { abort.abort(); } });
    expect(probe).toHaveBeenCalledTimes(1); expect(samples[0].https).toBeUndefined();
  });
  it('HTTPS 取消后不测下一组', async () => {
    const probe = vi.fn(async (mode: string): Promise<ProbeResult> => mode === 'https' ? { ...result, status: 'cancelled', durationMs: undefined } : result);
    const samples = await executeSession({ target, mode: 'combined', parameters: { count: 5, interval: 1, timeout: 3 }, signal: new AbortController().signal,
      probe, onProgress: () => undefined, onSample: async () => undefined });
    expect(probe).toHaveBeenCalledTimes(2); expect(samples).toHaveLength(1);
  });
  it('严格串行且最后一次后不再等待或创建连接', async () => {
    const probe = vi.fn(async () => result), wait = vi.fn(async () => undefined), save = vi.fn(async () => undefined);
    const samples = await executeSession({ target, mode: 'tcp', parameters: { count: 5, interval: 1, timeout: 3 }, signal: new AbortController().signal, probe, wait, onSample: save, onProgress: () => undefined });
    expect(probe).toHaveBeenCalledTimes(5); expect(wait).toHaveBeenCalledTimes(4); expect(save).toHaveBeenCalledTimes(5);
    expect(samples.map(s => s.sequence)).toEqual([1, 2, 3, 4, 5]);
  });
  it('间隔中停止不开始下一次连接', async () => {
    const abort = new AbortController(), probe = vi.fn(async () => result);
    const samples = await executeSession({ target, mode: 'tcp', parameters: { count: 10, interval: 1, timeout: 3 }, signal: abort.signal, probe, onProgress: () => undefined, onSample: async () => undefined, wait: async () => { abort.abort(); } });
    expect(probe).toHaveBeenCalledTimes(1); expect(samples).toHaveLength(1);
  });
  it('原生返回取消后立即停止', async () => {
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ ...result, status: 'cancelled', durationMs: undefined }));
    const samples = await executeSession({ target, mode: 'tcp', parameters: { count: 100, interval: 1, timeout: 3 }, signal: new AbortController().signal, probe, onSample: async () => undefined, onProgress: () => undefined });
    expect(samples).toHaveLength(1); expect(probe).toHaveBeenCalledTimes(1);
  });
  it('检查点保存失败后不再创建新连接', async () => {
    const probe = vi.fn(async () => result);
    await expect(executeSession({ target, mode: 'https', parameters: { count: 5, interval: 1, timeout: 3 }, signal: new AbortController().signal, probe, onSample: async () => { throw new Error('磁盘故障'); }, onProgress: () => undefined })).rejects.toThrow('磁盘故障');
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
