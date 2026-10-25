# 黑土智管 Agent 开发经验与相似项目调研

> 调研日期：2026-07-25
> 目标：为“多源遥感农情智能体”筛选可复用的 Agent 工程经验、相似开源项目、评测方法和风险控制方案。
> 说明：GitHub 星数和仓库状态是调研日快照；论文预印本不等同于经过同行评审或生产验证。

## 1. 结论摘要

没有一个现成项目同时覆盖黑土智管需要的全部能力。最合理的参考组合是：

| 参考对象 | 借鉴内容 | 不直接照搬的部分 |
|---|---|---|
| Codex harness | 对话线程、流式事件、恢复、沙箱和审批策略 | Coding Agent 的 Shell、文件、MCP 与网络能力 |
| RS-Agent | 中央控制器、遥感工具集、任务解法空间、领域知识空间 | 默认 stub 工具、偏图像处理的任务范围、只看规划准确率 |
| GeoAgent | 自然语言多步 GIS、算法发现、参数填充、失败重试、执行日志 | 对本地 QGIS 状态的强依赖、开放算法注册表 |
| GeoBenchX | 可解与不可解任务、拒绝工具、完整轨迹、参考答案和评测集 | 纯 LLM-as-Judge 作为唯一质量判定 |
| LLM-Geo | solution graph、自动数据处理、代码执行与结果可视化 | 任意代码生成执行、弱隔离、高 token 成本、约 80% 自述成功率 |
| Arion | MapLibre 地图、聊天与工具联动、跨平台 UI、知识库 | MCP 任意扩展直接进入生产权限面 |
| Farmer.Chat | 面向真实农业用户、知识接地、多语言与现场服务设计 | 以问答/RAG 为主，缺少遥感任务和地块证据链 |
| AgroTools / GeoBenchX | 农业与地理空间工具调用评测 | 仅用通用 benchmark 替代铁岭玉米场景评测 |

黑土智管应采用“一名受控编排 Agent + 深领域工具 + 明确拒绝/补充输入 + 专业复核”的后台结构，但产品形态必须是面向普通种植户的巡田服务，而不是 GIS Agent。首期不需要多 Agent，也不应允许模型生成任意遥感代码直接执行，更不能要求用户选择算法、填写遥感参数或阅读工具日志。

RS-Agent、GeoAgent、LLM-Geo 和 Arion 的价值只在后台工程层：工具如何组织、任务如何执行、失败如何追踪。面向用户的直接参考应更多来自 Farmer.Chat 一类低门槛农业服务，以及真实巡田、语音交互、小程序和基层农技服务流程。

## 2. Agent 开发的共识经验

### 2.1 先做工作流，再放开自主性

Anthropic 的工程建议区分 workflow 与 agent：固定流程适合步骤可预判、责任边界清晰的任务；Agent 适合步骤需要根据中间结果动态决定的任务。对于黑土智管：

- 地块授权、数据质检、时空对齐、质量门、专业复核和报告发布采用确定性 workflow；
- 农情工具组合和顺序由版本化 Workflow 决定；Codex 承担解释、追问、纯对话和受控结果文字编辑，不参与业务分析；
- 只有稳定的单 Agent 任务链通过评测后，才考虑规划器、执行器、审核器等多 Agent 分工。

### 2.2 Agent 运行状态不能替代业务状态

多数框架提供 message、turn、tool call 和 session，但这些只是运行时状态。生产系统仍需单独保存：

- 谁授权了哪些地块；
- 当前业务任务处于 running、needs_input、needs_review 或 completed；
- 哪个数据版本和工具版本产生了哪条证据；
- 谁审核和发布了报告；
- 现场反馈是否支持原判断。

Codex thread 只保存对话运行状态；PostgreSQL 中的 `analysis_task`、`agent_run`、`tool_run`、`analysis_result` 和 `review` 才是业务事实。

### 2.3 工具要窄、深、结构化

成熟项目通常把 GIS/遥感能力包装成工具，而不是让 LLM 自己计算。好工具具有：

- 语义明确的名称和 description；
- 受约束的参数 schema、单位、坐标和时间约定；
- 质量、覆盖、限制、失败类型和产物引用；
- 幂等键、版本、成本和可重放输入；
- 内部处理供应商差异、重试和数据清洗。

避免注册 `run_python`、`execute_sql`、`call_url` 之类宽工具。它们虽然演示灵活，但难以审计、授权和复现。

