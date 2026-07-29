import type { AnalysisObjective, AnalysisTask, FieldInput, FieldSummary, PlanetAccessStatus } from "@chernozem/contracts";
import { ArrowClockwiseIcon as ArrowClockwise } from "@phosphor-icons/react/dist/icons/ArrowClockwise";
import { ArchiveIcon as Archive } from "@phosphor-icons/react/dist/icons/Archive";
import { CaretLeftIcon as CaretLeft } from "@phosphor-icons/react/dist/icons/CaretLeft";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/dist/icons/CaretRight";
import { ChartLineUpIcon as ChartLineUp } from "@phosphor-icons/react/dist/icons/ChartLineUp";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/icons/CheckCircle";
import { CrosshairIcon as Crosshair } from "@phosphor-icons/react/dist/icons/Crosshair";
import { DownloadSimpleIcon as DownloadSimple } from "@phosphor-icons/react/dist/icons/DownloadSimple";
import { FarmIcon as Farm } from "@phosphor-icons/react/dist/icons/Farm";
import { GearSixIcon as GearSix } from "@phosphor-icons/react/dist/icons/GearSix";
import { LeafIcon as Leaf } from "@phosphor-icons/react/dist/icons/Leaf";
import { ListChecksIcon as ListChecks } from "@phosphor-icons/react/dist/icons/ListChecks";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/dist/icons/MagnifyingGlass";
import { MapPinIcon as MapPin } from "@phosphor-icons/react/dist/icons/MapPin";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import { PencilSimpleIcon as PencilSimple } from "@phosphor-icons/react/dist/icons/PencilSimple";
import { SparkleIcon as Sparkle } from "@phosphor-icons/react/dist/icons/Sparkle";
import { SquaresFourIcon as SquaresFour } from "@phosphor-icons/react/dist/icons/SquaresFour";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/dist/icons/WarningCircle";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { archiveField, createField, createTask, fetchFields, fetchPlanetAccessStatus, fetchTask, importFields, updateField } from "./api.js";
import { MapCanvas } from "./MapCanvas.js";

const objectives: Array<{ value: AnalysisObjective; label: string }> = [
  { value: "current_condition", label: "当前长势" },
  { value: "recent_change", label: "近期变化" },
  { value: "within_field", label: "田内差异" },
  { value: "season_trend", label: "本季趋势" },
];

