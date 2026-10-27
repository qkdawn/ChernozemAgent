# 黑土农情 Workflow 受控工具

本文只描述 Agent 可调用的稳定工具及其完成条件。工具的自顶向下架构、Workflow 图和逐项职责见 [agent-tool-design.md](agent-tool-design.md)；系统分层、Skill 和知识库边界见 [agent.md](agent.md)，数据来源与采集过程见 [multisource-data-acquisition.md](multisource-data-acquisition.md)。

新增工具、输入快照、证据复核与发布状态的待实施语义见[工具体系完整设计](farm-agent-tool-system-plan.md)。实施相关分支时先读取该设计，再在共享 TypeScript 契约收敛正式定义；本文不把目标方案列为当前已支持字段。

## 1. 边界

工具层消费已经登记的数据产物，不检索或下载外部数据：

```text
数据采集层 -> 采集清单和本地产物
工具层 -> 确定性分析结果和地图产物
Skill -> 工具选择、调用顺序和结果组织
对话工具门面 -> 读取已发布结果、规划并在确认后启动 Workflow
Agent -> 面向用户表达结论、限制和下一步行动
```

对话工具门面与 Workflow 步骤工具分开。对话 Agent 不直接调用 `analyze_optical_condition` 等底层工具；它只能通过 `plan_workflow` 和用户确认后的 `start_workflow` 进入固定 Skill。`get_field_context`、`get_task_result`、`get_workflow_status` 和知识检索属于只读解释能力；`record_scouting_note` 等写入操作需要明确确认。

`get_field_context` 的权威 schema 位于 `packages/contracts/src/index.ts`。它返回当前地块的种植档案、当前边界版本的数据来源状态和最近三项任务，支持 `summary`、`profile`、`data` 和 `recent_tasks` 四类焦点。数据状态聚合已登记来源的可用日期与取回产物数量，不把旧边界数据混入当前地块，也不据此越权生成农情结论；对话结果不返回边界几何。该门面不调用模型，不创建采集或分析任务。

`plan_workflow` 返回的 `ConversationWorkflowPlan` 同时包含用户可读的三步计划和冻结的 `startRequest`。`startRequest` 只包含地块、作物、预定义目标、时间口径和原始用户需求；它在“确认并开始”之前不执行。`start_workflow` 不重新解释自然语言，也不让前端重写请求，只把同一份 `startRequest` 提交到任务入口；任务入口重新读取当前地块并拒绝作物或目标不匹配的请求，随后冻结当前边界版本与可用数据批次。

`get_task_result` 的权威 schema 位于 `packages/contracts/src/index.ts`。它在当前地块范围内读取最新匹配任务，支持 `summary`、`locations`、`evidence`、`limitations` 和 `actions` 五类焦点，并返回 `found`、`not_ready` 或 `not_found`。最新匹配任务尚未发布结果时返回 `not_ready`，不得跳过它去读取更早的旧结论；地图发现只暴露是否具有空间位置，不通过对话接口返回完整几何。该门面不调用模型、不创建或重跑任务，服务端直接把结果作为普通对话消息返回。

Workflow 步骤工具只能传入 `{ taskId }`。地块、边界版本、作物、时间范围和已授权资产由服务端任务上下文绑定；对话模型不能传入文件路径、供应商资产 ID、波段、坐标系、阈值或任意代码。

数据源适配、下载、缓存和重试属于数据采集层，不注册为 Agent 工具。裁剪、重采样、云掩膜、指数、统计和 GeoJSON 写入是工具内部实现，也不拆成 Agent 工具。

### 1.1 空间能力边界

Agent 不获得一套通用 GIS 工具箱。它调用当前四项农情任务已有的领域工具，空间处理由这些工具内部完成：

