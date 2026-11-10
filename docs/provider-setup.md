# 模型服务接线

Sci-epo 0.4.0 起提供作者可用的[模型服务管理页](provider-management.zh-CN.md)，支持服务、模型和三个创作角色的独立分配。密钥只写入服务器加密存储，不回显给网页；普通运行状态接口只显示是否配置。下文的环境变量只用于首次导入。生成、审稿、改稿失败时保留原稿和失败记录，不以示例结果代替真实返回。

## 首次导入用的环境变量

可以使用 `SCIEPO_MODEL_*`，也兼容 `AI_NOVEL_*` 这组旧名称（前者优先）：

| Sci-epo | 兼容名称 | 含义 |
| --- | --- | --- |
| `SCIEPO_MODEL_PROVIDER` | `AI_NOVEL_PROVIDER` | `openai` / `anthropic` / `google` |
| `SCIEPO_MODEL_BASE_URL` | `AI_NOVEL_BASE_URL` | 服务根地址，通常包含 API 版本路径 |
| `SCIEPO_MODEL_ID` | `AI_NOVEL_MODEL` | 服务端模型标识 |
| `SCIEPO_MODEL_API_KEY` | `AI_NOVEL_API_KEY` | 服务凭据，仅服务端可见 |
| `SCIEPO_MODEL_PROTOCOL` | `AI_NOVEL_OPENAI_PROTOCOL` | OpenAI 兼容协议：`chat_completions` / `responses` |
| `SCIEPO_MODEL_REASONING_EFFORT` | `AI_NOVEL_REASONING_EFFORT` | 可选，`omit` 不发送 |
| `SCIEPO_MODEL_MAX_OUTPUT` | — | 输出 token 上限，默认 8192 |
| `SCIEPO_MODEL_TIMEOUT_MS` | `AI_NOVEL_LLM_TIMEOUT_MS` | 包括读取响应的总时限，默认 180000 毫秒 |

角色覆盖用 `SCIEPO_MODEL_WRITING_*`、`SCIEPO_MODEL_REVISION_*`、`SCIEPO_MODEL_QUALITY_*`，需 `ENABLED=true`。只改模型 ID 时继承默认连接；改连接时 PROVIDER、BASE_URL、API_KEY、ID 必须完整，禁止混用半套凭据。也可以把同样的键值写成 JSON 文件，用 `SCIEPO_MODEL_CONFIG_FILE` 指定。数据库里已有服务时不再导入。无配置时真实生成不可用，仍可选择预置示例体验。

## 传输与验收边界

`src/server/provider.ts` 是最小适配层，支持四种协议的 SSE 与普通 JSON 响应。它拒绝重定向、截断结果、缺失终止标志、空结果和超过大小限制的响应；不自动重试，不把上游错误正文或凭据放进错误提示。

应用编排层对真实审稿和改稿的 `invalid_json`，以及独立审计批次的 `invalid_audit_format` 做有界重发：原请求、冻结 Provider 和模型不变，每个逻辑调用最多重发一次，整次审稿最多增加两次请求，单次改稿最多增加一次。生成、翻译、分镜表、HTTP/超时/输出上限、前序审稿和事实扫描的结构或引文错误均不因此重试。后一份审计必须独立完整通过，前一份有效否定保留。失败文本不修改，也不回传模型作为纠错提示。`Run.modelAttempts` 保留阶段、批次、序号、结果、错误码与耗时，网页即使最终成功仍展示格式失败和重发记录。

所有真实创作请求都有 JSON 对象响应合约。Chat Completions 发送 `response_format: {type: "json_object"}`，Responses 发送 `text.format: {type: "json_object"}`；这是 JSON 语法约束，不是业务 schema 保证。[OpenAI 官方文档](https://developers.openai.com/api/docs/guides/structured-outputs) Gemini 原生 `generateContent` 使用 `generationConfig.responseMimeType: "application/json"`。[Gemini API 文档](https://ai.google.dev/api/generate-content)

Anthropic Messages 没有对应的通用 JSON 对象模式；其原生结构输出使用 `output_config.format` 与 JSON schema。该适配器不向未验证的兼容网关强推 schema，仍依靠 JSON 提示词及本地响应校验。[Claude 官方文档](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

四种协议都在响应完整结束后执行严格 `JSON.parse` 并检查各层对象字段名唯一，再交业务解析器验证字段、覆盖和引文。兼容网关可能忽略原生 JSON 参数，因此本地额外接受唯一、完整的外层 `json` 或无语言代码围栏，只验证围栏内部的严格 JSON 对象，仍原样保存模型文本。前后说明、多块围栏、裸词、坏 JSON、数组或标量响应仍以 `ModelError.code = "invalid_json"` 拒绝。普通连接测试只要求 `OK`，测试通过不证明创作接口支持格式约束。

`tests/provider.test.ts` 通过离线模拟验证协议字段、UTF-8 流分片、截断拒绝、角色覆盖和错误脱敏。离线测试不证明真实服务可用，也不证明剧本质量。

`bun run scripts/smoke-live.ts --run` 是显式的真实验证：新建独立的英文验证系列，顺序执行生成、因果审查、五维审稿、事实与遗漏整理、独立陈述审计，再指定单场改稿。默认访问本机；`SCIEPO_SMOKE_BASE_URL` 可指定 HTTPS origin，`SCIEPO_SMOKE_AUTH_TOKEN` 只用于运维在进程内传入短期验证会话，禁止写入命令参数、日志或仓库。结果写入被 Git 忽略的 `artifacts/`。
