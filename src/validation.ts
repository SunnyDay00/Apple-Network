import { actualInterfaces, summarize } from './statistics';
import type { HTTPMetrics, Interface, RecordEntry, Sample, Target } from './types';
const interfaces = ['wifi', 'cellular', 'wired', 'other', 'none'];
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function normalizeHost(input: string): string {
  const host = input.trim().replace(/^\[|\]$/g, '');
  if (!host || /[\s/@?#\\]/.test(host) || host.includes('://')) throw new Error('请输入域名或 IP，不要包含协议、路径或账号。');
  const url = new URL(`https://${host.includes(':') ? `[${host}]` : host}/`);
  const normalized = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized.length > 253 || (!normalized.includes(':') && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*\.?$/.test(normalized)))
    throw new Error('域名或 IP 格式不正确。');
  return normalized;
}
export function validateTarget(input: Target): Target {
  if (!input.name.trim() || input.name.length > 80) throw new Error('目标名称需要 1–80 个字符。');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('端口需要在 1–65535 之间。');
  return { ...input, host: normalizeHost(input.host), name: input.name.trim() };
}
function metric(value: unknown): HTTPMetrics {
  if (!isObject(value) || typeof value.url !== 'string' || typeof value.protocol !== 'string' ||
    typeof value.reused !== 'boolean' || typeof value.cached !== 'boolean' || !interfaces.includes(String(value.interface)))
    throw new Error('HTTPS 指标格式无效。');
  for (const key of ['dnsMs', 'tcpMs', 'tlsMs', 'ttfbMs', 'totalMs']) {
    if (value[key] !== null && !finite(value[key])) throw new Error('HTTPS 耗时格式无效。');
  }
  if (value.statusCode !== null && (!Number.isInteger(value.statusCode) || Number(value.statusCode) < 100 || Number(value.statusCode) > 599))
    throw new Error('HTTP 状态码无效。');
  if (typeof value.localAddress !== 'string' || typeof value.remoteAddress !== 'string') throw new Error('地址格式无效。');
  return value as unknown as HTTPMetrics;
}
function sample(value: unknown, index: number): Sample {
  if (!isObject(value) || value.sequence !== index + 1 || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)) ||
    !['success', 'failed', 'timeout', 'cancelled'].includes(String(value.status)) || !finite(value.elapsedMs) ||
    !interfaces.includes(String(value.interface)) || typeof value.dnsIncluded !== 'boolean' ||
    (value.status === 'success' && !finite(value.durationMs))) throw new Error('原始采样格式无效。');
  if (value.durationMs !== undefined && !finite(value.durationMs)) throw new Error('采样耗时无效。');
  if (value.error !== undefined && typeof value.error !== 'string') throw new Error('错误说明无效。');
  if (value.observedInterface !== undefined && !interfaces.includes(String(value.observedInterface))) throw new Error('网络类型无效。');
  if (value.metrics !== undefined) {
    if (!Array.isArray(value.metrics) || value.metrics.length > 6) throw new Error('HTTPS 事务数量无效。');
    value.metrics = value.metrics.map(metric);
  }
  return value as unknown as Sample;
}
export function validateRecord(value: unknown): RecordEntry {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id || value.id.length > 100 ||
    (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 80)) ||
    typeof value.startedAt !== 'string' || typeof value.endedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.endedAt)) ||
    Date.parse(value.endedAt) < Date.parse(value.startedAt) ||
    !['tcp', 'https'].includes(String(value.mode)) || !['auto', 'wifi', '5g'].includes(String(value.label)) ||
    !['complete', 'stopped', 'interrupted'].includes(String(value.completion)) ||
    !isObject(value.target) || typeof value.target.id !== 'string' || typeof value.target.name !== 'string' ||
    typeof value.target.host !== 'string' || typeof value.target.port !== 'number' ||
    !isObject(value.parameters) || ![1, 5, 10, 20, 50, 100].includes(Number(value.parameters.count)) ||
    ![1, 2, 3, 5].includes(Number(value.parameters.interval)) || ![2, 3, 5, 10].includes(Number(value.parameters.timeout)) ||
    !Array.isArray(value.samples) || value.samples.length > Number(value.parameters.count)) throw new Error('历史记录结构或参数无效。');
  const samples = value.samples.map(sample);
  if (value.completion === 'complete' && (samples.length !== value.parameters.count || samples.some(s => s.status === 'cancelled')))
    throw new Error('完整记录的采样数量或状态无效。');
  return { ...value, target: validateTarget(value.target as unknown as Target), samples,
    summary: summarize(samples), actualInterfaces: actualInterfaces(samples) as Interface[] } as unknown as RecordEntry;
}
export function parseBackup(text: string): RecordEntry[] {
  if (text.length > 10 * 1024 * 1024) throw new Error('JSON 超过 10 MB，请拆分后导入。');
  const data: unknown = JSON.parse(text);
  if (!isObject(data) || data.version !== 1 || !Array.isArray(data.records) || data.records.length > 2000)
    throw new Error('需要本应用导出的版本 1 JSON 文件，最多 2000 条记录。');
  const records = data.records.map(validateRecord);
  if (new Set(records.map(r => r.id)).size !== records.length) throw new Error('文件包含重复记录 ID。');
  return records;
}
