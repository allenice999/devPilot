# DevPilot

DevPilot 是一个用于学习和演示 AI Agent 工程链路的浏览器应用。第一周完成了 Next.js、FastAPI、FastMCP 与 pgvector 的可运行底座；第二周加入多轮流式聊天、SSE 协议、模型适配、结构化输出和假工具事件。

## 第二周能力

- `POST /chat/stream` 以 SSE 推送 `token`、`message`、`done` 事件。
- DeepSeek / Qwen OpenAI 兼容流式调用，支持超时、有限重试与降级。
- 无 API Key 时默认使用本地演示模型，完整演示流式链路。
- 3 个 System Prompt 预设：通用助手、翻译助手、代码审查。
- 多轮历史回传、温度设置、上下文与费用估算。
- Markdown、表格、代码块与复制按钮。
- 假天气工具卡片：`tool_start -> tool_result`。
- JSON Schema 结构化输出与运行时校验卡片。
- 停止生成、重新生成、清除会话。
- 自研 `ReadableStream + SSE parser`，不依赖现成 SSE 库。

详细概念和程序调用链见 [第二周学习笔记](docs/week-02-streaming-chat.md)。

## 当前架构

```text
Browser
  | POST /chat/stream
  v
Next.js UI :3000
  | ReadableStream -> lib/sse.ts -> RAF batch updates
  v
FastAPI :8000
  | OpenAI-compatible /chat/completions
  v
DeepSeek / Qwen / Mock
```

后端同时连接 pgvector，MCP Server 继续提供独立的 Streamable HTTP 工具入口。第五周会把本周的假天气工具替换为真实 MCP 工具。

## 启动

```powershell
docker compose up --build -d
```

访问：

- 前端：<http://localhost:3000>
- 后端健康检查：<http://localhost:8000/health>
- 聊天配置：<http://localhost:8000/chat/meta>
- MCP Inspector 地址：`http://localhost:8001/mcp`

容器镜像通过专属轩辕镜像域 `mxmu9192alwcr342d1.xuanyuan.run` 拉取，该专属域无需执行 `docker login`。

## 模型配置

默认使用无需密钥的演示模型。需要使用真实模型时，复制环境变量模板并配置：

```powershell
Copy-Item .env.example .env
```

DeepSeek：

```dotenv
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-key
DEEPSEEK_MODEL=deepseek-chat
```

Qwen：

```dotenv
LLM_PROVIDER=qwen
QWEN_API_KEY=your-key
QWEN_MODEL=qwen-plus
```

可选降级：

```dotenv
LLM_FALLBACK_PROVIDER=mock
LLM_ALLOW_MOCK_FALLBACK=true
```

不要把真实密钥提交到仓库。前后端均通过环境变量读取配置。

## SSE 事件协议

所有 `data` 都是 JSON：

```text
event: message
data: {"id":"assistant_...","role":"assistant","provider":"mock"}

event: tool_start
data: {"id":"weather_...","name":"get_weather","input":{"city":"北京"}}

event: tool_result
data: {"id":"weather_...","result":{"temperature":"24°C"}}

event: token
data: {"text":"流式"}

event: structured
data: {"data":{"title":"...","summary":"...","key_points":[]}}

event: done
data: {"finish_reason":"stop","usage":{"total_tokens":123}}
```

发生错误时还有 `event: error`。流式接口仍返回 HTTP 200 后通过 SSE 事件报告上游模型错误，因此前端必须同时处理 HTTP 错误和流内错误。

## 验收

基础健康检查：

```powershell
Invoke-RestMethod http://localhost:8000/health
```

自动验证长文本、假工具、取消和 10 次结构化输出：

```powershell
docker compose exec -T backend python verify_stream.py
```

前端静态检查与生产构建：

```powershell
cd frontend
pnpm run typecheck
pnpm run build
```

MCP：

```powershell
docker compose exec -T mcp-server python test_client.py
```

## 目录

```text
backend/
  main.py            FastAPI、SSE、工具演示、上下文组装
  chat_models.py     请求协议与校验模型
  prompts.py         System Prompt 与 JSON Schema
  llm.py             模型适配、超时、重试、降级
  sse.py             SSE 编码
  verify_stream.py   流式验收脚本

frontend/
  app/               Next.js 页面
  components/chat/   对话、Markdown、工具卡、结构化卡
  lib/sse.ts         自研 SSE parser
  lib/chat-types.ts  前端事件类型与运行时校验

mcp/                 FastMCP 服务
docs/                学习笔记
infra/postgres/      PostgreSQL 与 pgvector 初始化
```