### 2.4 明确允许“无法完成”

GeoBenchX 专门加入 `reject_task()`，并把不可解任务纳入 benchmark。其结果显示，不同模型在“解题能力”和“识别不可解”之间存在明显差异。黑土智管需要把拒绝设计成产品能力：

- `needs_input`：缺地块、作物、时段、授权或必要资料；
- `insufficient_evidence`：覆盖、时效、有效像元或多源证据不足；
- `needs_review`：涉及高风险农业解释；
- `unsupported_task`：超出玉米巡田首期边界；
- `failed`：工具或基础设施错误。

Agent 不应为了“给出答案”把这些状态改写成推测性结论。

### 2.5 评测工具轨迹，不只评测最终文本

RS-Agent 重点测工具规划，GeoBenchX 保存完整 conversation/tool history，Codex 提供线程与流式事件。黑土智管的评测单位应至少包含：

- 任务意图是否正确；
- 选择的数据和工具是否合适；
- 参数、单位、坐标系和时间窗口是否正确；
- 工具是否成功，失败后动作是否合理；
- 是否遗漏质量限制；
- 田块排序是否能由证据重建；
- 是否正确拒绝不可解任务；
- 是否越过专业复核边界；
- 最终报告是否与结构化事实一致。

### 2.6 评测集必须包含反例

仅测试正常任务会高估 Agent。建议建立以下样本族：

| 样本族 | 代表问题 |
|---|---|
| 正常 | 数据齐全，单块玉米田农情状态、时序变化和田内差异分析 |
| 缺授权 | 用户请求分析未授权地块 |
| 缺覆盖 | 时间窗口没有可用遥感场景 |
| 质量差 | 云污染、低有效像元、雷达异常噪声 |
| 尺度冲突 | 数据空间分辨率不足以支持地块级结论 |
| 证据冲突 | 光学、雷达与气象信号不一致 |
| 不可解 | 请求预测确定产量或直接给施肥处方 |
| 工具失败 | 超时、限流、供应商错误和产物损坏 |
| 注入攻击 | 外部文档或数据字段含工具调用指令 |
| 重放 | 相同输入、固定版本应得到一致结构结果 |

### 2.7 人在回路要成为状态机，而不是按钮

农业高风险建议需要显式发布门：

1. Agent 形成 observation、inference、limitation 和 inspection question；
2. 领域规则判断是否进入 `needs_review`；
3. 专家查看证据、修订内容并记录理由；
4. 发布端再次校验 review 状态；
5. 报告保留审核前后版本。

“页面上有审核按钮”不足以保证责任边界，后端必须拒绝未经审核的发布请求。

### 2.8 上下文管理是数据产品问题

长任务不能依赖无限消息历史。服务端构造 Codex 对话上下文时应：

- 保留当前任务口径、授权摘要、最近有效证据和未解决缺口；
- 把完整审计事件、UI 消息和敏感字段留在模型上下文之外；
- 对旧消息做版本化摘要，完整原文继续保存在数据库；
- 任务重放以结构化快照为基础，不以自然语言摘要作为唯一事实。

### 2.9 并行只用于无副作用工作

Workflow 只有在步骤彼此独立且无副作用时才并行。适合并行的任务包括不同数据源检索、只读元数据查询和独立质量检查。以下操作应串行：

- 写入任务事实；
- 消耗共享临时资源；
- 专业复核；
- 报告发布；
- 现场反馈；
- 计费或额度扣减。

### 2.10 成本、时延和终止条件必须可观测

每次 run 记录模型、token、工具时间、外部调用、计算资源、人工审核工时和最终状态。内部限制至少包括：

- 最大 turn 数；
- 最大工具调用次数；
- 单工具重试次数；
- 单任务模型与计算预算；
- 总执行时限；
- 连续相同失败的终止条件。

这些限制由运行时和领域代码执行，不只写在 prompt 中。

### 2.11 外部内容按不可信输入处理

遥感产品说明、STAC metadata、用户上传文件、网页和知识库文本都可能包含异常或恶意内容。防护包括：

- 外部文本不能直接改变 system prompt、工具 allowlist 或 organization scope；
- `beforeToolCall` 重新验证授权、预算和状态；
- 数据工具只返回业务所需字段；
- 报告渲染转义不可信文本；
- 对模型不可见的审计日志保留原始来源摘要；
- Codex SDK 与其他第三方依赖在安装前审查来源并锁定版本。