export default function App() {
  const [fields, setFields] = useState<FieldSummary[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [objective, setObjective] = useState<AnalysisObjective>("recent_change");
  const [period, setPeriod] = useState<"last_30_days" | "this_season">("last_30_days");
  const [task, setTask] = useState<AnalysisTask | null>(null);
  const [planetStatus, setPlanetStatus] = useState<PlanetAccessStatus | null>(null);
  const [loadingPlanetStatus, setLoadingPlanetStatus] = useState(true);
  const [loadingFields, setLoadingFields] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [locateSignal, setLocateSignal] = useState(0);
  const [fieldPanelOpen, setFieldPanelOpen] = useState(true);
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  const [leftPanelMode, setLeftPanelMode] = useState<"fields" | "analysis">("fields");
  const [fieldEditorOpen, setFieldEditorOpen] = useState(false);
  const [editingField, setEditingField] = useState<FieldSummary | null>(null);
  const [draftBoundary, setDraftBoundary] = useState<FieldSummary["boundary"] | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchFields().then((items) => {
      setFields(items);
      setSelectedFieldId(null);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "农田列表加载失败。"))
      .finally(() => setLoadingFields(false));
  }, []);

  useEffect(() => {
    fetchPlanetAccessStatus()
      .then(setPlanetStatus)
      .catch((reason: unknown) => {
        setPlanetStatus({
          configured: false,
          reachable: false,
          planetScopeAvailable: false,
          itemTypes: [],
          message: reason instanceof Error ? reason.message : "Planet 数据连接状态加载失败。",
        });
      })
      .finally(() => setLoadingPlanetStatus(false));
  }, []);

  useEffect(() => {
    if (!task || task.status !== "running") return;
    const timer = window.setInterval(() => {
      fetchTask(task.id).then(setTask).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "分析进度加载失败。");
        window.clearInterval(timer);
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [task?.id, task?.status]);

  const selectedField = fields.find((field) => field.id === selectedFieldId) ?? null;
  const filteredFields = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return keyword ? fields.filter((field) => `${field.name}${field.code}${field.village}`.toLowerCase().includes(keyword)) : fields;
  }, [fields, query]);

  const selectField = useCallback((fieldId: string) => {
    if (fieldId === selectedFieldId) {
      setSelectedFieldId(null);
      setTask(null);
      setDetailPanelOpen(false);
      return;
    }
    setSelectedFieldId(fieldId);
    setTask(null);
    setError(null);
    setDetailPanelOpen(true);
  }, [selectedFieldId]);

  const startAnalysis = async () => {
    if (!selectedField) return;
    setError(null);
    try {
      setTask(await createTask({ fieldId: selectedField.id, crop: selectedField.crop, period, objective }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "分析任务创建失败。");
    }
  };

  const openFieldEditor = (field: FieldSummary | null = null) => { setEditingField(field); setDraftBoundary(field?.boundary ?? null); setFieldEditorOpen(true); setDetailPanelOpen(true); setError(null); };
  const saveField = async (input: FieldInput) => {
    const field = editingField ? await updateField(editingField.id, input) : await createField(input);
    setFields((current) => editingField ? current.map((item) => item.id === field.id ? field : item) : [...current, field]);
    setSelectedFieldId(field.id);
    setFieldEditorOpen(false);
    setEditingField(null);
    setDraftBoundary(null);
  };
  const archiveSelectedField = async () => {
    if (!selectedField || !window.confirm(`归档“${selectedField.name}”吗？历史分析记录会保留。`)) return;
    try {
      await archiveField(selectedField.id);
      setFields((current) => current.filter((field) => field.id !== selectedField.id));
      setSelectedFieldId(null);
      setTask(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "地块归档失败。"); }
  };
  const importGeoJson = async (file: File) => {
    try {
      const imported = await importFields(file);
      setFields((current) => [...current, ...imported]);
      setSelectedFieldId(imported[0]?.id ?? null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "GeoJSON 导入失败。"); }
  };

  return (
    <div className="agri-shell">
      <nav className="nav-rail">
        <div className="nav-brand"><span><Leaf size={22} weight="fill" /></span><div><strong>黑土智管</strong><small>遥感农情平台</small></div></div>
        <div className="nav-menu">
          <button><SquaresFour size={20} /><span>工作总览</span></button>
          <button className={leftPanelMode === "fields" ? "is-active" : ""} onClick={() => { setLeftPanelMode("fields"); setFieldPanelOpen(true); }}><Farm size={20} weight="fill" /><span>地块管理</span></button>
          <button className={leftPanelMode === "analysis" ? "is-active" : ""} onClick={() => { setLeftPanelMode("analysis"); setFieldPanelOpen(true); }}><ChartLineUp size={20} /><span>农情分析</span></button>
          <button><ListChecks size={20} /><span>分析记录</span></button>
        </div>
        <div className="nav-bottom"><button><GearSix size={20} /><span>设置</span></button><div className="account-mark">辽</div><span className="account-name">铁岭示范账户</span></div>
      </nav>

      <main className="map-workspace">
        <MapCanvas fields={fields} selectedFieldId={selectedFieldId} findings={task?.findings ?? []} locateSignal={locateSignal} onSelectField={selectField} onLocationError={setError} drawing={fieldEditorOpen} draftBoundary={draftBoundary} onBoundaryDrawn={setDraftBoundary} />

        <aside className={`field-drawer ${fieldPanelOpen ? "is-open" : ""}`}>
          <div className="drawer-head"><div><h1>{leftPanelMode === "fields" ? "地块管理" : "农情分析"}</h1><span>{leftPanelMode === "fields" ? `${fields.length} 块农田` : selectedField?.name ?? "选择地块"}</span></div><button className="plain-icon" title={leftPanelMode === "fields" ? "收起地块列表" : "返回地块列表"} onClick={() => leftPanelMode === "fields" ? setFieldPanelOpen(false) : setLeftPanelMode("fields")}>{leftPanelMode === "fields" ? <CaretLeft size={19} /> : <CaretLeft size={19} />}</button></div>
          {leftPanelMode === "fields" ? <>
          <div className="field-tools"><label><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索地块名称或村庄" /></label><div className="field-tabs"><button className="is-active">全部</button><button>玉米</button><button>其他</button></div></div>
          <div className="field-list-new">
            {loadingFields ? <FieldSkeleton /> : null}
            {!loadingFields && filteredFields.length === 0 ? <div className="empty-state">没有找到匹配地块</div> : null}
            {filteredFields.map((field) => <button key={field.id} className={`field-card ${field.id === selectedFieldId ? "is-selected" : ""}`} onClick={() => selectField(field.id)}>
              <div><strong>{field.name}</strong><StatusDot status={field.latestStatus} /></div><p>{field.village}</p><footer><span>{field.areaHa} 公顷</span><span>{cropName(field.crop)} · {field.seasonYear}</span></footer>
            </button>)}
          </div>
          <div className="field-actions"><button className="drawer-primary" onClick={() => openFieldEditor()}><Plus size={18} />新增地块</button><button className="import-button" onClick={() => importInputRef.current?.click()}>导入 GeoJSON</button><input ref={importInputRef} type="file" accept="application/geo+json,application/json,.geojson" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importGeoJson(file); event.currentTarget.value = ""; }} /></div>
          </> : <LeftAnalysisPanel field={selectedField} task={task} objective={objective} period={period} planetStatus={planetStatus} loadingPlanetStatus={loadingPlanetStatus} onObjectiveChange={setObjective} onPeriodChange={setPeriod} onStart={startAnalysis} onNewAnalysis={() => setTask(null)} />}
        </aside>
        {!fieldPanelOpen ? <button className="drawer-toggle left" title="展开地块列表" onClick={() => setFieldPanelOpen(true)}><CaretRight size={18} /></button> : null}

        <div className="map-topbar">
          <span className={`data-badge ${planetStatus?.planetScopeAvailable ? "is-connected" : "is-pending"}`}>
            {loadingPlanetStatus ? "正在检查 Planet" : planetStatus?.planetScopeAvailable ? "PlanetScope 已连接" : "PlanetScope 未就绪"}
          </span>
          {selectedField ? <button onClick={() => setDetailPanelOpen(true)}><MapPin size={16} weight="fill" /><strong>{selectedField.name}</strong><span>{selectedField.areaHa} 公顷</span></button> : null}
        </div>
        <div className="map-controls"><button title="回到所选地块" onClick={() => selectedFieldId && selectField(selectedFieldId)}><ArrowClockwise size={19} /></button><button title="定位当前位置" onClick={() => setLocateSignal((value) => value + 1)}><Crosshair size={19} /></button></div>
        {fields.length > 0 ? <div className="map-legend-new"><span><i className="field-key" />地块边界</span>{task?.status === "completed" ? <span><i className="watch-key" />近期下降区</span> : null}</div> : null}

        <aside className={`analysis-drawer ${detailPanelOpen ? "is-open" : ""}`}>
          <div className="drawer-head"><div><span className="section-kicker">地块详情</span><h2>{selectedField?.name ?? "选择地块"}</h2></div><button className="plain-icon" title="关闭地块详情" onClick={() => setDetailPanelOpen(false)}><X size={19} /></button></div>
          {error ? <div className="error-banner"><WarningCircle size={18} weight="fill" /><span>{error}</span><button onClick={() => setError(null)}>关闭</button></div> : null}
          {fieldEditorOpen ? <FieldEditor field={editingField} boundary={draftBoundary} onCancel={() => { setFieldEditorOpen(false); setEditingField(null); setDraftBoundary(null); }} onSave={saveField} /> : null}
          {!fieldEditorOpen && !selectedField ? <NoFieldSelected /> : null}
          {!fieldEditorOpen && selectedField ? <FieldDetails field={selectedField} planetStatus={planetStatus} loadingPlanetStatus={loadingPlanetStatus} onEdit={() => openFieldEditor(selectedField)} onArchive={() => void archiveSelectedField()} /> : null}
        </aside>
      </main>
    </div>
  );
}

