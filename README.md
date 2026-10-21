# DevPilot

DevPilot 是一个面向浏览器演示的 AI Agent 工作台。第一周只搭建最小可运行底座，后续再逐步加入对话工作区、React Flow 执行图、审批弹层、知识库和评测看板。

## 当前架构

```text
Browser (Next.js :3000)
        |
        | GET /health
        v
FastAPI backend :8000
        |
        | PostgreSQL 协议
        v
pgvector :5432

MCP Inspector / MCP client
        |
        | Streamable HTTP /mcp
        v
FastMCP server :8001
```

一条请求的完整链路是：浏览器加载 Next.js 页面，`useEffect` 请求后端 `/health`，FastAPI 返回 JSON，页面随后显示“后端已连接 ✅”。Agent 接入后，后续链路会扩展为浏览器 -> FastAPI Agent -> MCP Server -> 工具/数据库 -> 前端流式展示。

## 一键启动

环境要求：Docker Engine 和 Docker Compose v2。

```powershell
docker compose up --build
```

启动完成后：

- 前端：<http://localhost:3000>
- 后端健康检查：<http://localhost:8000/health>
- MCP Streamable HTTP 入口：<http://localhost:8001/mcp>

容器镜像通过专属轩辕镜像域 `mxmu9192alwcr342d1.xuanyuan.run` 拉取，该专属域无需执行 `docker login`。

四个容器都配置了健康检查：

```powershell
docker compose ps
```

## 验收后端与前端

```powershell
Invoke-RestMethod http://localhost:8000/health
```

预期输出：

```json
{"status":"ok"}
```

浏览器打开 <http://localhost:3000>，页面应显示 `后端已连接 ✅`。

## 用 MCP Inspector 验收 ping

启动本地 Inspector：

```powershell
npx @modelcontextprotocol/inspector
```

在界面中选择 `Streamable HTTP`，URL 填 `http://localhost:8001/mcp`，连接后：

1. 在 Tools 中应看到 `ping`。
2. 调用 `ping`，返回文本 `pong`。

也可以用仓库里的客户端脚本直接验证：

```powershell
docker compose exec mcp-server python test_client.py
```

## 本地开发

前端依赖已经写入 `frontend/package.json`，包括 shadcn/ui、zustand、React Flow、Markdown 渲染、React Hook Form 和 TanStack Query。

```powershell
cd frontend
pnpm install
pnpm run dev
```

项目统一使用 pnpm，并通过 `frontend/.npmrc` 固定 npm 官方镜像 `https://registry.npmjs.org/`。

本机运行 Next.js 时，`NEXT_PUBLIC_BACKEND_URL` 默认为 `http://localhost:8000`。如果前端部署在其他主机，需要把它改成浏览器能够访问的后端地址，并在后端 CORS 白名单中加入对应来源。

## 目录

```text
backend/        FastAPI 服务
frontend/       Next.js + shadcn/ui 前端
mcp/            FastMCP 服务与测试客户端
infra/postgres/ PostgreSQL 初始化脚本
docker-compose.yml
```