| Agent 工具 | 空间职责 | 不承担的职责 |
| --- | --- | --- |
| `analyze_optical_condition` | 选择合格 Sentinel-2 观测，生成单期图层、跨期变化和田内相对差异区 | 不确认缺水、缺氮或产量 |
| `analyze_radar_change` | 选择同轨可比时相，生成后向散射观测与变化区 | 不凭单期雷达确认积水 |
| `analyze_terrain_susceptibility` | 生成高程、坡度和低洼易发区 | 不把易发性写成已发生灾害 |
| `assess_growth_status` | 把光学空间结果组织成长势区和巡田动作 | 不修改底层观测 |
| `assess_water_nitrogen_evidence` | 对齐已有观测，计算同日差异、几何交集和现场记录对照 | 不自动生成施肥剂量 |
| `detect_waterlogging` | 组合雷达、降雨与地形，发布疑似积水区和核查优先级 | 不用天气生成田内栅格 |
| `assess_frost_risk` | 组合预报、生育期与地形，发布风险关注区 | 不把粗分辨率预报下推为田内温度 |

`analyze_weather_event`、`get_soil_background` 和 `estimate_crop_stage` 提供时间或地块上下文，本身不是空间分区工具。前端的底图、图层显隐、定位和缩放是展示操作，也不注册为 Agent 工具。

底层的地块授权校验、几何修复、投影归一、栅格裁剪、重采样、时间对齐、空间相交、碎斑处理和产物登记属于工具内部单一实现。Agent 不能逐步调用这些算子，也不能传入阈值或中间产物路径。

## 2. 唯一结果契约

所有分析工具和业务工具只返回 `AnalysisResult<T>`。权威 TypeScript 定义位于 `packages/contracts/src/index.ts`，本文不复制第二份接口。

最终业务工具的 `AnalysisResult` 是任务发布事实的单一来源。模型可以组织解释和调用轨迹，但不得用自由文本覆盖任务状态、摘要、来源、限制、地图产物或下一步动作。

稳定状态：

| 状态 | 含义 |
| --- | --- |
| `succeeded` | 达到该工具的完整完成条件 |
| `partial` | 有可交付结果，但时相或质量限制缩小了结论范围 |
| `needs_input` | 缺少播种日期等用户或业务资料 |
| `needs_data` | 缺影像、无覆盖、云遮挡或其他采集数据不足 |
| `needs_review` | 高风险专业建议等待复核 |
| `failed` | 处理程序、产物或基础设施执行失败 |

每个结果必须包含：任务归属、工具版本、摘要、来源及日期、结构化结果或 `null`、发现、地图/图表产物、当前限制、下一步动作和失败原因。缺测不使用零值表示。

每个结果还必须包含 `execution` 执行元数据。权威 schema 位于 `packages/contracts/src/index.ts`，其中冻结：

- 实际执行的 `toolName`；
- `fieldId`、`boundaryVersion` 和工具采用的时间窗口；
- 当前任务登记的采集批次 ID、资产 ID，以及业务判断工具实际读取的前序结果 ID；
- 影响结果语义的参数摘要；
- 由工具名、版本、scope、输入与参数共同生成的 `inputFingerprint`。

光学、生育期、长势、雷达、天气、地形、土壤和三个业务判断工具分别维护独立语义版本；一个工具实现变化不得借用共享版本号使其他工具的指纹无意义变化。

同一任务的同一工具使用稳定结果 ID，重放时更新同一结果记录而不新增重复步骤；输入未变化时 `inputFingerprint` 必须保持一致。Workflow Runner 同时校验返回结果的 `taskId`、`execution.toolName` 和 `fieldId` scope，身份不一致时终止执行，不把错误结果混入后续判断。执行元数据用于专家复核和后台审计，普通用户界面仍以结论、来源日期和实际影响结论的限制为主。

### 2.1 可视化产物

工具只返回两类可视化，前端不解析 GeoTIFF、NetCDF 或供应商响应：

- `visualization`：带来源、指标、日期、WGS84 四角坐标、数值范围和单位的 PNG 栅格。当前包括 Sentinel-2 NDVI/对比 NDVI、Sentinel-1 VV/VH/VV 变化，以及 DEM 高程/坡度/相对高程。
- `chart`：带来源、标题、单位和序列点的结构化图表。天气图表按日期返回 ERA5-Land 历史每日降雨、最低/最高气温，以及 IFS 预报每日降雨、最低/最高气温；窗口累计值仍保留在天气工具结果中供积水和霜冻判断使用。SoilGrids 返回 Q0.5 各深度地块背景值。