function FieldEditor({ field, boundary, onCancel, onSave }: { field: FieldSummary | null; boundary: FieldSummary["boundary"] | null; onCancel: () => void; onSave: (input: FieldInput) => Promise<void> }) {
  const [name, setName] = useState(field?.name ?? ""); const [crop, setCrop] = useState<FieldInput["crop"]>(field?.crop ?? "corn"); const [seasonYear, setSeasonYear] = useState(field?.seasonYear ?? new Date().getFullYear()); const [plantingDate, setPlantingDate] = useState(field?.plantingDate ?? ""); const [variety, setVariety] = useState(field?.variety ?? ""); const [saving, setSaving] = useState(false); const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setName(field?.name ?? ""); setCrop(field?.crop ?? "corn"); setSeasonYear(field?.seasonYear ?? new Date().getFullYear()); setPlantingDate(field?.plantingDate ?? ""); setVariety(field?.variety ?? ""); setMessage(null); }, [field]);
  const submit = async () => { if (!boundary) return setMessage("请先在地图上绘制地块边界。"); setSaving(true); setMessage(null); try { await onSave({ name, crop, seasonYear, plantingDate: plantingDate || null, variety: variety || null, boundary }); } catch (reason) { setMessage(reason instanceof Error ? reason.message : "地块保存失败。"); } finally { setSaving(false); } };
  return <div className="panel-scroll-new field-editor"><div className="editor-hint"><strong>{field ? "编辑地块边界" : "在地图上绘制地块"}</strong><span>单击落点，双击结束；选中边界后可拖动顶点，右上角垃圾桶可删除。</span></div><section className="form-section-new"><label>地块名称</label><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：北田 01" /></section><section className="form-section-new"><label>作物</label><select value={crop} onChange={(event) => setCrop(event.target.value as FieldInput["crop"])}><option value="corn">玉米</option><option value="soybean">大豆</option><option value="rice">水稻</option></select></section><section className="form-section-new"><label>种植季年份</label><input type="number" value={seasonYear} min="2000" max="2100" onChange={(event) => setSeasonYear(Number(event.target.value))} /></section><section className="form-section-new optional-fields"><label>播种日期和品种（可选）</label><input type="date" value={plantingDate} onChange={(event) => setPlantingDate(event.target.value)} /><input value={variety} onChange={(event) => setVariety(event.target.value)} placeholder="品种" /></section>{message ? <p className="field-error">{message}</p> : null}<div className="drawer-footer split"><button className="secondary-button" onClick={onCancel}>取消</button><button className="drawer-primary" disabled={saving || !boundary || !name.trim()} onClick={() => void submit()}>{saving ? "正在保存" : field ? "保存修改" : "保存地块"}</button></div></div>;
}

