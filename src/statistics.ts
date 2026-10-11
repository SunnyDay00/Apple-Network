import type { RecordEntry, Sample, Summary } from './types';
export function summarize(samples: Sample[]): Summary {
  const values = samples.filter(s => s.status === 'success' && Number.isFinite(s.durationMs) && s.durationMs! >= 0)
    .map(s => s.durationMs!).sort((a, b) => a - b);
  const success = values.length;
  const failed = samples.filter(s => s.status === 'failed' || s.status === 'timeout').length;
  const cancelled = samples.filter(s => s.status === 'cancelled').length;
  const mean = success ? values.reduce((a, b) => a + b, 0) / success : null;
  const percentile = (p: number) => success ? values[Math.ceil(success * p) - 1] : null;
  return {
    success, failed, cancelled, failureRate: success + failed ? failed / (success + failed) : null,
    mean, min: values[0] ?? null, max: values[success - 1] ?? null,
    p50: percentile(.5), p95: percentile(.95), p99: percentile(.99),
    stddev: mean === null ? null : Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / success),
  };
}
export function actualInterfaces(samples: Sample[]) {
  return [...new Set(samples.map(s => s.interface === 'other' || s.interface === 'none'
    ? s.observedInterface ?? s.interface : s.interface))];
}
export function lineMatches(record: RecordEntry, kind: 'wifi' | 'cellular') {
  // Only single-interface, complete sessions are comparable. A label never overrides native evidence.
  return record.completion === 'complete' && record.samples.length > 0 &&
    record.actualInterfaces.length === 1 && record.actualInterfaces[0] === kind;
}
export function comparable(a: RecordEntry, b: RecordEntry) {
  return a.target.host === b.target.host && a.target.port === b.target.port && a.mode === b.mode &&
    a.parameters.count === b.parameters.count && a.parameters.interval === b.parameters.interval &&
    a.parameters.timeout === b.parameters.timeout;
}
export function comparisonConclusion(a: Summary, b: Summary): string {
  if (a.success < 20 || b.success < 20) return '每条线路至少需要 20 个成功样本；当前样本较少，暂不下结论。';
  if ([a.mean, b.mean, a.p95, b.p95, a.stddev, b.stddev, a.failureRate, b.failureRate].some(v => v === null))
    return '有效指标不足，暂不下结论。';
  const aBetter = a.mean! < b.mean! && a.p95! <= b.p95! && a.stddev! <= b.stddev! && a.failureRate! <= b.failureRate!;
  const bBetter = b.mean! < a.mean! && b.p95! <= a.p95! && b.stddev! <= a.stddev! && b.failureRate! <= a.failureRate!;
  return aBetter ? '本次样本中，Wi-Fi 的耗时更低，尾延迟、波动和失败率也未更差。'
    : bBetter ? '本次样本中，蜂窝线路的耗时更低，尾延迟、波动和失败率也未更差。'
    : '两条线路各有优势或差异较小，请结合 P95、波动和失败率选择。';
}
export function formatMs(value: number | null | undefined) { return value == null ? '不可用' : value.toFixed(1); }
