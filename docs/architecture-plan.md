# 黑土智管技术与版本方案

> 状态：架构基线草案
> 适用阶段：原型开发至首批付费验证
> 产品主线：农田 -> 黑土农情 Agent 能力 -> 数据与工具 -> 分析结果 -> 判断/行动 -> 反馈 -> 复用
> 语言运行时基线：`@openai/codex-sdk` 0.149.0；功能侧使用项目内确定性 Workflow

> 工具与交付闭环的增量实施方案见[工具体系完整设计](farm-agent-tool-system-plan.md)。扩展变化追踪、现场资料、专业审核或持续监测时读取该文档，以确定依赖、状态和验收门；待实施方案不代表当前能力已通过真实地块验收。

## 1. 决策摘要

首期采用 **模块化单体 + 独立数据获取作业 + 受限对话 Agent + 隔离的确定性农情 Workflow**，围绕黑土小地块提供四类高频农情服务。数据获取由独立 worker 执行并登记统一 manifest；关键生育期长势监测、水氮协同诊断、农田积水灾害识别和霜冻风险提前预警由项目内 Workflow 按固定步骤执行受控领域工具。Codex harness 负责自然语言对话，并在首轮 Workflow 完成后，通过原生 MCP 按需读取已保存成果、检索农学原文和补调受控证据工具，再生成分析文档；它可以组织证据、解释和核查建议，但不能修改结构化计算结果或质量门。业务状态、来源、授权和结果产物由项目领域层控制，报告只是可选渲染产物。技术方案优先保障每项业务能力可独立调用、来源可追溯、结果可复查和试点可交付，不提前建设微服务、数据湖、Kubernetes、复杂实时流处理或通用农业 SaaS。

### 1.1 黑土农情 Agent 能力目录

首期只有一个面向用户的黑土农情 Agent。Agent 根据用户选择的业务场景加载对应能力契约和工具 allowlist；变化追踪、异常检测、多源证据解释、地图生成等是共享内部机制，不拆成多个 Agent。每项业务能力必须有独立的触发条件、输入契约、工具组合、结构化输出和完成标准。

| 业务能力 | 主要输入 | 处理机制 | 结构化输出 | 发布边界 |
|---|---|---|---|---|
| `growth_stage_monitoring` 关键生育期长势监测 | 时序光学指数、雷达特征、作物与播种信息 | 动态追踪玉米营养生长到生殖生长关键期，执行时间可比性和有效覆盖质量门 | 生育期状态、长势分级、田内差异、变化时间、证据日期；经校准后增加产量潜力 | 未有历史产量和地面样本验证前不输出确定产量预测 |
| `water_nitrogen_diagnosis` 水氮协同诊断 | 同日期 NDVI、NDRE/RECI、NDMI/NDWI；同窗雷达与降雨；生育期、地形、土壤背景和可选现场记录 | 先在地块田况页浏览日期与图层；Agent 任务再用光谱差异定位，只有独立同向证据才组织原因排查 | 植被偏弱区、水分相关排查、经现场对照支持的氮素核查、来源角色和巡田动作 | 单期光学指标不直接形成水氮原因区；处方必须经过模型验证与专业复核 |
| `waterlogging_detection` 农田积水灾害识别 | 强降雨气象过程、Sentinel-1 雷达、地块与历史基线 | 利用微波对水体的敏感性，在多云或阴雨条件下提取疑似积水范围 | 积水多边形、受影响面积、观测时间、置信与核查优先级 | 无合格灾前/灾后观测时返回证据缺口，不以低后向散射直接等同积水 |
| `frost_risk_warning` 霜冻风险提前预警 | 温度骤降预报、DEM/低洼地形、作物生育期、历史气象 | 叠加空间易发性与时间突发性，评估风险窗口和影响区域 | 风险等级、空间高亮区、预警时效、触发依据和防护关注区 | 属于风险预警，不把预报直接描述成已经发生的霜冻灾害 |

报告生成、PDF 渲染、数据采集、遥感指标计算和专业审核不是 Agent 能力。它们分别属于交付服务、独立数据获取层、确定性工具层和复核层。

Codex 是受限语言运行时，不是业务数据库、工作流数据库、权限系统或遥感计算引擎。系统不把可靠性寄托在 system prompt 上；生产对话与文档分析均关闭 Shell、文件编辑、任意网络、搜索及审批扩权。文档分析额外注册一个服务端绑定任务的 loopback MCP，允许成果读取、知识检索和受控证据计算。发布校验核对范围、已读字段引用与专业复核状态；它不证明每个自然语言主张的正确性，仍需独立评测。

建议技术基线：

| 领域 | 首选方案 | 选择理由 |
|---|---|---|
| Web 前端 | React + TypeScript + Vite + MapLibre GL JS | 适合地图工作台，并与 API 共享稳定领域 schema |
| API 与领域服务 | Node.js 22 + TypeScript + Fastify + TypeBox | 承载 HTTP 边界、对话装配、任务状态和工具 schema |
| 语言运行时 | `@openai/codex-sdk` 0.149.0 | 提供对话和基于领域结果的 JSON 文档生成；发布契约见 agent.md 第 7 节 |
| 业务编排 | 能力注册表 + 确定性 Workflow + 领域状态机 + 受控工具注册表 | 路由到长势、水氮、积水或霜冻工作流；代码决定工具顺序与完成门 |
| 遥感执行 | Python 3.12 工具包，通过版本化 JSON 协议调用 | 保留成熟地理空间生态，与 Agent 进程隔离 |
| 后台任务 | 首版 Node worker；需要可靠排队后引入 BullMQ + Redis | 先降低复杂度，再按执行时长和并发证据升级 |
| 业务与空间数据库 | PostgreSQL 16 + PostGIS | 统一管理地块、任务、证据、知识来源和 GraphRAG 索引运行 |
| 农业知识检索 | Microsoft GraphRAG Python worker + Parquet + LanceDB | 使用官方索引与 Local Search，不在业务库复制图谱派生表 |
| 大文件与产物 | S3 兼容对象存储，开发期使用 MinIO | 影像、缩略图、报告和中间产物不进入数据库 |
| 遥感处理 | Rasterio、GDAL、GeoPandas、Shapely、xarray/rioxarray | 成熟的 Python 地理空间工具链 |
| Node 数据访问 | Drizzle ORM + drizzle-kit | 类型清晰，迁移和 SQL 都可审查 |
| Python 工具数据访问 | 禁止直接访问业务库 | 工具通过输入快照和产物协议工作，降低跨层耦合 |
| 报告 | HTML 模板 -> PDF；结构化 JSON 同步保存 | 人可阅读交付与机器可复用结果并存 |
| 部署 | Docker Compose 单机部署 | 满足原型和 3-5 个试点，维护成本低 |
| 可观测性 | Codex thread ID + Workflow 事件 + 结构化日志 + OpenTelemetry | 从 run ID 串联对话、步骤、工具、产物和错误 |