function LeftAnalysisPanel({ field, task, objective, period, planetStatus, loadingPlanetStatus, onObjectiveChange, onPeriodChange, onStart, onNewAnalysis }: { field: FieldSummary | null; task: AnalysisTask | null; objective: AnalysisObjective; period: "last_30_days" | "this_season"; planetStatus: PlanetAccessStatus | null; loadingPlanetStatus: boolean; onObjectiveChange: (value: AnalysisObjective) => void; onPeriodChange: (value: "last_30_days" | "this_season") => void; onStart: () => void; onNewAnalysis: () => void }) {
  if (!field) return <NoFieldSelected />;
  if (!task) return <TaskComposer field={field} objective={objective} period={period} planetStatus={planetStatus} loadingPlanetStatus={loadingPlanetStatus} onObjectiveChange={onObjectiveChange} onPeriodChange={onPeriodChange} onStart={onStart} />;
  if (task.status === "running") return <TaskProgress field={field} task={task} />;
  return <TaskResult field={field} task={task} onNewAnalysis={onNewAnalysis} />;
}

function FieldDetails({ field, planetStatus, loadingPlanetStatus, onEdit, onArchive }: { field: FieldSummary; planetStatus: PlanetAccessStatus | null; loadingPlanetStatus: boolean; onEdit: () => void; onArchive: () => void }) {
  return <div className="panel-scroll-new field-details"><section className="detail-hero"><span className="detail-eyebrow">基本信息</span><div><strong>{field.name}</strong><span>{cropName(field.crop)} · {field.seasonYear} 种植季</span></div><p>{field.plantingDate ? `播种日期：${field.plantingDate}` : "未记录播种日期"}</p></section><section className="detail-metrics"><div><span>地块面积</span><strong>{field.areaHa.toFixed(2)} 公顷</strong></div><div><span>边界状态</span><strong>已保存</strong></div><div><span>品种</span><strong>{field.variety ?? "未记录"}</strong></div></section><PlanetSourcePanel status={planetStatus} loading={loadingPlanetStatus} /><section className="detail-management"><span>地块管理</span><div className="detail-actions"><button className="detail-edit" onClick={onEdit}><PencilSimple size={17} />编辑地块</button><button className="detail-archive" title="归档地块" onClick={onArchive}><Archive size={17} /></button></div></section></div>;
}