同一个产物被业务结果再次引用时按 `ref` 去重。天气不生成田内栅格；SoilGrids 250 米只显示地块背景剖面，不生成施肥分区。每项土壤测量保留有效/总像元数和有效覆盖率；部分属性缺测或有效覆盖低于 80% 时工具返回 `partial`。砂、粉、黏粒按 SoilGrids 官方换算因子显示为百分比，其他属性使用契约中的明确单位。

前端通过 `GET /api/v1/fields/:fieldId/visualizations` 读取地块已经生成的可视化目录。地图图层按 `source + date + metric` 保留最新的有效产物，并在返回前确认文件仍存在；天气和土壤图表按 `source + title` 保留最新结果、单位和来源日期，新的工具版本会替换同名旧指标。因此页面刷新或重新进入地块后仍可恢复历史可视化，失效的地图 `ref` 不会成为可选项。采集层的 GeoTIFF、NetCDF 和 GRIB 不直接进入该目录，必须先经过确定性工具处理为上述可视化契约。

地块可视化目录和任务证据是两个不同范围：地图图层菜单与数据详情可以读取该地块的历史可视化；“本次分析依据”只统计当前任务 `analysisResults` 中的来源、图层和图表。不得把历史任务产物计入本次任务的数据数量或结论依据。

Sentinel-1 的单期浏览与变化判断分开：每个已登记观测日期分别生成 VV/VH 图层，供用户按日期查看真实后向散射；只有轨道方向和相对轨道一致的至少两个日期才能生成变化图。单期 VV/VH 图层只表示该日雷达观测，不能单独称为积水、土壤湿度或灾害判断。

## 3. 首条已实现链路

```text
analyze_optical_condition
        -> estimate_crop_stage
        -> assess_growth_status
```

Skill 固定顺序，但每个工具独立保存一个 `AnalysisResult<T>`。业务工具通过 `taskId` 从服务端结果仓储读取前序结果，模型不传递栅格、文件路径或结果 ID。

### 3.1 `analyze_optical_condition`

用途：读取任务时间范围内、同一地块和同一边界版本的 Sentinel-2 L2A 采集历史，生成当前光学状态、可用时相、日期间变化和田内相对差异。

内部处理：

1. 按观测日期和场景归并完整的 B03/B04/B08、B05/B06/B07/B8A/B11/B12 与 SCL；
2. 将 10 米波段重采样到 20 米分析网格；
3. 裁剪到地块，使用 SCL 排除无数据、坏像元、云影、云、薄云和雪；
4. 在同一 20 米分析网格计算 NDVI、NDRE、RECI、MSAVI、NDMI、NDWI、有效像元比例和云影响比例；
5. 对可用日期按时间排序，计算相邻日期各指数的地块均值变化；
6. 对每个可用日期生成 NDVI、对比 NDVI、NDRE、RECI、MSAVI、NDMI 和 NDWI 真实栅格；对最近可用日期在 20 米分析网格内生成田内相对差异区和 GeoJSON 地图产物。

结构化结果：

```text
current: 最近可用日期、六项指数统计、质量
observations: 所有可用日期及统计
changes: 相邻可用日期、六项指数差值
zones: 最近日期的田内相对差异区
zoningMethod: 分区算法身份
zoningQuality: NDVI P90-P10 稳健极差、最低差异门槛和是否存在可见田内差异
```

完成语义：

| 条件 | 结果 |
| --- | --- |
| 至少两个完整且质量可用的日期 | `succeeded`，输出日期间变化 |
| 只有一个可用日期 | `partial`，只输出当前状态和地图，不生成变化 |
| 部分日期受云影响但仍有有效像元 | `partial`，保留 `cloud_contaminated` 质量标记 |
| 当前影像不覆盖地块 | `needs_data / no_field_coverage` |
| 地块像元全部受云污染 | `needs_data / cloud_contaminated` |
| 同一日期缺少光谱或 SCL 资产 | `needs_data / optical_assets_missing` |
| 登记产物不能读取或处理程序失败 | `failed` |

日期比较只使用任务时间范围内的观测，不把范围外历史影像混入结果，也不使用其他日期像元填补云空洞。

### 3.2 `estimate_crop_stage`

用途：给长势结果提供玉米生育阶段上下文。

