# 多源地块数据采集设计

## 1. 目标与边界

本设计把 Sentinel-1、Sentinel-2、Copernicus DEM、ERA5-Land、ECMWF IFS 免费公开子集和 SoilGrids 土壤背景收敛为版本化来源目录。用户只提供已授权地块、时间窗口和业务任务；任务服务按能力选择必要的数据角色，独立数据获取服务在一个采集任务中完成数据发现、权限检查、资产选择、下载或暂存、完整性校验和清单登记。来源目录包含全部免费基准数据，但单次采集不会默认下载全部来源。数据获取不依赖 Agent，也不由 Agent 发起供应商调用。

采集阶段不执行农情分析。它不计算 NDVI、NDRE、雷达指数、田内差异、干旱等级或农事结论，也不把不同分辨率的数据重采样后直接比较。后续黑土农情 Agent 的长势监测、水氮诊断、积水识别和霜冻预警能力只消费已经完成的数据采集批次，并根据各自目标选择必要资产。

当前实现状态：

- Sentinel-1、Sentinel-2、Copernicus DEM、ERA5-Land、ECMWF IFS 和 SoilGrids 均已实现下载或地块裁取 worker、文件校验和产物登记；
- `POST /api/v1/acquisitions` 独立执行来源检查，`GET /api/v1/acquisitions/{id}` 和 `GET /api/v1/fields/{id}/data` 返回统一 manifest；
- 采集 manifest 已写入 Postgres `acquisition_runs`；内存 API 仅用于无数据库的界面联调；
- `POST /api/v1/acquisitions` 返回 `202` 和 `running` 任务，下载在后台继续执行；目录发现、授权和已抓取通过 `accessStatus`、`retrievedAt`、来源状态和失败原因显式区分；
- Sentinel-1/2 的按地块 Process API 下载需要 `CDSE_CLIENT_ID/CDSE_CLIENT_SECRET`；Copernicus DEM 原生 GLO-30 瓦片下载需要具备 CCM 权限的 `CDSE_USERNAME/CDSE_PASSWORD`。缺少凭据或权限时显式返回 `needs_input`，不伪装为已采集。

## 2. 独立采集工作流

一次数据采集分为“发现”和“执行”两个阶段，但在产品中表现为一个由 API/任务服务调度的采集任务：

```text
地块 + 时间窗口
        |
        v
创建数据采集任务
        |
        v
按任务并行发现 Sentinel-1 / Sentinel-2 / DEM / 历史天气 / 预报 / 土壤
        |
        v
返回可用日期、覆盖率、许可、预计下载和失败项
        |
抓取或暂存授权资产
        |
        v
生成不可变的数据采集清单
        |
        v
后续分析工具通过任务快照只读解析 acquisitionRunId
```

发现阶段不得下载大体积产品。执行阶段只读取发现阶段已经选定且仍满足权限条件的资产，避免 Agent 自行改变数据源、时间或地块范围。

### 2.1 采集触发策略

采集采用“自动为主、手动刷新为辅”的产品策略，采集服务独立于 Agent 和页面生命周期：

- 当前原型在用户首次选择新增地块或边界新版本时自动创建首次采集；用户不需要填写来源、波段或供应商配置。
- 用户进入地块数据目录时，前端先读取该地块最近批次。已有批次直接展示，并在批次为 `running` 时轮询同一个任务 ID；没有批次才自动创建首次采集。当前自动触发依赖用户打开地块，独立调度器接入后再下沉为服务端事件触发。
- 地块切换不会重复创建同一批次。服务端也会对相同地块、边界版本、profile 和时间窗口的 `running` 任务去重，返回已有任务，避免并发下载。
- 数据目录右上角的刷新按钮是显式的“立即检查”。它会创建新的采集批次，用于用户需要立刻检查最新数据的场景；刷新不会修改历史批次。发现算法命中已有完整资产时，新批次引用原 `artifactRef`，不重复下载文件。
- 跨批次资产复用已经接入全部六类来源。它不是按固定 TTL 跳过发现，而是每次先检索并选出实际场景、模型批次或产品版本，再核对同一地块边界版本下的历史清单和落盘文件，只下载缺失或变化的资产。
- 下一阶段由后台调度器按来源更新节奏执行后续检查，即使页面没有打开也能运行。当前原型尚未实现该定时调度，不能描述为已完成能力。
- Agent 只消费已经登记的采集清单，不负责抓取数据、不保存供应商凭据，也不因为分析请求直接拼接外部请求。

采集页面只需要展示“最近批次、各来源日期、质量状态和失败原因”。`running`、`partial`、`needs_input`、`failed` 等状态必须保留，不能用“暂无记录”或零值替代真实的数据缺口。

### 2.2 任务与下载过程

创建采集任务后，manifest 必须立即登记任务 ID、创建时间、profile、时间窗口和全部来源队列。运行期间每个来源独立上报并持久化以下阶段：

```text
queued -> discovering -> downloading -> validating -> completed
                                                \-> failed
```

- `queued`：采集任务已经创建，该来源等待 worker 开始。
- `discovering`：正在检索目录、覆盖范围、可用日期和许可状态。
- `downloading`：已经选定资产，正在下载或按地块裁取。阶段消息可包含稳定的文件计数，例如 ERA5-Land 月份文件 `1/2`。
- `validating`：正在执行文件完整性、校验和、栅格像元或质量层检查。
- `completed`：该来源已经形成最终 `succeeded`、`partial` 或 `needs_input` 结果；部分可用和权限缺口仍须保留原始 domain status。
- `failed`：该来源未形成可用结果，必须记录稳定错误码、是否可重试和面向用户的失败原因。

总体进度按“已进入终态的来源数 / 本批次来源总数”展示，不伪造供应商未提供的字节百分比。后台每次阶段变化都写回同一个 run，前端轮询 `GET /api/v1/acquisitions/{id}` 展示真实过程，不在页面本地模拟下载进度。任务结束后阶段记录随 manifest 保留，用于复查本次下载过程。

