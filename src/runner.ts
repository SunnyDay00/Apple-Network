import type { Mode, Parameters, ProbeMode, ProbeResult, Sample, Target } from './types';
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
  probe: (mode: ProbeMode, target: Target, timeout: number) => Promise<ProbeResult>;
  onProgress: (sequence: number) => void; onSample: (samples: Sample[]) => Promise<void>;
  onPhase?: (phase: ProbeMode | 'interval') => void;
  wait?: typeof delay;
}): Promise<Sample[]> {
  const samples: Sample[] = [];
  const { signal, parameters } = options;
  for (let sequence = 1; sequence <= parameters.count; sequence++) {
    if (signal.aborted) break;
    options.onProgress(sequence);
    const firstMode = options.mode === 'combined' ? 'tcp' : options.mode;
    options.onPhase?.(firstMode);
    const result = await options.probe(firstMode, options.target, parameters.timeout);
    samples.push({ ...result, sequence, at: new Date().toISOString() });
    await options.onSample([...samples]);
    if (signal.aborted || result.status === 'cancelled') break;
    if (options.mode === 'combined') {
      // Keep the two measurements independent and sequential. A TCP failure
      // must not hide an HTTPS result; cancelling never starts a second probe.
      options.onPhase?.('https');
      const https = await options.probe('https', options.target, parameters.timeout);
      samples[samples.length - 1] = { ...samples[samples.length - 1], https };
      await options.onSample([...samples]);
      if (signal.aborted || https.status === 'cancelled') break;
    }
    if (sequence < parameters.count) {
      options.onPhase?.('interval');
      await (options.wait ?? delay)(parameters.interval * 1000, signal);
    }
  }
  return samples;
}
