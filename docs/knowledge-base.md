# 辽宁春玉米农情解释知识库

首版已建立可运行的**本地原文检索**，用于解释地块或任务中的农情线索。它不依赖外部 chat/embedding 服务生成索引，不产生地块观测，不计算遥感指标，也不直接发布施肥、灌溉或用药处方。

## 当前交付与范围

当前知识包为 `maize-evidence-v1`，清单位于 [maize-evidence-v1.json](knowledge-sources/maize-evidence-v1.json)。首次核验日期为 2026-10-18。

| 内容 | 当前数量与状态 |
| --- | --- |
| 来源目录 | 14 个来源 |
| 可全文处理的开放论文 | 9 篇；Crossref 与出版方 JATS 双重核验 |
| 可检索原文 | 40 个章节、177 个原文片段 |
| 仅引用的官方入口 | 5 个；不复制全文、不返回为检索证据 |
| 检索引擎 | `extractive-bilingual-v2`，确定性的中英概念检索 |
| GraphRAG | 保留为可选引擎；当前模型访问被上游阻止，尚无完成索引 |
| 农业效果验证 | 尚未完成；检索通过不等于完成田间诊断或效果验证 |

材料围绕长势、生育期、水氮解释、积水机制和低温影响组织。目前没有巡田记录也可以查询；缺少现场记录时，不能把一般规律写成当前地块实测，不能确认缺氮或给出未经验证的变量处方。知识库不要求先建立完整巡田档案。

## 已核验的全文来源

以下论文均保存作者、DOI、发表年份、许可、章节定位、原文 SHA-256 和获取快照。除第一篇为 CC BY 3.0 外，其余为 CC BY 4.0。原文没有翻译或改写成“专家结论”；中文解释由对话模型结合原文和地块事实生成。