## 3. 高相似度项目

### 3.1 RS-Agent

- 仓库：[IntelliSensing/RS-Agent](https://github.com/IntelliSensing/RS-Agent)
- 定位：LLM 中央控制器编排遥感处理工具，并结合 Solution Space 和 Knowledge Space。
- 能力：云去除、去雾、超分、光学/SAR 检测、分割、土地利用分类、知识检索等 18 类工具。
- 对黑土智管的价值：证明“领域解法检索 + 专用工具 + 中央控制器”比通用视觉问答更接近专业遥感工作。
- 注意：README 明确说明默认工具包含用于规划评测的 stub；真实推理需要逐个安装上游模型。其高规划准确率不能等同于端到端遥感结果准确率。
- 建议复用：Solution Space 思路、工具目录和规划评测方法，不直接复制工具依赖体系。

### 3.2 Earth-Agent

- 仓库：[opendatalab/Earth-Agent](https://github.com/opendatalab/Earth-Agent)
- 定位：面向 Earth Observation 的综合 Agent，并提供 Earth-Bench。
- 对黑土智管的价值：观察更广泛 EO 任务如何组织感知、分析和工具能力；适合作为工具分类与 benchmark 参考。
- 注意：研究型系统覆盖面远大于铁岭玉米巡田，不能据此扩大首期产品边界。

### 3.3 OpenEarthAgent / OpenEarth-Agent

- 论文：[OpenEarthAgent: A Unified Framework for Tool-Augmented Geospatial Agents](https://arxiv.org/abs/2602.17665)
- 论文：[OpenEarth-Agent: From Tool Calling to Tool Creation for Open-Environment Earth Observation](https://arxiv.org/abs/2603.22148)
- 对黑土智管的价值：统一工具增强地理空间 Agent，以及开放环境中的工具发现/创建研究。
- 注意：生产系统不应在首期允许 Agent 动态创建并执行新工具；可把相关工作作为未来离线工具候选生成研究。

### 3.4 LLM-Geo

- 仓库：[gladcolor/LLM-Geo](https://github.com/gladcolor/LLM-Geo)
- 论文：[Autonomous GIS: the next-generation AI-powered GIS](https://doi.org/10.1080/17538947.2023.2278895)
- 定位：LLM 生成 solution graph、程序集成代码、执行空间分析并生成地图和图表。
- 对黑土智管的价值：solution graph、结果图和自动数据处理的端到端表达。
- 注意：项目 README 自述案例程序约有 80% 成功概率，同时指出缺少 logging 和 code testing；代码生成、review、debug 消耗大量 token。黑土智管应使用受控工具图，而非任意代码生成执行。

### 3.5 GeoAgent for QGIS

- 仓库：[iamtekson/GeoAgent](https://github.com/iamtekson/GeoAgent)
- 定位：QGIS 插件，通过自然语言发现算法、填充参数、执行多步流程并将结果加入地图。
- 工程亮点：General/Processing 模式分离；结构化 state/schema；最多两次失败修复；Logs 展示每一步；支持输出传递到下一步。
- 对黑土智管的价值：任务分解、单位处理、算法发现、执行日志和地图结果联动。
- 注意：QGIS 全算法注册表对专业用户有价值，但生产农情 Agent 应只暴露经过验证的工具子集。

### 3.6 Arion

- 仓库：[GeoRetina/Arion](https://github.com/GeoRetina/Arion)
- 定位：Electron + React + MapLibre 的跨平台 geospatial agent 桌面应用。
- 能力：多模型、地图工具、MCP、自定义知识库、PGlite/pgvector、SQLite/SpatiaLite。
- 对黑土智管的价值：聊天、地图、工具过程和知识库的前端组织方式；Node/TypeScript 与 Python 地理工具共存方式。
- 注意：其 agentic workflows、plugin system 和部分 SpatiaLite 能力仍标为计划中；GPLv3 许可也意味着不能无审查复制代码进入闭源交付。

## 4. 评测与方法项目

### 4.1 GeoBenchX

- 仓库：[Solirinai/GeoBenchX](https://github.com/Solirinai/GeoBenchX)
- 论文：[GeoBenchX: Benchmarking LLMs for Multistep Geospatial Tasks](https://arxiv.org/abs/2503.18129)
- 内容：200 多个多步地理空间任务、23 个工具、可解与不可解样本、参考答案、完整轨迹和 LLM-as-Judge。
- 关键经验：显式 `reject_task()`；保存工具和中间产物；分开评价 solve 与 reject 能力。
- 建议：借鉴数据格式、难度分组和不可解任务；关键农业结论仍由确定性断言与人工专家评估，不只靠 LLM judge。

### 4.2 GeoBenchX 之外的近期 benchmark

- [TerraBench: Can Agents Reason Over Heterogeneous Earth-System Data?](https://arxiv.org/abs/2606.13148)
- [TerraLogic: A Benchmark for Hierarchical Geospatial Reasoning in Earth Observation](https://arxiv.org/abs/2607.12497)
- [GeoDisaster: Benchmarking Orchestrated Agents for Operational Disaster Geo-Intelligence](https://arxiv.org/abs/2606.17246)
- [AgroTools: A Benchmark for Tool-Augmented Multimodal Agents in Agriculture](https://arxiv.org/abs/2605.22366)
- [awesome-eo-agent-benchmarks](https://github.com/AlexEco1/awesome-eo-agent-benchmarks)

这些工作适合补充任务类型和评测指标，但都不能替代本项目自己的铁岭玉米地块样本、质量阈值和现场反馈。

## 5. 农业 Agent 参考

### 5.1 Farmer.Chat

- 论文：[Farmer.Chat: Scaling AI-Powered Agricultural Services for Smallholder Farmers](https://arxiv.org/abs/2409.08916)
- 定位：面向小农户和农业推广服务的 AI 农业问答与服务系统。
- 对黑土智管的价值：真实农业用户、多语言/低门槛交互、知识接地、反馈与推广服务场景。
- 不足：核心更接近农业知识服务，不是多源遥感地块任务编排。

### 5.2 ShizishanGPT

- 论文：[ShizishanGPT: An Agricultural Large Language Model Integrating Tools and Resources](https://arxiv.org/abs/2409.13537)
- 对黑土智管的价值：农业领域模型、工具和资源整合方式。
- 建议：农业知识层可以参考，但遥感结论仍应来自结构化观测和专业工具。

### 5.3 MA3

- 论文：[Multimodal Agricultural Agent Architecture (MA3)](https://arxiv.org/abs/2504.04789)
- 对黑土智管的价值：农业文本、图像和多模态信息的 Agent 架构参考。
- 注意：论文架构不能直接证明真实试点中的可靠性、成本或责任边界。

### 5.4 低成熟度开源农业 Agent

GitHub 搜索发现以下方向与黑土智管主题接近：

- [DhwanilPanchani/FieldPulse](https://github.com/DhwanilPanchani/FieldPulse)：卫星、土壤和天气信号融合；
- [arnavdhar07/harvest](https://github.com/arnavdhar07/harvest)：地块级卫星智能与 LangGraph；
- [FarmSphere-AI](https://github.com/arka-coder/FarmSphere-AI)：NDVI、天气、病害与多 Agent；
- [Sustainable-Agriculture-Agentic-System](https://github.com/sachinunitn/Sustainable-Agriculture-Agentic-System)：土壤、卫星与气候；
- [LeafNetwork](https://github.com/DEVADARSANCP/LeafNetwork)：视觉、气候与卫星 Agent。

这些仓库在调研日星数很低，项目描述多强调 agent 数量和功能广度，缺少可见的基准、真实数据血缘、专业复核和试点证据。适合观察产品功能，不宜作为核心工程依赖或架构权威。

## 6. 近期研究方向

- [Agentic AI for Remote Sensing: Technical Challenges and Research Directions](https://arxiv.org/abs/2604.24919)：遥感 Agent 技术挑战综述；
- [RS-Claw: Progressive Active Tool Exploration via Hierarchical Skill Trees](https://arxiv.org/abs/2605.13391)：层级技能树与工具探索；
- [Bidirectional Semantic Complementary Tool Retrieval for Remote Sensing Agents](https://arxiv.org/abs/2606.07538)：遥感工具检索；
- [Bringing Agentic Search to Earth Observation Data Discovery](https://arxiv.org/abs/2607.02387)：EO 数据发现；
- [Risk-Aware LLM Agents for Geospatial Data Retrieval](https://arxiv.org/abs/2606.15077)：地理数据检索风险；
- [EO-Agents: A Three-Agent LLM Pipeline for Earth Observation Hypothesis Generation](https://arxiv.org/abs/2607.01584)：多 Agent EO 假设生成。

近期论文提供未来方向，但黑土智管 V0.1 更需要稳定的受控工具、质量门和可复查报告，而不是动态造工具、层级多 Agent 或自主科学发现。

## 7. 对现有架构方案的建议

### 产品形态纠偏

- 普通用户不使用“GIS 分析”“遥感指标”“Agent 工具”等产品语言；
- 核心入口是“分析这块田现在怎么样、和之前有什么不同”，不是开放式 GIS 命令框；
- 系统输出农情状态、变化区域、日常语言解释和报告，而不是算法结果目录；
- 地图服务于理解田内差异和时间变化，不要求用户操作图层、投影和空间算法；
- 技术日志只进入专家复核端，普通端显示“正在分析卫星和天气资料”等阶段性状态；
- 输入优先采用预设问题、地块选择、语音和少量确认项，减少 prompt 编写负担；
- 数据不足时说清楚“暂时看不清，建议现场确认”，不向用户暴露供应商错误或工具栈；
- 专业人员负责审核高风险解释，普通用户获得的是农田分析服务，不是遥感软件培训。

### 立即纳入 V0.1

1. 增加显式 `reject_task` / `request_missing_input` 领域工具；
2. 建立 Solution Space 的轻量版本：为玉米巡田保存经过审核的任务模板和工具组合；
3. 每个 Workflow run 保存完整事件轨迹、结构化输入快照和最终证据图；
4. 评测集同时包含可解、不可解、低质量和工具失败样本；
5. 前端显示步骤、工具、质量、限制和拒绝原因；
6. 固定最大 turn、工具调用、重试、时限和成本预算；
7. Python geo runner 只实现白名单函数，不接受任意代码。

### 纳入 V0.2

1. 把专家审核过的成功任务沉淀为可检索 Solution Space；
2. 加入证据冲突检测和来源互证；
3. 建立模型对比评测，分别统计 solve、reject、tool selection 和 evidence fidelity；
4. 引入农业知识检索，但其内容不能覆盖遥感观测事实；
5. 对外部数据和知识文本增加 prompt injection 测试。

### 暂不采用

- 多 Agent 团队；
- Agent 动态生成并执行 Python/SQL；
- 开放全部 QGIS/GDAL 算法给模型；
- 自动创建新工具并立即进入生产；
- 用向量库替代结构化证据与数据血缘；
- 只依赖 LLM-as-Judge 评价农业结论；
- 以 GitHub 星数或论文规划准确率作为产品可靠性证明。

## 8. 推荐跟踪清单

| 优先级 | 项目 | 跟踪内容 |
|---|---|---|
| P0 | Codex harness / SDK | 线程、事件、恢复、沙箱与模型兼容性 |
| P0 | RS-Agent | Solution Space、遥感工具目录、规划评测 |
| P0 | GeoBenchX | 不可解任务、轨迹格式和评测数据组织 |
| P1 | GeoAgent | GIS 工具发现、参数解析、失败修复和日志 UI |
| P1 | Earth-Agent / OpenEarthAgent | EO 工具分类、benchmark 和多源任务 |
| P1 | Farmer.Chat | 农业用户体验、知识接地和现场反馈 |
| P2 | Arion | MapLibre + chat + tool 前端模式 |
| P2 | LLM-Geo | solution graph 与结果可视化，重点观察其失败改进 |
| P2 | AgroTools / TerraBench | 新 benchmark 和异构数据推理指标 |

## 9. 主要来源

- [OpenAI Codex](https://github.com/openai/codex)
- [Codex SDK](https://developers.openai.com/codex/sdk)
- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)
- [RS-Agent](https://github.com/IntelliSensing/RS-Agent)
- [Earth-Agent](https://github.com/opendatalab/Earth-Agent)
- [LLM-Geo](https://github.com/gladcolor/LLM-Geo)
- [GeoAgent](https://github.com/iamtekson/GeoAgent)
- [GeoBenchX](https://github.com/Solirinai/GeoBenchX)
- [Arion](https://github.com/GeoRetina/Arion)
- [Farmer.Chat](https://arxiv.org/abs/2409.08916)
- [ShizishanGPT](https://arxiv.org/abs/2409.13537)
- [MA3](https://arxiv.org/abs/2504.04789)
- [AgroTools](https://arxiv.org/abs/2605.22366)
- [Agentic AI for Remote Sensing](https://arxiv.org/abs/2604.24919)
