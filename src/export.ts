import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { RecordEntry } from './types';
function csvCell(value: unknown) {
  let text = value == null ? '' : String(value);
  // Prevent spreadsheet formula injection in imported names/error text.
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function toCSV(records: RecordEntry[]) {
  const rows: unknown[][] = [['记录ID', '记录名称', '开始时间', '域名', '端口', '模式', '线路标记', '记录状态', '序号', '时间', '连接实际网络', '路径监视网络', '状态', '耗时ms', '等待耗时ms', '错误', 'HTTP状态码', 'DNSms', 'TCPms', 'TLSms', 'TTFBms', '协议', '复用', '缓存', 'HTTPS状态', 'HTTPS总耗时ms', 'HTTPS等待ms', 'HTTPS错误', 'HTTPS实际网络', 'HTTPS路径监视网络']];
  for (const r of records) for (const s of r.samples) {
    const h = s.https;
    const m = (h ?? s).metrics?.at(-1);
    rows.push([r.id, r.name ?? r.target.name, r.startedAt, r.target.host, r.target.port, r.mode, r.label, r.completion,
      s.sequence, s.at, s.interface, s.observedInterface, s.status, s.durationMs, s.elapsedMs,
      s.error, (h ?? s).statusCode, m?.dnsMs, m?.tcpMs, m?.tlsMs, m?.ttfbMs, m?.protocol, m?.reused, m?.cached,
      h?.status, h?.durationMs, h?.elapsedMs, h?.error, h?.interface, h?.observedInterface]);
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
export async function exportRecords(records: RecordEntry[], format: 'json' | 'csv') {
  const data = format === 'json' ? JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), records }, null, 2) : toCSV(records);
  const name = `apple-network-${new Date().toISOString().replaceAll(':', '-')}.${format}`;
  if (Capacitor.isNativePlatform()) {
    const { uri } = await Filesystem.writeFile({ path: name, directory: Directory.Cache,
      data, encoding: Encoding.UTF8 });
    await Share.share({ title: '苹果网络探针记录', files: [uri], dialogTitle: '导出记录' });
  } else {
    const url = URL.createObjectURL(new Blob([data], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
