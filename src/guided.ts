import { executeSession } from './runner';
import { summarize, summarizeHTTPS } from './statistics';
import type { Interface, NetworkRound, NetworkStatus, Parameters, ProbeMode, ProbeResult, Sample, Target, TestScope } from './types';

export function oppositeNetwork(kind: Interface): 'wifi' | 'cellular' {
  if (kind === 'wifi') return 'cellular';
  if (kind === 'cellular') return 'wifi';
  throw new Error('双线路测试需要先连接 Wi-Fi 或蜂窝网络。');
}

export async function executeGuidedSession(options: {
  scope: TestScope; target: Target; parameters: Parameters; signal: AbortSignal;
  readNetwork: () => Promise<NetworkStatus>;
  probe: (mode: ProbeMode, target: Target, timeout: number) => Promise<ProbeResult>;
  changeNetwork: (expected: 'wifi' | 'cellular') => Promise<boolean>;
  onRoundStart: (kind: Interface) => void;
  onProgress: (sequence: number) => void;
  onPhase: (phase: ProbeMode | 'interval') => void;
  onRounds: (rounds: NetworkRound[]) => Promise<void>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<NetworkRound[]> {
  const initial = await options.readNetwork();
  if (!initial.available) throw new Error('当前网络不可用，请连接后再开始。');
  if (options.scope === 'both') oppositeNetwork(initial.interface);
  const rounds: NetworkRound[] = [];
  for (let index = 0; index < (options.scope === 'both' ? 2 : 1); index++) {
    if (options.signal.aborted) break;
    const kind = index === 0 ? initial.interface : oppositeNetwork(initial.interface);
    if (index === 1) {
      if (!await options.changeNetwork(kind as 'wifi' | 'cellular') || options.signal.aborted) break;
      const current = await options.readNetwork();
      if (!current.available || current.interface !== kind) throw new Error('网络路径未切换到目标线路，请检查后重试。');
    }
    options.onRoundStart(kind);
    const startedAt = new Date().toISOString();
    let samples: Sample[] = [];
    const snapshot = (completion: NetworkRound['completion']): NetworkRound => ({
      interface: kind, startedAt, endedAt: new Date().toISOString(), samples,
      summary: summarize(samples), httpsSummary: summarizeHTTPS(samples), completion,
    });
    await executeSession({
      ...options, mode: 'combined', onSample: async values => {
        samples = values;
        await options.onRounds([...rounds, snapshot('interrupted')]);
      },
    });
    const complete = !options.signal.aborted && samples.length === options.parameters.count &&
      samples.every(s => s.status !== 'cancelled' && s.https && s.https.status !== 'cancelled');
    rounds.push(snapshot(complete ? 'complete' : 'stopped'));
    await options.onRounds([...rounds]);
    if (!complete) break;
  }
  return rounds;
}