### 2.3 参考日期与最近数据匹配

用户在数据目录选择“参考日期”时只查询已经登记的采集清单，不创建新采集任务，也不自动下载尚未保存的资产。后端返回六个来源对该日期的统一匹配结果，包含匹配日期或有效区间、相差天数、已下载状态、质量状态、批次引用和未匹配原因。

- Sentinel-1 使用目标日前后 7 天内的最近观测；相同距离时优先较新的观测。
- Sentinel-2 使用目标日前后 10 天内的最近观测；匹配后仍保留地块 SCL 质量状态，不能把云污染隐藏成可用。
- ERA5-Land 优先匹配有效期覆盖目标日的已登记天气文件；目标日仍处于发布延迟区间时，返回最近已下载历史日期和相差天数，明确表示该文件不覆盖目标日。
- ECMWF IFS 只匹配预报有效期覆盖目标日的 model run，不用已过期预报替代。
- Copernicus DEM 与 SoilGrids 是静态背景，返回当前已登记版本，不计算日期偏移。
- 超出窗口或没有覆盖目标日的数据时返回 `unavailable` 和具体原因，不使用很远的日期冒充目标日数据。

主列表展示每个来源的最佳匹配，例如“2026-08-11 · 早 1 天 · 已下载”；点击来源后进入完整的日期或版本历史。`available` 只表示采集目录曾发现该日期，`retrieved` 才表示本地已有通过校验并登记的资产。

## 3. 首期数据源选择

| 来源 | 首期产品 | 采集内容 | 时间/空间特征 | 采集阶段质量检查 |
| --- | --- | --- | --- | --- |
| Sentinel-2 光学 | Copernicus Data Space，Level-2A | B03/B04/B05/B06/B07/B08/B8A/B11/B12/SCL；B02 只按需用于真彩色预览 | 10 m 可见光/近红外，20 m 红边/短波红外/SCL；实际无云日期不固定 | 地块覆盖率、瓦片云量、L2A 处理级别、SCL 可用性、所需波段和产品完整性 |
| Sentinel-1 | IW GRDH，VV+VH | VV、VH、dataMask，以及升降轨、相对轨道、观测时间和入射角元数据 | High 分辨率产品，约 10 m 像元间距；名义重访约 6 天，实际受观测计划影响 | 地块覆盖率、IW/GRDH、VV+VH、升降轨、相对轨道、边缘和资产完整性 |
| Copernicus DEM | GLO-30 原生瓦片 | 覆盖地块及处理缓冲区的 30 m DEM 瓦片 | 30 m；静态数据；当前生成地块裁取 GeoTIFF，同版本原生产品跨批次复用 | 瓦片覆盖、版本、垂直基准、空洞/无数据和 CCM 权限 |
| 历史天气基线 | ERA5-Land | 2 米气温、2 米露点、总降水、向下短波辐射、潜在蒸发和 1-3 层土壤水 | 公开网格 0.1°、原生约 9 km；小时级，近实时数据有发布延迟 | 数据版本、时间完整率、变量、单位和延迟 |
| 天气预报 | ECMWF IFS 免费公开子集 | 2 米气温/露点、10 米 U/V 风、总降水、总云量、向下短波辐射；保存原始 model run | 全球 0.25°；前 144 小时每 3 小时，之后每 6 小时，最长约 15 天；每天 4 个周期 | model run、生成时间、有效时间、预报步长、陈旧度、缺小时和许可模式 |
| 全球土壤背景 | SoilGrids 250m 2.0 | pH、有机碳、总氮、砂/粉/黏粒、容重和 CEC；六个标准深度与 Q0.05/Q0.5/Q0.95 | 全球约 250 m；静态模型预测，不代表地块化验 | 产品版本、深度、单位、空间覆盖、预测不确定性和 CC-BY 4.0 归属 |

天气来源按两个角色隔离：ERA5-Land 回答已经发生过的历史天气，ECMWF IFS 回答未来可能发生什么。ERA5-Land 有发布延迟，不能把其最新可用时间之前的空档静默补成实时实况；IFS 预报也不能冒充已发生的降雨或温度观测。天气 provider 必须记录实际上游模型和 model run，不能只写接入网关名称。

### 3.1 下载目标目录（单一事实来源）

本节是首期下载 worker 的目标数据目录，也是波段、变量、深度和分位层选择的单一事实来源。provider 配置、下载 worker、manifest、测试和其他设计文档只能引用本节，不再维护第二套清单。清单变更必须同时更新采集契约版本和相关回归测试。

本节目录均已有对应 worker。是否实际生成本地文件取决于当前地块、时间窗口、数据覆盖、上游可用性和运行环境凭据；manifest 只把通过文件完整性校验并登记校验和的资产标记为 `retrieved`。

#### Sentinel-2 Level-2A

Sentinel-2 下载 worker 必须抓取下列十个数据层，并按地块范围裁取：

| 数据层 | 分辨率 | 首期用途 |
| --- | ---: | --- |
| `B03` 绿光 | 10 m | 水体、湿润区域和真彩色显示的组成波段 |
| `B04` 红光 | 10 m | NDVI、植被活力和裸土差异 |
| `B05` 红边 1 | 20 m | NDRE 和早期红边响应 |
| `B06` 红边 2 | 20 m | 红边曲线、叶绿素和冠层状态补充证据 |
| `B07` 红边 3 | 20 m | 红边曲线、较高冠层覆盖阶段的补充证据 |
| `B08` 近红外 | 10 m | NDVI、冠层覆盖与活力 |
| `B8A` 窄近红外 | 20 m | 与红边、SWIR 组合，支持 NDRE/NDMI |
| `B11` SWIR 1 | 20 m | 植被含水与湿润变化 |
| `B12` SWIR 2 | 20 m | 水分、裸土和异常区分的补充证据 |
| `SCL` 场景分类 | 20 m | 云、云影、薄云、雪冰、无数据和有效像元质量门 |

