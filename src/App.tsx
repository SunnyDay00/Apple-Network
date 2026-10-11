import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { PluginListenerHandle } from '@capacitor/core';
import { Card, Empty, Icon, SampleChart, SampleDetails, Stats } from './components';
import { NetworkProbe, isNative } from './native';
import { actualInterfaces, comparable, comparisonConclusion, formatMs, lineMatches, summarize } from './statistics';
import { builtins, defaults, interfaceNames, type LineLabel, type Mode, type NetworkStatus, type Parameters, type RecordEntry, type Sample, type Settings, type Target } from './types';
import { readDraft, readHistory, readSettings, readTargets, saveDraft, saveRecord, saveSettings, saveTargets, updateHistory } from './storage';
import { parseBackup, validateTarget } from './validation';
import { executeSession } from './runner';
import { exportRecords } from './export';
import { fastestRecord, sortRecords, type SortKey } from './history';

type Tab = 'test' | 'compare' | 'history' | 'settings';
const tabs = [{ id: 'test', title: '网络测试', icon: 'activity' }, { id: 'compare', title: '对比分析', icon: 'compare' },
  { id: 'history', title: '历史记录', icon: 'history' }, { id: 'settings', title: '设置', icon: 'settings' }] as const;
const time = (date: string) => new Date(date).toLocaleString('zh-CN', { hour12: false });
const rate = (v: number | null) => v == null ? '不可用' : `${(v * 100).toFixed(1)}%`;
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