当前首版使用地块记录中的播种日期和最近可用光学日期计算播后天数，再按版本化阶段区间返回播种、出苗、拔节、抽雄、吐丝、灌浆或成熟阶段。结果置信度固定为 `medium`，并明确需要积温和品种参数继续校准。播种日期无效或晚于参考观测日时返回 `needs_input`，不把负播后天数静默归零。

| 条件 | 结果 |
| --- | --- |
| 有播种日期和有效参考日期 | `succeeded` |
| 缺少播种日期 | `needs_input / planting_date_missing` |

单幅影像不能替代播种记录，也不能单独确认生育阶段。

### 3.3 `assess_growth_status`

用途：组合光学状态和生育期，形成用户可读的长势任务结果。

输出：

- 当前估计生育期；
- 最近可用日期和地块平均 NDVI；
- 最近两个可用时相的上升、稳定、下降或时相不足；
- 田内低于、接近或高于地块平均水平的区域；
- 数据日期、地图引用及实际影响结论的数据情况。

单时相结果在摘要中写明观测日期、估计生育期、田内低值分区数量和时序不足。成功计算不附带固定巡田或等待影像动作；播期缺口等可修正输入保留明确的补充入口，实际建议由领域分析形成。受云污染等不可用日期保留在来源说明中，但不能进入可用观测窗口。

`observationWindow` 同时保存用户请求时段、窗口内有效日期和窗口外比较日期；扩大采集窗口取得的前期基线不计为请求窗口内观测。`areaBasis.fieldAreaHa` 是登记地块总面积，`belowAverageAreaFractionDenominator=field_area` 明确偏弱面积比例以它为分母，不能把该比例描述为占有效观测面积。当前有效覆盖率另由 `validCoverageFraction` 表达。

`growth-assessment-v2` 的 `zoneChange` 使用 `relative-class-footprint-overlap-v1`，按实际日期选取严格早于当前日期的最近快照；缺少当前快照时不使用其他日期替代，重复日期不自行择一。先合并各期完整分类多边形（包含 `holes`）建立可观测范围，再计算共同覆盖和相对偏弱类交集，不使用分区 ID、中心行列号或面积比阈值推断持续、扩大或恢复。

`areas` 返回各期及共同可观测几何面积、两期同位置均偏弱面积、共同覆盖内由非偏弱转为偏弱/由偏弱转为非偏弱的面积，以及另一时期未观测到的偏弱面积。逐个当前偏弱区保存对应面积与前期分区 ID。以上单位均为公顷，是 WGS84 多边形的几何面积；分区有效像元面积单独保留，缺测为 `null`，不能用几何面积补填。相对分级转换不是同位置 NDVI 数值升降，不能直接称为恶化、恢复、缺氮或减产。

`status` 为 `computed`、`not_comparable`、`incomplete_geometry`、`invalid_geometry` 或 `calculation_failed`；不可比较时保留原因及空测量，只有实算不相交才为零。旧成果缺少内环字段时不假定无云洞，不建立新的同位置比较。

当前 `0.03` NDVI 变化阈值是长势判断的工程阈值，用于避免把极小数值波动描述为趋势，尚需东北玉米样本校准。田内分区是同一地块的相对比较，不代表跨地块排名、缺氮确认或产量预测。

缺少光学结果时返回 `needs_data`；缺少播种日期时返回 `needs_input`；两者同时缺少时同时列出两个缺口和两个补充动作。

## 4. 后续三项能力

以下 Skill 名称、工具和失败语义已经固定；四项确定性链路已有首版 API 实现，但“产品能力完成”仍以真实授权地块的输入、结果和地图验收为准。

### 水氮协同诊断

当前工具链固定为 `analyze_optical_condition`、`estimate_crop_stage`、`analyze_radar_change`、`analyze_weather_event`、`analyze_terrain_susceptibility`、`get_soil_background`、`assess_water_nitrogen_evidence`。地块“田况”页直接浏览日期、原图、指数和时序，不创建 Agent 任务；只有用户发起水氮协同诊断时才执行这条多源链路。

巡田记录属于地块资料，不属于某次工具 finding。创建水氮任务时默认不加载历史巡田记录；只有用户明确选择的 `scoutingNoteIds` 才进入本次工具输入。这样保存记录不会暗中改变后续任务结论，单个地块也可以长期积累多条带日期和坐标的现场观察。

