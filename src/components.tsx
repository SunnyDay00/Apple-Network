import type { ReactNode } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { averageComparison, comparisonConclusion, formatMs } from './statistics';
import { interfaceNames, type NetworkRound, type Sample, type Summary } from './types';

export function Icon({ name, size = 22 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    activity: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
    compare: <><path d="M5 20V10m7 10V4m7 16v-7M3 20h18" /></>,
    history: <><path d="M3 10a9 9 0 1 1 2 9M3 4v6h6m3-3v6l4 2" /></>,
    settings: <><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z" /><circle cx="12" cy="12" r="3" /></>,
    wifi: <><path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0" /><circle cx="12" cy="20" r=".7" /></>,
    cellular: <><path d="M4 20v-4m5 4v-8m5 8V8m5 12V4" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
    arrow: <path d="m9 5 7 7-7 7" />,
    play: <path d="m8 4 12 8-12 8Z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.activity}</svg>;
}
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}
export function Empty({ icon, title, text }: { icon: string; title: string; text: string }) {
  return <div className="empty"><div className="empty-icon"><Icon name={icon} size={32} /></div><h3>{title}</h3><p>{text}</p></div>;
}
export function MeasurementValue({ value, label, status }: { value: number | null | undefined; label: string; status: string }) {
  const text = value == null ? '—' : formatMs(value);
  return <div className="reading-slot">
    <div className="big-number" title={value == null ? `${label}：不可用` : `${label}：${text} ms`}>
      <span className="reading-value">{text}</span><span className="reading-unit">ms</span>
    </div>
    <div className="measurement-label">{label}</div><p title={status}>{status}</p>
  </div>;
}
export function Stats({ summary }: { summary: Summary }) {
  const numbers = [['平均耗时', summary.mean], ['最低耗时', summary.min], ['最高耗时', summary.max],
    ['P50', summary.p50], ['P95', summary.p95], ['P99', summary.p99], ['标准差', summary.stddev]] as const;
  return <><div className="stats-grid">{numbers.map(([label, value]) => <div key={label}><span>{label}</span><strong className="stat-value" title={value == null ? '不可用' : `${formatMs(value)} ms`}><span className="stat-number">{formatMs(value)}</span><small className={`stat-unit ${value == null ? 'unit-placeholder' : ''}`} aria-hidden={value == null}>ms</small></strong></div>)}
    <div><span>连接失败率</span><strong className={`stat-value ${summary.failed ? 'danger-text' : ''}`}>{summary.failureRate == null ? '不可用' : `${(summary.failureRate * 100).toFixed(1)}%`}</strong></div></div>
    <div className="counts"><span><i className="dot green" />成功 <b>{summary.success}</b></span><span><i className="dot red" />失败 <b>{summary.failed}</b></span><span>取消 <b>{summary.cancelled}</b></span></div></>;
}
export function RoundComparison({rounds, compact = false}: {rounds: NetworkRound[]; compact?: boolean}) {
  const wifi = rounds.find(r => r.interface === 'wifi'), cell = rounds.find(r => r.interface === 'cellular');
  if (!wifi || !cell) return null;
  const complete = wifi.completion === 'complete' && cell.completion === 'complete';
  return <section className={`round-comparison ${compact ? 'compact' : ''}`}>
    <h3>同一组 Wi-Fi / 蜂窝测量</h3><div className="round-cards">{[wifi, cell].map(round => <div key={round.interface}>
      <b><Icon name={round.interface === 'wifi' ? 'wifi' : 'cellular'} size={18} />{interfaceNames[round.interface]}{round.completion !== 'complete' && ' · 未完成'}</b>
      <span>TCP 平均<strong>{formatMs(round.summary.mean)} <small>ms</small></strong></span>
      <span>HTTPS 平均<strong>{formatMs(round.httpsSummary.mean)} <small>ms</small></strong></span>
      <p>P95 {formatMs(round.summary.p95)} ms · 波动 {formatMs(round.summary.stddev)} ms</p>
      <p>TCP 失败率 {round.summary.failureRate === null ? '不可用' : `${(round.summary.failureRate * 100).toFixed(1)}%`}</p>
    </div>)}</div>
    <div className="round-conclusions"><p className="round-lowest">{averageComparison('TCP', wifi.summary.mean, cell.summary.mean, complete)}</p><p className="round-lowest">{averageComparison('HTTPS', wifi.httpsSummary.mean, cell.httpsSummary.mean, complete)}</p></div>
    {!compact && <p className="hint">{complete ? comparisonConclusion(wifi.summary, cell.summary) : '两条线路尚未完整测量，暂不下线路优劣结论。'}</p>}
  </section>;
}
export function SampleChart({ samples, mode = 'tcp', onSelect }: { samples: Sample[]; mode?: string; onSelect?: (s: Sample) => void }) {
  if (!samples.length) return <div className="chart chart-empty"><div className="grid-lines" /><div><Icon name="activity" size={30} /><p>真实采样将在这里呈现</p><span>开始测试后，查看每一次连接的变化</span></div></div>;
  const data = samples.map(s => ({ sequence: s.sequence, success: s.status === 'success' ? s.durationMs : null,
    // Failure marker is on a zero baseline; it is never used as a latency value.
    failure: s.status === 'success' ? null : 0,
    https: s.https?.status === 'success' ? s.https.durationMs : null,
    httpsFailure: s.https && s.https.status !== 'success' ? 0 : null, sample: s }));
  return <div className="chart" role="img" aria-label={`${mode === 'combined' ? 'TCP 与 HTTPS' : mode === 'tcp' ? 'TCP 连接' : 'HTTPS 总'}耗时图，失败点在基线显示`}>
    <ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{ top: 12, right: 8, left: -12, bottom: 0 }}>
      <CartesianGrid strokeDasharray="3 5" vertical={false} stroke="var(--border)" />
      <XAxis dataKey="sequence" tickLine={false} axisLine={false} tick={{ fontSize: 13, fill: 'var(--muted)' }} minTickGap={24} />
      <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 13, fill: 'var(--muted)' }} width={50} domain={[0, 'auto']} />
      <Tooltip content={({ active, payload }) => {
        if (!active || !payload?.length) return null;
        const s: Sample = payload[0].payload.sample;
        return <div className="chart-tooltip"><b>第 {s.sequence} 次 · {s.status === 'success' ? `${formatMs(s.durationMs)} ms` : s.status === 'cancelled' ? '已取消' : '连接失败'}</b>{mode === 'combined' && <p>HTTPS：{s.https?.status === 'success' ? `${formatMs(s.https.durationMs)} ms` : s.https ? ({failed:'失败',timeout:'超时',cancelled:'取消'})[s.https.status] : '尚未执行'}</p>}<p>{interfaceNames[s.interface]}{s.error && ` · ${s.error}`}</p><button onClick={() => onSelect?.(s)}>查看采样详情</button></div>;
      }} />
      <Line type="linear" dataKey="success" stroke="var(--accent)" strokeWidth={2.3} connectNulls={false}
        dot={{ r: 3, fill: 'var(--card)', strokeWidth: 2 }} activeDot={{ r: 6, onClick: (_event: unknown, point: unknown) => {
          const s = (point as { payload?: { sample?: Sample } }).payload?.sample; if (s) onSelect?.(s);
        } }} isAnimationActive={false} />
      <Line dataKey="failure" stroke="var(--red)" strokeWidth={0} dot={{ r: 4, fill: 'var(--red)' }} isAnimationActive={false} />
      {mode === 'combined' && <Line type="linear" dataKey="https" stroke="var(--green)" strokeWidth={2.3} connectNulls={false} dot={{ r: 3, fill: 'var(--card)', strokeWidth: 2 }} isAnimationActive={false} />}
      {mode === 'combined' && <Line dataKey="httpsFailure" stroke="var(--red)" strokeWidth={0} dot={{ r: 5, fill: 'var(--card)', stroke: 'var(--red)', strokeWidth: 2 }} isAnimationActive={false} />}
    </LineChart></ResponsiveContainer>
  </div>;
}
export function SampleDetails({ sample }: { sample: Sample }) {
  if (sample.https) {
    const { https, ...tcp } = sample;
    return <div className="combined-detail"><h3>TCP 建连结果</h3><SampleDetails sample={tcp} /><h3>HTTPS 性能结果</h3><SampleDetails sample={{ ...https, sequence: sample.sequence, at: sample.at }} /></div>;
  }
  return <div className="sample-detail"><div className="detail-grid"><span>状态</span><b>{({ success: '成功', failed: '失败', timeout: '超时', cancelled: '取消' })[sample.status]}</b>
    <span>耗时</span><b>{formatMs(sample.durationMs)}{sample.durationMs != null && ' ms'}</b>
    <span>等待总耗时</span><b>{formatMs(sample.elapsedMs)} ms</b><span>连接路径</span><b>{interfaceNames[sample.interface]}</b>
    <span>路径监视器</span><b>{sample.observedInterface ? interfaceNames[sample.observedInterface] : '不可用'}</b>
    {sample.statusCode !== undefined && <><span>HTTP 状态码</span><b>{sample.statusCode}</b></>}
  </div>{sample.error && <p className="danger-text">{sample.error}</p>}
    {sample.metrics?.map((m, i) => <div className="http-transaction" key={i}><h4>HTTPS 事务 {i + 1}</h4><p className="mono break-all">{m.url}</p><div className="detail-grid">
      {([['DNS', m.dnsMs], ['TCP', m.tcpMs], ['TLS', m.tlsMs], ['TTFB', m.ttfbMs], ['事务总耗时', m.totalMs]] as const).map(([k, v]) => <div className="contents" key={k}><span>{k}</span><b>{formatMs(v)}{v != null && ' ms'}</b></div>)}
      <span>协议</span><b>{m.protocol}</b><span>复用 / 缓存</span><b>{m.reused ? '是' : '否'} / {m.cached ? '是' : '否'}</b>
      <span>目标地址</span><b className="break-all">{m.remoteAddress || '不可用'}</b></div></div>)}
    <p className="hint">{sample.dnsIncluded ? 'TCP 建连耗时可能包含 DNS 解析及系统调度；这是建连时间，不是 ICMP Ping RTT。' : 'TTFB 从请求开始至首字节；总体耗时包含重定向。复用或缓存可能使分项指标不可用，HTTP/3 不显示 TCP 指标。'}</p>
  </div>;
}