function TaskComposer({ field, objective, period, planetStatus, loadingPlanetStatus, onObjectiveChange, onPeriodChange, onStart }: { field: FieldSummary; objective: AnalysisObjective; period: "last_30_days" | "this_season"; planetStatus: PlanetAccessStatus | null; loadingPlanetStatus: boolean; onObjectiveChange: (value: AnalysisObjective) => void; onPeriodChange: (value: "last_30_days" | "this_season") => void; onStart: () => void }) {
  const supported = field.crop === "corn";
  return <div className="panel-scroll-new">
    <div className="field-summary"><div><span>地块编号</span><strong>{field.code}</strong></div><div><span>种植作物</span><strong>{cropName(field.crop)}</strong></div><div><span>地块面积</span><strong>{field.areaHa} 公顷</strong></div></div>
    <PlanetSourcePanel status={planetStatus} loading={loadingPlanetStatus} />
    <section className="form-section-new"><label htmlFor="period">分析时间</label><select id="period" value={period} onChange={(event) => onPeriodChange(event.target.value as typeof period)}><option value="last_30_days">最近 30 天</option><option value="this_season">本种植季</option></select></section>
    <section className="form-section-new"><label>分析目标</label><div className="objective-grid">{objectives.map((item) => <button key={item.value} className={item.value === objective ? "is-active" : ""} onClick={() => onObjectiveChange(item.value)}>{item.label}<i /></button>)}</div></section>
    {!supported ? <p className="field-error">首版专项分析目前仅支持玉米。</p> : null}
    <div className="analysis-note"><Sparkle size={17} weight="fill" /><p><strong>智能体将规划分析步骤</strong><span>当前以 PlanetScope 光学影像为目标数据源；云量影响可用影像时将明确返回数据缺口。</span></p></div>
    <div className="drawer-footer"><button className="drawer-primary" disabled={!supported} onClick={onStart}><Sparkle size={18} weight="fill" />开始分析</button></div>
  </div>;
}

