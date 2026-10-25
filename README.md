# ChernozemAgent

黑土智管是面向种植户、合作社和基层农业服务人员的玉米农田智能 Agent 工作台。产品提供纯粹的农情对话，以及关键生育期长势监测、水氮协同诊断、农田积水灾害识别和霜冻风险提前预警四项独立功能工作流；报告只是任务结果的可选导出形式。普通对话使用开源 Codex harness，功能工作流使用受控、可重放的确定性工具链。

## 当前能力

- pnpm + TypeScript 单仓工作区；
- 精确锁定官方 `@openai/codex-sdk`，由 Codex harness 承载普通对话；
- Codex 对话运行在独立空目录、只读沙箱中，关闭网络和审批式扩权；
- 功能工作流只消费已校验 task scope 和注册的领域工具；
- 不保存消息正文的 Agent 生命周期事件记录；
- 支持 OpenAI API 与兼容的 `CODEX_BASE_URL`，并保留稳定的功能工作流轨迹；
- 使用 runtime port fake 的无密钥测试。
- Fastify 任务 API 与显式任务状态；
- React + MapLibre 农田工作台，提供地块、时段和分析目标的工作流界面；
- Esri 卫星底图与地块空间工作区；
- Sentinel-1、Sentinel-2、Copernicus DEM、ERA5-Land、ECMWF IFS 0.25°免费公开子集与 SoilGrids 的统一数据采集设计。
- 独立数据采集 API、版本化 manifest 与 Postgres 采集记录；
- 六类真实上游目录发现：CDSE STAC/OData、CDS 产品目录、ECMWF Open Data 与 SoilGrids WCS；
- 选择地块后自动检查最近 30 天数据，并在地块数据页展示日期、覆盖、许可和失败原因。
- 受控长势 Skill：`analyze_optical_condition` → `estimate_crop_stage` → `assess_growth_status`；
- Sentinel-2 L2A 地块裁剪、SCL 有效像元过滤、NDVI/NDRE 统计、多时相变化和田内差异地图；
- 长势结果会对相邻可用日期的空间近邻偏弱分区做保守关联，标记持续、扩大、减弱、新出现或暂不可比较，并把对应的判断目的带入下一步动作；
- 缺影像、云污染、无覆盖、单一时相和缺少播种日期时返回明确的 `needs_data`、`partial` 或 `needs_input`。
- 分析任务和统一结果写入 PostgreSQL，API 重启后仍可按任务 ID 复查。
- 用户可围绕一条不可变分析任务继续追问；对话不会重新采集或静默重跑分析。
- 独立只读知识 MCP、GraphRAG 3.1.1 Local Search 适配器和可追溯 text unit 引用同步管线；没有索引时不影响农情任务。

当前版本不预置任何示例地块或演示农情结论。地块边界通过 PostGIS 保存，支持地图绘制和 GeoJSON 导入。六类来源均已具备目录发现、下载或地块裁取 worker 和统一采集清单；积水与水氮的 Sentinel-1 采集配置会选择同轨双时相并复用已有文件。Sentinel-1/2 按地块下载需要 CDSE Sentinel Hub OAuth client，DEM 需要 CDSE CCM 权限，缺少凭据或权限时返回明确状态。所有分析工具只读取已登记的采集产物，数据下载不由 Agent 执行；系统没有向 Agent 暴露 shell、SQL、文件或任意网络工具。

ERA5-Land 已支持按地块周边网格和时间窗口下载 NetCDF。API 运行环境需安装 `apps/api/requirements.txt`，并通过根目录 `.env` 提供新版 CDS Personal Access Token `CDS_API_KEY`；Token 不进入命令行、日志或采集产物。

## 设计文档

- [农情 Agent 工具体系完整设计（待实施）](docs/farm-agent-tool-system-plan.md)
- [黑土农情四类工作流的价值调研与试点优先级](docs/workflow-value-research.md)
- [总体架构与阶段计划](docs/architecture-plan.md)
- [Sentinel、DEM、天气与土壤的统一数据采集设计](docs/multisource-data-acquisition.md)
- [黑土农情 Agent 工具集与契约](docs/ai-tool-contracts.md)
- [辽宁春玉米知识库、已核验来源与检索接入](docs/knowledge-base.md)

## 环境要求

- Node.js 22 或更高版本；
- pnpm 11.9.0。

## 本地验证

```bash
pnpm install
pnpm typecheck
pnpm test
```

测试使用本地 fake runtime，不消耗模型额度。