`B06` 和 `B07` 已正式纳入默认下载契约，不再作为可选波段。`B02` 只在需要生成真彩色预览时按需抓取，不进入默认分析资产。`B01`、`B09`、`AOT`、`WVP`、`CLD` 和 `SNW` 首期不默认抓取：前四项主要服务大气校正且 L2A 已完成相关处理；云和雪质量控制首期统一使用 `SCL`，避免维护重复质量层。若后续验证表明云概率或雪概率能显著改善质量门，再通过新契约版本加入。

为避免在采集层提前重采样，单个选中场景生成三个原生分辨率 GeoTIFF：`B03/B04/B08` 为 10 m，`B05/B06/B07/B8A/B11/B12` 为 20 m，`SCL` 单独保存为 20 m 分类栅格。分析工具按任务显式决定对齐方式，不在采集阶段对 `SCL` 做连续值插值。

#### Sentinel-1 Level-1 GRD

默认选择 `IW_GRDH_1S`、双极化 `VV+VH` 产品。下载 worker 通过 CDSE Sentinel Hub Process API 获取 AOI 范围的 `VV`、`VH` 和 `dataMask`；若后续改为下载原始 GRD 产品，`dataMask` 必须在预处理阶段生成，不能当作原始 GRD 资产名。manifest 保存观测时间、升降轨、相对轨道号、极化、产品处理版本和入射角信息。时序比较只在同一轨道方向、相对轨道和极化条件内进行。

积水任务按事件选择同轨灾前 2-4 景和灾后 1-2 景；一般长势或水氮任务按时间窗口保留同轨连续观测。首期不抓取 `SLC`、`RAW`、`EW`、`WV`、`HH/HV` 或相干性产品。

#### Copernicus DEM

只抓取 `COP-DEM GLO-30` 的原生瓦片，并裁成覆盖地块的 GeoTIFF。跨 1°网格地块枚举并下载全部相交瓦片。DEM 是静态数据，同一版本和瓦片应通过缓存复用。首期不使用会以 GLO-90 填补缺口的 Process API；任一 GLO-30 瓦片缺失时返回 `dem_incomplete`。

#### ERA5-Land

当前代码已真实下载下列八个小时变量，按月份、地块周边 0.1° 网格窗口生成 NetCDF：

```text
2m_temperature
2m_dewpoint_temperature
total_precipitation
surface_solar_radiation_downwards
potential_evaporation
volumetric_soil_water_layer_1
volumetric_soil_water_layer_2
volumetric_soil_water_layer_3
```

不默认抓取雪、风、气压、植被参数和第 4 层深层土壤水。请求窗口超过 CDS 最新发布日期时，只下载已发布部分并返回 `weather_incomplete`。CDS 请求允许等待最长 60 分钟；跨月任务每完成一个月份就立即校验并写入运行清单，因此后续月份超时或采集进程中断时，已完成月份仍可用于日期匹配和下一批次复用。

#### ECMWF IFS 0.25°公开子集

从同一个最新完整 model run 抓取以下地表变量，并通过 ecCodes 提取地块质心最近网格的预报时间序列 JSON：

```text
2t    # 2 米气温
2d    # 2 米露点温度
10u   # 10 米 U 风分量
10v   # 10 米 V 风分量
tp    # 总降水
tcc   # 总云量
ssrd  # 向下短波太阳辐射
```

首期不抓取压力层、集合成员、海浪和完整全球 GRIB 文件。公开门户只保留最近约 12 个 model run，采集后必须在本地保留 model run、生成时间和有效时间。

#### SoilGrids 250m

通过 WCS 按地块范围抓取以下八类土壤属性：

```text
phh2o      # 水浸 pH
soc        # 土壤有机碳
nitrogen   # 总氮
sand       # 砂粒含量
silt       # 粉粒含量
clay       # 黏粒含量
bdod       # 干容重
cec        # 阳离子交换量
```

每个属性保存六个标准深度 `0-5`、`5-15`、`15-30`、`30-60`、`60-100`、`100-200 cm` 的 `Q0.05`、`Q0.5`、`Q0.95`，用于同时保留中位预测和 90% 预测区间。这里使用的是 SoilGrids WCS coverage ID 的实际分位层写法 `Q0.5`。SoilGrids 只作为背景数据，不表示地块化验或田内精细养分差异。

### 3.2 天气预报产品约束

| 比较项 | 首期确定值 |
| --- | --- |
| 产品 | ECMWF IFS 免费公开子集 |
| 全球空间分辨率 | 0.25°；更高分辨率产品需单独服务接入 |
| 原生时间步长 | 前 144 小时每 3 小时，之后每 6 小时 |
| 最长预报 | 00/12 UTC 周期最长约 15 天；06/18 UTC 周期到约 6 天 |
| 更新频率 | 每天 4 个周期 |
| 公开接入 | ECMWF 官方门户、Python client 和多云平台副本，CC-BY 4.0 |
| 霜冻工具适配 | 提取 3/6 小时最低温和低温窗口，但不表达田内实测温度 |

首期天气预报模型确定为 **ECMWF IFS 免费公开子集**。`EcmwfIfsForecastProvider` 是唯一启用的预报 provider；完整约 9 km 产品和 CMA GRAPES 均不属于首期基准，不参与默认查询或静默回退。天气网格远粗于农田，霜冻工具只能结合 DEM 生成相对关注区，不能生成田内逐像元实测气温。

### 3.3 来源目录与按需采集

来源目录登记全部已选 provider，但任务服务根据能力生成不可编辑的 source role 集合：

