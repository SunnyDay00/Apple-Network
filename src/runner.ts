import type { Mode, Parameters, ProbeResult, Sample, Target } from './types';
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
export async function executeSession(options: {
  target: Target; mode: Mode; parameters: Parameters; signal: AbortSignal;
  probe: (mode: Mode, target: Target, timeout: number) => Promise<ProbeResult>;
  onProgress: (sequence: number) => void; onSample: (samples: Sample[]) => Promise<void>;
  wait?: typeof delay;
}): Promise<Sample[]> {
  const samples: Sample[] = [];
  const { signal, parameters } = options;
  for (let sequence = 1; sequence <= parameters.count; sequence++) {
    if (signal.aborted) break;
    options.onProgress(sequence);
    const result = await options.probe(options.mode, options.target, parameters.timeout);
    samples.push({ ...result, sequence, at: new Date().toISOString() });
    await options.onSample([...samples]);
    if (signal.aborted || result.status === 'cancelled') break;
    if (sequence < parameters.count) await (options.wait ?? delay)(parameters.interval * 1000, signal);
  }
  return samples;
}
