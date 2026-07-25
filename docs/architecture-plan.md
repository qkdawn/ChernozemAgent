# 黑土智管技术与版本方案

> 状态：架构基线草案
> 适用阶段：原型开发至首批付费验证
> 产品主线：农田 -> 分析目标 -> 数据与工具 -> 证据 -> 解释 -> 报告 -> 复用
> Pi 基线：`@mariozechner/pi-agent-core` / `@mariozechner/pi-ai` 0.73.1（2026-07-25 核验）

## 1. 决策摘要

首期采用 **Pi Agent 驱动的模块化单体 + 隔离的遥感工具执行器**，围绕“玉米农情监测与巡田辅助”完成一条纵向链路。`@mariozechner/pi-agent-core` 负责有状态 Agent 循环、工具调用、事件流和上下文管理；业务状态、证据、授权和报告仍由项目领域层控制。技术方案优先保障任务可执行、证据可追溯、结果可复查和试点可交付，不提前建设微服务、数据湖、Kubernetes、复杂实时流处理或通用农业 SaaS。

Pi 是 Agent 运行时，不是业务数据库、工作流数据库、权限系统或遥感计算引擎。系统不把可靠性寄托在 system prompt 上，也不直接把 Pi Coding Agent 的 `bash`、`write`、`edit` 等通用编码工具暴露给农情任务。

建议技术基线：

| 领域 | 首选方案 | 选择理由 |
|---|---|---|
| Web 前端 | React + TypeScript + Vite + MapLibre GL JS | 与 Pi 事件类型共享 schema，适合地图工作台 |
| API 与领域服务 | Node.js 22 + TypeScript + Fastify + TypeBox | 直接嵌入 Pi SDK，HTTP 与工具 schema 复用 TypeBox |
| Agent 运行时 | `@mariozechner/pi-agent-core` 0.73.1（精确锁版） | 提供 Agent、事件流、工具执行、steering 和上下文转换 |
| 模型适配 | `@mariozechner/pi-ai` 0.73.1（与 core 同版本） | 统一模型和供应商接口，避免业务层绑定单一厂商 |
| 业务编排 | 领域状态机 + Pi Agent + 受控工具注册表 | Pi 推进对话与工具循环，领域状态机决定合法状态和发布门 |
| 遥感执行 | Python 3.12 工具包，通过版本化 JSON 协议调用 | 保留成熟地理空间生态，与 Agent 进程隔离 |
| 后台任务 | 首版 Node worker；需要可靠排队后引入 BullMQ + Redis | 先降低复杂度，再按执行时长和并发证据升级 |
| 业务与空间数据库 | PostgreSQL 16 + PostGIS | 统一管理地块、授权、任务、证据索引和空间查询 |
| 大文件与产物 | S3 兼容对象存储，开发期使用 MinIO | 影像、缩略图、报告和中间产物不进入数据库 |
| 遥感处理 | Rasterio、GDAL、GeoPandas、Shapely、xarray/rioxarray | 成熟的 Python 地理空间工具链 |
| Node 数据访问 | Drizzle ORM + drizzle-kit | 类型清晰，迁移和 SQL 都可审查 |
| Python 工具数据访问 | 禁止直接访问业务库 | 工具通过输入快照和产物协议工作，降低跨层耦合 |
| 报告 | HTML 模板 -> PDF；结构化 JSON 同步保存 | 人可阅读交付与机器可复用结果并存 |
| 部署 | Docker Compose 单机部署 | 满足原型和 3-5 个试点，维护成本低 |
| 可观测性 | Pi 事件订阅 + 结构化日志 + OpenTelemetry + 基础指标 | 从 run ID 串联 turn、message、tool、产物和错误 |

## 2. 版本路线

版本按“可验证的能力”划分，不按页面数量或代码量划分。后续版本只有在上一版本质量门通过后进入。

### V0.1：端到端纵向切片

**目标**：一项真实或经过授权的样例地块任务可以生成清晰、可复查和可重复的遥感分析报告。

范围：

- 导入 GeoJSON 地块并记录授权；为每个地块建立当前种植季，由用户选择作物，支持多选地块批量设置后再单独修改；
- 创建玉米农情监测任务，明确地块、时段和结果口径；
- 建立 Pi `Agent` 工厂、农情 system prompt、上下文转换和事件持久化；
- 仅注册项目自有的只读数据工具与结果组织工具，不加载 Pi Coding Agent 内置文件和 shell 工具；
- 接入 Sentinel-2 光学遥感和一个公开气象数据源；
- 执行质量检查、地块级聚合和简单历史对比；
- 输出当前农情、历史变化、田内异常区域、分析依据和报告；
- 保存任务步骤、工具调用、参数、产物和失败原因；
- Web 端展示地图、任务状态、地块结果和报告。

质量门：