| 任务能力 | 默认采集角色 |
| --- | --- |
| 地块基础数据目录 | 六类来源全部检查；用于地块详情自动更新，不直接启动分析 |
| 关键生育期长势监测 | 当前 `growth_stage_v1` 只采集 Sentinel-2，支撑首条光学时序链路；Sentinel-1 与 ERA5-Land 融合属于后续版本 |
| 水氮协同诊断 | Sentinel-2 红边/SWIR、Sentinel-1、ERA5-Land、SoilGrids、DEM |
| 农田积水灾害识别 | 灾前/灾后 Sentinel-1、ERA5-Land 事件降雨、DEM；Sentinel-2 可选 |
| 霜冻风险提前预警 | ECMWF IFS、DEM；ERA5-Land 只作为长期低温背景 |

模型不能自行增删来源；任务服务根据版本化 profile 生成来源集合。这样可以完整登记六类免费来源，又不会在每次任务中重复抓取历史天气、预报和土壤。

`field_baseline_v1` 仍用于地块数据目录的六类来源更新，不等于每个分析任务都下载六类数据。当前首条真实链路固定为 `analyze_optical_condition -> estimate_crop_stage -> assess_growth_status`，因此 `growth_stage_v1` 只补齐 Sentinel-2 完整光谱与 SCL 资产；雷达和历史天气进入长势业务结论前，必须先完成时间对齐规则与真实样本验收，再升级 profile 版本。

### 3.4 设计与实现状态

| 数据角色 | 确定来源 | 许可与首期数据费 | 设计状态 | 代码状态 |
| --- | --- | --- | --- | --- |
| 光学遥感 | Sentinel-2 / Copernicus Data Space | 免费，可商用，按要求署名；受 CDSE 免费配额限制 | 已确定 | STAC 发现和 Process API 原生分辨率地块下载已实现；运行需 OAuth client |
| 雷达遥感 | Sentinel-1 / Copernicus Data Space | 免费，可商用，按要求署名；受 CDSE 免费配额限制 | 已确定 | IW GRD VV+VH 发现和 Process API 地块下载已实现；运行需 OAuth client |
| 地形 | Copernicus DEM GLO-30 | 免费开放，遵守专用许可 | 已确定 | 原生 GLO-30 多瓦片下载与地块裁取已实现；运行需 CCM 权限 |
| 历史天气基线 | ERA5-Land | CC-BY，可商用；无数据费 | 已确定 | 按月、地块周边网格下载 NetCDF 已实现；发布延迟显式返回 |
| 天气预报 | ECMWF IFS 0.25°免费公开子集 | CC-BY-4.0，可商用；无数据费 | 已确定 | 最新 model run 发现、7 变量下载和质心最近网格时间序列提取已实现 |
| 全球土壤背景 | SoilGrids 250m 2.0 | CC-BY-4.0，可商用；无数据费 | 已确定 | WCS 8 属性 × 6 深度 × 3 分位层的地块范围下载已实现 |

“已确定”表示产品角色、产品级别、质量检查和来源边界已经进入正式设计，不表示已经完成账户申请、下载接入或真实地块验证。provider 只有通过契约测试、失败语义测试和至少一个授权地块的端到端采集后，才能改为“已实现”。

## 4. 统一输入契约

数据获取 API 只接受经过 API 层校验的业务范围，不接受任意 URL、供应商查询字符串或输出路径。该契约不注册为 Agent 工具。

```ts
interface CreateDataAcquisitionRequest {
  fieldId: string;
  boundaryVersion: number;
  period: {
    start: string; // UTC ISO-8601
    end: string;   // UTC ISO-8601
  };
  dataProfile:
    | "field_baseline_v1"
    | "growth_stage_v1"
    | "water_nitrogen_v1"
    | "waterlogging_v1"
    | "frost_risk_v1";
}
```

输入边界处理规则：

1. API 根据 `fieldId` 读取地块，不信任调用方上传的第二份几何；
2. `boundaryVersion` 必须与当前授权版本一致，避免任务执行期间边界变化；
3. 内部查询几何统一为 WGS84 GeoJSON；面积和距离计算使用地块所在的投影坐标系；
4. 所有动态数据源使用同一个 UTC 时间窗口；DEM 不使用时间窗口，但仍绑定采集批次；
5. 公开数据源仍受带宽、并发、账户处理配额和存储预算控制。

`dataProfile` 是来源集合和派生窗口的单一入口。API、前端和 Agent 不提交 provider 名称或 `sources[]`；`DataAcquisitionService` 根据版本化 profile 展开 source role，并把 profile code、版本和展开结果写入 manifest。

分析任务发现数据缺口时，由后端在 `AnalysisNextAction.acquisitionRequest` 中返回完整、确定性的采集计划，包括地块、边界版本、profile 和冻结时间窗口。前端只校验计划仍属于当前地块和边界版本，然后原样创建采集任务；它不根据提示文字猜测来源，也不把专项补采扩成六类基础采集。用户从普通地块数据入口主动更新时，才由前端创建默认的 `field_baseline_v1` 请求。

`period` 是业务任务的冻结窗口，不要求每个来源具有同样的原生时间范围。任务 profile 可以为 ERA5-Land 增加多年基线或事件窗口、为 IFS 使用未来有效窗口；每个 `SourceAcquisitionResult.requestedPeriod` 必须记录实际请求范围，禁止把不同来源的窗口静默混成一个日期。

## 5. 统一结果契约

采集任务允许部分成功。一个 provider 失败时，已经完成的其他来源不得被改成失败或丢弃。

