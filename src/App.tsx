import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { PluginListenerHandle } from '@capacitor/core';
import { Card, Icon, MeasurementValue, RoundComparison, SampleChart, SampleDetails, Stats } from './components';
import { NetworkProbe, isNative } from './native';
import { actualInterfaces, formatMs, summarize, summarizeHTTPS } from './statistics';
import { builtins, defaults, interfaceNames, modeNames, type Interface, type LineLabel, type NetworkRound, type NetworkStatus, type Parameters, type ProbeMode, type RecordEntry, type Sample, type Settings, type Target, type TestScope } from './types';
import { readDraft, readHistory, readSettings, readTargets, saveDraft, saveRecord, saveSettings, saveTargets, updateHistory } from './storage';
import { parseBackup, validateTarget } from './validation';
import { executeGuidedSession } from './guided';
import { exportRecords } from './export';
import { renameHistoryRecord, sortRecords, type SortKey } from './history';
import Toast from './Toast';

type Tab = 'test' | 'history' | 'settings';
const tabs = [{ id: 'test', title: '网络测试', icon: 'activity' },
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
  const mode = 'combined' as const;
  const [phase, setPhase] = useState<ProbeMode | 'interval'>('tcp');
  const [scopeDialog, setScopeDialog] = useState(false);
  const [switchPrompt, setSwitchPrompt] = useState<'wifi' | 'cellular' | null>(null);
  const [switchError, setSwitchError] = useState('');
  const [rounds, setRounds] = useState<NetworkRound[]>([]);
  const [testingInterface, setTestingInterface] = useState<Interface>('none');
  const switchWaiter = useRef<((accepted: boolean) => void) | null>(null);
  const [label, setLabel] = useState<LineLabel>('auto');
  const [settings, setSettings] = useState<Settings>({ theme: 'system', parameters: defaults });
  const [history, setHistory] = useState<RecordEntry[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [notice, setNoticeState] = useState<{ id: number; message: string } | null>(null);
  const noticeSequence = useRef(0);
  const setNotice = useCallback((message: string) => {
    setNoticeState(message ? { id: ++noticeSequence.current, message } : null);
  }, []);
  const dismissNotice = useCallback((id: number) => {
    setNoticeState(current => current?.id === id ? null : current);
  }, []);
  const [pending, setPending] = useState<RecordEntry | null>(null);
  const [naming, setNaming] = useState(false);
  const [recordName, setRecordName] = useState('');
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<Target | null>(null);
  const [selectedSample, setSelectedSample] = useState<Sample | null>(null);
  const [detail, setDetail] = useState<RecordEntry | null>(null);
  const [renameTarget, setRenameTarget] = useState<RecordEntry | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('mean');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
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
  const httpsSummary = useMemo(() => summarizeHTTPS(samples), [samples]);
  const latest = samples.at(-1);
  const completedCount = samples.filter(s => s.https !== undefined).length;

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
          beginNaming(recovered);
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
          if (controller.current && !switchWaiter.current && !n.available) void stopRef.current('interrupted', '网络不可用');
        } }));
        await listen(NetworkProbe.addListener('interrupted', data => {
          if (alive && !switchWaiter.current) { setNotice(data.reason); void stopRef.current('interrupted', data.reason); }
        }));
        const n = await NetworkProbe.getNetworkStatus();
        if (alive) setNetwork(n);
      } catch (error) { if (alive) { setReady(false); setNotice(`原生插件未就绪：${message(error)}`); } }
    }
    void init();
    const onVisibility = () => { if (document.visibilityState === 'hidden' && controller.current && !switchWaiter.current)
      void stopRef.current('interrupted', '应用进入后台'); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { alive = false; listeners.forEach(h => { void h.remove(); }); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    if (ready) void saveSettings(settings).catch(error => setNotice(`设置未保存：${message(error)}`));
  }, [settings, ready]);

  async function requestStart() {
    if (isNative) {
      try { setNetwork(await NetworkProbe.getNetworkStatus()); }
      catch (error) { setNotice(message(error)); return; }
    }
    setScopeDialog(true);
  }
  function waitForSwitch(expected: 'wifi' | 'cellular'): Promise<boolean> {
    return new Promise(resolve => {
      const signal = controller.current?.signal;
      const finish = (accepted: boolean) => {
        signal?.removeEventListener('abort', cancel);
        switchWaiter.current = null; setSwitchPrompt(null); resolve(accepted);
      };
      const cancel = () => finish(false);
      if (signal?.aborted) { resolve(false); return; }
      switchWaiter.current = finish; setSwitchError(''); setSwitchPrompt(expected);
      signal?.addEventListener('abort', cancel, {once: true});
    });
  }
  async function continueOnNetwork() {
    if (!switchPrompt || !switchWaiter.current) return;
    try {
      const actual = await NetworkProbe.getNetworkStatus(); setNetwork(actual);
      if (!actual.available || actual.interface !== switchPrompt) {
        setSwitchError(`当前仍是${interfaceNames[actual.interface]}，请切换到${interfaceNames[switchPrompt]}后继续。`); return;
      }
      switchWaiter.current?.(true);
    } catch (error) { setSwitchError(message(error)); }
  }
  async function run(scope: TestScope) {
    if (!isNative || !ready || runLock.current || pending) return;
    if (history.length >= 2000) { setNotice('历史已满，请先导出并清理。'); return; }
    runLock.current = true;
    const abort = new AbortController(); controller.current = abort; stopType.current = 'stop';
    setScopeDialog(false); setRunning(true); setSamples([]); setRounds([]); setProgress(0); setSelectedSample(null); setNotice('');
    let record: RecordEntry = {
      id: crypto.randomUUID(), startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      target: { ...target, port }, mode, scope, rounds: [], parameters: { ...params }, label: scope === 'both' ? 'auto' : label,
      actualInterfaces: [], samples: [], summary: summarize([]), completion: 'interrupted',
    };
    try {
      record.target = validateTarget(record.target);
      await saveDraft(record);
      await executeGuidedSession({ target: record.target, scope, parameters: record.parameters, signal: abort.signal,
        readNetwork: () => NetworkProbe.getNetworkStatus(), changeNetwork: waitForSwitch,
        onRoundStart: kind => { setTestingInterface(kind); setSamples([]); setProgress(0); },
        probe: (kind, t, timeout) => NetworkProbe[kind]({ host: t.host, port: t.port, timeout }),
        onProgress: setProgress, onPhase: setPhase,
        onRounds: async entries => {
          const values = entries.flatMap(r => r.samples).map((s, index) => ({...s, sequence: index + 1}));
          record = { ...record, rounds: entries, samples: values, endedAt: new Date().toISOString(), summary: summarize(values), httpsSummary: summarizeHTTPS(values), actualInterfaces: actualInterfaces(values) };
          setRounds(entries); setSamples(entries.at(-1)?.samples ?? []);
          await saveDraft(record);
        },
      });
      record.endedAt = new Date().toISOString();
      if (currentStopType() === 'discard') { await saveDraft(null); setSamples([]); setRounds([]); setNotice('本轮测试已取消，未保存历史记录。'); }
      else {
        record.completion = !abort.signal.aborted && record.rounds?.length === (scope === 'both' ? 2 : 1) && record.rounds.every(r => r.completion === 'complete') ? 'complete'
          : currentStopType() === 'interrupted' ? 'interrupted' : 'stopped';
        setPending(record); await saveDraft(record); beginNaming(record);
      }
    } catch (error) {
      abort.abort();
      try { await NetworkProbe.cancel({ reason: '测试异常，关闭连接' }); } catch { /* Original error remains visible. */ }
      record.endedAt = new Date().toISOString(); setPending(record);
      setNotice(`测试或检查点保存失败：${message(error)}。已有采样可命名保存或导出。`);
      beginNaming(record);
    } finally { controller.current = null; runLock.current = false; setRunning(false); }
  }

  async function safely(action: () => Promise<void>) {
    try { await action(); } catch (error) { setNotice(message(error)); }
  }
  function beginNaming(record = pending) {
    if (!record) return;
    const line = record.actualInterfaces.map(i => interfaceNames[i]).join(' / ') || '网络测试';
    setRecordName(`${line} · ${new Date(record.startedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}`);
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
  const sortedHistory = sortRecords(history, sortKey, sortOrder);
  function openRename(record: RecordEntry) {
    setRenameTarget(record); setRenameName(record.name ?? record.target.name); setRenameError('');
  }
  async function confirmRename(event: FormEvent) {
    event.preventDefault(); if (!renameTarget || renameSaving) return;
    setRenameSaving(true); setRenameError('');
    try {
      const records = await updateHistory(current => renameHistoryRecord(current, renameTarget.id, renameName));
      setHistory(records);
      setDetail(current => current?.id === renameTarget.id ? records.find(r => r.id === current.id) ?? null : current);
      setRenameTarget(null); setNotice('记录名称已修改。');
    } catch (error) { setRenameError(message(error)); }
    finally { setRenameSaving(false); }
  }
  function chooseTarget(id: string) {
    const t = allTargets.find(t => t.id === id)!;
    setTargetId(id); setPort(t.port);
    setSamples([]); setSelectedSample(null);
  }
  const changeParam = (key: keyof Parameters, value: number) => {
    setSettings(s => ({ ...s, parameters: { ...s.parameters, [key]: value } })); setSamples([]); setSelectedSample(null);
  };

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-icon"><Icon name="activity" size={28} /></div><div><b>苹果网络探针</b><span>APPLE NETWORK PROBE</span></div></div>
      <div className="sidebar-label">工作空间</div><nav>{tabs.map(t => <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => { setTab(t.id); setDetail(null); setSelectedSample(null); }}><Icon name={t.icon} />{t.title}<span>›</span></button>)}</nav>
      <div className="sidebar-footer"><Icon name="shield" size={18} /><span>本地存储 · 无需登录</span><small>版本 2.0</small></div>
    </aside>
    <main aria-label={tabs.find(t => t.id === tab)!.title}>
      {!isNative && <div className="preview-banner"><span className="banner-icon"><Icon name="globe" size={19} /></span><div><b>你正在预览界面</b><p>这里仅预览界面。真实测速与网络识别需要在 iPhone App 内运行。</p></div><span className="preview-tag">预览模式</span></div>}

      {tab === 'test' && <>
        <div className="network-strip"><div className="network-symbol"><Icon name={network.interface === 'cellular' ? 'cellular' : 'wifi'} size={24} /></div><div><span>当前网络</span><b>{isNative ? interfaceNames[network.interface] : '安装后识别'}</b></div><span className={`status-pill ${isNative && network.available ? 'good' : ''}`}><i className="dot" />{isNative ? network.available ? '网络可用' : '暂无可用路径' : '等待连接'}</span></div>
        <div className="test-action-bar"><div><b>TCP + HTTPS 双项测试</b><span title={running ? `${interfaceNames[testingInterface]} · 第 ${progress} 次 · ${phase === 'interval' ? '等待下一次' : `正在测量 ${phase.toUpperCase()}`}` : ''}>{running ? `${interfaceNames[testingInterface]} · 第 ${progress} 次 · ${phase === 'interval' ? '等待下一次' : `正在测量 ${phase.toUpperCase()}`}` : `${params.count} 次采样 · 每次依次测量两项`}</span></div>{pending ? <button className="primary" onClick={() => beginNaming()}>命名保存</button> : running ? <button className="primary" onClick={() => void stop('stop')}>结束测试</button> : <button className="primary" disabled={!ready || (isNative && !network.available)} onClick={() => void requestStart()}><Icon name="play" size={17} />开始测试</button>}<button className="text-button danger-text cancel-action" disabled={!running} style={{ visibility: running ? 'visible' : 'hidden' }} onClick={() => void stop('discard', '用户取消本轮')}>取消本轮</button></div>
        <div className="test-layout"><div className="test-results">
          <Card className="measurement"><div className="card-heading"><span><i className={`dot ${running ? 'green pulse' : ''}`} />{running ? '正在测试' : samples.length ? '本轮测试结果' : '准备就绪'}</span><span className="protocol-chip">TCP + HTTPS</span></div>
            <div className="dual-readings"><MeasurementValue value={latest?.status === 'success' ? latest.durationMs : null} label="TCP 建连耗时" status={latest ? ({success:'成功',failed:'失败',timeout:'超时',cancelled:'取消'})[latest.status] : '等待测试'} /><MeasurementValue value={latest?.https?.status === 'success' ? latest.https.durationMs : null} label="HTTPS 请求总耗时" status={latest?.https ? ({success:'成功',failed:'失败',timeout:'超时',cancelled:'取消'})[latest.https.status] : running && phase === 'https' ? '测量中' : '等待测试'} /></div>
            <div className="target-inline"><Icon name="globe" size={14} /><span>{target.host}</span><b>:{port}</b></div>
            <div className="progress-line"><span title={latest?.error}>{running ? `第 ${progress} / ${params.count} 次 · ${phase === 'interval' ? '间隔等待' : `正在测量 ${phase.toUpperCase()}`}` : latest?.error ?? '每次新建连接，分别测量两项'}</span><span>{completedCount} / {params.count}</span></div><div className="progress-track"><div style={{ width: `${Math.min(completedCount / params.count * 100, 100)}%` }} /></div>
            <div className="chart-heading"><b>耗时趋势</b><span><i className="dot" style={{background:'var(--accent)'}} />TCP<i className="dot green" />HTTPS<i className="dot red" />失败</span></div><SampleChart samples={samples} mode={mode} onSelect={setSelectedSample} />
            <div className="chart-caption"><span>横轴：测试序号</span><span>纵轴：毫秒 · 失败点仅显示在基线</span></div>
          </Card>
          <Card className="statistics-card"><div className="section-title"><h2>TCP 统计</h2><span>基于 TCP 成功采样</span></div><Stats summary={summary} /></Card>
          <Card className="statistics-card"><div className="section-title"><h2>HTTPS 统计</h2><span>基于 HTTPS 成功采样</span></div><Stats summary={httpsSummary} /></Card>
          {selectedSample && <Card><div className="section-title"><h2>第 {selectedSample.sequence} 次采样</h2><button className="text-button" onClick={() => setSelectedSample(null)}>收起</button></div><SampleDetails sample={selectedSample} /></Card>}
        </div><div className="test-controls">
          <Card><div className="section-title"><h2>测试目标</h2><button className="text-button" disabled={running} onClick={() => setEditor({ id: crypto.randomUUID(), name: '', host: '', port: 443 })}><Icon name="plus" size={15} />添加</button></div>
            <label className="field"><span>目标服务器</span><select disabled={running} value={targetId} onChange={e => chooseTarget(e.target.value)}>{allTargets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><div className="host-label mono">{target.host}</div>
            <label className="field horizontal"><span>目标端口</span><input disabled={running} type="number" min={1} max={65535} value={Number.isNaN(port) ? '' : port} onChange={e => setPort(e.target.valueAsNumber)} /></label>
            {!target.builtin && <div className="button-row"><button className="text-button" disabled={running} onClick={() => setEditor(target)}>编辑目标</button><button className="text-button danger-text" disabled={running} onClick={() => void safely(async () => { const next = targets.filter(t => t.id !== target.id); await saveTargets(next); setTargets(next); chooseTarget(builtins[0].id); })}>删除目标</button></div>}
            <p className="hint">{target.id.startsWith('apple-connectivity') ? '官方文档列出的基础连通性验证主机，仅作线路参考。80 端口通常不支持 HTTPS。' : '公开网站入口，用于比较线路响应；并非实际库存或订单服务器。'}</p>
          </Card>
          <Card><div className="section-title"><h2>测试配置</h2><Icon name="settings" size={17} /></div><p className="combined-description">每次先测 TCP 建连，再测 HTTPS 性能，无需选择模式。两项分别记录耗时、错误和统计。</p>
            <div className="config-grid">{([{ key: 'count', title: '测试次数', values: [1, 5, 10, 20, 50, 100], unit: '次' }, { key: 'interval', title: '测试间隔', values: [1, 2, 3, 5], unit: '秒' }, { key: 'timeout', title: '连接超时', values: [2, 3, 5, 10], unit: '秒' }] as const).map(item => <label className="field" key={item.key}><span>{item.title}</span><select disabled={running} value={params[item.key]} onChange={e => changeParam(item.key, Number(e.target.value))}>{item.values.map(v => <option key={v} value={v}>{v === 1 && item.key === 'count' ? '单次测试' : `${v} ${item.unit}`}</option>)}</select></label>)}
              <label className="field"><span>线路标记</span><select disabled={running} value={label} onChange={e => setLabel(e.target.value as LineLabel)}><option value="auto">自动识别</option><option value="wifi">Wi-Fi</option><option value="5g">5G（手动标记）</option></select></label></div>
            {label === '5g' && <p className="hint">路径可识别蜂窝网络，无法确认当前是否为 5G。请查看 iPhone 状态栏。</p>}
            {label !== 'auto' && isNative && network.interface !== (label === 'wifi' ? 'wifi' : 'cellular') && <p className="warning-text">线路标记与当前原生网络信息不一致，记录会保留实际网络类型。</p>}
            <p className="hint">超时对每一项分别生效，两项都使用所选端口；80 端口通常不支持 HTTPS，会保留实际连接错误。</p>
            <p className="privacy-note"><Icon name="shield" size={13} />逐次测量 · 无登录 · 无订单请求</p>
          </Card>
          <div className="reading-note"><div className="reading-icon"><Icon name="activity" size={18} /></div><div><b>看得更全面，选得更稳妥</b><p>除了平均耗时，也留意 P95、波动与连接失败率。测试结果不能预测抢购成功率。</p></div></div>
        </div></div>
        {!running && rounds.length > 1 && <RoundComparison rounds={rounds} />}
        {editor && <Card className="target-editor"><div className="section-title"><h2>{targets.some(t => t.id === editor.id) ? '编辑目标' : '新增自定义目标'}</h2><button className="text-button" onClick={() => setEditor(null)}>取消</button></div><form onSubmit={e => void saveEditor(e)}><div className="editor-fields"><label className="field"><span>名称</span><input required maxLength={80} value={editor.name} placeholder="例如：我的测试服务器" onChange={e => setEditor({ ...editor, name: e.target.value })} /></label><label className="field"><span>域名或 IP</span><input required value={editor.host} placeholder="example.com 或 IPv6 地址" autoCapitalize="none" autoCorrect="off" onChange={e => setEditor({ ...editor, host: e.target.value })} /></label><label className="field"><span>端口</span><input required type="number" min={1} max={65535} value={Number.isNaN(editor.port) ? '' : editor.port} onChange={e => setEditor({ ...editor, port: e.target.valueAsNumber })} /></label></div><button className="primary small" type="submit">保存目标</button></form></Card>}
        <p className="page-footnote">TCP 建连时间可能包含 DNS 解析；连接失败率不等于 ICMP 丢包率。测量中退后台会中断；手动切换等待阶段会保留结果。</p>
      </>}

      {tab === 'history' && <>
        {detail ? <><div className="section-title"><button className="text-button" onClick={() => { setDetail(null); setSelectedSample(null); }}>‹ 返回历史</button><div className="button-row"><button className="secondary small" disabled={running} onClick={() => openRename(detail)}>修改名称</button><button className="secondary small" onClick={() => void safely(() => exportRecords([detail], 'csv'))}>CSV</button><button className="secondary small" onClick={() => void safely(() => exportRecords([detail], 'json'))}>JSON</button></div></div><Card><h2>{detail.name ?? detail.target.name}</h2><p className="mono">{detail.target.host}:{detail.target.port} · {modeNames[detail.mode]}</p><p className="hint">{time(detail.startedAt)} 至 {time(detail.endedAt)} · {detail.actualInterfaces.map(i => interfaceNames[i]).join(' / ') || '未获得路径'} · 标记：{detail.label === '5g' ? '5G（手动）' : detail.label === 'wifi' ? 'Wi-Fi' : '自动'}</p><p className="hint">{detail.parameters.count} 次 · 间隔 {detail.parameters.interval} 秒 · 超时 {detail.parameters.timeout} 秒 · {detail.completion === 'complete' ? '完整' : '部分 / 中断'}记录</p><h3 className={detail.mode === 'combined' ? 'metrics-subtitle' : 'sr-only'}>TCP 统计</h3>{detail.rounds && detail.rounds.length > 1 && <RoundComparison rounds={detail.rounds} />}<Stats summary={detail.summary} />{detail.httpsSummary && <><h3 className='metrics-subtitle'>HTTPS 统计</h3><Stats summary={detail.httpsSummary} /></>}<SampleChart samples={detail.samples} mode={detail.mode} onSelect={setSelectedSample} /></Card><Card><h2>原始采样</h2><div className="sample-list">{detail.samples.map(s => <button key={s.sequence} onClick={() => setSelectedSample(s)}><span>#{s.sequence}</span><span>{interfaceNames[s.interface]}</span><b className={s.status === 'success' ? '' : 'danger-text'}>{s.status === 'success' ? `${formatMs(s.durationMs)} ms` : ({ failed: '失败', timeout: '超时', cancelled: '取消' })[s.status]}</b><Icon name="arrow" size={15} /></button>)}</div></Card>{selectedSample && <Card><h2>第 {selectedSample.sequence} 次详情</h2><SampleDetails sample={selectedSample} /></Card>}</>
          : <>
            <div className="history-sort"><span>{sortedHistory.length} 条记录</span><div><select aria-label="排序指标" value={sortKey} onChange={e => setSortKey(e.target.value as SortKey)}><option value="mean">平均耗时</option><option value="min">最低耗时</option><option value="p95">P95 耗时</option><option value="max">最高耗时</option><option value="stddev">延迟波动</option><option value="failureRate">失败率</option><option value="date">测试时间</option></select><button className="secondary small" onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}>{sortOrder === 'asc' ? '↑ 正序' : '↓ 倒序'}</button></div></div>
            {!sortedHistory.length ? <div className="history-empty-line">暂无保存的记录</div> : <div className="history-list">{sortedHistory.map(r => <details className="history-entry" key={r.id}>
              <summary><span title={r.name ?? r.target.name}>{r.name ?? r.target.name}</span><Icon name="arrow" size={18} /></summary>
              <div className="history-entry-content">
                <p className="mono">{r.target.host}:{r.target.port} · {modeNames[r.mode]}</p>
                <p className="hint">{time(r.startedAt)} · {r.actualInterfaces.map(i => interfaceNames[i]).join(' / ') || '无采样'}{r.completion !== 'complete' && ' · 部分记录'}</p>
                {r.rounds && r.rounds.length > 1 && <RoundComparison rounds={r.rounds} compact />}
                <div className="record-metrics"><span>TCP 平均<b>{formatMs(r.summary.mean)} ms</b></span><span>TCP P95<b>{formatMs(r.summary.p95)} ms</b></span><span>TCP 最高<b>{formatMs(r.summary.max)} ms</b></span><span>TCP 波动<b>{formatMs(r.summary.stddev)} ms</b></span>{r.httpsSummary && <><span>HTTPS 平均<b>{formatMs(r.httpsSummary.mean)} ms</b></span><span>HTTPS P95<b>{formatMs(r.httpsSummary.p95)} ms</b></span><span>HTTPS 失败率<b>{rate(r.httpsSummary.failureRate)}</b></span></>}</div>
                <div className="record-footer"><span>{r.summary.success} 次成功 · {rate(r.summary.failureRate)} TCP 失败率</span></div>
                <div className="button-row"><button className="text-button" onClick={() => {setDetail(r); setSelectedSample(null);}}>查看采样详情</button><button disabled={running} className="text-button" onClick={() => openRename(r)}>修改名称</button><button disabled={running} className="text-button danger-text" onClick={() => void safely(async () => {setHistory(await updateHistory(records => records.filter(item => item.id !== r.id)));})}>删除记录</button></div>
              </div>
            </details>)}</div>}
          </>}
      </>}

      {tab === 'settings' && <div className="settings-layout"><div><Card><div className="section-title"><h2>外观</h2><Icon name="settings" size={19} /></div><label className="field horizontal"><span>显示主题</span><select value={settings.theme} onChange={e => setSettings(s => ({ ...s, theme: e.target.value as Settings['theme'] }))}><option value="system">跟随系统</option><option value="light">浅色模式</option><option value="dark">深色模式</option></select></label></Card>
        <Card><h2>数据管理</h2><p className="hint">所有记录保存在本机，无账户或云端同步。删除应用会清除本地数据，请定期导出备份。</p><div className="settings-actions"><button onClick={() => void safely(() => exportRecords(history, 'json'))}><span><Icon name="download" size={18} />导出全部 JSON 备份</span><Icon name="arrow" size={16} /></button><button onClick={() => void safely(() => exportRecords(history, 'csv'))}><span><Icon name="download" size={18} />导出全部 CSV</span><Icon name="arrow" size={16} /></button><button disabled={running || !ready} onClick={() => fileInput.current?.click()}><span><Icon name="history" size={18} />从 JSON 恢复记录</span><Icon name="arrow" size={16} /></button><button disabled={running || !ready} className="danger-text" onClick={() => { if (window.confirm('清空所有历史记录？此操作无法撤销，请先导出备份。')) void safely(async () => { setHistory(await updateHistory(() => [])); setDetail(null); setNotice('历史记录已清空。'); }); }}><span>清空历史记录</span><Icon name="arrow" size={16} /></button></div>
          <input hidden type="file" ref={fileInput} accept=".json,application/json" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; void safely(async () => { if (file.size > 10 * 1024 * 1024) throw new Error('文件不能超过 10 MB。'); const imported = parseBackup(await file.text()); setHistory(await updateHistory(records => [...imported.filter(r => !records.some(old => old.id === r.id)), ...records])); setNotice('导入完成，重复 ID 已跳过。'); }); }} />
        </Card></div><div><Card className="about-card"><div className="brand-icon"><Icon name="activity" size={35} /></div><h2>苹果网络探针</h2><p>为开售前的线路选择，提供一份真实参考。</p><span className="protocol-chip">版本 2.0</span><div className="about-divider" /><div className="detail-grid"><span>TCP 测量</span><b>Network.framework</b><span>HTTPS 测量</span><b>URLSession Metrics</b><span>网络识别</span><b>NWPathMonitor</b><span>记录存储</span><b>本机持久化</b></div></Card>
          <Card><h2>公开目标说明</h2><p className="hint">本工具为独立网络诊断应用，与 Apple 无关联。未找到官方公开的 iPhone 库存或抢购测速 API。Apple Store 是购买硬件的 App；App Store Server API 面向应用内购买。</p><p className="hint">captive.apple.com 的 TCP 443 / 80 来自官方连通性文档，仅作基础网络参考。</p><a className="external-link" href="https://support.apple.com/zh-cn/101555" target="_blank" rel="noreferrer">查看 Apple 官方主机与端口说明 ↗</a></Card>
          <Card><h2>如何理解结果</h2><p className="hint">TCP 总建连耗时可能包含 DNS；HTTPS 显示可用的分项指标。统计采用最近秩百分位和总体标准差，取消采样不计入连接失败率。两条线路建议各采集至少 20 个成功样本。</p><p className="hint">测量中进入后台或网络切换会中断；手动切换等待阶段保留第一轮。系统路径只能识别蜂窝网络，不能据此确认 5G。</p></Card>
        </div></div>}
      <footer className="desktop-footer"><span>Apple Network Probe</span><span><Icon name="shield" size={13} />测量真实连接，数据留在本机</span></footer>
    </main>
    <nav className="bottom-tabs" aria-label="主导航">{tabs.map(t => <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => { setTab(t.id); setDetail(null); setSelectedSample(null); }}><Icon name={t.icon} size={23} /><span>{t.title}</span></button>)}</nav>
    {notice && <Toast key={notice.id} id={notice.id} message={notice.message} onDismiss={dismissNotice} />}
    {renameTarget && <div className="modal-backdrop"><section className="naming-modal" role="dialog" aria-modal="true" aria-labelledby="rename-title">
      <div className="section-title"><h2 id="rename-title">修改记录名称</h2><button className="text-button" aria-label="关闭改名窗口" disabled={renameSaving} onClick={() => setRenameTarget(null)}><Icon name="close" size={19} /></button></div>
      <form onSubmit={e => void confirmRename(e)}><label className="field"><span>记录名称</span><input autoFocus required maxLength={80} value={renameName} onChange={e => setRenameName(e.target.value)} disabled={renameSaving} /></label>
        {renameError && <p className="modal-error" role="alert">{renameError}</p>}
        <div className="modal-actions"><button className="secondary" type="button" disabled={renameSaving} onClick={() => setRenameTarget(null)}>取消</button><button className="primary" type="submit" disabled={renameSaving || !renameName.trim()}>{renameSaving ? '保存中…' : '保存名称'}</button></div>
      </form>
    </section></div>}
    {scopeDialog && <div className="modal-backdrop"><section className="naming-modal" role="dialog" aria-modal="true" aria-labelledby="scope-title">
      <div className="section-title"><h2 id="scope-title">选择测试范围</h2><button className="text-button" aria-label="关闭选择窗口" onClick={() => setScopeDialog(false)}><Icon name="close" size={19} /></button></div>
      <p className="hint">{isNative ? `当前是${interfaceNames[network.interface]}。${network.interface === 'wifi' ? '是否也测一下蜂窝网络？' : network.interface === 'cellular' ? '是否也测一下 Wi-Fi？' : '双线路测试需要 Wi-Fi 或蜂窝路径。'}` : '浏览器可预览流程；真实测试请在 iPhone App 内执行。'}</p>
      <div className="scope-options"><button disabled={!isNative || !network.available} onClick={() => void run('current')}><b>只测试当前网络环境</b><span>完成一轮 TCP + HTTPS 测量后命名保存</span></button>
        <button disabled={!isNative || !network.available || !['wifi','cellular'].includes(network.interface)} onClick={() => void run('both')}><b>移动网络跟 Wi-Fi 一起测试</b><span>先测当前线路，手动切换后继续测另一条，合并保存</span></button></div>
    </section></div>}
    {switchPrompt && <div className="modal-backdrop"><section className="naming-modal" role="dialog" aria-modal="true" aria-labelledby="switch-title">
      <h2 id="switch-title">当前线路已测完，切换后继续</h2><p className="hint">{switchPrompt === 'cellular' ? '请手动关闭 Wi-Fi，确认已开启蜂窝数据，再回到这里点击“继续”。' : '请手动打开 Wi-Fi 并连接目标网络，再回到这里点击“继续”。'}</p>
      <p className="hint">切换期间不会发起测试请求，第一轮结果已保留。</p>{switchError && <p className="modal-error" role="alert">{switchError}</p>}
      <div className="modal-actions"><button className="secondary" onClick={() => switchWaiter.current?.(false)}>结束并保存已测线路</button><button className="primary" onClick={() => void continueOnNetwork()}>继续</button></div>
    </section></div>}
    {naming && pending && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !saving) setNaming(false); }}>
      <section className="naming-modal" role="dialog" aria-modal="true" aria-labelledby="name-title">
        <div className="section-title"><h2 id="name-title">{pending.completion === 'complete' ? '测试完成，保存记录' : '测试已结束，保存记录'}</h2><button aria-label="稍后处理" className="text-button" disabled={saving} onClick={() => setNaming(false)}><Icon name="close" size={19} /></button></div>
        <p className="hint">为本轮测试取个名字，确认保存后加入历史记录。</p>
        <div className="save-result-summary"><span>TCP 平均<b>{formatMs(pending.summary.mean)} ms</b></span><span>HTTPS 平均<b>{formatMs(pending.httpsSummary?.mean)} ms</b></span></div>
        <form onSubmit={e => void confirmSave(e)}><label className="field"><span>记录名称</span><input autoFocus required maxLength={80} placeholder="例如：家中 Wi-Fi · 开售前" value={recordName} onChange={e => setRecordName(e.target.value)} disabled={saving} /></label>
          <div className="modal-actions"><button type="button" className="secondary" disabled={saving} onClick={() => void safely(async () => { await saveDraft(null); setPending(null); setNaming(false); setNotice('本轮记录未保存。'); })}>不保存</button><button type="submit" className="primary" disabled={saving || !recordName.trim()}>{saving ? '正在保存…' : '命名并保存'}</button></div>
        </form>
        <button className="text-button modal-export" disabled={saving} onClick={() => void safely(() => exportRecords([pending], 'json'))}>导出本轮 JSON</button>
      </section>
    </div>}
  </div>;
}