- 1 个多地块任务从创建到报告完成；
- 同一输入和数据版本可重放，核心结果一致；
- Pi 的 turn、message 和 tool events 能完整关联到业务任务与 agent run；
- 每个田块结果均能定位到证据、工具调用和质量状态；
- 每个参与分析的地块均关联一个明确的当前种植季和作物；同一地块跨年份更换作物时保留历史种植季，不覆盖旧记录；
- V0.1 仅对玉米启用专项分析规则；其他作物可以保存，但创建专项分析任务时明确显示尚未支持，不套用玉米阈值；
- 地块授权、organization scope、工具 allowlist 和任务状态在每次工具调用前完成校验；
- 缺测、无覆盖、云污染和工具失败不会被显示为正常零值；
- 用户报告不包含通用免责声明；只有实际影响结论的数据问题才在对应结论旁说明。

### V0.2：多源证据与专业复核

**目标**：从单一分析结果升级为可解释的多源证据包。

范围：

- 接入 Sentinel-1 或等价雷达来源；
- 扩展 `beforeToolCall` 的调用预算、并发和幂等检查；
- 使用 `afterToolCall` 归一化工具详情、登记产物、计算质量门并记录审计事件；
- 完善 `transformContext` 的长任务裁剪策略和 `convertToLlm` 的多源消息过滤；
- 扩展 observation 与 quality flag 模型以支持多源对齐；
- 支持光学、雷达、气象证据的时间与空间对齐；
- 引入证据强度、冲突和缺口表达，不使用不可解释总分；
- 增加 `needs_review`，并完善多源证据不足时的 `needs_input` 规则；
- 专家可查看证据、修改解释、记录修订理由并发布报告；
- 建立回归样本、错误分类和工具契约测试。

质量门：

- 所有多源对比都记录时间窗口、分辨率、覆盖率和对齐方法；
- 冲突证据不会被强行合并成确定结论；
- 专家修订前后版本可追踪；
- 报告中的观测、推断、待核查事项和专业建议可区分。

### V0.3：试点闭环

**目标**：支持 3-5 个示范点连续使用，验证采用率与交付成本。

范围：

- 组织、用户、角色和地块授权隔离；
- Agent run 恢复、取消、重试和上下文压缩；
- 用户补充输入通过业务命令映射为 Pi steering，后续请求使用 follow-up 队列并全部审计；
- 历史任务、批量地块和任务模板；
- 现场巡田清单、移动端适配和反馈录入；
- 任务、专家修订、现场反馈和报告之间形成闭环；
- 生成试点台账和产品指标；
- 对外报告使用脱敏地块编号；
- 建立备份、恢复和数据保留策略。

质量门：

- 不同组织之间无法访问对方地块、任务或产物；
- 任务完成率达到内部试点门槛，失败类型可统计；
- 每次现场反馈可以回链到原任务、地块和判断；
- 能统计结果采用率、专家修订率、交付耗时与单次成本。

### V1.0：首批付费交付

**目标**：形成可计价、可支持、可审计的稳定服务。

范围：

- 专业账号、专题报告与企业交付包；
- 服务额度、任务成本和人工审核工时记录；
- 稳定的失败恢复、任务重试与通知机制；
- 数据来源、工具版本、模型版本和报告版本审计；
- Pi、模型、system prompt、工具 schema 和上下文策略版本审计；
- 运营后台、试点转付费记录和服务支持流程；
- 部署、升级、监控、备份恢复和应急手册。

质量门：

- 任务、报告、订单和回款事实严格分离，业务状态可审计；
- 核心任务具备明确 SLO，并通过连续试点数据验证；
- 备份恢复演练成功；
- 对外承诺与系统实际能力一致。

### V1.x 以后再评估

只有付费、复购和任务复用证据成立后，才评估县域部署、相邻产区、多作物、灾害专题、复杂客户管理或微服务拆分。

## 3. 总体架构