```ts
interface DataAcquisitionRun {
  id: string;
  fieldId: string;
  boundaryVersion: number;
  period: { start: string; end: string };
  dataProfile: string;
  dataProfileVersion: string;
  status: "planned" | "running" | "needs_input" | "partial" | "completed" | "failed";
  createdAt: string;
  completedAt: string | null;
  manifestVersion: string;
  sources: SourceAcquisitionResult[];
  progress: Array<{
    source: SourceAcquisitionResult["source"];
    stage: "queued" | "discovering" | "downloading" | "validating" | "completed" | "failed";
    message: string;
    updatedAt: string;
  }>;
  manifestArtifactId: string | null;
}

interface SourceAcquisitionResult {
  sourceType: "optical" | "radar" | "terrain" | "weather-historical" | "weather-forecast" | "soil";
  source: "sentinel-1" | "sentinel-2" | "copernicus-dem" | "era5-land" | "ecmwf-ifs" | "soilgrids-250m";
  provider: string;
  product: string;
  status: "succeeded" | "partial" | "needs_input" | "failed";
  requestedPeriod: { start: string; end: string } | null;
  discoveredAt: string;
  retrievedAt: string | null;
  availableDates: string[];
  selectedObservationDates: string[];
  selectedAssets: AcquiredAsset[];
  coverage: {
    requestedAreaHa: number | null;
    coveredAreaFraction: number | null;
  };
  quality: {
    flags: string[];
    metadata: Record<string, string | number | boolean | null>;
  };
  license: {
    access: "public" | "licensed" | "restricted" | "unknown";
    downloadAllowed: boolean;
    attribution: string | null;
  };
  limitations: string[];
  error: {
    code: string | null;
    retryable: boolean;
    message: string | null;
  };
}

interface AcquiredAsset {
  id: string;
  providerAssetId: string;
  role: "spectral" | "quality-mask" | "radar" | "dem" | "weather-series" | "soil" | "metadata";
  capturedAt: string | null;
  validFrom: string | null;
  validTo: string | null;
  generatedAt: string | null;
  retrievedAt: string | null;
  spatialResolutionMeters: number | null;
  crs: string | null;
  format: string;
  byteSize: number | null;
  checksum: string | null;
  artifactRef: string | null;
  accessStatus: "discovered" | "authorized" | "retrieved";
}
```

公共结果不得包含供应商签名下载 URL、访问令牌、账号、密码、任意本地路径或完整供应商响应。发现阶段资产的 `retrievedAt` 和 `artifactRef` 为 `null`；只有完整下载、校验并登记后才能设为 `accessStatus: "retrieved"`。`artifactRef` 是内部产物标识，由仓储层解析到受控对象存储。

### 5.1 统一数据目录

`DataAcquisitionRun.sources` 是本次采集数据日期、覆盖、质量、许可和失败状态的单一事实来源。所有来源按 `sourceType` 分类存放，但仍属于同一个 manifest，前端、工具和 Agent 不再分别维护自己的“可用日期”。

日期字段必须表达不同语义：

- `availableDates`：发现阶段可选的观测日期；
- `selectedObservationDates`：本批次实际选中的观测日期；
- `capturedAt`：卫星或观测数据的实际观测时间；
- `validFrom` / `validTo`：天气预报或时间序列覆盖区间；
- `generatedAt`：模型产品生成时间；
- `retrievedAt`：系统实际抓取时间；未下载时为 `null`；
- `accessStatus`：明确区分已发现、已有权限和已完成抓取。

不得用文件修改时间替代观测日期，也不得把预报生成时间当作预报有效时间。DEM 等静态数据允许 `capturedAt` 为空，但必须记录产品版本和 `retrievedAt`。土壤数据必须区分采样时间、产品发布时间和系统获取时间，并在适用时记录采样深度。

## 6. 采集编排

### 6.1 范围冻结

采集开始时保存地块 ID、边界版本、作物季、时间窗口和输入哈希。后续重试继续使用同一个范围快照，不重新读取可能已经变化的地块。

### 6.2 并行数据发现

编排器以有限并发调用各 provider 的 `discover`：

- Sentinel-1 查询覆盖地块的 IW GRD VV+VH 场景；
- Sentinel-2 查询覆盖地块的 L2A 场景和瓦片云量；
- DEM 根据地块外包矩形和处理缓冲区定位 GLO-30 瓦片；
- ERA5-Land 根据覆盖地块的 0.1° 网格窗口查询历史时段，并记录实际最新可用时间和发布延迟；
- ECMWF IFS 根据地块代表点查询最新有效 model run，并检查预报有效期；
- SoilGrids 根据地块外包矩形查询所需属性和深度层，并保留产品版本与不确定性；
- 授权土壤采样记录属于后续独立适配器，不在当前六类公开来源的采集契约中。

任何 provider 都不能在空间过滤构造失败时退化为无空间限制查询。空间查询失败必须返回 `invalid_geometry` 或 `provider_request_failed`。

### 6.3 资产选择

采集阶段只选择数据，不计算分析指标：

- Sentinel-2 按观测日期分组，在每个日期内按地块覆盖率、观测时间和许可选择一景；
- Sentinel-1 按地块覆盖率、IW/GRD、VV+VH、日期、升降轨和相对轨道分组；
- DEM 选择能够完整覆盖地块及缓冲区的最高可公开使用分辨率；
- ERA5-Land 按同一数据版本和连续历史窗口选择；若事件窗口仍处于发布延迟内，返回 `weather_incomplete`，不伪造实时实况；
- ECMWF IFS 只选择一个最新且完整的 model run，不把不同 run 的小时片段静默拼接；
- SoilGrids 按属性、深度、产品版本和空间覆盖选择，不把粗分辨率背景值伪装成田内差异；
- 后续接入授权土壤样本时，按采样日期、深度、检测方法和地块边界版本选择，并与 SoilGrids 背景值保持不同来源身份。

Sentinel-2 场景选择只使用观测时间和地块覆盖，不以供应商提供的整景云量进行筛选、排序或状态判断。整景云量只保留为上游溯源元数据，因为它描述整幅卫星产品，不能代表地块情况。一次采集按观测日期去重并最多选择最近 12 期，每期只选一景；每个选中日期都生成完整的 10 m 光谱、20 m 光谱和 20 m SCL 三件套。采集器立即从每期地块 SCL 分别计算 `fieldValidPixelFraction`、`fieldCloudAffectedFraction`、像元数量和类别直方图；Sentinel Hub 在地块外包矩形中写入的 `SCL=0` NoData 像元必须从地块质量分母中排除。有效像元达到 80% 时可作为完整光学输入；50%-80% 为局部可用；低于 50% 为证据不足。manifest 通过 `sceneQualityByDate` 保留逐日期质量，并分别汇总可用、云污染和待判质日期数量；不得把任一日期的质量状态套用到整条时序。命中历史影像缓存时重新读取 SCL 并按当前算法计算质量，不能沿用旧算法生成的摘要。Sentinel-1 不受云影响。

