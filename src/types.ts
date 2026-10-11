export type Interface = 'wifi' | 'cellular' | 'wired' | 'other' | 'none';
export type Mode = 'tcp' | 'https';
export type LineLabel = 'auto' | 'wifi' | '5g';
export interface Target { id: string; name: string; host: string; port: number; builtin?: boolean }
export interface Parameters { count: number; interval: number; timeout: number }
export interface HTTPMetrics {
  url: string; dnsMs: number | null; tcpMs: number | null; tlsMs: number | null;
  ttfbMs: number | null; totalMs: number | null; protocol: string;
  reused: boolean; cached: boolean; interface: Interface;
  localAddress: string; remoteAddress: string; statusCode: number | null;
}
export interface ProbeResult {
  status: 'success' | 'failed' | 'timeout' | 'cancelled';
  durationMs?: number; elapsedMs: number; interface: Interface;
  observedInterface?: Interface; dnsIncluded: boolean; error?: string;
  statusCode?: number; redirects?: number; metrics?: HTTPMetrics[];
}
export interface Sample extends ProbeResult { sequence: number; at: string }
export interface Summary {
  success: number; failed: number; cancelled: number; failureRate: number | null;
  mean: number | null; min: number | null; max: number | null;
  p50: number | null; p95: number | null; p99: number | null; stddev: number | null;
}
export interface RecordEntry {
  id: string; name?: string; startedAt: string; endedAt: string; target: Target; mode: Mode;
  parameters: Parameters; label: LineLabel; actualInterfaces: Interface[];
  samples: Sample[]; summary: Summary; completion: 'complete' | 'stopped' | 'interrupted';
}
export interface NetworkStatus { available: boolean; interface: Interface; expensive?: boolean; constrained?: boolean }
export interface Settings { theme: 'system' | 'light' | 'dark'; parameters: Parameters }
export const interfaceNames: Record<Interface, string> = {
  wifi: 'Wi-Fi', cellular: '蜂窝网络', wired: '有线网络', other: '其他 / 未知', none: '无可用路径',
};
export const defaults: Parameters = { count: 10, interval: 1, timeout: 5 };
export const builtins: Target[] = [
  { id: 'apple-cn', name: 'Apple 中国官网', host: 'www.apple.com.cn', port: 443, builtin: true },
  { id: 'apple-global', name: 'Apple 国际官网', host: 'www.apple.com', port: 443, builtin: true },
  { id: 'apple-store', name: 'Apple 商店入口', host: 'store.apple.com', port: 443, builtin: true },
  { id: 'apple-connectivity', name: 'Apple 连通性参考 · HTTPS', host: 'captive.apple.com', port: 443, builtin: true },
  { id: 'apple-connectivity-80', name: 'Apple 连通性参考 · TCP 80', host: 'captive.apple.com', port: 80, builtin: true },
];
