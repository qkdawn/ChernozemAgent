# ChernozemAgent

黑土智管是面向种植户、合作社和基层农业服务人员的玉米农田遥感分析智能体。当前版本提供可运行的任务工作台和最小 Pi Agent 运行基线。

## 当前能力

- pnpm + TypeScript 单仓工作区；
- 精确锁定 `@mariozechner/pi-agent-core` 与 `@mariozechner/pi-ai` 0.73.1；
- 集中的 Pi `Agent` 工厂和最小农情 system prompt；
- 只读、具备 TypeBox schema 的任务范围工具；
- `beforeToolCall` 地块 scope 与工具 allowlist 校验；
- 不保存消息正文的 Agent 生命周期事件记录；
- 使用 Pi faux provider 的无密钥测试。
- Fastify 任务 API 与显式任务状态；
- React + MapLibre 农田工作台，提供地块、时段和分析目标的工作流界面；
- PlanetScope 连接状态检查与 Esri 卫星底图。

当前版本不预置任何示例地块或演示农情结论。地块边界通过 PostGIS 保存，支持地图绘制和 GeoJSON 导入；真实 PlanetScope 影像分析链路仍在接入中。系统没有向 Agent 暴露 shell、SQL、文件或任意网络工具。

## 环境要求

- Node.js 22 或更高版本；
- pnpm 11.9.0。

## 本地验证

```bash
pnpm install
pnpm typecheck
pnpm test
```

测试使用 Pi 自带的 faux provider，不消耗模型额度。

## 启动工作台

先启动 PostGIS。首次启动会自动执行地块表迁移：

```bash
docker compose up -d postgis
```

在本地 `.env` 配置 `.env.example` 中的 `DATABASE_URL` 后，运行：

```bash
pnpm dev
```

启动后访问 `http://localhost:5173`。Web 开发服务器会将 `/api` 请求代理到 `http://localhost:3001` 的本地 API。

### 地块管理

- 在地图上绘制多边形，双击结束；选中后可拖动顶点，地图右上角删除控件可清除当前边界；
- 保存时校验坐标、闭合边界、自相交和面积范围；
- 支持导入 `GeoJSON FeatureCollection`，每个 Polygon 建立一块地；
- `POST /api/v1/fields`、`PATCH /api/v1/fields/:id`、`DELETE /api/v1/fields/:id` 与 `POST /api/v1/fields/import` 提供对应的受控 API。

## 真实模型 Smoke Test

参考 `.env.example` 配置所选 provider 的模型 ID 和 API key，并将变量注入当前终端，然后运行：

```bash
pnpm agent:smoke
```

该命令只验证“用户输入 -> Pi Agent -> 受控任务范围工具 -> 中文结果 -> 生命周期事件”链路，不执行遥感分析。

## 目录

```text
apps/agent-worker/          # Pi Agent 运行入口
apps/api/                   # Fastify 任务 API
apps/web/                   # React + MapLibre 农田工作台
packages/contracts/         # 前后端共享领域契约
packages/agent-runtime/     # Agent 工厂、受控工具、scope 校验和事件记录
docs/                       # 架构与调研文档
```