L2A 是经过大气校正的地表反射率产品，不是“已经去云并恢复云下地表”的影像。采集层保存 L2A 光谱和 SCL 原始证据；遥感工具层使用 SCL 生成单期云掩膜资产，云、云影、薄云、雪和无数据像元写为 NoData。首期不使用其他日期填补这些 NoData，不生成跨日期无云合成图。连续阴雨期间以同范围 Sentinel-1 雷达承担当期状态证据；界面可以显示最近清晰光学影像，但必须保留其真实观测日期，不能把它描述为当前画面。

### 6.4 执行抓取

执行抓取时：

1. 再次验证地块授权、provider 权限和资产状态；
2. 优先请求按 AOI 和所需波段裁剪的资产；只有 provider 不支持子集时才暂存完整产品；
3. 下载写入临时文件，校验长度和校验和后原子登记为运行产物；
4. 保存原始 provider 元数据的受控摘要和数据版本；
5. 不在 Agent 工具调用中阻塞数小时下载，大资产通过后台任务执行并报告进度。

采集阶段允许做保障可读取性的机械处理，例如解包、格式识别、COG 转换、坐标元数据验证和按地块外包矩形裁剪。辐射校准、地形校正、云掩膜应用、重采样、指数计算和多源对齐属于后续分析阶段。

### 6.5 天气空间采样

第一版 ERA5-Land 按覆盖地块的 0.1° 网格窗口下载，ECMWF IFS 按地块质心获取代表时间序列，并分别记录 `spatialSampling`、网格分辨率和 model run。天气网格远粗于单个地块，不能把同一个天气值绘制成田内差异，也不表示气象站实测面。

## 7. 资产存储与幂等性

运行时文件放在受控产物目录或 S3/MinIO，不进入 Git：

```text
runtime/artifacts/acquisitions/{runId}/
  manifest.json
  optical/sentinel-2/
  radar/sentinel-1/
  terrain/copernicus-dem/
  weather/
    historical/era5-land/
    forecast/
      ecmwf-ifs/
  soil/soilgrids-250m/
```

目录分类只用于产物管理，不能成为业务契约。数据库中的 `source_acquisition_result` 与版本化 `manifest.json` 才是日期、来源、质量、许可和失败状态的权威索引。

幂等键至少包含：

```text
organizationId
fieldId
boundaryVersion
provider
product
providerAssetId
requestedPeriod
acquisitionContractVersion
dataProfileVersion
```

同一资产已经完成校验时复用已有产物，不重复下载。供应商重新处理或产品基线变化时，使用新的 provider 版本创建新资产，不覆盖旧版本。

复用判定按来源执行：

- Sentinel-1/2 每次照常发现和选择场景，只有供应商场景 ID 与观测时间一致时才复用；Sentinel-2 按观测日期逐景判断三件套是否完整，完整日期直接复用并继承该日期的地块像元质量，缺失日期单独补下载，不因同一来源已有其他日期而跳过；
- Copernicus DEM 必须命中本次发现的全部原生产品 ID 和同一数据集版本；
- ERA5-Land 以月文件为单位复用，历史资产的 `validFrom/validTo` 必须完整覆盖本次所需日期；同一窗口中允许复用已完整月份并只下载新增或不完整月份；
- ECMWF IFS 必须命中完全相同的模型批次资产 ID 和预报有效期；
- SoilGrids 必须命中 2.0 产品版本和当前契约规定的完整 144 文件资产集。

所有来源还必须满足 `accessStatus: "retrieved"`、非空校验和、非空 `artifactRef`，且受控 `runtime/artifacts` 下的原文件仍存在且大小大于零。地块边界版本不同、文件丢失、资产组不完整或上游产品 ID/版本变化时均不复用。新清单记录 `cacheHit`、`reusedFromRunId`、复用数和新增下载数，旧清单保持不可变。

采集清单记录：

- 数据来源、产品、供应商资产 ID 和获取时间；
- 实际观测时间、时间范围和空间范围；
- 分辨率、坐标系、波段/极化和处理级别；
- 质量元数据、许可、归属说明和下载状态；
- 文件大小、校验和、工具版本、输入哈希和重试次数；
- 明确的失败原因和是否可重试。

## 8. 资源和许可成本

- Sentinel-1/2：Copernicus Sentinel 数据对公众、科研和商业用户免费提供；CDSE 下载、处理 API、openEO 作业、带宽、存储和并发仍受免费配额限制，超出后可能需要云额度或自有基础设施。
- Copernicus DEM GLO-30：注册 CDSE CCM 用户后可免费访问，按专用许可保存归属和修改说明；GLO-90 和受限的 EEA-10 不进入首期默认抓取或静默回退。
- ERA5-Land：通过 Copernicus Climate Data Store 获取，按 CC-BY 许可使用；记录数据版本和发布延迟，批量下载、缓存和处理由系统预算控制。
- ECMWF IFS 0.25°公开子集：按 CC-BY-4.0 可商用，数据本身不收费；直接交付高分辨率或大体量目录可能产生分发服务费，因此首期只使用公开 0.25°子集。
- SoilGrids 250m：全球土壤背景产品按 CC-BY-4.0 使用，保存属性、深度、版本、不确定性和归属；官方 REST API 不保证稳定，生产环境优先使用 WCS/WebDAV 自托管。WCS 地块裁取 worker 限制为 2 个并发请求，网络断开、超时和 408/429/5xx 会按 2、4、8 秒退避重试 4 次，非重试型错误仍显式返回 `soil_service_unavailable`。
- CLDAS 与 CMA GRAPES：不属于首期免费商用基准。CLDAS 的公开注册和下载不等于允许用于经营性产品，接入前需单独核验授权；GRAPES 保留为未来候选。
- 国内土壤数据库与授权样本：作为后续 `DomesticSoilProvider` 和 `FieldSoilSampleProvider` 接入，分别记录申请状态、采样深度、检测方法和许可。
- 所有来源都要设置资产保留期限、下载并发和最大字节数；达到预算时进入 `needs_input`，不得静默降级为低质量数据。