## 启动工作台

先启动 PostGIS。首次启动会自动执行全部迁移：

```bash
docker compose up -d postgis
```

在本地 `.env` 配置 `.env.example` 中的 `DATABASE_URL` 后，运行：

```bash
pnpm dev
```

启动后访问 `http://localhost:5173`。Web 开发服务器会将 `/api` 请求代理到 `http://localhost:3001` 的本地 API。

已有本地数据库在拉取新版本后，需要手动执行新增迁移一次：

```bash
docker compose exec -T postgis psql -U chernozem -d chernozem -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/002_field_management.sql
docker compose exec -T postgis psql -U chernozem -d chernozem -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/003_data_acquisition.sql
docker compose exec -T postgis psql -U chernozem -d chernozem -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/004_knowledge_base.sql
docker compose exec -T postgis psql -U chernozem -d chernozem -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/010_knowledge_text_units.sql
docker compose exec -T postgis psql -U chernozem -d chernozem -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/011_knowledge_source_licenses.sql
docker compose exec -T postgis psql -U chernozem -d chernozem -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/005_analysis_results.sql
docker compose exec -T postgis psql -U chernozem -d chernozem -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/006_analysis_tasks.sql
docker compose exec -T postgis psql -U chernozem -d chernozem -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/007_field_scouting_notes.sql
docker compose exec -T postgis psql -U chernozem -d chernozem -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/008_agent_runs.sql
docker compose exec -T postgis psql -U chernozem -d chernozem -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/009_task_conversation.sql
docker compose exec -T postgis psql -U chernozem -d chernozem -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/012_variable_nitrogen_prescriptions.sql
```

建立首版农情知识库（9 篇开放论文、5 个仅引用官方来源）：

```bash
docker compose exec -T postgis psql -U chernozem -d chernozem -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/014_local_knowledge.sql
pnpm --filter @chernozem/knowledge-mcp knowledge:build-local
pnpm --filter @chernozem/api knowledge:verify-local
```

在 `.env` 中启用知识检索并重启 API：

```dotenv
KNOWLEDGE_MCP_ENABLED=true
KNOWLEDGE_SEARCH_ENGINE=local
```

默认使用本地中英概念检索，返回可追溯原文，无需 chat/embedding 凭据建立索引。知识只解释农情线索，不能替代现场观测或验证。GraphRAG 保留为可选引擎；已核验来源、许可、方法限制与复现步骤见 [知识库文档](docs/knowledge-base.md)。

没有 PostGIS、只需要调试界面和公开数据目录时，可运行 `pnpm --filter @chernozem/api dev:memory`。该模式的地块和采集记录会在 API 重启后清空。

### 地块管理

- 在地图上绘制多边形，双击结束；选中后可拖动顶点，地图右上角删除控件可清除当前边界；
- 保存时校验坐标、闭合边界、自相交和面积范围；
- 地块归属固定到当前示范组织，后端按授权范围校验，不允许把边界保存到授权范围外；
- 修改边界自动形成新边界版本；跨年份保存作物信息时，保留旧种植季；右侧详情展示边界版本与种植季数量；
- 支持导入 `GeoJSON FeatureCollection`，每个 Polygon 建立一块地；
- `POST /api/v1/fields`、`PATCH /api/v1/fields/:id`、`DELETE /api/v1/fields/:id`、`GET /api/v1/fields/:id/history` 与 `POST /api/v1/fields/import` 提供对应的受控 API。

当前是单个“铁岭示范账户”的开发配置，组织 ID 由后端配置固定。正式多账号登录、成员角色和每个用户的组织解析仍属于下一阶段，不能将该演示配置视为完整的身份认证系统。

## 工作流 Smoke Test

```bash
pnpm agent:smoke
```

该命令验证“已校验任务 -> 三个长势工具 -> 结构化结果 -> 生命周期事件”链路，不调用模型，也不读取真实遥感资产。Codex 对话通过 API 启动时读取 `.env` 中的 `CODEX_MODEL`、可选 `CODEX_BASE_URL` 和 `OPENAI_API_KEY`。

## 目录

```text
apps/agent-worker/          # 确定性功能工作流 smoke 入口
apps/api/                   # Fastify 任务 API
apps/web/                   # React + MapLibre 农田工作台
packages/contracts/         # 前后端共享领域契约
packages/agent-runtime/     # Codex 对话 runtime、功能工作流和事件记录
docs/                       # 架构与调研文档
```