| 原始来源 | 用途 | 适用范围 |
| --- | --- | --- |
| [Delegido et al., 2011](https://doi.org/10.3390/s110707063)，Sentinel-2 红边、LAI 与叶绿素 | 长势、水氮线索 | 通用遥感方法，不能凭指数确诊缺氮 |
| [Wang et al., 2022](https://doi.org/10.3390/agronomy12102585)，东北玉米物候 | 生育期、区域背景 | 东北区域研究，地块仍需播期、品种和当年天气 |
| [Jiang et al., 2023](https://doi.org/10.3390/atmos14121755)，东北春玉米播期与温度 | 积温、成熟和低温背景 | 非本地霜冻预警阈值 |
| [Soil properties and nitrogen status, 2020](https://doi.org/10.3390/rs12142175) | 红边、氮营养与土壤差异 | 意大利玉米/小麦试验，模型精度不迁移为铁岭精度 |
| [Sentinel-1 vegetation optical depth, 2019](https://doi.org/10.3390/rs11232769) | 雷达、冠层和土壤水分解释 | 有观测几何、土壤和冠层假设，不是积水确证 |
| [Inundated vegetation and SAR, 2022](https://doi.org/10.3390/rs14246374) | 积水与植被散射机制 | 美国洪水区域研究，不是辽宁玉米识别效果 |
| [Chilling tolerance in maize, 2022](https://doi.org/10.3390/plants11162082) | 玉米低温生理响应 | 冷害与结冰霜冻应区分，试验温度不是本地预警阈值 |
| [Forage maize waterlogging, 2025](https://doi.org/10.3390/agronomy15102389) | 涝渍和生育阶段差异 | 韩国青贮玉米盆栽试验，不套用处理天数、产量或施肥量 |
| [Waxy maize waterlogging, 2023](https://doi.org/10.3390/plants12173034) | 拔节期涝渍生理影响 | 河南糯玉米控水试验，不套用淹水阈值或减产率 |

每个来源的 `capabilities` 决定可参与哪些任务；`retrievalKeywords` 只辅助检索；`applicabilityNote` 随命中材料返回。其他地区资料标为“通用方法”，不标为本地验证。

## 官方来源目录

| 入口 | 当前处理 |
| --- | --- |
| [辽宁省农业农村厅 2024 年粮油生产技术指导文件（含玉米）](https://nync.ln.gov.cn/nync/index/zwgk/zszdgkwj/2024031114442896015/index.shtml) | 登记辽农农〔2024〕42号出处，未复制全文 |
| [Copernicus Sentinel-2 Products](https://sentiwiki.copernicus.eu/web/s2-products) | 光学产品和质量说明入口 |
| [Copernicus Sentinel-1 Products](https://sentiwiki.copernicus.eu/web/s1-products) | 雷达产品说明入口 |
| [ISRIC SoilGrids](https://www.isric.org/explore/soilgrids) | 土壤背景数据说明入口 |
| [中央气象台农业气象灾害风险预警](https://www.nmc.cn/publish/nongyeqixiang/quanguonongyeqixiangzaihaifengxianyujing/index.html) | 动态预警入口，不能充当已获取的当前天气 |

这些入口已验证可访问，但本次未完成正文再利用许可核验，因此保持 `citation_only`。动态页面的原始发布年份未核实就保存为 null，目录版本记录访问日期。后续拿到地方农技站材料、标准或书籍时，先登记许可与版本，满足全文处理条件后再进入索引。

## 建立与复用

前置条件：PostGIS 正常运行，已执行既有知识来源迁移 004、011，以及新的 014。已有数据库执行：

```powershell
docker compose exec -T postgis psql -U chernozem -d chernozem -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/014_local_knowledge.sql
pnpm --filter @chernozem/knowledge-mcp knowledge:build-local
```

首次运行需要网络，依次验证 Crossref 的 DOI、标题、出版社和许可，再核验出版方 JATS 的 DOI、标题和许可声明。只有白名单出版方地址、明确 CC BY 许可的全文可以进入当前知识包。numeric XML entities 被解码后再比对标题，不跳过元数据校验。

本地产物保存在 `runtime/knowledge/maize-evidence-v1/`：

- `sources/`：原始出版方 XML；
- `input/`：带元数据与原文章节的文本；
- `source-snapshot.json`：获取日期、来源版本、清单指纹和原文哈希；
- `input-manifest.json`：来源、章节文件名、定位和章节文本哈希。

未变更清单和已验证原文时可以离线重复建立。入库前逐一核对全部来源与章节哈希；来源版本不能原地改写。新知识包用独立来源快照版本保留早期 GraphRAG 输入，避免覆盖旧产物。

`knowledge_local_indexes` 保存引擎版本、指纹、manifest 和片段数；`knowledge_local_passages` 保存原文片段与来源快照。片段不超过 1800 字符，优先沿段落/句子切分，引用包含章节名与提取文本的字符位置。来源、输入 manifest、检索元数据和引擎版本共同决定指纹。

全部片段在单个数据库事务中发布；失败回滚，不留下可查询的半成品。同一指纹重复或并发建立复用同一个 index ID。来源变化应使用新版本，切分或排序规则变化应提升 `LOCAL_ENGINE_VERSION`。

## Agent 接入

本地 `.env`：

```dotenv
KNOWLEDGE_MCP_ENABLED=true
KNOWLEDGE_SEARCH_ENGINE=local
```

重启 API 后使用现有农田对话，选择农田即可提问，例如：

- “红边下降能直接判断缺氮吗？”
- “玉米生育期与积温有什么关系？”
- “雷达可以识别积水吗？”
- “玉米低温霜冻有什么影响？”

API 通过独立 stdio MCP 暴露 `search_agronomy_knowledge({taskId | fieldId, query})`，范围二选一。检索先校验组织、玉米作物和未归档地块，任务查询还锁定能力；SQL 先过滤发布状态、版本、许可、区域和能力，再进行相关性排序。来源目录不作为全文证据返回。

本地检索通过受控中英概念表匹配英文原文，按概念覆盖与标题/关键词相关性排序，过滤弱匹配，每份来源至多两段、合计至多五段。片段中实际出现查询概念才可命中，不能仅凭来源标签匹配。该方案是当前试点的可复查基线，尚不覆盖任意农业问题或复杂语义同义表达。

成功结果返回 `answer: null`、原文、章节位置、来源链接、版本和适用范围。`indexRunRef` 为当前引擎的发布索引 ID，GraphRAG 与本地索引分别保存，不伪造 GraphRAG 完成状态。对话模型负责用中文解释并保留出处，不能把外地论文的阈值、精度、产量响应当成本地验证事实。

无匹配返回 `no_matches`；范围无效、没有索引或数据库故障返回 `unavailable`。不静默切换引擎，不产生无出处答案；知识故障不改写已经完成的遥感结果。

## 验证与已知缺口

```powershell
pnpm --filter @chernozem/knowledge-mcp test
pnpm --filter @chernozem/knowledge-mcp typecheck
pnpm --filter @chernozem/api knowledge:verify-local
```

首版验证包括中文问题命中英文来源、原文不改写、适用范围传递、无关问题不匹配、全部来源和章节哈希校验，以及重复建立复用索引。`knowledge:verify-local` 使用临时合成组织、地块和任务，通过真实 PostgreSQL 与 stdio MCP 运行 14 次检索检查；结束后删除合成数据。它覆盖四种任务、组织隔离、作物限制、归档地块、无效范围和不匹配问题，不读取或打印真实用户边界。

目前仍缺少辽宁当地专家审校的规则、独立检索评测集和同期田间对照。这些缺口影响农业解释可迁移性和诊断验证，不能靠增加论文数量消除。下一步优先收集少量真实任务中的问题与专家修订，再决定是否增加语义向量检索或 GraphRAG。

## 可选 GraphRAG 引擎

原有 GraphRAG 3.1.1 链路仍可显式选择：`KNOWLEDGE_SEARCH_ENGINE=graphrag`。它需要可用的 chat 与 embedding 接口；当前上游模型校验被阻止，本地原文检索不依赖它。

```powershell
uv venv runtime/graphrag-venv --python 3.11
uv pip install --python runtime/graphrag-venv/Scripts/python.exe -r apps/knowledge-mcp/requirements.txt
pnpm --filter @chernozem/knowledge-mcp knowledge:init
pnpm --filter @chernozem/knowledge-mcp knowledge:prepare
pnpm --filter @chernozem/knowledge-mcp knowledge:plan-index
pnpm --filter @chernozem/knowledge-mcp knowledge:index -- <indexRunId>
pnpm --filter @chernozem/knowledge-mcp knowledge:sync -- <indexRunId> <output目录> <manifest.json>
```

原有 `knowledge:prepare` 默认读取 `growth-monitoring-v1.json`，只覆盖早期长势包。GraphRAG 的 Python、root、data、API base/key 通过环境变量配置，凭据不写入来源或索引指纹。只有 GraphRAG 状态为 completed、必要产物存在并完成引用同步后，才可使用该引擎。