## 9. 稳定失败语义

| 错误码 | 含义 | 采集任务行为 |
| --- | --- | --- |
| `invalid_geometry` | 地块几何、坐标或边界版本无效 | 整个任务失败，不调用外部 provider |
| `no_scenes` | 时间窗口内没有场景 | 当前来源 `partial`，其他来源继续 |
| `no_coverage` | 有场景但没有覆盖地块 | 当前来源 `partial`，其他来源继续 |
| `cloud_contaminated` | 地块裁片的云、云影或薄云导致有效像元不足 | 保留 L2A 与 SCL；生成云掩膜资产，并根据地块有效像元返回局部可用或证据不足 |
| `asset_not_licensed` | 资产存在但不可下载 | 当前来源 `needs_input` 或 `partial` |
| `provider_unauthorized` | provider 凭据无效 | 当前来源失败，不记录密钥或完整响应 |
| `provider_rate_limited` | provider 限流 | 有界退避重试，超过预算后 `partial` |
| `provider_unavailable` | 网络或服务不可用 | 有界重试，保留其他已完成来源 |
| `asset_integrity_failed` | 长度、校验和或格式校验失败 | 删除临时文件并允许重新抓取 |
| `weather_incomplete` | 天气时间序列缺小时或变量 | 标记缺口，不以零值补齐 |
| `forecast_stale` | 预报生成时间超过任务允许陈旧时限 | 不发布霜冻风险，等待新 model run |
| `forecast_model_unavailable` | ECMWF IFS 当前 model run 或接入网关不可用 | 有界重试；不自动切换其他模型 |
| `dem_incomplete` | GLO-30 瓦片缺失或有空洞 | 标记缺口，不静默回退其他分辨率 |
| `soil_incomplete` | 土壤来源缺失、尺度不适用或采样信息不完整 | 标记缺口，不推断田内养分差异 |
| `soil_service_unavailable` | SoilGrids 服务或属性覆盖不可用 | 保留其他来源，水氮任务进入受限状态 |

只有所有请求来源都失败且没有可用资产时，采集任务才进入 `failed`。部分来源成功时进入 `partial`，并保留可以被后续受限分析使用的资产。

## 10. 数据获取与 Agent 边界

数据获取由 API/任务服务或定时调度器创建独立后台作业：

```text
POST /api/v1/acquisitions
  -> DataAcquisitionService
  -> acquisition-worker
  -> AcquisitionRun + Manifest
```

API 只传递已校验的 `fieldId`、`boundaryVersion`、时间窗口和 `dataProfile`。具体来源集合、provider、查询表达式、认证、重试、下载、缓存和产物路径由 `DataAcquisitionService` 内部管理。采集作业完成后，内部工具服务通过只读接口解析清单：

```text
resolve_acquisition_manifest(acquisitionRunId)
```

不向 Agent 注册以下能力：

- 任意 OData/STAC 查询；
- 任意下载 URL；
- 任意输出目录或本地文件访问；
- 整景批量下载；
- 文件清理；
- provider 用户名、密码、令牌或客户端密钥。

API/后台作业返回 `runId`、每个来源的结构化状态和产物引用。能力路由器把任务快照交给同一个黑土农情 Agent，并加载长势监测、水氮诊断、积水识别或霜冻预警的能力契约。服务端在业务工具执行前完成内部 readiness preflight，不向模型注册独立的就绪检查工具；Agent 不直接读取原始 manifest 或资产清单，业务深工具只能消费已经登记的资产，不能在执行过程中隐式触发数据下载。采集失败、部分成功和数据日期仍以 manifest 为单一事实来源。当前工具边界见 [Agent 设计](agent.md)。

## 11. 模块划分

```text
API / Task Scheduler
  create_acquisition_run
        |
        v
DataAcquisitionService
  范围冻结、profile、并发、预算、重试、幂等、清单
        |
        +-- CopernicusCatalogClient
        |     +-- Sentinel1AcquisitionProvider
        |     +-- Sentinel2AcquisitionProvider
        |     +-- CopernicusDemProvider
        +-- WeatherProvider
        |     +-- Era5LandHistoricalWeatherAdapter
        |     +-- EcmwfIfsForecastAdapter
        +-- SoilBaselineProvider
              +-- SoilGrids250mAdapter
              +-- DomesticSoilReferenceAdapter (later)
              +-- FieldSoilSampleAdapter (later, authorized)
        |
        v
AcquisitionStore / ArtifactStore
        ^
        |
AI-visible tools (normalized readiness and business results)
```

`CopernicusCatalogClient` 只隐藏 CDSE 认证、OData/STAC 语法、分页和限流；Sentinel-1 与 Sentinel-2 provider 分别拥有自己的产品选择和元数据规则。不能用一个按 mission 字符串分支的浅模块承担所有遥感语义。

## 12. 实施状态与下一步

### 已完成：采集契约、编排器和持久化

- `@chernozem/contracts` 已包含采集任务、来源结果、下载状态和资产引用；
- `DataAcquisitionService` 已能按 profile 独立执行六类来源发现，并保留部分成功结果；
- acquisition run 和 manifest 已写入 Postgres；无数据库时保留内存模式供界面联调；
- ERA5-Land 已完成按月、地块网格窗口的真实 NetCDF 下载、校验和与产物登记；
- 采集阶段不包含光学或雷达分析。

当前证据：API 和 provider 测试覆盖多源发现、部分成功及失败语义；ERA5-Land 已在真实 CDS 请求中生成登记产物。

### 已完成：公开数据下载与地块裁取 worker