田况浏览返回原图、指数与时序；水氮调查返回可追溯的比较数据，原因解释由能够按需读取成果和知识原文的 Agent 完成。没有巡田记录不妨碍遥感分析，也不把计算成功的任务降级为“待巡田”。

当前光学工具版本 `optical-condition-v8` 保留分区有效像元面积、逐日空间快照及多边形内环 `holes`；旧保存成果不自动补值。光学分区的空洞保留到地图产物、地块结果及水氮目标分区交集，避免将云/无数据或被其他等级包围的像元填成该分区。当前单一水氮契约为 `water-nitrogen-v5`，工具版本为 `water-nitrogen-assessment-v4`；类型与参数的权威定义在 `apps/api/src/multi-source-analysis.ts`。

- 基准为最新光学结果的 `current.observationDate`；`latestChange` 只采用终点与该日一致的变化结果。全田跨期变化与同日空间偏差分别保存。
- `zones` 保留光学分区 ID、均值、各指标相对田内均值的偏差、有效像元面积和几何。未计算面积为 `null`；无低值区时合计为已计算的零。
- `sourceAlignment` 逐项记录支持成果 ID、类型、`aligned/outside_window/unusable` 和可计算的时间差。雷达必须可比、有前后日期且距参考日不超过 14 天；历史气象窗口须包含参考日且小时覆盖不低于 80%；地形和土壤保留原成果质量。对齐只表示能参与比较，不表示证明某个原因。对齐但与假设不一致的数据仍保留。
- `radarOverlap` 与 `lowlandOverlap` 返回来源成果 ID、几何面积、交集面积、公顷单位、交集占分区几何面积比例及贡献分区 ID。算法在 `spatial-evidence.ts`：WGS84 有效闭环验证，多边形求交后合并交集，避免重叠来源重复计数。雷达仅纳入实际强增/强减分区，稳定分区不算变化区；地形只纳入低洼分区。几何面积不替代光学有效像元面积，不解释成积水或缺氮面积。
- 每个偏弱区的 `spatialPriority` 根据已有交集给出 `status/changesPriority/preferredBecause/note`。任一已计算的雷达或低洼交集面积大于零时为 `computed/true`，`preferredBecause` 指明相交侧；已测侧全为零时为 `computed/false/none`，表示多源空间证据未改变先看哪块；两侧均缺测或计算失败时为 `unavailable/null/null`。`spatialPrioritySummary.changesAnyPriority` 在有优先区时为 true、全部弱区均已计算且无正交集时为 false、其余情况为 null；`orderedZoneIds` 把优先区排在前面，同组保持原光学顺序。无偏弱区时列表为空且汇总为 null。它是巡田顺序信号，不是原因或农事处方。
- 空间状态区分 `computed/unavailable/invalid_geometry/calculation_failed`：真正计算无交集为 0，缺测或失败为 `null`。几何适用范围是当前地块处理器输出的 WGS84 单外环；不修补、展开或猜测未支持几何。来源质量与覆盖需继续读取原成果。
- `scoutingNoteIds` 仍只携带用户选定记录。`inspectionMatches` 相对本次参考日匹配，3 天内为 `aligned`，更远为 `historical`，无效日期为 `unmatched`。`fieldComparison` 保留所有同期低值、对照与一般记录的引用，并列出日期间隔不超过 3 天的低值—对照组合，不挑选第一条替代相互冲突的观测。坐标与分区的包含关系只在有效几何中计算，边界点算区域内。
- `evidenceLevel` 为 `optical_only/multi_source/field_comparison`，表示资料和对照是否可用，不是诊断置信度、原因优先级或任务发布状态。`field_comparison` 仅代表有可匹配的低值与对照记录，不能自动确认水分或氮素问题。
- payload 不再包含预写的 `investigation/interpretation/checks`、分区原因标签或巡田话术。成功结果不附加固定“等下一期”或“未来两天巡田”动作；正式文档由 Agent 比较数据后形成。缺少光学结果为 `needs_data`；影像距任务结束超过 21 天、输入质量受限、必要面积缺测或已尝试的空间比较失败为 `partial`，这些情况局部说明其影响。

