import type {
  AnalysisObjective,
  AnalysisTask,
  ConversationFieldContext,
  ConversationFieldContextFocus,
  DataAcquisitionRun,
  DataSource,
  FieldSummary,
  SourceAcquisitionResult,
  TaskStatus,
} from "@chernozem/contracts";

import type { DataAcquisitionService } from "./data-acquisition.js";
import { DATA_SOURCE_LABELS } from "./data-profiles.js";
import type { AnalysisTaskStore } from "./task-store.js";

const CROP_LABELS: Record<FieldSummary["crop"], string> = { corn: "玉米", soybean: "大豆", rice: "水稻" };
const OBJECTIVE_LABELS: Record<AnalysisObjective, string> = {
  growth_stage_monitoring: "长势巡检",
  water_nitrogen_diagnosis: "水氮排查",
  waterlogging_detection: "积水识别",
  frost_risk_warning: "霜冻预警",
};
const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  planned: "等待运行",
  running: "运行中",
  needs_input: "等待补充资料",
  needs_data: "等待观测数据",
  needs_review: "等待专业复核",
  partial: "受限完成",
  completed: "已完成",
  failed: "未完成",
  cancelled: "已取消",
};
const SOURCE_STATUS_LABELS: Record<SourceAcquisitionResult["status"], string> = {
  succeeded: "可用",
  partial: "部分可用",
  needs_input: "等待资料",
  failed: "获取失败",
};
const SOURCE_ORDER = Object.keys(DATA_SOURCE_LABELS) as DataSource[];

export class FieldContextService {
  constructor(
    private readonly tasks: Pick<AnalysisTaskStore, "list">,
    private readonly acquisitions: Pick<DataAcquisitionService, "list">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(input: { field: FieldSummary; focus: ConversationFieldContextFocus }): Promise<ConversationFieldContext> {
    const [tasks, allRuns] = await Promise.all([
      this.tasks.list(input.field.id, 10),
      this.acquisitions.list(input.field.id, 50),
    ]);
    const runs = allRuns.filter((run) => run.boundaryVersion === input.field.boundaryVersion);
    const recentTasks = tasks.slice(0, 3).map(publicTask);
    const data = summarizeData(runs);
    const missingInputs = [
      ...(!input.field.plantingDate ? ["播种日期"] : []),
      ...(!data.sources.length ? ["当前边界的数据采集记录"] : []),
    ];
    const result: ConversationFieldContext = {
      tool: "get_field_context",
      status: "found",
      fieldId: input.field.id,
      requestedFocus: input.focus,
      checkedAt: this.now().toISOString(),
      field: {
        name: input.field.name,
        crop: input.field.crop,
        seasonYear: input.field.seasonYear,
        plantingDate: input.field.plantingDate,
        variety: input.field.variety,
        areaHa: input.field.areaHa,
        boundaryVersion: input.field.boundaryVersion,
      },
      data,
      recentTasks,
      missingInputs,
      message: "",
    };
    result.message = focusedMessage(result);
    return result;
  }
}

function summarizeData(runs: DataAcquisitionRun[]): ConversationFieldContext["data"] {
  const sourceResults = new Map<DataSource, SourceAcquisitionResult[]>();
  for (const run of runs) for (const result of run.sources) {
    sourceResults.set(result.source, [...(sourceResults.get(result.source) ?? []), result]);
  }
  const sources = SOURCE_ORDER.flatMap((source) => {
    const candidates = sourceResults.get(source);
    if (!candidates?.length) return [];
    const usable = candidates.filter(hasRegisteredData);
    const representative = usable[0] ?? candidates[0]!;
    const dates = unique((usable.length ? usable : [representative]).flatMap((result) => [
      ...result.selectedObservationDates,
      ...result.availableDates,
    ])).sort();
    const assets = new Set(usable.flatMap((result) => result.selectedAssets)
      .filter((asset) => asset.accessStatus === "retrieved")
      .map((asset) => asset.id));
    return [{
      source,
      status: representative.status,
      latestAvailableDate: dates.at(-1) ?? null,
      availableDateCount: dates.length,
      retrievedAssetCount: assets.size,
      limitations: representative.limitations,
    }];
  });
  return {
    currentBoundaryRunCount: runs.length,
    latestRunStatus: runs[0]?.status ?? null,
    latestRunAt: runs[0]?.createdAt ?? null,
    sources,
  };
}

function hasRegisteredData(result: SourceAcquisitionResult): boolean {
  return result.status === "succeeded" || result.status === "partial"
    || result.selectedAssets.some((asset) => asset.accessStatus === "retrieved");
}

function publicTask(task: AnalysisTask): ConversationFieldContext["recentTasks"][number] {
  return {
    id: task.id,
    objective: task.objective,
    status: task.status,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    summary: task.summary,
  };
}

function focusedMessage(context: ConversationFieldContext): string {
  if (context.requestedFocus === "profile") return profileMessage(context);
  if (context.requestedFocus === "data") return dataMessage(context);
  if (context.requestedFocus === "recent_tasks") return taskMessage(context);
  return [profileMessage(context), dataMessage(context), taskMessage(context)].join(" ");
}

function profileMessage(context: ConversationFieldContext): string {
  const field = context.field;
  const planting = field.plantingDate ? `${dateLabel(field.plantingDate)}播种` : "尚未记录播种日期";
  const variety = field.variety ? `，品种为${field.variety}` : "";
  return `${field.name}为 ${field.seasonYear} 种植季${CROP_LABELS[field.crop]}地，面积 ${field.areaHa.toFixed(2)} 公顷，${planting}${variety}。`;
}

function dataMessage(context: ConversationFieldContext): string {
  if (!context.data.sources.length) {
    if (context.data.latestRunStatus === "running") return "当前边界的数据采集正在运行，暂未登记可用来源。";
    return "当前边界还没有数据采集记录。";
  }
  const items = context.data.sources.map((source) => {
    const date = source.latestAvailableDate ? `，最近 ${dateLabel(source.latestAvailableDate)}` : "";
    return `${DATA_SOURCE_LABELS[source.source]}（${SOURCE_STATUS_LABELS[source.status]}${date}）`;
  });
  return `当前边界已登记 ${items.length} 类数据：${items.join("、")}。`;
}

function taskMessage(context: ConversationFieldContext): string {
  if (!context.recentTasks.length) return "这块农田还没有分析任务。";
  const items = context.recentTasks.map((task) => `${OBJECTIVE_LABELS[task.objective]}（${TASK_STATUS_LABELS[task.status]}，${dateLabel(task.createdAt)}创建）`);
  return `最近 ${items.length} 项任务：${items.join("；")}。`;
}

function dateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${Number(match[2])}月${Number(match[3])}日` : value;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
