import { describe, expect, it, vi } from 'vitest';
import { executeGuidedSession } from './guided';
import type { NetworkRound, NetworkStatus, ProbeResult } from './types';
const result: ProbeResult = {status: 'success', durationMs: 10, elapsedMs: 10, interface: 'wifi', dnsIncluded: true};
function configuration() {
  return {scope: 'both' as const, target: {id: 'a', name: 'Apple', host: 'www.apple.com', port: 443},
    parameters: {count: 1, interval: 1, timeout: 2}, signal: new AbortController().signal,
    onProgress: () => undefined, onPhase: () => undefined, onRoundStart: () => undefined,
    onRounds: async (_rounds: NetworkRound[]) => undefined};
}
describe('手动切换网络的双线路流程', () => {
  it('Wi-Fi 完成后等待同意和蜂窝校验，才开始第二轮', async () => {
    const events: string[] = [], snapshots: NetworkRound[][] = [];
    const readNetwork = vi.fn<() => Promise<NetworkStatus>>()
      .mockResolvedValueOnce({available: true, interface: 'wifi'})
      .mockResolvedValueOnce({available: true, interface: 'cellular'});
    const rounds = await executeGuidedSession({...configuration(), readNetwork,
      probe: async mode => {events.push(mode); return result;},
      changeNetwork: async expected => {events.push(`switch:${expected}`); return true;},
      onRounds: async value => {snapshots.push(value);}});
    expect(events).toEqual(['tcp','https','switch:cellular','tcp','https']);
    expect(rounds.map(r => r.interface)).toEqual(['wifi','cellular']);
    expect(snapshots.some(s => s.length === 1 && s[0].completion === 'complete')).toBe(true);
  });
  it('蜂窝开始时引导切换到 Wi-Fi', async () => {
    const changeNetwork = vi.fn(async () => true);
    const readNetwork = vi.fn<() => Promise<NetworkStatus>>()
      .mockResolvedValueOnce({available: true, interface: 'cellular'})
      .mockResolvedValueOnce({available: true, interface: 'wifi'});
    const rounds = await executeGuidedSession({...configuration(), readNetwork, probe: async () => result, changeNetwork});
    expect(changeNetwork).toHaveBeenCalledWith('wifi'); expect(rounds).toHaveLength(2);
  });
  it('用户结束切换时保留第一轮，绝不启动第二轮', async () => {
    const probe = vi.fn(async () => result);
    const rounds = await executeGuidedSession({...configuration(), readNetwork: async () => ({available: true, interface: 'wifi'}), probe,
      changeNetwork: async () => false});
    expect(rounds).toHaveLength(1); expect(probe).toHaveBeenCalledTimes(2);
  });
  it('切换后路径仍是 Wi-Fi 时不能启动蜂窝测量', async () => {
    const probe = vi.fn(async () => result);
    await expect(executeGuidedSession({...configuration(), readNetwork: async () => ({available: true, interface: 'wifi'}), probe,
      changeNetwork: async () => true})).rejects.toThrow('网络路径未切换');
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it('当前网络模式仅完成一轮，不询问切换', async () => {
    const changeNetwork = vi.fn(async () => true), probe = vi.fn(async () => result);
    const rounds = await executeGuidedSession({...configuration(), scope: 'current', readNetwork: async () => ({available: true, interface: 'wifi'}), probe, changeNetwork});
    expect(rounds).toHaveLength(1); expect(probe).toHaveBeenCalledTimes(2); expect(changeNetwork).not.toHaveBeenCalled();
  });
  it('等待切换时取消，不启动下一条线路', async () => {
    const abort = new AbortController(), probe = vi.fn(async () => result);
    const rounds = await executeGuidedSession({...configuration(), signal: abort.signal,
      readNetwork: async () => ({available: true, interface: 'wifi'}), probe,
      changeNetwork: async () => {abort.abort(); return true;}});
    expect(rounds).toHaveLength(1); expect(probe).toHaveBeenCalledTimes(2);
  });
});