export default function App() {
  const [tab, setTab] = useState<Tab>('test');
  const [network, setNetwork] = useState<NetworkStatus>({ available: false, interface: 'none' });
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState(builtins[0].id);
  const [port, setPort] = useState(443);
  const [mode, setMode] = useState<Mode>('tcp');
  const [label, setLabel] = useState<LineLabel>('auto');
  const [settings, setSettings] = useState<Settings>({ theme: 'system', parameters: defaults });
  const [history, setHistory] = useState<RecordEntry[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<RecordEntry | null>(null);
  const [naming, setNaming] = useState(false);
  const [recordName, setRecordName] = useState('');
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<Target | null>(null);
  const [selectedSample, setSelectedSample] = useState<Sample | null>(null);
  const [detail, setDetail] = useState<RecordEntry | null>(null);
  const [filterHost, setFilterHost] = useState('');
  const [filterNetwork, setFilterNetwork] = useState('all');
  const [filterDate, setFilterDate] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('mean');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [wifiId, setWifiId] = useState('');
  const [cellId, setCellId] = useState('');
  const controller = useRef<AbortController | null>(null);
  const stopType = useRef<'stop' | 'discard' | 'interrupted'>('stop');
  // Read through a function: asynchronous native events can mutate the ref during await.
  const currentStopType = (): 'stop' | 'discard' | 'interrupted' => stopType.current;
  const runLock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const allTargets = [...builtins, ...targets];
  const target = allTargets.find(t => t.id === targetId) ?? builtins[0];
  const params = settings.parameters;
  const summary = useMemo(() => summarize(samples), [samples]);
  const latest = samples.at(-1);

  async function stop(kind: 'stop' | 'discard' | 'interrupted', reason = '用户停止') {
    stopType.current = kind;
    controller.current?.abort();
    if (isNative) try { await NetworkProbe.cancel({ reason }); } catch (error) { setNotice(message(error)); }
  }
  const stopRef = useRef(stop);
  stopRef.current = stop;

  useEffect(() => {
    let alive = true;
    const listeners: PluginListenerHandle[] = [];
    async function init() {
      try {
        const [saved, custom, config, draft] = await Promise.all([readHistory(), readTargets(), readSettings(), readDraft()]);
        if (!alive) return;
        setHistory(saved); setTargets(custom); setSettings(config);
        if (draft) {
          const recovered = draft;
          setPending(recovered);
          setNotice('已恢复上次尚未保存的测试。请命名保存，或选择不保存。');
        }
        setReady(true);
      } catch (error) { if (alive) setNotice(`读取本地数据失败：${message(error)}。为保护原数据，测试暂不可用。`); }
      if (!isNative || !alive) return;
      try {
        const listen = async (promise: Promise<PluginListenerHandle>) => {
          const handle = await promise;
          if (alive) listeners.push(handle); else await handle.remove();
        };
        await listen(NetworkProbe.addListener('networkChanged', n => { if (alive) {
          setNetwork(n);
          // Also stops an inter-sample wait when no native operation is active.
          if (controller.current && !n.available) void stopRef.current('interrupted', '网络不可用');
        } }));
        await listen(NetworkProbe.addListener('interrupted', data => {
          if (alive) { setNotice(data.reason); void stopRef.current('interrupted', data.reason); }
        }));
        const n = await NetworkProbe.getNetworkStatus();
        if (alive) setNetwork(n);
      } catch (error) { if (alive) { setReady(false); setNotice(`原生插件未就绪：${message(error)}`); } }
    }
    void init();
    const onVisibility = () => { if (document.visibilityState === 'hidden' && controller.current)
      void stopRef.current('interrupted', '应用进入后台'); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { alive = false; listeners.forEach(h => { void h.remove(); }); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    if (ready) void saveSettings(settings).catch(error => setNotice(`设置未保存：${message(error)}`));
  }, [settings, ready]);

  async function run() {
    if (!isNative || !ready || runLock.current || pending) return;
    if (history.length >= 2000) { setNotice('历史已满，请先导出并清理。'); return; }
    runLock.current = true;
    const abort = new AbortController(); controller.current = abort; stopType.current = 'stop';
    setRunning(true); setSamples([]); setProgress(0); setSelectedSample(null); setNotice('');
    let record: RecordEntry = {
      id: crypto.randomUUID(), startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      target: { ...target, port }, mode, parameters: { ...params }, label,
      actualInterfaces: [], samples: [], summary: summarize([]), completion: 'interrupted',
    };
    try {
      record.target = validateTarget(record.target);
      await saveDraft(record);
      await executeSession({ target: record.target, mode, parameters: record.parameters, signal: abort.signal,
        probe: (kind, t, timeout) => NetworkProbe[kind]({ host: t.host, port: t.port, timeout }),
        onProgress: setProgress,
        onSample: async values => {
          record = { ...record, samples: values, endedAt: new Date().toISOString(), summary: summarize(values), actualInterfaces: actualInterfaces(values) };
          setSamples(values);
          await saveDraft(record);
        },
      });
      record.endedAt = new Date().toISOString();
      if (currentStopType() === 'discard') { await saveDraft(null); setSamples([]); setNotice('本轮测试已取消，未保存历史记录。'); }
      else {
        record.completion = !abort.signal.aborted && record.samples.length === params.count && !record.samples.some(s => s.status === 'cancelled') ? 'complete'
          : currentStopType() === 'interrupted' ? 'interrupted' : 'stopped';
        setPending(record); await saveDraft(record);
        setNotice(record.completion === 'complete' ? '测试完成。请选择是否保存本轮记录。' : '测试已结束。请选择是否保存已有采样。');
      }
    } catch (error) {
      abort.abort();
      try { await NetworkProbe.cancel({ reason: '测试异常，关闭连接' }); } catch { /* Original error remains visible. */ }
      record.endedAt = new Date().toISOString(); setPending(record);
      setNotice(`测试或检查点保存失败：${message(error)}。已有采样可命名保存或导出。`);
    } finally { controller.current = null; runLock.current = false; setRunning(false); }
  }

  async function safely(action: () => Promise<void>) {
    try { await action(); } catch (error) { setNotice(message(error)); }
  }
  function beginNaming() {
    if (!pending) return;
    const line = pending.actualInterfaces.map(i => interfaceNames[i]).join(' / ') || '网络测试';
    setRecordName(`${line} · ${new Date(pending.startedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}`);
    setNaming(true);
  }
  async function confirmSave(event: FormEvent) {
    event.preventDefault(); if (!pending || saving) return;
    const name = recordName.trim();
    if (!name || name.length > 80) { setNotice('请填写 1–80 个字符的记录名称。'); return; }
    setSaving(true);
    try {
      setHistory(await saveRecord({ ...pending, name }));
      await saveDraft(null); setPending(null); setNaming(false); setNotice(`“${name}”已保存到历史记录。`);
    } catch (error) { setNotice(`记录未保存：${message(error)}。请重试或导出备份。`); }
    finally { setSaving(false); }
  }
  async function saveEditor(event: FormEvent) {
    event.preventDefault(); if (!editor) return;
    await safely(async () => {
      const valid = validateTarget(editor);
      const next = targets.some(t => t.id === valid.id) ? targets.map(t => t.id === valid.id ? valid : t) : [...targets, valid];
      await saveTargets(next); setTargets(next); setTargetId(valid.id); setPort(valid.port); setEditor(null);
      setNotice('自定义目标已保存。');
    });
  }
  const wifiRecords = history.filter(r => lineMatches(r, 'wifi'));
  const cellRecords = history.filter(r => lineMatches(r, 'cellular'));
  const wifi = wifiRecords.find(r => r.id === wifiId) ?? wifiRecords[0];
  const cell = cellRecords.find(r => r.id === cellId) ?? cellRecords.find(r => wifi && comparable(wifi, r)) ?? cellRecords[0];
  const filtered = sortRecords(history.filter(r => (!filterHost || r.target.host.includes(filterHost.toLowerCase())) &&
    (filterNetwork === 'all' || r.actualInterfaces.includes(filterNetwork as NetworkStatus['interface'])) &&
    (!filterDate || new Date(r.startedAt).toLocaleDateString('sv-SE') === filterDate)), sortKey, sortOrder);
  const fastest = fastestRecord(filtered);
  function chooseTarget(id: string) {
    const t = allTargets.find(t => t.id === id)!;
    setTargetId(id); setPort(t.port); if (t.id === 'apple-connectivity-80') setMode('tcp');
    setSamples([]); setSelectedSample(null);
  }
  const changeParam = (key: keyof Parameters, value: number) => {
    setSettings(s => ({ ...s, parameters: { ...s.parameters, [key]: value } })); setSamples([]); setSelectedSample(null);
  };

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-icon"><Icon name="activity" size={28} /></div><div><b>苹果网络探针</b><span>APPLE NETWORK PROBE</span></div></div>
      <div className="sidebar-label">工作空间</div><nav>{tabs.map(t => <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => { setTab(t.id); setDetail(null); setSelectedSample(null); }}><Icon name={t.icon} />{t.title}<span>›</span></button>)}</nav>
      <div className="sidebar-footer"><Icon name="shield" size={18} /><span>本地存储 · 无需登录</span><small>版本 1.0.0</small></div>
    </aside>
    <main aria-label={tabs.find(t => t.id === tab)!.title}>
      {!isNative && <div className="preview-banner"><span className="banner-icon"><Icon name="globe" size={19} /></span><div><b>你正在预览界面</b><p>这里仅预览界面。真实测速与网络识别需要在 iPhone App 内运行。</p></div><span className="preview-tag">预览模式</span></div>}
      {notice && <div className="notice" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><Icon name="close" size={17} /></button></div>}
      {pending && <Card className="save-prompt"><div><b>{pending.completion === 'complete' ? '本轮测试完成' : '本轮测试已结束'} · 是否保存？</b><p className="hint">{pending.samples.length} 个采样 · 平均 {formatMs(pending.summary.mean)} ms · 尚未加入历史记录</p></div><div className="button-row"><button className="primary small" onClick={beginNaming}>保存并命名</button><button className="secondary small" onClick={() => void safely(async () => { await saveDraft(null); setPending(null); setNotice('本轮记录未保存。'); })}>不保存</button><button className="text-button" onClick={() => void safely(() => exportRecords([pending], 'json'))}>仅导出 JSON</button></div></Card>}

      {tab === 'test' && <>
        <div className="network-strip"><div className="network-symbol"><Icon name={network.interface === 'cellular' ? 'cellular' : 'wifi'} size={24} /></div><div><span>当前网络</span><b>{isNative ? interfaceNames[network.interface] : '安装后识别'}</b></div><span className={`status-pill ${isNative && network.available ? 'good' : ''}`}><i className="dot" />{isNative ? network.available ? '网络可用' : '暂无可用路径' : '等待连接'}</span></div>
        <div className="test-layout"><div className="test-results">
          <Card className="measurement"><div className="card-heading"><span><i className={`dot ${running ? 'green pulse' : ''}`} />{running ? '正在测试' : samples.length ? '本轮测试结果' : '准备就绪'}</span><span className="protocol-chip">{mode === 'tcp' ? '原生 TCP' : 'HTTPS HEAD'}</span></div>
            <div className="big-number">{latest?.status === 'success' ? formatMs(latest.durationMs) : '—'}<span>ms</span></div><div className="measurement-label">{mode === 'tcp' ? '最近一次 TCP 建连耗时' : '最近一次 HTTPS 请求总耗时'}</div>
            <div className="target-inline"><Icon name="globe" size={14} /><span>{target.host}</span><b>:{port}</b></div>
            <div className="progress-line"><span>{running ? `第 ${progress} / ${params.count} 次 · 每次完成后间隔 ${params.interval} 秒` : latest?.error ?? '每次新建连接，真实测量'}</span><span>{samples.length} / {params.count}</span></div><div className="progress-track"><div style={{ width: `${Math.min(samples.length / params.count * 100, 100)}%` }} /></div>
            <div className="chart-heading"><b>耗时趋势</b><span><i className="dot green" />成功<i className="dot red" />失败 / 取消</span></div><SampleChart samples={samples} mode={mode} onSelect={setSelectedSample} />
            <div className="chart-caption"><span>横轴：测试序号</span><span>纵轴：毫秒 · 失败点仅显示在基线</span></div>
          </Card>
          <Card className="statistics-card"><div className="section-title"><h2>统计概览</h2><span>基于成功采样计算耗时</span></div><Stats summary={summary} /></Card>
          {selectedSample && <Card><div className="section-title"><h2>第 {selectedSample.sequence} 次采样</h2><button className="text-button" onClick={() => setSelectedSample(null)}>收起</button></div><SampleDetails sample={selectedSample} /></Card>}
        </div><div className="test-controls">
          <Card><div className="section-title"><h2>测试目标</h2><button className="text-button" disabled={running} onClick={() => setEditor({ id: crypto.randomUUID(), name: '', host: '', port: 443 })}><Icon name="plus" size={15} />添加</button></div>
            <label className="field"><span>目标服务器</span><select disabled={running} value={targetId} onChange={e => chooseTarget(e.target.value)}>{allTargets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><div className="host-label mono">{target.host}</div>
            <label className="field horizontal"><span>目标端口</span><input disabled={running} type="number" min={1} max={65535} value={Number.isNaN(port) ? '' : port} onChange={e => setPort(e.target.valueAsNumber)} /></label>
            {!target.builtin && <div className="button-row"><button className="text-button" disabled={running} onClick={() => setEditor(target)}>编辑目标</button><button className="text-button danger-text" disabled={running} onClick={() => void safely(async () => { const next = targets.filter(t => t.id !== target.id); await saveTargets(next); setTargets(next); chooseTarget(builtins[0].id); })}>删除目标</button></div>}
            <p className="hint">{target.id.startsWith('apple-connectivity') ? '官方文档列出的基础连通性验证主机，仅作线路参考。TCP 80 模式不请求网页。' : '公开网站入口，用于比较线路响应；并非实际库存或订单服务器。'}</p>
          </Card>
          <Card><div className="section-title"><h2>测试配置</h2><Icon name="settings" size={17} /></div><div className="segmented"><button disabled={running} className={mode === 'tcp' ? 'active' : ''} onClick={() => { setMode('tcp'); setSamples([]); }}>TCP 建连</button><button disabled={running || target.id === 'apple-connectivity-80'} className={mode === 'https' ? 'active' : ''} onClick={() => { setMode('https'); setSamples([]); }}>HTTPS 性能</button></div>
            <div className="config-grid">{([{ key: 'count', title: '测试次数', values: [1, 5, 10, 20, 50, 100], unit: '次' }, { key: 'interval', title: '测试间隔', values: [1, 2, 3, 5], unit: '秒' }, { key: 'timeout', title: '连接超时', values: [2, 3, 5, 10], unit: '秒' }] as const).map(item => <label className="field" key={item.key}><span>{item.title}</span><select disabled={running} value={params[item.key]} onChange={e => changeParam(item.key, Number(e.target.value))}>{item.values.map(v => <option key={v} value={v}>{v === 1 && item.key === 'count' ? '单次测试' : `${v} ${item.unit}`}</option>)}</select></label>)}
              <label className="field"><span>线路标记</span><select disabled={running} value={label} onChange={e => setLabel(e.target.value as LineLabel)}><option value="auto">自动识别</option><option value="wifi">Wi-Fi</option><option value="5g">5G（手动标记）</option></select></label></div>
            {label === '5g' && <p className="hint">路径可识别蜂窝网络，无法确认当前是否为 5G。请查看 iPhone 状态栏。</p>}
            {label !== 'auto' && isNative && network.interface !== (label === 'wifi' ? 'wifi' : 'cellular') && <p className="warning-text">线路标记与当前原生网络信息不一致，记录会保留实际网络类型。</p>}
            {!running ? <button className="primary start-button" disabled={!isNative || !ready || !!pending || !network.available} onClick={() => void run()}><Icon name="play" size={17} />{isNative ? '开始测试' : '在 iPhone App 中测试'}</button>
              : <><button className="primary start-button" onClick={() => void stop('stop')}>结束测试</button><button className="text-button cancel-button" onClick={() => void stop('discard', '用户取消本轮')}>取消本轮，不保存</button></>}
            <p className="privacy-note"><Icon name="shield" size={13} />逐次测量 · 无登录 · 无订单请求</p>
          </Card>
          <div className="reading-note"><div className="reading-icon"><Icon name="activity" size={18} /></div><div><b>看得更全面，选得更稳妥</b><p>除了平均耗时，也留意 P95、波动与连接失败率。测试结果不能预测抢购成功率。</p></div></div>
        </div></div>
        {editor && <Card className="target-editor"><div className="section-title"><h2>{targets.some(t => t.id === editor.id) ? '编辑目标' : '新增自定义目标'}</h2><button className="text-button" onClick={() => setEditor(null)}>取消</button></div><form onSubmit={e => void saveEditor(e)}><div className="editor-fields"><label className="field"><span>名称</span><input required maxLength={80} value={editor.name} placeholder="例如：我的测试服务器" onChange={e => setEditor({ ...editor, name: e.target.value })} /></label><label className="field"><span>域名或 IP</span><input required value={editor.host} placeholder="example.com 或 IPv6 地址" autoCapitalize="none" autoCorrect="off" onChange={e => setEditor({ ...editor, host: e.target.value })} /></label><label className="field"><span>端口</span><input required type="number" min={1} max={65535} value={Number.isNaN(editor.port) ? '' : editor.port} onChange={e => setEditor({ ...editor, port: e.target.valueAsNumber })} /></label></div><button className="primary small" type="submit">保存目标</button></form></Card>}
        <p className="page-footnote">TCP 建连时间可能包含 DNS 解析；连接失败率不等于 ICMP 丢包率。应用进入后台会结束当前测试。</p>
      </>}

      {tab === 'compare' && <>
        <div className="analysis-intro"><div className="comparison-icons"><span><Icon name="wifi" size={30} /></span><b>vs</b><span><Icon name="cellular" size={30} /></span></div><h2>Wi-Fi，还是蜂窝网络？</h2><p>选择相同目标与参数的两次完整测试，比较耗时与稳定性。</p></div>
        <div className="comparison-selectors">{[{ title: 'Wi-Fi 测试', records: wifiRecords, selected: wifi?.id ?? '', onChange: setWifiId, icon: 'wifi' }, { title: '蜂窝 / 手动 5G 测试', records: cellRecords, selected: cell?.id ?? '', onChange: setCellId, icon: 'cellular' }].map(item => <Card key={item.title}><div className="section-title"><h2><Icon name={item.icon} size={19} />{item.title}</h2></div><select value={item.selected} onChange={e => item.onChange(e.target.value)}><option value="">{item.records.length ? '选择完整记录' : '暂无对应记录'}</option>{item.records.map(r => <option key={r.id} value={r.id}>{time(r.startedAt)} · {r.target.host}:{r.target.port} · {r.mode.toUpperCase()}</option>)}</select></Card>)}</div>
        {wifi && cell ? comparable(wifi, cell) ? <>
          <Card><div className="section-title"><h2>线路表现</h2><span>{wifi.target.host}:{wifi.target.port} · {wifi.mode.toUpperCase()}</span></div><div className="comparison-table"><div className="comparison-row heading"><span>指标</span><b>Wi-Fi</b><b>蜂窝网络</b></div>{([['平均耗时', wifi.summary.mean, cell.summary.mean], ['P95 耗时', wifi.summary.p95, cell.summary.p95], ['最高耗时', wifi.summary.max, cell.summary.max], ['波动（标准差）', wifi.summary.stddev, cell.summary.stddev]] as const).map(([k, a, b]) => <div className="comparison-row" key={k}><span>{k}</span><b>{formatMs(a)}{a != null && ' ms'}</b><b>{formatMs(b)}{b != null && ' ms'}</b></div>)}<div className="comparison-row"><span>连接失败率</span><b>{rate(wifi.summary.failureRate)}</b><b>{rate(cell.summary.failureRate)}</b></div><div className="comparison-row"><span>成功 / 失败</span><b>{wifi.summary.success} / {wifi.summary.failed}</b><b>{cell.summary.success} / {cell.summary.failed}</b></div></div>
            <div className="comparison-bars">{[{ name: 'Wi-Fi', s: wifi.summary }, { name: '蜂窝网络', s: cell.summary }].map(item => <div key={item.name}><span>{item.name} · 平均耗时</span><div><i style={{ width: `${item.s.mean === null ? 0 : item.s.mean / Math.max(wifi.summary.mean ?? 0, cell.summary.mean ?? 0, 1) * 100}%` }} /></div><b>{formatMs(item.s.mean)} ms</b></div>)}</div>
          </Card><div className="comparison-charts"><Card><h2>Wi-Fi 耗时趋势</h2><SampleChart samples={wifi.samples} mode={wifi.mode} onSelect={setSelectedSample} /></Card><Card><h2>蜂窝网络耗时趋势</h2><SampleChart samples={cell.samples} mode={cell.mode} onSelect={setSelectedSample} /></Card></div><Card className="conclusion"><Icon name="compare" /><div><b>基于本次采样的参考</b><p>{comparisonConclusion(wifi.summary, cell.summary)}</p><p className="hint">分时测量受 CDN、DNS 缓存、信号与服务负载影响。建议在相近时间多做几组测试；结果不能预测抢购成功率。</p></div></Card>
          {selectedSample && <Card><SampleDetails sample={selectedSample} /></Card>}
        </> : <Card><Empty icon="compare" title="两次记录的测试条件不同" text="请选择域名、端口、模式、次数、间隔和超时一致的记录，减少比较偏差。" /></Card>
          : <Card><Empty icon="compare" title="等两条线路都留下真实数据" text="先用 Wi-Fi 完成一轮测试，再关闭 Wi-Fi、开启蜂窝数据，用相同参数测试。网络变化或中断的记录不会用于对比。" /><button className="secondary empty-action" onClick={() => setTab('test')}>去网络测试</button></Card>}
        <p className="page-footnote">“5G”为手动标记。对比以原生路径的 Wi-Fi / 蜂窝证据为准，不代表已检测到 5G 制式。</p>
      </>}

      {tab === 'history' && <>
        {detail ? <><div className="section-title"><button className="text-button" onClick={() => { setDetail(null); setSelectedSample(null); }}>‹ 返回历史</button><div className="button-row"><button className="secondary small" onClick={() => void safely(() => exportRecords([detail], 'csv'))}>CSV</button><button className="secondary small" onClick={() => void safely(() => exportRecords([detail], 'json'))}>JSON</button></div></div><Card><h2>{detail.name ?? detail.target.name}</h2><p className="mono">{detail.target.host}:{detail.target.port} · {detail.mode.toUpperCase()}</p><p className="hint">{time(detail.startedAt)} 至 {time(detail.endedAt)} · {detail.actualInterfaces.map(i => interfaceNames[i]).join(' / ') || '未获得路径'} · 标记：{detail.label === '5g' ? '5G（手动）' : detail.label === 'wifi' ? 'Wi-Fi' : '自动'}</p><p className="hint">{detail.parameters.count} 次 · 间隔 {detail.parameters.interval} 秒 · 超时 {detail.parameters.timeout} 秒 · {detail.completion === 'complete' ? '完整' : '部分 / 中断'}记录</p><Stats summary={detail.summary} /><SampleChart samples={detail.samples} mode={detail.mode} onSelect={setSelectedSample} /></Card><Card><h2>原始采样</h2><div className="sample-list">{detail.samples.map(s => <button key={s.sequence} onClick={() => setSelectedSample(s)}><span>#{s.sequence}</span><span>{interfaceNames[s.interface]}</span><b className={s.status === 'success' ? '' : 'danger-text'}>{s.status === 'success' ? `${formatMs(s.durationMs)} ms` : ({ failed: '失败', timeout: '超时', cancelled: '取消' })[s.status]}</b><Icon name="arrow" size={15} /></button>)}</div></Card>{selectedSample && <Card><h2>第 {selectedSample.sequence} 次详情</h2><SampleDetails sample={selectedSample} /></Card>}</>
          : <><Card><div className="section-title"><h2>本机记录 <span className="count-badge">{history.length}</span></h2><div className="button-row"><button className="text-button" onClick={() => void safely(() => exportRecords(filtered, 'csv'))}><Icon name="download" size={15} />CSV</button><button className="text-button" onClick={() => void safely(() => exportRecords(filtered, 'json'))}>JSON</button></div></div><div className="history-filters"><label className="field"><span>域名</span><input placeholder="筛选域名" value={filterHost} onChange={e => setFilterHost(e.target.value)} /></label><label className="field"><span>网络类型</span><select value={filterNetwork} onChange={e => setFilterNetwork(e.target.value)}><option value="all">全部网络</option><option value="wifi">Wi-Fi</option><option value="cellular">蜂窝网络</option><option value="other">其他</option><option value="none">无可用路径</option><option value="wired">有线网络</option></select></label><label className="field"><span>日期</span><input type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)} /></label></div></Card>
            <div className="history-sort"><span>{filtered.length} 条记录</span><div><select aria-label="排序指标" value={sortKey} onChange={e => setSortKey(e.target.value as SortKey)}><option value="mean">平均耗时</option><option value="min">最低耗时</option><option value="p95">P95 耗时</option><option value="max">最高耗时</option><option value="stddev">延迟波动</option><option value="failureRate">失败率</option><option value="date">测试时间</option></select><button className="secondary small" onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}>{sortOrder === 'asc' ? '↑ 正序' : '↓ 倒序'}</button></div></div>
            {fastest && <div className="fastest-summary"><Icon name="check" size={18} /><div><b>当前筛选中平均耗时最低</b><p>{fastest.name ?? fastest.target.name} · {formatMs(fastest.summary.mean)} ms</p></div><span>不同目标与模式的结果仅供参考</span></div>}
            {!filtered.length ? <Card><Empty icon="history" title={history.length ? '没有符合筛选条件的记录' : '还没有命名保存的测试'} text="每轮测试结束后选择保存，为记录命名后才会出现在这里。记录会直接显示延迟指标，并可按平均耗时、P95、失败率等排序。" /></Card> : <div className="history-list">{filtered.map(r => <Card key={r.id} className={r.id === fastest?.id ? 'fastest-record' : ''}><button className="history-record" onClick={() => { setDetail(r); setSelectedSample(null); }}><div className="record-icon"><Icon name={r.actualInterfaces[0] === 'cellular' ? 'cellular' : 'wifi'} /></div><div><b>{r.name ?? r.target.name}</b>{r.id === fastest?.id && <span className="fastest-badge">平均耗时最低</span>}<p>{r.target.host}:{r.target.port} · {r.mode.toUpperCase()}</p><small>{time(r.startedAt)} · {r.actualInterfaces.map(i => interfaceNames[i]).join(' / ') || '无采样'}{r.completion !== 'complete' && ' · 部分记录'}</small></div><div className="record-value"><strong>{formatMs(r.summary.mean)}</strong><small>平均 ms</small></div><Icon name="arrow" size={16} /></button><div className="record-metrics"><span>最低 <b>{formatMs(r.summary.min)} ms</b></span><span>P95 <b>{formatMs(r.summary.p95)} ms</b></span><span>最高 <b>{formatMs(r.summary.max)} ms</b></span><span>波动 <b>{formatMs(r.summary.stddev)} ms</b></span></div><div className="record-footer"><span>{r.summary.success} 次成功 · {rate(r.summary.failureRate)} 连接失败率</span><button disabled={running} className="text-button danger-text" onClick={() => void safely(async () => { setHistory(await updateHistory(records => records.filter(item => item.id !== r.id))); })}>删除</button></div></Card>)}</div>}
          </>}
      </>}

      {tab === 'settings' && <div className="settings-layout"><div><Card><div className="section-title"><h2>外观</h2><Icon name="settings" size={19} /></div><label className="field horizontal"><span>显示主题</span><select value={settings.theme} onChange={e => setSettings(s => ({ ...s, theme: e.target.value as Settings['theme'] }))}><option value="system">跟随系统</option><option value="light">浅色模式</option><option value="dark">深色模式</option></select></label></Card>
        <Card><h2>数据管理</h2><p className="hint">所有记录保存在本机，无账户或云端同步。删除应用会清除本地数据，请定期导出备份。</p><div className="settings-actions"><button onClick={() => void safely(() => exportRecords(history, 'json'))}><span><Icon name="download" size={18} />导出全部 JSON 备份</span><Icon name="arrow" size={16} /></button><button onClick={() => void safely(() => exportRecords(history, 'csv'))}><span><Icon name="download" size={18} />导出全部 CSV</span><Icon name="arrow" size={16} /></button><button disabled={running || !ready} onClick={() => fileInput.current?.click()}><span><Icon name="history" size={18} />从 JSON 恢复记录</span><Icon name="arrow" size={16} /></button><button disabled={running || !ready} className="danger-text" onClick={() => { if (window.confirm('清空所有历史记录？此操作无法撤销，请先导出备份。')) void safely(async () => { setHistory(await updateHistory(() => [])); setDetail(null); setNotice('历史记录已清空。'); }); }}><span>清空历史记录</span><Icon name="arrow" size={16} /></button></div>
          <input hidden type="file" ref={fileInput} accept=".json,application/json" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; void safely(async () => { if (file.size > 10 * 1024 * 1024) throw new Error('文件不能超过 10 MB。'); const imported = parseBackup(await file.text()); setHistory(await updateHistory(records => [...imported.filter(r => !records.some(old => old.id === r.id)), ...records])); setNotice('导入完成，重复 ID 已跳过。'); }); }} />
        </Card></div><div><Card className="about-card"><div className="brand-icon"><Icon name="activity" size={35} /></div><h2>苹果网络探针</h2><p>为开售前的线路选择，提供一份真实参考。</p><span className="protocol-chip">版本 1.0.0</span><div className="about-divider" /><div className="detail-grid"><span>TCP 测量</span><b>Network.framework</b><span>HTTPS 测量</span><b>URLSession Metrics</b><span>网络识别</span><b>NWPathMonitor</b><span>记录存储</span><b>本机持久化</b></div></Card>
          <Card><h2>公开目标说明</h2><p className="hint">本工具为独立网络诊断应用，与 Apple 无关联。未找到官方公开的 iPhone 库存或抢购测速 API。Apple Store 是购买硬件的 App；App Store Server API 面向应用内购买。</p><p className="hint">captive.apple.com 的 TCP 443 / 80 来自官方连通性文档，仅作基础网络参考。</p><a className="external-link" href="https://support.apple.com/zh-cn/101555" target="_blank" rel="noreferrer">查看 Apple 官方主机与端口说明 ↗</a></Card>
          <Card><h2>如何理解结果</h2><p className="hint">TCP 总建连耗时可能包含 DNS；HTTPS 显示可用的分项指标。统计采用最近秩百分位和总体标准差，取消采样不计入连接失败率。两条线路建议各采集至少 20 个成功样本。</p><p className="hint">应用进入后台或网络切换会中断测试。系统路径只能识别蜂窝网络，不能据此确认 5G。</p></Card>
        </div></div>}
      <footer className="desktop-footer"><span>Apple Network Probe</span><span><Icon name="shield" size={13} />测量真实连接，数据留在本机</span></footer>
    </main>
    <nav className="bottom-tabs" aria-label="主导航">{tabs.map(t => <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => { setTab(t.id); setDetail(null); setSelectedSample(null); }}><Icon name={t.icon} size={23} /><span>{t.title}</span></button>)}</nav>
    {naming && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !saving) setNaming(false); }}><section className="naming-modal" role="dialog" aria-modal="true" aria-labelledby="name-title"><div className="section-title"><h2 id="name-title">为这次测试命名</h2><button aria-label="关闭命名窗口" className="text-button" disabled={saving} onClick={() => setNaming(false)}><Icon name="close" size={19} /></button></div><p className="hint">用容易识别的名字，记录地点、线路或测试时机。</p><form onSubmit={e => void confirmSave(e)}><label className="field"><span>记录名称</span><input autoFocus required maxLength={80} placeholder="例如：家中 Wi-Fi · 开售前" value={recordName} onChange={e => setRecordName(e.target.value)} disabled={saving} /></label><div className="modal-actions"><button type="button" className="secondary" disabled={saving} onClick={() => setNaming(false)}>返回</button><button type="submit" className="primary" disabled={saving || !recordName.trim()}>{saving ? '正在保存…' : '保存记录'}</button></div></form></section></div>}
  </div>;
}