计算只消费已经登记的成果，没有外部网络或新增采集成本；多边形相交成本随分区顶点数与来源分区数增长。任务/工具确定性 ID 和输入指纹复用既有机制。支持源缺失时保留光学测量，比较项为 `unavailable`，不生成替代数值或原因。最小空间样例见 `spatial-evidence.test.ts`，任务样例与日期、冲突记录、缺测和质量回归见 `multi-source-analysis.test.ts`；测试数据为合成数据，不能替代实地农学验证。

### 辅助变量施氮

辅助变量施氮是地块工作流，不注册为 Agent 分析工具，也不属于 `assess_water_nitrogen_evidence` 的输出。它只消费 `ndvi-quantile-connected-v2` 分区：先计算有效像元 NDVI 的 P90-P10 稳健极差，达到 0.05 时才按当期 NDVI 三分位形成低、中、高相对等级，执行 3×3 邻域多数平滑，将小于 3 个像元或有效区 1% 的碎斑吸收到相邻主区，再按四邻域连通区矢量化并裁切到地块；差异不足时全部归为中等区，并拒绝创建处方。旧版 3×3 几何网格不进入处方来源。地图边缘保留 20 米像元阶梯，避免通过视觉平滑伪造更高空间精度；无效像元不补值，也不进入施用面积。

该分区只表示所选日期的单期相对 NDVI 候选管理区，不是长期生产力区、缺氮区或系统推荐剂量。单期内差异不足时不应强行创建处方；生产级稳定管理区需要多个可比季节、产量或土壤/农艺记录校准，并根据农机作业宽度进一步合并。当前版本通过 `zoningMethod` 固化算法身份，边界版本或算法版本变化后需重新分析。

用户或农艺师显式填写肥料名称、含氮率、常规产品施用量和三区产品施用量；系统不根据 NDVI 自动产生不同剂量。服务端使用地理面积计算每区面积、产品总量、折纯氮量、全田总量和相对均匀施用的差值，保存为 `needs_review` 候选处方。GeoJSON 导出逐多边形携带来源日期、管理区、产品施用量、折纯氮施用量和面积。地块边界版本变化后，不得继续使用旧版本任务创建新处方。

现场记录与光学参考日期相差不超过 3 天时可作为同期线索；跨窗口记录只作历史参考。雷达后时相距光学参考日超过 14 天时不参与；天气窗口不包含光学参考日时不参与。

首期空间模式阈值为：红边方向 `NDRE <= -0.035` 或 `RECI <= -0.08`，水分方向 `NDMI <= -0.035` 或 `NDWI <= -0.035`，均相对于同一日期的地块均值。阈值是待东北玉米样本校准的工程起点。雷达与 DEM 只有和光学网格区存在空间相交时才增强该区，ERA5-Land 只能增强地块级事件背景，不能生成田内分区。

### 农田积水灾害识别

工具：`analyze_radar_change`、`analyze_weather_event`、`analyze_terrain_susceptibility`、`detect_waterlogging`。

`analyze_radar_change` 有同轨、同极化且间隔不超过 24 天的前后对时输出变化并为 `succeeded`；只有单期时输出该期 VV/VH 均值、轨道、覆盖率和图层，标记为 `partial`，不生成变化指标，也不把它称为积水或土壤湿度。用户选择某个雷达观测日时，公共任务时间仍记录该目标日；工具内部向前扩展最多 24 天的证据窗口，自动选择距离目标日最近的同轨基线。

`detect_waterlogging` 必须具备可比雷达对、覆盖雷达区间且小时覆盖率不低于 80% 的连续历史天气和地块范围，才发布降雨关联的疑似积水区。首期降雨事件门槛为单次过程累计 20 毫米；低于门槛的降雨保留数值但不把雷达变化升级为积水判断。结果同时保留雷达间隔、有效覆盖、显著变化面积与占比、最强区间降雨事件、疑似影响面积与占比。只有雷达对但天气缺失或覆盖不足时保留 `partial / radar_change_only`，不判定积水；缺少可比雷达对时为 `needs_data`。DEM 只用于易发区和核查排序，只有 `succeeded` 的 DEM 可以提升优先级；部分 DEM 不进入业务来源，也不把分区标为高优先级。