function PlanetSourcePanel({ status, loading }: { status: PlanetAccessStatus | null; loading: boolean }) {
  const ready = status?.planetScopeAvailable === true;
  return <section className={`planet-source ${ready ? "is-ready" : "is-unavailable"}`} aria-live="polite">
    <div><span>数据连接</span><strong>{loading ? "正在验证 Planet" : ready ? "PlanetScope PSScene" : "PlanetScope 未就绪"}</strong></div>
    <i aria-hidden="true" />
    <p>{loading ? "正在检查目录与数据权限。" : status?.message ?? "尚未获得 Planet 数据连接状态。"}</p>
    {ready ? <small>接入已授权地块后，将检索影像并执行质量检查与指数计算。</small> : null}
  </section>;
}

function TaskProgress({ field, task }: { field: FieldSummary; task: AnalysisTask }) { return <div className="panel-scroll-new"><div className="progress-block"><div className="progress-orbit"><Leaf size={27} weight="fill" /></div><strong>{field.name}正在分析</strong><p>{task.stage}</p><span>{task.progress}%</span><div className="progress-track"><i style={{ transform: `scaleX(${task.progress / 100})` }} /></div></div><div className="step-list">{["确认地块与种植季", "检查可用影像", "分析田内变化", "组织农情结论"].map((step, index) => { const done = task.progress >= ([10,35,65,90][index] ?? 100); return <div key={step} className={done ? "is-done" : ""}><CheckCircle size={19} weight={done ? "fill" : "regular"} /><span>{step}</span></div>; })}</div></div>; }

function TaskResult({ field, task, onNewAnalysis }: { field: FieldSummary; task: AnalysisTask; onNewAnalysis: () => void }) { return <div className="panel-scroll-new result-scroll"><div className="result-summary"><span>本次结论</span><p>{task.summary}</p>{task.demoData ? <small className="demo-result-note">这是工作台演示结果，尚未请求该地块的 PlanetScope 影像。</small> : null}</div><section className="result-section"><h3>关键发现</h3>{task.findings.map((finding) => <article key={finding.id} className={finding.severity === "watch" ? "is-watch" : ""}><div><i />{finding.severity === "watch" ? "需要关注" : "整体稳定"}</div><strong>{finding.title}</strong><p>{finding.summary}</p><small>依据：{finding.evidenceDates.join("、")}</small></article>)}</section><section className="result-section evidence-section"><h3>{task.demoData ? "演示依据" : "分析依据"}</h3>{task.evidence.map((item) => <div key={`${item.source}-${item.observedAt}`}><span><strong>{item.source}</strong><small>{item.note}</small></span><time>{item.observedAt}</time></div>)}</section><div className="drawer-footer split"><button className="secondary-button" onClick={onNewAnalysis}><ArrowClockwise size={17} />重新分析</button><button className="drawer-primary" disabled title="报告导出将在真实分析链路接入后启用"><DownloadSimple size={18} />导出报告</button></div></div>; }

function StatusDot({ status }: { status: FieldSummary["latestStatus"] }) { const label = status === "watch" ? "需关注" : status === "normal" ? "稳定" : "未分析"; return <span className={`status-dot status-${status}`}><i />{label}</span>; }
function FieldSkeleton() { return <div className="skeleton-list" aria-label="正在加载农田">{[0,1,2].map((item) => <div key={item} className="skeleton-row" />)}</div>; }
function NoFieldSelected() { return <div className="empty-panel"><MapPin size={30} /><strong>暂无已授权地块</strong><span>接入或绘制地块边界后，可在这里发起农情分析</span></div>; }
function cropName(crop: FieldSummary["crop"]): string { return crop === "corn" ? "玉米" : crop === "soybean" ? "大豆" : "水稻"; }