## 2. 版本路线

版本按“可验证的能力”划分，不按页面数量或代码量划分。后续版本只有在上一版本质量门通过后进入。

### V0.1：端到端纵向切片

**目标**：一个真实或经过授权的样例地块能够完成关键生育期长势监测，并返回清晰、可复查、可重复使用的结构化结果；报告导出不是 V0.1 完成的唯一标准。

范围：

- 导入 GeoJSON 地块并记录授权；为每个地块建立当前种植季，由用户选择作物，支持多选地块批量设置后再单独修改；
- 创建玉米农情监测任务，明确地块、时段和结果口径；
- 建立农情能力注册表、确定性 Workflow、领域状态机和事件持久化；
- Codex 对话与文档分析单独装配；文档分析仅开放任务范围内的原生 MCP，文件、Shell、任意网络和其他 MCP 保持关闭；
- 接入 Sentinel-2 光学遥感和一个公开气象数据源；
- 执行质量检查、地块级聚合和简单历史对比；
- 首先跑通关键生育期长势监测，输出生育期状态、长势分级、田内差异、变化时间、地图图层、证据和限制；
- 为水氮协同诊断、积水灾害识别和霜冻风险预警建立同一 Agent 下的能力契约和测试样例，但不把尚未验证的结果描述成已实现；
- 保存任务步骤、工具调用、参数、产物和失败原因；
- Web 端按 Agent 任务展示地图、执行状态、结构化结果和可选导出。

质量门：

- 1 个授权地块能够完成关键生育期长势监测任务；
- 同一输入和数据版本可重放，核心结果一致；
- 对话消息、Workflow 步骤和 tool events 能完整关联到业务任务与 agent run；
- 每个田块结果均能定位到证据、工具调用和质量状态；
- 每个参与分析的地块均关联一个明确的当前种植季和作物；同一地块跨年份更换作物时保留历史种植季，不覆盖旧记录；
- V0.1 仅对玉米启用专项分析规则；其他作物可以保存，但创建专项分析任务时明确显示尚未支持，不套用玉米阈值；
- 地块授权、organization scope、工具 allowlist 和任务状态在每次工具调用前完成校验；
- 缺测、无覆盖、云污染和工具失败不会被显示为正常零值；
- 每项农情能力都有独立输入 schema、工具 allowlist、结构化输出和可检查完成标准；
- 用户结果不包含通用免责声明；只有实际影响判断的数据问题才在对应结果旁说明。

### V0.2：多源证据与专业复核

**目标**：在真实雷达、DEM、天气和土壤证据基础上，增加水氮协同诊断、农田积水灾害识别和霜冻风险提前预警。

范围：

- 接入 Sentinel-1 或等价雷达来源；
- 接入 DEM、温度预报和可合法使用的土壤背景数据；
- 扩展 `beforeToolCall` 的调用预算、并发和幂等检查；
- 使用 `afterToolCall` 归一化工具详情、登记产物、计算质量门并记录审计事件；
- 完善 `transformContext` 的长任务裁剪策略和 `convertToLlm` 的多源消息过滤；
- 扩展 observation 与 quality flag 模型以支持多源对齐；
- 支持光学、雷达、气象证据的时间与空间对齐；
- 引入证据强度、冲突和缺口表达，不使用不可解释总分；
- 增加 `needs_review`，并完善多源证据不足时的 `needs_input` 规则；
- 专家可查看各业务能力的证据与结构化结果、修改解释、记录修订理由，并审核变量施肥或精准灌溉候选方案；
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
- 用户补充输入通过经过校验的业务命令恢复任务，所有变更和重试均审计；
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
- Codex SDK、模型、system prompt、Workflow、工具 schema 和上下文策略版本审计；
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