`analyze_weather_event` 分别记录历史窗口的预期/实际小时数与覆盖率，以及预报窗口的有效点数与覆盖率；当前 Workflow 请求的数据角色达到 80% 才为 `succeeded`。历史强降雨按相互分离的过程保留多次事件，不只返回全窗口最大一次。只请求历史或只请求预报时，另一角色缺失不造成降级。

`analyze_terrain_susceptibility` 只有在分区均值处于地块低分位且比地块均值低至少 0.5 米时才标记低洼；完全平坦 DEM 不产生虚假低洼区。无覆盖为 `needs_data`，有效覆盖不足 80% 时保留结果但为 `partial`。

### 霜冻风险提前预警

工具：`analyze_weather_event`、`analyze_terrain_susceptibility`、`estimate_crop_stage`、`assess_frost_risk`。

必须使用带合法生成时间和有效期、预报提前量不超过 240 小时、且有效窗口与任务时段相交的低温预报，并结合生育期和地形背景。阶段参考日使用最冷触发窗口的开始日期；`stage-temperature-duration-terrain-v2` 由最低温、生育期敏感性和低温持续小时数共同决定 `high/watch/normal`，输出的 `forecastWindow` 是实际触发窗口，并保留预报生成时间、覆盖率、格点距离和地形可用状态。低洼关注区保留面积与地块占比；没有完整 DEM 时不得在行动文字中声称已定位低洼区。生成时间晚于预报有效期、提前量超限或窗口不相交时返回 `needs_data`；预报覆盖率低于 80% 或 DEM 部分覆盖时风险结果为 `partial`。霜冻任务不继承地图上的历史光学或雷达日期，也不接受自定义历史日期范围。输出是未来风险窗口和地形关注区，当前只生成现场核查动作，不确认灾害已经发生，也不把 0.25 度预报下推成田内精准温度图；具体防护处置未来接入时必须经过专业复核。

## 5. 知识检索

`search_agronomy_knowledge({ taskId, query })` 是只读解释工具，只允许检索东北黑土地春玉米知识和原文出处。它不参与遥感计算，不覆盖确定性工具结果，也不能把一般农学规律写成当前地块事实。

GraphRAG 索引失败只影响扩展解释，不影响上述确定性工具链。

## 6. 最小验证

四项链路的回归样本必须覆盖：

- 两个可用时相产生变化日期；
- 单时相返回 `partial`；
- 云污染返回质量标记或明确 `needs_data`；
- 地块无覆盖返回 `no_field_coverage`；
- 缺完整资产返回 `optical_assets_missing`；
- 缺播种日期返回 `planting_date_missing`；
- 自定义时间范围之外的影像不参与分析；
- API 能创建长势任务、轮询完成并返回三个 `AnalysisResult` 和地图产物；水氮任务返回七个受控工具结果，支持源缺失时仍保留光学排查结果，影像过期或质量受限时为 `partial`；积水、霜冻任务在缺数据时返回明确 `needs_data`/`partial`。
- 水氮任务验证无任务田况浏览、多源工具顺序、光谱差异定位、独立支持证据、雷达 14 天窗口、天气事件窗口、来源角色和可选现场记录；单期光学指标不得命名为水氮原因区，没有经过本地验证和专业复核时不生成施肥或灌溉处方；

真实地块验收还必须使用授权边界和已登记产物；测试替身只证明编排和契约，不能替代真实栅格验证。

若要对已保存历史任务复跑 `analysis-brief-writer-v6` 正文（例如 S2/B3 钉死样例 `aca17f7b-34e2-442f-977b-7f0b63b56c0f` / `60b8e16b-8e4a-45d6-9b53-e5d9cd076829`），在仓库根目录配置与 API 相同的 `.env` 后执行：`pnpm --filter @chernozem/api writer:v6-rerun -- <taskId> [taskId...]`。脚本会按需就地补齐 `spatialPriority`/`spatialPrioritySummary`（有 `radarOverlap`/`lowlandOverlap` 时不重下影像），产物写到 gitignore 的 `runtime/writer-v6-rerun/<taskId>.json`。