- Sentinel-2 按观测日期去重、单次最多选择最近 12 期，并为每期按第 3.1 节固定目录生成 10 m 光谱、20 m 光谱和 20 m SCL 三个原生分辨率资产；
- Sentinel-1 固定 IW GRD VV+VH，并保存 `VV/VH/dataMask` 地块栅格；
- Copernicus DEM 枚举全部相交 GLO-30 原生瓦片并裁到地块；
- ECMWF IFS 下载 7 个地表变量并输出地块质心最近网格时间序列；
- SoilGrids 通过 WCS 下载 144 个属性/深度/分位层地块背景栅格；
- 每个完成资产均登记获取时间、文件大小、SHA-256、内部 `artifactRef` 和 `accessStatus: "retrieved"`。

当前验证：离线 provider/worker 契约测试覆盖五类来源成功登记；真实公共端点已验证 SoilGrids 地块 WCS GeoTIFF、IFS 七变量 GRIB/最近网格提取，以及 Sentinel-1/2 地块裁片下载。2026-08-12 使用仓库测试中的铁岭验收范围验证：Sentinel-1 于 2026-08-04 获取 10 m `VV/VH/dataMask` 三波段资产；Sentinel-2 的 2026-08-05 验收场景已下载光谱和 SCL 三项资产，地块 SCL 显示云/云影影响 69.01%、有效像元 30.99%，因此标记为 `partial + cloud_contaminated`。种植季窗口另验证了 2026-06-26 场景，可生成非空的 10 m 光谱、20 m 光谱和 20 m SCL 三项资产。当前生产选择规则已收敛为“按时间和地块覆盖选择，下载后按地块 SCL 判质”，不按整景云量筛选。该范围是工程验收样本，不代表客户地块或农情结论。

Sentinel Hub 的 Process API 按 STAC 选中观测的 UTC 日期请求影像，不使用产品时间戳前后数分钟的窄窗口；CDSE 两端对产品时间戳的口径可能不同，窄窗口会返回格式有效但全零的 GeoTIFF。下载器现使用整日窗口，并在登记前读取像元；无有效像元、非有限值或 Sentinel-2 全零栅格均删除并返回 `asset_integrity_failed`。

### 后续：真实授权地块验收与调度

- 当前 CDSE Sentinel Hub OAuth client 已完成工程验收；下一步需由已授权客户地块重放同一验收流程，工程验收范围不得替代客户授权；
- 用具备 CCM 权限的账户完成 GLO-30 原生瓦片下载验收；
- 增加按来源更新频率运行的后台调度器，在页面未打开时也能自动检查新数据；
- 增加跨瓦片 DEM、Process API 2500 像素限制、上游限流和中途失败清理的集成回归。

完成标准：同一采集批次包含雷达资产、天气时间序列、土壤背景和明确来源版本；任何来源失败都不会生成零值或无来源养分判断。

### 后续：后台作业和 Agent 只读接入

- 增加后台大资产下载、进度和可重放检查；
- 实现内部只读 manifest resolver 和 readiness preflight，由业务工具在执行前读取；不把它注册为 Agent 工具。

完成标准：用户从一个地块任务发起一次独立采集，能够查看每个来源的状态、可用日期、实际观测日期、覆盖、许可、产物和失败原因；Agent 不拥有采集凭据，也不解析原始资产清单；分析不会在采集完成前隐式执行。

## 13. 验证场景

最小回归集必须覆盖：

1. Sentinel-1、Sentinel-2、DEM、ERA5-Land、ECMWF IFS 和 SoilGrids 在同一个 profile 中按需成功；
2. Sentinel-2 云量过高但 Sentinel-1 成功；
3. Sentinel-1 无覆盖但 Sentinel-2 成功；
4. DEM GLO-30 缺瓦片时返回 `dem_incomplete`，不静默回退 GLO-90；
5. ERA5-Land 缺小时或事件窗口仍未发布，返回 `weather_incomplete`；
6. IFS 预报过期或 model run 不可用，返回 `forecast_stale`/`forecast_model_unavailable`，不静默切换其他模型；
7. SoilGrids 属性缺失或服务不可用，返回 `soil_service_unavailable`；
8. provider 429、超时和无效 JSON；
9. 重复执行命中缓存，不重复下载；
10. 地块边界版本变化时拒绝执行旧范围；
11. 采集结果中不存在密钥、令牌、签名 URL 和任意文件路径；
12. 采集产物中不存在 NDVI、雷达指数或农情结论字段；
13. 一个来源失败时，其他来源的成功资产仍可被后续分析引用。

## 14. 官方资料

- [Copernicus Data Space OData API](https://documentation.dataspace.copernicus.eu/APIs/OData.html)
- [Copernicus Data Space STAC API](https://documentation.dataspace.copernicus.eu/APIs/STAC.html)
- [Copernicus Data Space 免费配额与限制](https://documentation.dataspace.copernicus.eu/Quotas.html)
- [Sentinel-1 数据集合](https://dataspace.copernicus.eu/data-collections/copernicus-sentinel-missions/sentinel-1)
- [Sentinel-1 GRD Process API](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/S1GRD.html)
- [Sentinel-2 数据集合](https://dataspace.copernicus.eu/data-collections/copernicus-sentinel-missions/sentinel-2)
- [Sentinel-2 L2A Process API](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/S2L2A.html)
- [Copernicus DEM GLO-30](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM.html)
- [ERA5-Land 数据说明](https://confluence.ecmwf.int/spaces/CKB/pages/140385202/ERA5-Land+data+documentation)
- [Copernicus Climate Data Store CC-BY 许可](https://cds.climate.copernicus.eu/licences/cc-by)
- [ECMWF Open Data](https://www.ecmwf.int/en/forecasts/datasets/open-data)
- [SoilGrids 官方说明](https://docs.isric.org/globaldata/soilgrids/)
- [SoilGrids WCS 地块范围访问](https://docs.isric.org/globaldata/soilgrids/wcs.html)
