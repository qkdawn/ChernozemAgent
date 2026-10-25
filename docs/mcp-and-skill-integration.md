# Skill、内部工具与 MCP

黑土智管只有一个面向用户的黑土农情 Agent。四项农情能力由四个 Skill 表达，不拆成多个 Agent。

权威边界：

- Agent、Skill、知识库和运行流程：[agent.md](agent.md)
- 受控工具与失败语义：[ai-tool-contracts.md](ai-tool-contracts.md)
- 独立数据采集层：[multisource-data-acquisition.md](multisource-data-acquisition.md)
- 唯一工具结果契约：`packages/contracts/src/index.ts` 中的 `AnalysisResult<T>`

## 运行边界

```text
任务创建 -> 服务端固定地块、时间范围和 Workflow
Workflow -> 按代码声明的顺序调用当前功能所需的受控工具
内部工具 -> 读取已登记资产并保存 AnalysisResult<T>
知识服务 -> 在对话前预取解释上下文并返回出处
Codex 对话 -> 仅依据任务事实和知识上下文回答用户
```

内部确定性工具保持本地调用，因为它们与任务结果仓储、栅格产物和质量规则共享同一领域上下文。为了使用 MCP 而把这些工具搬到远程服务，只会增加协议和部署复杂度。

MCP 用于确实需要跨进程隔离或复用的能力。首个适配器是 `search_agronomy_knowledge`，服务端固定 GraphRAG workspace、东北玉米范围和索引版本；模型只能传入 `{ taskId, query }`。未来插件必须经过允许列表和 schema 注册后才能进入某项 Skill。

MCP 不提供任意 SQL、Shell、文件路径、网络请求或供应商下载能力。数据采集继续独立运行，模型可传给内部分析工具的参数仍只有 `{ taskId }`。MCP 不可用时只减少知识解释，不得把确定性农情结果改成失败。

## 实现顺序

1. 已完成：确定性 Workflow、工具注册表、scope 校验和运行记录。
2. 已完成：前端读取真实 Agent 轨迹，并围绕不可变任务结果继续对话。
3. 已完成：固化知识检索结果契约、任务 scope 校验和 GraphRAG text unit 到来源定位的外键映射；任务对话在调用 Codex 前按需预取知识上下文。
4. 已完成：GraphRAG 3.1.1 Local Search 的只读 MCP 服务、API stdio 客户端和引用同步管线；未配置或没有索引时任务对话继续基于任务事实工作。
5. 正在推进：登记首批合法来源、生成真实索引，并以长势任务追问验收引用定位。
6. 验证后再决定是否有第二个外部 MCP 能力；没有明确跨进程需求时不新增。