<div style="width:1200px;box-sizing:border-box;position:relative;background:#f5f9f5;padding:20px;border-radius:8px;border:1px solid #c3d9c3;"><style scoped>.arch-wrapper{display:flex;gap:12px}.arch-sidebar{width:160px;flex-shrink:0}.arch-main{flex:1;min-width:0}.arch-title{text-align:center;font-size:22px;font-weight:bold;color:#14532d;margin-bottom:16px}.arch-layer{margin:8px 0;padding:14px;border-radius:8px;box-shadow:0 2px 8px rgba(22,101,52,.06)}.arch-layer-title{font-size:13px;font-weight:bold;margin-bottom:10px;text-align:center}.arch-grid{display:grid;gap:8px}.arch-grid-3{grid-template-columns:repeat(3,1fr)}.arch-grid-4{grid-template-columns:repeat(4,1fr)}.arch-box{border-radius:5px;padding:8px;text-align:center;font-size:11px;font-weight:600;line-height:1.35;color:#14532d;background:rgba(255,255,255,.9);border:1px solid rgba(34,197,94,.15)}.arch-box.highlight{background:linear-gradient(135deg,#dcfce7 0%,#bbf7d0 100%);border:2px solid #16a34a}.arch-box.tech{font-size:10px;color:#166534;background:rgba(240,253,244,.8)}.arch-layer.external{background:#e8f0e8;border:2px dashed #a3c0a3}.arch-layer.user{background:#dcfce7;border:2px solid #22c55e}.arch-layer.application{background:#d1fae5;border:2px solid #059669}.arch-layer.ai{background:#ccfbf1;border:2px solid #14b8a6}.arch-layer.data{background:#fef3c7;border:2px solid #ca8a04}.arch-layer.infra{background:#e2e8f0;border:2px solid #64748b}.arch-sidebar-panel{border-radius:8px;padding:10px;background:#e8f0e8;border:2px solid #86b086;margin-bottom:8px}.arch-sidebar-title{font-size:12px;font-weight:bold;text-align:center;color:#14532d;margin-bottom:6px}.arch-sidebar-item{font-size:10px;text-align:center;color:#166534;background:#fff;padding:5px;border-radius:4px;margin:3px 0}</style><div class="arch-title">基于 Pi Agent 的黑土智管总体架构</div><div class="arch-wrapper"><div class="arch-sidebar"><div class="arch-sidebar-panel"><div class="arch-sidebar-title">Pi 运行观测</div><div class="arch-sidebar-item">agent / turn 事件</div><div class="arch-sidebar-item">message 流</div><div class="arch-sidebar-item">tool 执行与成本</div><div class="arch-sidebar-item">错误与终止</div></div><div class="arch-sidebar-panel"><div class="arch-sidebar-title">产品评测</div><div class="arch-sidebar-item">任务完成率</div><div class="arch-sidebar-item">专家修订率</div><div class="arch-sidebar-item">结果采用率</div><div class="arch-sidebar-item">交付成本</div></div></div><div class="arch-main"><div class="arch-layer user"><div class="arch-layer-title">用户与交付层</div><div class="arch-grid arch-grid-4"><div class="arch-box">Web 地图工作台</div><div class="arch-box">移动巡田视图</div><div class="arch-box">专家复核台</div><div class="arch-box">报告与导出</div></div></div><div class="arch-layer application"><div class="arch-layer-title">TypeScript 应用与领域层</div><div class="arch-grid arch-grid-4"><div class="arch-box">Fastify API</div><div class="arch-box">任务状态机</div><div class="arch-box">证据与报告</div><div class="arch-box">授权与反馈</div></div></div><div class="arch-layer ai"><div class="arch-layer-title">Pi Agent 运行时与领域工具</div><div class="arch-grid arch-grid-3"><div class="arch-box highlight">Pi Agent Core<br><small>Agent + events + context</small></div><div class="arch-box">Tool Governance<br><small>TypeBox + hooks + allowlist</small></div><div class="arch-box">Python Geo Runner<br><small>检索、质检、对齐、聚合</small></div></div></div><div class="arch-layer data"><div class="arch-layer-title">数据层</div><div class="arch-grid arch-grid-4"><div class="arch-box tech">PostgreSQL/PostGIS<br><small>业务、run、消息与证据</small></div><div class="arch-box tech">S3/MinIO<br><small>栅格、缩略图、报告</small></div><div class="arch-box tech">Redis（按需）<br><small>队列、锁和短期缓存</small></div><div class="arch-box tech">数据目录<br><small>来源、版本、质量与许可</small></div></div></div><div class="arch-layer infra"><div class="arch-layer-title">运行与基础设施层</div><div class="arch-grid arch-grid-3"><div class="arch-box tech">Node API / Agent Worker</div><div class="arch-box tech">Python Tool Worker</div><div class="arch-box tech">Docker Compose / Backup</div></div></div><div class="arch-layer external"><div class="arch-layer-title">模型与外部数据</div><div class="arch-grid arch-grid-4"><div class="arch-box tech">Pi AI Providers</div><div class="arch-box tech">光学与雷达</div><div class="arch-box tech">气象数据</div><div class="arch-box tech">地形与土壤</div></div></div></div><div class="arch-sidebar"><div class="arch-sidebar-panel"><div class="arch-sidebar-title">Pi 治理门</div><div class="arch-sidebar-item">beforeToolCall</div><div class="arch-sidebar-item">afterToolCall</div><div class="arch-sidebar-item">convertToLlm</div><div class="arch-sidebar-item">transformContext</div></div><div class="arch-sidebar-panel"><div class="arch-sidebar-title">安全责任</div><div class="arch-sidebar-item">组织与地块授权</div><div class="arch-sidebar-item">无通用 shell 工具</div><div class="arch-sidebar-item">高风险专业复核</div><div class="arch-sidebar-item">审计与脱敏</div></div></div></div></div>

## 4. 模块划分

建议仓库采用单仓库结构，先建立清晰领域边界，不把每个目录部署成独立服务。

```text
ChernozemAgent/
├─ apps/
│  ├─ api/                 # Fastify HTTP/SSE 入口、认证和请求编排
│  ├─ agent-worker/        # Pi Agent 会话运行与事件持久化
│  ├─ geo-worker/          # Python 遥感与空间计算入口
│  └─ web/                 # React 地图工作台与专家复核界面
├─ packages/
│  ├─ domain/              # 任务、地块、证据、复核、报告与反馈领域
│  ├─ agent-runtime/       # Pi Agent 工厂、消息转换、上下文与事件映射
│  ├─ agent-tools/         # TypeBox 工具定义、hooks、allowlist 与适配器
│  ├─ db/                  # Drizzle schema、仓储和迁移
│  ├─ contracts/           # API、事件、Python runner 的版本化 schema
│  └─ observability/       # 日志、trace、指标与审计写入
├─ python/
│  └─ chernozem_geo/       # 遥感检索、质检、对齐、聚合和产物生成
├─ .pi/
│  ├─ skills/              # 项目开发技能，不参与生产农情任务
│  └─ prompts/             # 开发辅助模板，不作为业务规则来源
├─ drizzle/                # 数据库迁移
├─ tests/
│  ├─ unit/
│  ├─ contract/
│  ├─ integration/
│  ├─ regression/          # 农情任务评测样本与预期结构
│  └─ e2e/
├─ docs/
├─ deploy/
└─ runtime/                # 本地运行产物，不提交
```

边界规则：API 只编排请求与响应；Pi Agent 只通过 `agent-tools` 注册表访问分析能力；Python runner 不访问业务数据库；工具不生成最终农业结论；报告不重新计算指标；前端不复制后端空间与排序逻辑。

项目开发时可以使用 Pi Coding Agent 的 `AGENTS.md`、skills、prompt templates 和 extensions；生产农情智能体只嵌入 `pi-agent-core` 与 `pi-ai`，不启动带有通用编码工具的 Pi CLI。

## 5. 数据层方案

### 5.1 数据分层

数据按用途分成四层，避免业务数据库、原始影像和报告文件混在一起。

| 层 | 内容 | 存储 | 保留策略 |
|---|---|---|---|
| 业务事实层 | 组织、用户、地块、授权、任务、复核、反馈 | PostgreSQL/PostGIS | 按业务与合规策略长期保存 |
| 观测与证据层 | 数据集目录、场景、地块统计、质量标记、证据关系 | PostgreSQL/PostGIS | 保留可复查所需元数据 |
| 文件产物层 | 原始或裁剪栅格、缩略图、图表、报告、导出包 | S3/MinIO | 生命周期策略管理，数据库仅存 URI 与摘要 |
| 短期运行层 | 队列、锁、短期缓存、下载临时文件 | Redis/本地临时目录 | 自动过期，不作为事实来源 |

PostgreSQL 是业务状态和审计元数据的单一事实来源；对象存储是大文件内容的单一事实来源；Redis 不能保存唯一业务事实。

Pi Coding Agent 的本地 JSONL session 适合开发交互，但生产系统不将其作为事实数据库。生产会话通过 Pi SDK 事件写入业务表，并由领域层重建可恢复上下文。完整审计消息与发送给模型的压缩上下文是两种数据，不应相互覆盖。

### 5.2 核心实体

| 实体 | 关键字段 | 约束与作用 |
|---|---|---|
| `organization` | `id`, `name`, `status` | 数据隔离主体 |
| `user` | `id`, `organization_id`, `role` | 角色至少包含 operator、expert、admin |
| `field` | `id`, `organization_id`, `code`, `geometry`, `area_ha` | PostGIS geometry；对外使用脱敏 code |
| `field_authorization` | `field_id`, `purpose`, `valid_from`, `valid_until`, `status` | 没有有效授权不能创建分析任务 |
| `crop_cycle` | `id`, `field_id`, `crop`, `season_year`, `sowing_date`, `harvest_date`, `variety`, `status` | 作物绑定“地块 + 种植季”，不永久绑定在 field；同一地块同一时间只能有一个当前种植季 |
| `analysis_task` | `id`, `organization_id`, `type`, `status`, `input_snapshot`, `analysis_spec_version` | 任务事实与重放入口；输入快照创建后不可原地修改 |
| `task_field` | `task_id`, `field_id`, `crop_cycle_id`, `geometry_snapshot`, `crop_snapshot`, `analysis_period`, `status` | 冻结任务包含的地块、种植季和分析时间，避免后续修改污染历史结果 |
| `agent_run` | `id`, `task_id`, `status`, `pi_version`, `model_ref`, `prompt_version`, `context_policy_version` | 一次 Pi Agent 执行；与业务任务分离 |
| `agent_message` | `run_id`, `sequence`, `role`, `content`, `parent_message_id`, `created_at` | 保存应用级 AgentMessage；敏感字段先脱敏 |
| `agent_event` | `run_id`, `sequence`, `event_type`, `payload`, `occurred_at` | 保存 agent、turn、message、tool 生命周期事件 |
| `task_step` | `task_id`, `kind`, `status`, `sequence`, `started_at`, `ended_at` | 显式记录步骤状态与失败位置 |
| `tool_run` | `run_id`, `step_id`, `pi_tool_call_id`, `tool_name`, `tool_version`, `input_hash`, `status`, `parameters`, `error_code` | Pi tool call 与领域步骤的审计及幂等关联 |
| `dataset` | `id`, `provider`, `product`, `license`, `spatial_resolution`, `temporal_resolution` | 数据来源与许可目录 |
| `imagery_scene` | `id`, `dataset_id`, `provider_scene_id`, `captured_at`, `footprint`, `cloud_cover`, `assets`, `checksum` | 一次具体影像获取；供应商场景 ID 在数据集内唯一 |
| `processing_run` | `id`, `task_id`, `scene_id`, `tool_version`, `parameter_hash`, `status`, `started_at`, `ended_at` | 记录场景处理版本、参数和执行结果 |
| `observation` | `processing_run_id`, `task_id`, `field_id`, `observed_at`, `metric`, `value`, `unit`, `coverage` | 统一地块级观测，不混入结论 |
| `quality_assessment` | `subject_type`, `subject_id`, `flags`, `usable_fraction`, `details` | 质量状态独立建模，不用零值代替缺测 |
| `artifact` | `task_id`, `kind`, `uri`, `sha256`, `mime_type`, `size_bytes` | 对象存储产物索引与完整性校验 |
| `evidence_item` | `task_id`, `field_id`, `claim_type`, `source_ref`, `strength`, `limitations` | 观测、推断和待确认事项的证据引用 |
| `field_assessment` | `task_id`, `field_id`, `overall_status`, `findings`, `summary` | 单地块农情评估；每项发现必须引用证据 |
| `review` | `task_id`, `reviewer_id`, `status`, `decision`, `reason` | 高风险内容发布门 |
| `report` | `task_id`, `version`, `kind`, `status`, `review_id`, `artifact_id`, `published_at` | 分析报告通过质量门后可发布；专家报告必须关联已通过的复核；旧版本不覆盖 |
| `field_feedback` | `field_id`, `task_id`, `observed_at`, `finding`, `photos`, `adopted` | 现场事实和采用情况回链原任务 |

### 5.3 空间与时间约定

- API 接收 GeoJSON 时要求声明或固定为 WGS84（EPSG:4326）；数据库保留原始几何并使用统一 geometry 列。
- 面积、距离、缓冲和栅格统计在适合当地的投影或等面积坐标系中计算，转换规则集中在空间模块。
- 时间戳统一保存 UTC，业务日期和生育期同时保留时区 `Asia/Shanghai` 的解释语义。
- 地块几何入库前检查类型、合法性、空几何、范围、重复和授权；自动修复必须记录原始摘要与修复方法。
- 栅格不作为 PostgreSQL 主存储。数据库保存数据集、时间、范围、分辨率、校验和、对象 URI 和处理血缘。

### 5.4 质量与缺测模型

统一质量标记建议包括：

```text
valid
partial_coverage
cloud_contaminated
temporally_stale
spatial_mismatch
insufficient_pixels
provider_unavailable
processing_failed
not_available
```

指标值与质量状态分开保存。只有满足工具契约中最低覆盖、时间窗口和有效像元要求的观测，才能进入排序；不满足时生成数据缺口或现场核查问题。

### 5.5 数据血缘

每个可交付结论至少能回溯：

```text
report statement
  -> field_assessment / evidence_item
  -> observation / quality_assessment
  -> processing_run / tool_run + parameters + tool_version
  -> imagery_scene + dataset
  -> artifact URI + checksum
```

## 6. Pi Agent 运行时与工具链

### 6.1 Pi 集成边界

生产系统嵌入 `@mariozechner/pi-agent-core` 的 `Agent` 类，不使用带编码工具的 Pi CLI，也不直接使用低层 `agentLoop` 作为默认入口。`Agent` 的消息结束屏障和 awaited subscribers 使事件持久化、审计与工具 preflight 具备稳定顺序。

一次业务任务可以包含多次 `agent_run`。业务任务状态由领域层控制；Pi 的 `isStreaming`、pending tool calls 和消息列表仅描述当前运行时状态，不能替代业务状态机。

```text
draft -> planned -> running -> needs_input -> running
                            -> needs_review -> completed
                            -> failed
                            -> cancelled
```

`agent_start` 创建或恢复 run，`turn_start`/`turn_end` 记录模型回合，`message_*` 驱动前端流式显示，`tool_execution_*` 映射到 `tool_run`。只有 `agent_end` 订阅者完成数据库 flush 后，本次 run 才视为稳定落盘。`completed` 表示报告达到发布条件；Pi 循环结束但待专家审核时保持 `needs_review`。

### 6.2 Agent 构造

每次运行由项目工厂创建，固定记录：

- `pi-agent-core` 与 `pi-ai` 精确版本；
- 模型 provider、model ID、thinking level 和采样配置；
- system prompt、工具集合和 schema 版本；
- `convertToLlm` 与 `transformContext` 策略版本；
- `sessionId`、业务 task ID、organization scope 和用户身份。

Pi `AgentMessage` 允许扩展项目消息，例如 `taskSnapshot`、`qualityNotice`、`reviewDecision` 和 `uiProgress`。`convertToLlm` 只向模型发送必要的 user、assistant、toolResult 与压缩后的领域上下文；UI 进度、完整审计事件、内部权限细节和敏感字段留在应用侧。

`transformContext` 负责确定性裁剪和摘要：保留当前任务口径、有效授权摘要、最近证据、未解决缺口、复核状态及最近回合；完整消息历史始终保留在 PostgreSQL，不被压缩结果覆盖。

### 6.3 Agent 职责

Pi Agent 负责：

1. 将用户问题解析成受约束的任务意图；
2. 请求领域工具校验地块授权、作物、时段和期望输出；
3. 选择受支持的分析任务模板，并启动对应的确定性领域工作流；
4. 根据结构化工作流结果决定请求输入、解释结果或停止；
5. 组织证据、限制、异常线索和现场核查问题；
6. 将高风险农业解释送入专业复核门。

Pi Agent 不直接访问数据库、对象存储或供应商 API，不执行任意 Python、SQL、shell、文件写入或 URL 请求。数据库访问和 Python runner 调用隐藏在经过 allowlist 的领域工具适配器内部。

场景检索、质量检查、时空对齐、指标计算、历史对比和质量门由版本化领域工作流按固定步骤执行。Pi Agent 不自由拼装这些步骤，也不得修改工作流产生的指标值、空间范围或质量状态。自然语言可以变化，结构化分析结果必须由相同输入快照、数据版本、工具版本和参数稳定重放。

### 6.4 事件、steering 与终止

- API 把 Pi 事件转换成项目事件并通过 SSE 推送；前端不直接依赖 Pi 原始事件 payload。
- 用户在运行中补充地块、时段或任务口径时，先生成经过校验的业务命令，再调用 `agent.steer()`；原始前端文本不直接绕过校验注入运行时。
- 非紧急的追加请求使用 `followUp()`；steering 与 follow-up 均保存顺序、操作者和接收时点。
- 用户取消任务时先写入取消意图，再调用 `agent.abort()`，等待 `waitForIdle()` 后完成状态收敛和资源清理。
- `continue()` 仅用于上下文末尾满足 Pi 约束的错误恢复；领域层先确认任务仍可继续且不会重复副作用。
- 工具返回 `terminate: true` 只表示跳过自动后续模型调用，不代表业务任务自动完成；领域状态机仍执行质量门和发布门。

### 6.5 工具治理

工具使用 Pi `AgentTool` 与 TypeBox 定义参数。工具 schema 是调用契约的单一事实来源，同时生成运行时校验、文档和契约测试。

- `beforeToolCall` 在参数通过解析后检查 organization scope、地块授权、任务状态、工具 allowlist、调用预算、幂等键和并发限制；失败时阻止调用并返回可解释原因。
- `afterToolCall` 登记 observation、artifact、quality、limitations 和成本，清理不应发给模型的供应商字段，并决定是否设置运行时终止提示。
- 无副作用、相互独立的数据检索可使用 Pi 默认 parallel 模式。
- 依赖共享临时资源、写入领域事实、发布报告、提交复核或反馈的工具设置 `executionMode: "sequential"`。一个 batch 包含任一串行工具时，整批按串行执行。
- 工具失败时抛出受控异常，由 Pi 生成 `isError: true` 的 tool result；不得把失败伪装成成功内容。
- 工具进度通过 `onUpdate` 输出简短状态，完整诊断写入应用日志和 `tool_run`，避免用大量内部细节污染模型上下文。

所有工具的 `details` 遵循统一领域 envelope；Pi 的 `content` 只包含模型继续推理所需的精简文本或结构化摘要：

```json
{
  "status": "succeeded | partial | failed",
  "coverage": {"time_start": "...", "time_end": "...", "geometry_ref": "..."},
  "quality": {"flags": [], "usable_fraction": 0.0},
  "parameters": {},
  "outputs": [{"kind": "observation | artifact", "ref": "..."}],
  "limitations": [],
  "error": {"code": null, "retryable": false, "message": null},
  "audit": {"tool_version": "...", "input_hash": "...", "cost": null}
}
```

### 6.6 首批领域工具

| 工具 | 输入 | 输出 |
|---|---|---|
| `validate_field_scope` | 地块与授权 | 合法几何、scope 和诊断 |
| `search_optical_scenes` | 地块、时间、云量限制 | 候选场景与覆盖信息 |
| `compute_optical_observations` | 场景、地块、指标定义 | 地块观测、有效像元和质量 |
| `fetch_weather_summary` | 地块、时间窗口 | 降水、温度等摘要与来源 |
| `compare_field_history` | 当前观测、历史窗口 | 变化线索与可比性限制 |
| `assess_field_conditions` | 合格证据集合 | 农情状态、变化、异常区域和证据缺口 |
| `build_field_interpretation` | 农情评估与限制 | 日常语言解释和可选核查建议，不生成处方 |
| `render_task_report` | 已通过对应发布门的结构化结果 | HTML/PDF 和 JSON 分析报告或专家报告 |

`render_task_report`、专业复核和现场反馈工具强制串行。数据检索工具可以并行，但同一数据源的速率限制由适配器内部处理。

## 7. API 边界

首期使用 REST，任务进度通过轮询或 Server-Sent Events；没有实时双向协作需求时不引入 WebSocket。

| 方法与路径 | 作用 |
|---|---|
| `POST /api/v1/fields` | 导入并校验地块 |
| `GET /api/v1/fields` | 按组织查询授权地块 |
| `POST /api/v1/fields/{id}/crop-cycles` | 为地块建立种植季并设置作物 |
| `PATCH /api/v1/crop-cycles/{id}` | 修改当前种植季信息；既有任务继续使用自己的输入快照 |
| `POST /api/v1/crop-cycles/batch` | 为多个地块批量建立或更新当前种植季 |
| `GET /api/v1/fields/{id}/crop-cycles` | 查询地块的历史种植季 |
| `POST /api/v1/tasks` | 创建受约束农情任务 |
| `GET /api/v1/tasks/{id}` | 查询状态、步骤和诊断 |
| `GET /api/v1/tasks/{id}/events` | SSE 任务进度流 |
| `POST /api/v1/tasks/{id}/steer` | 校验后向运行中的 Pi Agent 追加纠偏输入 |
| `POST /api/v1/tasks/{id}/follow-ups` | 排队处理非紧急追加请求 |
| `POST /api/v1/tasks/{id}/cancel` | 记录取消并中止当前 run |
| `POST /api/v1/tasks/{id}/retry` | 按失败语义重试 |
| `GET /api/v1/tasks/{id}/assessments` | 地块排序、依据与限制 |
| `GET /api/v1/tasks/{id}/evidence` | 证据与质量详情 |
| `POST /api/v1/tasks/{id}/reviews` | 提交专业复核 |
| `POST /api/v1/tasks/{id}/publish` | 通过发布门后生成报告 |
| `POST /api/v1/tasks/{id}/feedback` | 提交现场巡田反馈 |
| `GET /api/v1/reports/{id}` | 获取报告元数据和下载地址 |

API 只返回稳定领域 schema；Pi 原始事件、供应商字段、内部 prompt、完整模型上下文和对象存储真实路径不进入公共契约。SSE 事件统一为 `task.status`、`agent.message.delta`、`tool.started`、`tool.progress`、`tool.completed`、`task.needs_input`、`task.needs_review` 和 `task.failed` 等应用事件。

## 8. 前端信息架构

产品采用“普通用户任务端 + 专家复核端”两套信息层级。遥感、GIS 和 Agent 复杂度留在后台，不要求种植户学习专业概念。

### 普通用户任务端

普通用户首屏直接回答三个问题：

1. **这块田现在怎么样**：用“整体正常”“长势偏弱”“变化明显”等清晰状态概述；
2. **问题在什么位置、怎么变化**：在地块图上标出差异区域，并展示与历史或邻近时段的变化；
3. **分析依据是什么**：展示使用的资料日期、时间对比和关键分析图层。

发起任务优先使用预设入口，例如“分析这块玉米田近期长势”“查看这块田与上月相比有什么变化”“分析雨后农田状况”“查看本季变化趋势”。自然语言是补充方式，不展示算法选择、阈值、坐标系或工具参数。

用户添加地块后，为该地块的当前种植季选择作物。合作社可以先多选地块批量设置同一种作物，再进入单个地块修改；播种日期和品种为可选项。作物选择决定生育期、时间窗口和专项解释规则。V0.1 的选择器允许记录其他作物，但只有玉米可以启动完整专项分析；界面直接显示支持状态，不使用玉米规则代替其他作物规则。

普通用户只看到四类状态：正在分析、需要补充信息、正在准备可用资料、报告已完成。后台技术状态映射成易懂文本；需要专家审核时显示“正在审核”，不伪装成已完成。

地图以农田边界、田内分析分区、变化图层和时间对比为核心。NDVI、SAR、云量、像元覆盖等专业内容默认隐藏；用户主动展开“分析依据”时再展示来源日期和证据摘要。只有云量或数据时效确实改变当前结论时，才在对应图层标注该事实。

V0.1 先完成桌面 Web 的地块设置、任务发起、地图结果、证据和报告流程。移动端、小程序、照片与现场反馈在试点闭环阶段实现；届时重点优化大按钮、弱网、语音输入和异常区域定位。

### 专家复核端

专家和项目团队可以查看数据来源、时间覆盖、质量标记、地块统计、历史对比、工具步骤、参数摘要、失败原因和修订记录。该界面服务于审核和排错，不作为种植户使用门槛。

同一条结论在两个界面使用同一结构化事实：普通端显示行动语言，专家端显示证据和限制，避免前后端形成两套结论。

### 8.1 结果表达门

报告生成层必须区分“内部质量控制”和“用户可见说明”。默认报告采用结论式表达，不附加模板化免责语。仅在质量门判断某一结论受具体数据问题影响时，生成与该结论绑定的简短事实说明。示例：

```text
正确：6 月中旬以来，地块西南区域长势较前期下降，变化面积约 12 公顷。
触发说明：6 月 18 日光学影像受云影响，变化判断使用 6 月 14 日和 6 月 21 日可用影像。

错误：本报告仅供参考，受多种因素影响，请谨慎使用。
```

## 9. 安全与责任方案

- 所有业务表带 `organization_id` 或能通过父实体稳定推导组织；查询层统一施加组织 scope。
- 地块任务创建前验证有效授权；授权撤销后停止新处理，并按政策处理已有产物。
- 对象存储使用私有 bucket 和短时签名 URL；真实路径不对前端暴露。
- 密钥通过环境变量或密钥服务注入；日志默认脱敏。
- 高风险建议使用显式规则进入 `needs_review`，发布端再次校验 review 状态。
- 只包含遥感观测、变化描述和数据依据的分析报告通过质量门后可以发布；施肥、灌溉、用药等专业建议必须经过审核后进入专家报告。
- 报告正文区分：已观察到的现象、可能风险、数据限制、现场待确认问题、经审核专业建议。
- 审计日志记录操作者、动作、主体、时间、前后状态和关联任务，不保存无关敏感正文。

## 10. 部署与运行

### 开发与首期试点

Docker Compose 包含：

- `web`：静态前端；
- `api`：Fastify HTTP 与 SSE 服务；
- `agent-worker`：嵌入 Pi Agent SDK 的后台运行进程；
- `geo-worker`：隔离的 Python 遥感工具执行器；
- `postgres`：PostgreSQL/PostGIS；
- `minio`：对象存储；
- `redis`：仅在引入异步队列后启用；
- `reverse-proxy`：TLS、静态文件与 API 入口。

### 升级触发条件

- 单任务常超过 HTTP 生命周期或需要可靠重试：启用独立 agent-worker 与 BullMQ/Redis 队列；
- 单机资源持续不足且任务可按工具类型隔离：拆分遥感 worker 资源池；
- 不同领域出现独立发布节奏、独立扩缩容和明确团队所有权：再评估服务拆分；
- 只有 Compose 无法满足已验证的可用性和规模需求时评估 Kubernetes。

## 11. 测试与验收

| 测试层 | 重点 |
|---|---|
| 单元测试 | 状态转换、质量门、排序理由、授权和空间函数 |
| 契约测试 | TypeBox 工具 schema、Python runner、供应商适配器与统一 envelope |
| Pi 运行时测试 | 事件顺序、消息转换、上下文裁剪、hooks、并行与串行工具语义 |
| 集成测试 | Pi Agent、PostGIS、对象存储、任务执行、报告版本和复核门 |
| 回归评测 | 正常、云污染、缺测、冲突证据、无授权、工具超时 |
| 端到端测试 | 导入地块 -> 设置种植季与作物 -> 创建任务 -> 结果与证据 -> 分析报告 |
| 安全测试 | 组织隔离、越权访问、签名 URL、日志脱敏和密钥检查 |

首个纵向切片完成标准：

- 所有迁移可在空数据库执行并可回滚；
- 一项任务可以成功运行，也能对每类预期失败返回明确状态；
- `agent_end` 后 run、message、event 与 tool_run 均完整落盘；
- `beforeToolCall` 能阻止越权、超预算和非法状态调用；
- 上下文压缩后仍保留任务口径、证据限制和待处理输入；
- 每个报告结论有可定位证据或明确标为待确认；
- 同一任务可以重放并比较工具版本、数据版本和结果差异；
- 桌面端完成地块、种植季、任务、结果、证据和分析报告全流程；
- 代码库不包含密钥、未脱敏真实地块和运行时大文件。

## 12. 建议实施顺序

1. 建立 TypeScript workspace、Python geo package、配置、迁移和统一 ID/时间/空间约定；
2. 精确锁定同版本 `pi-agent-core` 与 `pi-ai`，实现 Agent 工厂和最小事件订阅测试；
3. 实现组织、地块、授权、作物季、task_field、analysis_task 和 agent_run 模型；
4. 实现领域状态机、Pi 事件映射、消息落库、`convertToLlm` 和 `transformContext`；
5. 实现 TypeBox 工具注册表、before/after hooks、统一 envelope 和 Python runner 协议；
6. 接入 Sentinel-2，建立 imagery_scene 与 processing_run，完成检索、质检和地块聚合；
7. 接入气象摘要，完成第一版证据、农情解释和田内异常区域；
8. 完成地图任务台、SSE 状态、地块结果和证据详情；
9. 完成分析报告、取消、重试和重放链路；
10. 增加 Sentinel-1、专业复核、现场反馈、评测集与试点指标；
11. 通过 V0.1 质量门后再启用 BullMQ/Redis、完整账号隔离和试点部署。

## 13. 待确认决策

这些事项不阻塞 V0.1 骨架，但在对应实现开始前需要形成 ADR：

- 首个光学和气象数据源的许可、访问方式、覆盖与成本；
- 首期模型 provider、模型 ID、成本上限和密钥托管方式；
- Pi 依赖升级策略，以及 0.73.1 之后版本的事件与工具兼容测试；
- 是否已有高德地图前端或空间分析代码需要迁移复用；
- 首批真实地块的授权格式、数据字段和脱敏要求；
- 第一版农情状态、变化与异常区域由哪些可解释指标组成，以及质量阈值；
- 专业复核人员、审核范围和报告签发责任；
- 试点部署位置、预算、网络条件与数据保留期限。