<div style="width:1200px;box-sizing:border-box;position:relative;background:#f5f9f5;padding:20px;border-radius:8px;border:1px solid #c3d9c3;"><style scoped>.arch-wrapper{display:flex;gap:12px}.arch-sidebar{width:160px;flex-shrink:0}.arch-main{flex:1;min-width:0}.arch-title{text-align:center;font-size:22px;font-weight:bold;color:#14532d;margin-bottom:16px}.arch-layer{margin:8px 0;padding:14px;border-radius:8px;box-shadow:0 2px 8px rgba(22,101,52,.06)}.arch-layer-title{font-size:13px;font-weight:bold;margin-bottom:10px;text-align:center}.arch-grid{display:grid;gap:8px}.arch-grid-3{grid-template-columns:repeat(3,1fr)}.arch-grid-4{grid-template-columns:repeat(4,1fr)}.arch-box{border-radius:5px;padding:8px;text-align:center;font-size:11px;font-weight:600;line-height:1.35;color:#14532d;background:rgba(255,255,255,.9);border:1px solid rgba(34,197,94,.15)}.arch-box.highlight{background:linear-gradient(135deg,#dcfce7 0%,#bbf7d0 100%);border:2px solid #16a34a}.arch-box.tech{font-size:10px;color:#166534;background:rgba(240,253,244,.8)}.arch-layer.external{background:#e8f0e8;border:2px dashed #a3c0a3}.arch-layer.user{background:#dcfce7;border:2px solid #22c55e}.arch-layer.application{background:#d1fae5;border:2px solid #059669}.arch-layer.ai{background:#ccfbf1;border:2px solid #14b8a6}.arch-layer.tools{background:#ffedd5;border:2px solid #ea580c}.arch-layer.acquisition{background:#e0f2fe;border:2px solid #0284c7}.arch-layer.data{background:#fef3c7;border:2px solid #ca8a04}.arch-layer.infra{background:#e2e8f0;border:2px solid #64748b}.arch-sidebar-panel{border-radius:8px;padding:10px;background:#e8f0e8;border:2px solid #86b086;margin-bottom:8px}.arch-sidebar-title{font-size:12px;font-weight:bold;text-align:center;color:#14532d;margin-bottom:6px}.arch-sidebar-item{font-size:10px;text-align:center;color:#166534;background:#fff;padding:5px;border-radius:4px;margin:3px 0}</style><div class="arch-title">黑土智管分层总体架构</div><div class="arch-wrapper"><div class="arch-sidebar"><div class="arch-sidebar-panel"><div class="arch-sidebar-title">运行观测</div><div class="arch-sidebar-item">采集作业与资产</div><div class="arch-sidebar-item">对话 / Workflow 事件</div><div class="arch-sidebar-item">tool 执行与成本</div><div class="arch-sidebar-item">错误与终止</div></div><div class="arch-sidebar-panel"><div class="arch-sidebar-title">产品评测</div><div class="arch-sidebar-item">任务完成率</div><div class="arch-sidebar-item">专家修订率</div><div class="arch-sidebar-item">结果采用率</div><div class="arch-sidebar-item">交付成本</div></div></div><div class="arch-main"><div class="arch-layer user"><div class="arch-layer-title">用户与交付层</div><div class="arch-grid arch-grid-4"><div class="arch-box">Web 地图工作台</div><div class="arch-box">移动巡田视图</div><div class="arch-box">专家复核台</div><div class="arch-box">报告与导出</div></div></div><div class="arch-layer application"><div class="arch-layer-title">API 与任务层</div><div class="arch-grid arch-grid-4"><div class="arch-box">Fastify API</div><div class="arch-box">任务状态机</div><div class="arch-box">后台作业调度</div><div class="arch-box">授权与范围冻结</div></div></div><div class="arch-layer acquisition"><div class="arch-layer-title">独立数据获取层（不由 Agent 执行）</div><div class="arch-grid arch-grid-4"><div class="arch-box">Sentinel-1 / Sentinel-2</div><div class="arch-box">DEM / 天气 / 土壤</div><div class="arch-box">质量与许可检查</div><div class="arch-box">Acquisition Manifest</div></div></div><div class="arch-layer ai"><div class="arch-layer-title">对话与功能双链路</div><div class="arch-grid arch-grid-4"><div class="arch-box highlight">生育期长势监测</div><div class="arch-box">水氮协同诊断</div><div class="arch-box">积水灾害识别</div><div class="arch-box">霜冻风险预警</div></div></div><div class="arch-layer tools"><div class="arch-layer-title">确定性分析与知识检索</div><div class="arch-grid arch-grid-4"><div class="arch-box">时序光学 / 生育期</div><div class="arch-box">雷达 / 积水</div><div class="arch-box">水氮 / 天气 / 地形</div><div class="arch-box">GraphRAG Local Search</div></div></div><div class="arch-layer data"><div class="arch-layer-title">数据、证据与知识层</div><div class="arch-grid arch-grid-4"><div class="arch-box tech">PostgreSQL/PostGIS<br><small>业务、证据、知识来源与索引运行</small></div><div class="arch-box tech">S3/MinIO + LanceDB<br><small>栅格、报告、原文、Parquet 与向量</small></div><div class="arch-box tech">Redis（按需）<br><small>队列、锁和短期缓存</small></div><div class="arch-box tech">统一数据目录<br><small>日期、范围、质量、许可</small></div></div></div><div class="arch-layer infra"><div class="arch-layer-title">运行与基础设施层</div><div class="arch-grid arch-grid-4"><div class="arch-box tech">Node API</div><div class="arch-box tech">Acquisition Worker</div><div class="arch-box tech">Geo / GraphRAG Worker</div><div class="arch-box tech">Docker Compose / Backup</div></div></div><div class="arch-layer external"><div class="arch-layer-title">模型与外部数据</div><div class="arch-grid arch-grid-4"><div class="arch-box tech">Codex 对话模型</div><div class="arch-box tech">光学与雷达</div><div class="arch-box tech">气象数据</div><div class="arch-box tech">地形与土壤</div></div></div></div><div class="arch-sidebar"><div class="arch-sidebar-panel"><div class="arch-sidebar-title">Workflow 治理门</div><div class="arch-sidebar-item">request router</div><div class="arch-sidebar-item">workflow allowlist</div><div class="arch-sidebar-item">evidence contract</div><div class="arch-sidebar-item">completion gate</div></div><div class="arch-sidebar-panel"><div class="arch-sidebar-title">安全责任</div><div class="arch-sidebar-item">组织与地块授权</div><div class="arch-sidebar-item">无通用 shell 工具</div><div class="arch-sidebar-item">高风险专业复核</div><div class="arch-sidebar-item">审计与脱敏</div></div></div></div></div>

### 3.1 分层职责与调用方向

系统采用“数据获取、确定性工具、Agent 编排”三层核心结构，并由 API/任务、数据证据、复核交付三类基础能力支撑。数据获取不是 Agent 的工具调用过程，而是由任务服务独立创建、执行和登记的后台作业。任务服务在冻结快照中关联已完成或部分完成的 `acquisitionRunId`；Agent 只传 `taskId` 调用受控工具，不能自行拼接供应商请求、修改时间窗口、下载文件或选择任意资产。

```text
用户 / 前端
    |
    v
API 与任务服务 -----> 独立数据获取作业
    |                         |
    |                         +-- Sentinel-1 provider
    |                         +-- Sentinel-2 provider
    |                         +-- Copernicus DEM provider
    |                         +-- 历史/预报天气 provider
    |                         |
    |                         v
    |                  AcquisitionRun + Manifest
    |                         |
    v                         v
黑土农情 Agent ------> 确定性分析工具层
能力路由、步骤规划       光学 / 雷达 / 天气 / 地形 / 土壤
来源与结果选择、失败回退   对齐 / 统计 / 灾害与风险检测
    |                         |
    +-------------> AnalysisResult
                              |
                              v
                       复核与报告交付
```

#### 数据获取层

数据获取层拥有供应商差异和采集生命周期：范围冻结、场景检索、资产选择、许可检查、下载/暂存、完整性校验、重试、限流、缓存和来源清单登记。每个来源都返回统一的 `SourceAcquisitionResult`，至少记录：

- 请求时间窗口与实际可用日期；
- 请求地块、覆盖率和空间分辨率；
- 产品、波段/极化、处理级别和版本；
- 云量、质量标记、完整性和许可状态；
- `artifactRef`、校验和、获取时间和失败原因。

这些记录集中归档在 `AcquisitionRun` 的 manifest 中，不能分散在 Agent 消息、前端状态或供应商适配器私有日志里。采集作业允许部分成功，但不能把缺测、无覆盖、云污染和未授权伪装成零值。

#### 工具层

工具层只消费已登记的产物和范围快照，不访问供应商 API，也不处理账号许可。内部确定性引擎负责空间、时序、统计、规则和模型计算；AI 可见工具在其上返回观测或业务判断。工具不得让模型选择资产、波段、阈值、坐标系或底层执行步骤。Skill、工具输入、状态、来源和完成条件统一以 [Agent 设计](agent.md) 为准。

#### Agent 层

Agent 层拥有任务理解、能力路由、工具选择、执行顺序、结果组织、失败回退和完成门。黑土农情 Agent 的输入是任务快照和按能力归一化的数据就绪状态，原始采集清单只由内部工具服务读取；输出是当前能力约定的结构化任务结果、地图、来源日期和下一步动作。Agent 可以通过只读检索工具获取带出处的农学背景，但知识不能覆盖工具结果或补造缺失观测。自然语言解释只是其中一个字段。Agent 不拥有数据源凭据，不注册任意下载或文件工具，不直接决定空间范围和供应商查询语句。

#### API/任务、分析结果与复核交付

- API/任务层负责认证、地块授权、请求校验、任务状态、后台作业调度和进度查询；
- 领域工具集工厂根据任务目标计算内部证据窗口、筛选同边界版本采集批次，并按 Skill 注册表组合和校验必要工具；API 路由不掌握四项能力各自的工具清单；
- 工具层集中判断产物是否满足分析前置条件；例如长势和水氮任务必须存在同一观测日期的完整 Sentinel-2 光谱与 SCL 资产。只有采集批次但资产不完整时直接返回 `needs_data`，不调用模型；
- 数据配置、所需来源和目标到配置的映射由同一注册表拥有，采集服务和分析缺口共同读取；`needs_data` 任务返回缺失来源与数据入口，不复制来源清单；
- 数据与结果层负责 PostgreSQL/PostGIS 中的业务事实、采集批次、来源结果、工具运行和分析结果，以及对象存储中的栅格、图表和报告产物；
- 复核交付层负责来源与结果汇总、专业复核、结论版本、地图和报告导出，不重新计算遥感指标。

层间只通过版本化契约传递：`AcquisitionRun` -> `ArtifactRef` -> `AnalysisResult` -> `ReportVersion`。任何层都不得解析另一层的供应商原始响应或前端临时字段。

## 4. 模块划分

建议仓库采用单仓库结构，先建立清晰领域边界，不把每个目录部署成独立服务。

```text
ChernozemAgent/
├─ apps/
│  ├─ api/                 # Fastify HTTP/SSE 入口、认证和请求编排
│  ├─ acquisition-worker/  # 独立多源数据发现、抓取、校验和清单登记
│  ├─ agent-worker/        # 确定性功能工作流与事件持久化
│  ├─ geo-worker/          # Python 确定性遥感与空间分析入口
│  ├─ knowledge-worker/    # Microsoft GraphRAG 索引与 Local Search 入口
│  └─ web/                 # React 地图工作台与专家复核界面
├─ packages/
│  ├─ domain/              # 任务、地块、证据、复核、报告与反馈领域
│  ├─ acquisition/         # 采集编排、provider 适配器、幂等与 manifest
│  ├─ agent-runtime/       # Codex 受限语言 runtime、功能工作流与事件映射
│  ├─ agent-tools/         # 分析工具 schema、hooks、allowlist 与适配器
│  ├─ db/                  # Drizzle schema、仓储和迁移
│  ├─ contracts/           # API、事件、Python runner 的版本化 schema
│  └─ observability/       # 日志、trace、指标与审计写入
├─ python/
│  ├─ chernozem_geo/       # 遥感预处理、对齐、聚合和差异产物生成
│  └─ chernozem_knowledge/ # GraphRAG 配置、prompt、输入转换和查询适配
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

边界规则：API 只编排请求与响应并调度独立采集作业；`acquisition-worker` 独占外部数据源访问和采集清单登记；确定性 Workflow 只通过工具注册表访问已采集数据的分析能力；Codex 负责对话及已有结果上的文档分析，尚未自主访问分析工具；Python runner 不访问供应商 API 或业务数据库；报告不重新计算遥感指标；前端不复制后端空间与排序逻辑。

项目开发遵循仓库 `AGENTS.md` 和可审查的 skills；生产系统通过 Codex SDK 运行对话与文档生成，并由项目内 Workflow 执行计算功能，不开放任意编码执行。

## 5. 数据层方案

### 5.1 数据分层

数据按用途分成五层，避免业务数据库、知识文档、原始影像和报告文件混在一起。

| 层 | 内容 | 存储 | 保留策略 |
|---|---|---|---|
| 业务事实层 | 组织、用户、地块、授权、任务、复核、反馈 | PostgreSQL/PostGIS | 按业务与合规策略长期保存 |
| 观测与证据层 | 数据集目录、场景、地块统计、质量标记、证据关系 | PostgreSQL/PostGIS | 保留可复查所需元数据 |
| 农业知识层 | 有来源的农学材料、GraphRAG 索引运行及官方派生产物 | PostgreSQL 保存来源和运行；对象存储保存原文/Parquet；LanceDB 保存向量 | 原文和索引运行按版本保留；派生产物可重建 |
| 文件产物层 | 原始或裁剪栅格、缩略图、图表、报告、导出包 | S3/MinIO | 生命周期策略管理，数据库仅存 URI 与摘要 |
| 短期运行层 | 队列、锁、短期缓存、下载临时文件 | Redis/本地临时目录 | 自动过期，不作为事实来源 |

PostgreSQL 是业务状态和审计元数据的单一事实来源；对象存储是大文件内容的单一事实来源；Redis 不能保存唯一业务事实。

Codex thread 适合维持对话连续性，但生产系统不将其作为事实数据库。生产会话由 API 写入业务表，并由领域层构造可恢复上下文。完整审计消息与发送给模型的裁剪上下文是两种数据，不应相互覆盖。

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
| `agent_run` | `id`, `task_id`, `status`, `provider`, `model_id`, `started_at`, `completed_at` | 一次功能工作流执行；与业务任务分离 |
| `agent_message` | `run_id`, `sequence`, `role`, `content`, `parent_message_id`, `created_at` | 保存应用级 AgentMessage；敏感字段先脱敏 |
| `agent_event` | `run_id`, `sequence`, `event_type`, `payload`, `occurred_at` | 保存 agent、turn、message、tool 生命周期事件 |
| `task_step` | `task_id`, `kind`, `status`, `sequence`, `started_at`, `ended_at` | 显式记录步骤状态与失败位置 |
| `tool_run` | `run_id`, `step_id`, `tool_call_id`, `tool_name`, `tool_version`, `input_hash`, `status`, `parameters`, `error_code` | Workflow 工具调用与领域步骤的审计及幂等关联 |
| `acquisition_run` | `id`, `field_id`, `boundary_version`, `period`, `status`, `input_hash`, `manifest_artifact_id` | 独立采集批次；先于 Agent 分析运行，可部分成功和重放 |
| `source_acquisition_result` | `run_id`, `source_type`, `provider`, `product`, `status`, `available_dates`, `coverage`, `quality`, `license`, `error` | 按光学、雷达、地形、历史天气、预报天气和土壤分类集中记录可用日期与数据状态 |
| `acquired_asset` | `run_id`, `source_result_id`, `provider_asset_id`, `role`, `captured_at`, `resolution`, `crs`, `artifact_id`, `checksum` | 已抓取并校验的原始资产；分析工具只通过产物引用读取 |
| `dataset` | `id`, `provider`, `product`, `license`, `spatial_resolution`, `temporal_resolution` | 数据来源与许可目录 |
| `imagery_scene` | `id`, `dataset_id`, `provider_scene_id`, `captured_at`, `footprint`, `cloud_cover`, `assets`, `checksum` | 一次具体影像获取；供应商场景 ID 在数据集内唯一 |
| `processing_run` | `id`, `task_id`, `scene_id`, `tool_version`, `parameter_hash`, `status`, `started_at`, `ended_at` | 记录场景处理版本、参数和执行结果 |
| `observation` | `processing_run_id`, `task_id`, `field_id`, `observed_at`, `metric`, `value`, `unit`, `coverage` | 统一地块级观测，不混入结论 |
| `quality_assessment` | `subject_type`, `subject_id`, `flags`, `usable_fraction`, `details` | 质量状态独立建模，不用零值代替缺测 |
| `artifact` | `task_id`, `kind`, `uri`, `sha256`, `mime_type`, `size_bytes` | 对象存储产物索引与完整性校验 |
| `analysis_result` | `id`, `task_id`, `kind`, `tool_version`, `status`, `summary`, `sources`, `findings`, `result`, `artifacts`, `limitations`, `next_actions`, `error`, `created_at` | 工具返回和后台保存使用同一结果对象；业务工具按任务和类型读取；不再另设 Agent 结果或地块评估表 |
| `review` | `task_id`, `reviewer_id`, `status`, `decision`, `reason` | 高风险内容发布门 |
| `report` | `task_id`, `version`, `kind`, `status`, `review_id`, `artifact_id`, `published_at` | 分析报告通过质量门后可发布；专家报告必须关联已通过的复核；旧版本不覆盖 |
| `field_feedback` | `field_id`, `task_id`, `observed_at`, `finding`, `photos`, `adopted` | 现场事实和采用情况回链原任务 |
| `knowledge_source` | `id`, `title`, `source_type`, `crop`, `regions`, `varieties`, `stages`, `capabilities`, `authors`, `publisher`, `identifier_type`, `identifier`, `publication_year`, `version`, `license_status`, `status`, `content_ref` | 管理论文、书籍、标准和地方材料的来源、许可、适用范围和版本；不保存 GraphRAG 派生实体 |
| `knowledge_index_run` | `id`, `graphrag_version`, `config_sha256`, `prompt_version`, `chat_model_ref`, `embedding_model_ref`, `source_set_sha256`, `input_manifest_ref`, `output_tables_ref`, `vector_store_type`, `vector_store_ref`, `status` | 记录一次可重放的官方 GraphRAG 索引及 Parquet/LanceDB 位置 |
| `knowledge_index_run_source` | `index_run_id`, `source_id`, `source_version`, `content_sha256` | 冻结每次索引使用的合法来源版本 |

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
agent task result / optional report statement
  -> analysis_result
  -> observation / quality_assessment
  -> processing_run / tool_run + parameters + tool_version
  -> acquired_asset + source_acquisition_result + acquisition_run
  -> dataset / provider catalog
  -> artifact URI + checksum
```

## 6. Codex 对话与功能工具链

### 6.1 两条运行链路

生产系统通过 `@openai/codex-sdk` 创建纯对话线程或一次性结构化生成线程。每个线程固定模型、只读沙箱、`approvalPolicy: never`、关闭网络和 Web Search，并在配置的工作目录运行。运行结果出现 command、file change、MCP 或 Web Search 事件时判为失败；文档生成通过范围、契约与引用校验，具体边界以 [agent.md](agent.md) 第 7 节为准。

功能面板不调用 Codex 规划工具。每项业务能力由版本化 Workflow 按代码声明的顺序调用项目内受控工具。一次业务任务可以包含多次 `agent_run`，但业务任务状态始终由领域状态机控制，Codex thread 或 Workflow 内存状态不能替代业务事实。计算完成后，模型读取结果撰写分析文档；失败保留计算摘要，声明处方建议时追加专业复核状态。

```text
draft -> planned -> running -> needs_input -> running
                            -> needs_data
                            -> needs_review -> completed
                            -> partial
                            -> completed
                            -> failed
                            -> cancelled
```

Workflow 的 start、step、tool 和 finish 事件映射到 `agent_run`、`task_step` 与 `tool_run`。只有事件与结果完成数据库 flush 后，本次 run 才视为稳定落盘。`completed` 表示结构化结果达到全部完成条件；`partial` 表示已形成范围受限但可交付的结果；高风险建议保持 `needs_review`。是否导出报告不改变任务完成状态。

### 6.2 Codex 对话构造

每次对话调用由项目运行时创建，固定记录：

- Codex SDK 版本、model ID 和 reasoning effort；
- system prompt 与上下文构造策略版本；
- Codex thread ID、业务 task ID、organization scope 和用户身份；
- 沙箱、审批、网络和搜索策略。

服务端只向 Codex 发送 system prompt、最近对话、当前用户消息、经过筛选的任务事实，以及解释类问题所需的知识检索结果。UI 进度、完整审计事件、内部权限细节、存储路径和敏感字段留在应用侧。完整消息历史保存在 PostgreSQL，不被发送给模型的裁剪上下文覆盖。

### 6.3 Workflow 职责

不同业务能力通过版本化 Workflow 和工具注册表隔离。Workflow 遵守以下共同边界：

1. 读取创建任务时已经确定的能力、地块、时段和输入快照；
2. 只读取已经完成或部分完成的 `AcquisitionRun`；
3. 按固定顺序调用当前能力允许的确定性工具；
4. 根据结构化状态继续、停止、请求输入或请求补充数据；
5. 输出结构化结果、来源日期、限制和下一步动作；
6. 将高风险农业建议送入专业复核门。

业务能力与完成标准：

| 能力 | 允许的工具 | 必须返回 | 完成标准 |
|---|---|---|---|
| 关键生育期长势监测 | 时序光学、雷达、物候阶段、历史比较 | 生育期状态、长势分级、空间差异、变化时间、证据日期 | 有合格时序观测或明确数据缺口；产量潜力必须标记模型版本和验证范围 |
| 水氮协同诊断 | 同日光学多指标、生育期、14 天内同轨雷达、包含参考日的天气窗口、地形与土壤背景；现场记录由用户明确选择 | 田况页先独立浏览；Agent 先交付光谱差异，只有独立同向证据才形成水分或氮素核查方向 | 单期光学指标不命名为水氮原因区；未参与背景不混入来源；没有本地验证模型时不输出处方 |
| 农田积水灾害识别 | 强降雨过程、灾前/灾后 Sentinel-1、地块统计 | 积水多边形、受影响面积、观测时间、质量和核查优先级 | 具有合格雷达时相与覆盖；无基线或无覆盖时显式返回 |
| 霜冻风险提前预警 | 温度预报、DEM/低洼性、生育期、历史气象 | 风险等级、空间高亮区、预警时效、触发依据 | 明确预报生成/有效时间和不确定性，不把风险预警写成灾害事实 |

上表描述能力目标，不等于当前每条链路已经融合全部可选来源。V0.1 首条可执行长势链路固定为 `analyze_optical_condition -> estimate_crop_stage -> assess_growth_status`，其缺数补采 profile `growth_stage_v1` 当前只包含 Sentinel-2；雷达融合仍是后续升级，不能在现阶段结果或采集进度中暗示其已经参与。地块数据目录继续使用 `field_baseline_v1` 维护六类来源。

Codex 对话和结果编辑运行在独立空目录和只读沙箱中，关闭网络、搜索和审批式扩权，不直接访问数据库、对象存储、供应商 API 或功能工具。数据库访问和 Python runner 调用隐藏在确定性 Workflow 的领域工具适配器内部。

场景检索、质量检查、时空对齐、指标计算、历史对比和质量门由版本化领域 Workflow 按固定步骤执行。对话 Agent 不拼装这些步骤，也不得修改工作流产生的指标值、空间范围或质量状态。自然语言可以变化，结构化分析结果必须由相同输入快照、数据版本、工具版本和参数稳定重放。

### 6.4 事件、恢复与终止

- API 把 Workflow hooks 转换成稳定项目事件并通过 SSE 推送；前端不依赖 SDK 或工具内部 payload。
- 用户补充地块、时段或任务口径时，先生成经过校验的业务命令，再由领域层决定恢复或新建任务。
- 用户取消任务时先写入取消意图，停止后续步骤，再完成状态收敛和资源清理。
- 重试以任务快照、幂等键和已经落盘的步骤状态为依据，不能重复产生副作用。
- 单个工具结束不代表业务任务完成；领域状态机仍执行质量门和发布门。

### 6.5 工具治理

工具使用 TypeBox 定义参数，schema 是调用契约的单一事实来源，同时用于运行时校验、文档和契约测试。

- before hook 在参数通过解析后检查 organization scope、地块授权、任务状态、工具 allowlist、幂等键和并发限制；失败时阻止调用并返回可解释原因。
- after hook 登记 observation、artifact、quality、limitations 和成本，并清理不应进入公共结果的供应商字段。
- 无副作用、相互独立的数据检索只有在 Workflow 明确声明时才能并行。
- 依赖共享临时资源、写入领域事实、发布报告、提交复核或反馈的步骤保持串行。
- 工具失败转换成稳定的 `AnalysisResult<T>` 状态或受控领域错误，不得伪装成成功内容。
- 完整诊断写入应用日志和 `tool_run`，前端只接收完成任务所需的简短进度。

所有工具使用 [Agent 设计](agent.md) 定义的 `AnalysisResult<T>`。完整参数、供应商响应、性能记录和真实存储路径留在所属模块；Codex 对话只看到经过筛选的结果摘要和知识上下文。

### 6.6 Workflow 领域工具

| 工具 | 输入 | 输出 |
|---|---|---|
| `analyze_optical_condition` | `taskId` | 光学时序、日期变化、田内光学异常区和来源日期 |
| `analyze_radar_change` | `taskId` | 后向散射变化、空间变化区和来源日期；不直接输出湿度 |
| `analyze_weather_event` | `taskId` | 降雨、低温、积温时间窗口和来源日期；不生成田内分区 |
| `analyze_terrain_susceptibility` | `taskId` | 低洼、坡度或冷空气汇聚易发区和来源日期 |
| `get_soil_background` | `taskId` | 地块级 SoilGrids 背景和尺度限制；不生成田内土壤分区 |
| `estimate_crop_stage` | `taskId` | 基于播期、积温、品种和光学辅助信息的生育阶段证据 |
| `assess_growth_status` | `taskId` | 生育期、长势、趋势、光学差异区、地图和限制 |
| `assess_water_nitrogen_evidence` | `taskId` | 同日光谱差异、独立支持背景、原因待分离或有支持的核查分区、来源角色和核查动作 |
| `detect_waterlogging` | `taskId` | 疑似积水多边形、面积、日期、持续性和核查优先级 |
| `assess_frost_risk` | `taskId` | 风险时段、空间关注区、提前量、触发依据和动作 |
| `search_agronomy_knowledge` | `taskId`, `query` | 东北黑土地玉米知识、适用范围和论文/书籍/标准出处 |

一次 run 只允许当前 Workflow 声明的证据工具和对应业务判断工具。业务工具只接收 `taskId`，由服务端按最小证据矩阵解析兼容证据。日期比较、空间对齐、统计、分区矢量化和产物生成是内部模块，不暴露给 Codex。知识检索在对话调用前由服务端按需执行；报告渲染、专业复核和现场反馈属于交付/复核模块；外部数据源访问由 `acquisition-worker` 独立处理。

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
| `POST /api/v1/acquisitions` | 创建独立数据采集作业，不经过 Agent |
| `GET /api/v1/acquisitions/{id}` | 查询来源分类、数据日期、覆盖、质量、许可和失败原因 |
| `POST /api/v1/tasks` | 指定 `capability` 和 `acquisitionRunId` 创建受约束农情 Agent 任务 |
| `GET /api/v1/tasks/{id}` | 查询状态、步骤和诊断 |
| `GET /api/v1/tasks/{id}/result` | 获取当前 Agent 的结构化任务结果 |
| `GET /api/v1/tasks/{id}/events` | SSE 任务进度流 |
| `POST /api/v1/tasks/{id}/steer` | 长期规划：向支持中断的运行任务追加受控纠偏输入 |
| `POST /api/v1/tasks/{id}/follow-ups` | 排队处理非紧急追加请求 |
| `POST /api/v1/tasks/{id}/cancel` | 记录取消并中止当前 run |
| `POST /api/v1/tasks/{id}/retry` | 按失败语义重试 |
| `GET /api/v1/tasks/{id}/assessments` | 地块排序、依据与限制 |
| `GET /api/v1/tasks/{id}/analysis` | 来源、质量和分析结果详情 |
| `POST /api/v1/tasks/{id}/reviews` | 提交专业复核 |
| `POST /api/v1/tasks/{id}/publish` | 通过发布门后生成报告 |
| `POST /api/v1/tasks/{id}/feedback` | 提交现场巡田反馈 |
| `GET /api/v1/reports/{id}` | 获取报告元数据和下载地址 |

API 只返回稳定领域 schema；Pi 原始事件、供应商字段、内部 prompt、完整模型上下文和对象存储真实路径不进入公共契约。SSE 事件统一为 `task.status`、`agent.message.delta`、`tool.started`、`tool.progress`、`tool.completed`、`task.needs_input`、`task.needs_review` 和 `task.failed` 等应用事件。

## 8. 前端信息架构

产品采用“普通用户任务端 + 专家复核端”两套信息层级。遥感、GIS 和 Agent 复杂度留在后台，不要求种植户学习专业概念。

### 普通用户任务端

普通用户先选择地块并进入默认“田况”页，通过光学、雷达、地形、天气、土壤五个来源视图直接查看已有观测；这一步不需要先运行 Agent。光学视图展示最近可用日期、田内空间差异、标准指数图层和本季变化；雷达与地形视图控制真实地图图层；天气与 SoilGrids 只用图表表达时间或地块背景，不伪装成田内分区。用户可以从某个观测日期继续发起对应农情能力，所选日期进入任务上下文。报告不是默认入口。

任务结果直接回答四个问题：

1. **这块田现在怎么样**：用“整体正常”“长势偏弱”“变化明显”等清晰状态概述；
2. **问题在什么位置、怎么变化**：在地块图上标出差异区域，并展示与历史或邻近时段的变化；
3. **分析依据是什么**：展示使用的资料日期、时间对比和关键分析图层。
4. **下一步做什么**：需要时生成巡田位置、优先级、核查事项和反馈入口。

发起任务优先使用对应能力的预设入口，例如“监测关键生育期长势”“诊断水氮限制”“识别雨后积水”“查看未来霜冻风险”。自然语言是补充方式，不展示算法选择、阈值、坐标系或工具参数。

用户添加地块后，为该地块的当前种植季选择作物。合作社可以先多选地块批量设置同一种作物，再进入单个地块修改；播种日期和品种为可选项。作物选择决定生育期、时间窗口和专项解释规则。V0.1 的选择器允许记录其他作物，但只有玉米可以启动完整专项分析；界面直接显示支持状态，不使用玉米规则代替其他作物规则。

普通用户只看到四类状态：正在分析、需要补充信息、正在准备可用资料、任务结果已就绪。后台技术状态映射成易懂文本；需要专家审核时显示“正在审核”，不伪装成已完成。

地图以农田边界、田内分析分区、变化图层和时间对比为核心。田况页允许直接切换 NDVI、对比 NDVI、红边、水分、Sentinel-1 VV/VH/变化和 DEM 图层；云量、有效像元覆盖、处理参数和工具日志进入“数据”或“分析依据”。进入天气或土壤视图时回到卫星底图，避免暗示粗分辨率背景形成了田内空间结论。只有云量或数据时效确实改变当前结论时，才在对应结果中标注该事实。

V0.1 先完成桌面 Web 的地块设置、任务发起、Agent 结果、地图证据和可选导出流程。移动端、小程序、照片与现场反馈在试点闭环阶段实现；届时重点优化大按钮、弱网、语音输入和异常区域定位。

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
- `acquisition-worker`：独立数据发现、抓取、校验和 manifest 登记进程；
- `agent-worker`：执行确定性领域 Workflow 的后台进程；
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
| 契约测试 | 采集任务、manifest、TypeBox 工具 schema、Python runner、provider 适配器与统一 envelope |
| Agent 运行时测试 | Codex 安全配置、对话上下文、Workflow hooks、步骤顺序和失败语义 |
| 集成测试 | acquisition-worker、Codex 对话、PostGIS、对象存储、任务执行、报告版本和复核门 |
| 回归评测 | 正常、云污染、缺测、冲突证据、无授权、工具超时 |
| 端到端测试 | 导入地块 -> 独立采集 -> 选择农情能力 -> 结构化结果与证据 -> 可选地图/报告产物 |
| 安全测试 | 组织隔离、越权访问、签名 URL、日志脱敏和密钥检查 |

首个纵向切片完成标准：

- 所有迁移可在空数据库执行并可回滚；
- 一项任务可以成功运行，也能对每类预期失败返回明确状态；
- `agent_end` 后 run、message、event 与 tool_run 均完整落盘；
- `beforeToolCall` 能阻止越权、超预算和非法状态调用；
- 上下文压缩后仍保留任务口径、证据限制和待处理输入；
- 每项农情能力的结果有可定位证据或明确标为待确认；
- 同一任务可以重放并比较工具版本、数据版本和结果差异；
- 桌面端完成地块、种植季、数据采集、农情能力选择、任务结果和证据全流程；
- 代码库不包含密钥、未脱敏真实地块和运行时大文件。

## 12. 建议实施顺序

1. 建立 TypeScript workspace、Python geo package、配置、迁移和统一 ID/时间/空间约定；
2. 实现组织、地块、授权、作物季、task_field、analysis_task、acquisition_run 和 manifest 模型；
3. 实现独立 `acquisition-worker`、provider 接口、来源结果、资产索引和模拟采集测试；
4. 接入 Sentinel-2 与 DEM，完成按地块/时间窗口的检索、日期、覆盖率、质量、许可和失败原因登记；
5. 接入 Sentinel-1、ERA5-Land、ECMWF IFS 0.25°免费公开子集和 SoilGrids，保持统一 manifest 头部并保留各自质量字段；
6. 精确锁定 `@openai/codex-sdk`，实现对话、结构化文档生成运行时和边界测试；
7. 实现确定性分析工具、TypeBox 注册表、before/after hooks、统一 `ToolResult` 和 Python runner 协议；
8. 实现领域状态机、Workflow 事件映射、消息落库和对话上下文构造；
9. 让 Workflow 只以 `taskId` 调用当前能力的受控深工具，由工具内部解析采集清单和产物，完成第一版证据、农情解释和田内异常区域；
10. 完成地图任务台、SSE 状态、地块结果、报告和专业复核；
11. 通过 V0.1 质量门后再启用 BullMQ/Redis、完整账号隔离和试点部署。

## 13. 待确认决策

这些事项不阻塞 V0.1 骨架，但在对应实现开始前需要形成 ADR：

- CDSE、ERA5-Land、ECMWF IFS 0.25°公开子集和 SoilGrids 的生产访问方式、免费额度与自有计算存储成本；
- 首期模型 provider、模型 ID、成本上限和密钥托管方式；
- Codex SDK 升级策略，以及线程、事件、安全配置和模型兼容测试；
- 是否已有高德地图前端或空间分析代码需要迁移复用；
- 首批真实地块的授权格式、数据字段和脱敏要求；
- 第一版农情状态、变化与异常区域由哪些可解释指标组成，以及质量阈值；
- 专业复核人员、审核范围和报告签发责任；
- 试点部署位置、预算、网络条件与数据保留期限。
