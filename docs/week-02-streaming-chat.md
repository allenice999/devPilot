# 第二周：流式 AI 聊天应用

## 1. 先理解一条完整链路

```text
浏览器输入
  -> POST /chat/stream
  -> 恢复 System Prompt + 多轮历史
  -> 选择 DeepSeek / Qwen / 演示模型
  -> 上游 LLM 流式返回 delta
  -> FastAPI 封装 SSE
  -> ReadableStream 解码
  -> 自研 SSE parser
  -> RAF 批量更新消息
  -> Markdown / 工具卡片 / JSON Schema 卡片
```

普通请求和流式请求的区别不在“模型是否一次性算完”，而在传输层是否允许结果分块到达浏览器。

## 2. LLM 消息结构

| role | 作用 | 本项目中的来源 |
| --- | --- | --- |
| `system` | 固定行为边界、身份、输出格式 | 后端根据预设生成，客户端不能覆盖 |
| `user` | 用户输入和本轮问题 | 前端每次请求回传 |
| `assistant` | 之前模型已完成的回答 | 前端历史消息回传 |
| `tool` | 工具执行结果 | 本周由后端伪造成系统补充信息，第五周换成真实 MCP |

OpenAI 兼容接口的核心请求大致是：

```json
{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "你是一名..." },
    { "role": "user", "content": "解释 SSE" }
  ],
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 1200
}
```

服务端并不保存本次对话的隐式状态。所谓“多轮记忆”，本质是每一轮把相关历史重新发给模型。

## 3. Token、上下文窗口与费用

Token 是模型处理文本的离散单位。英文单词、中文单字、标点和代码片段都可能被拆成不同数量的 token。准确数量应由具体 tokenizer 计算；本项目为了学习和展示，使用中文字符与英文近似换算。

上下文窗口包括：

```text
System Prompt + 历史消息 + 当前输入 + 模型输出
```

数据库索引不自动进入上下文，工具结果也只有在被放进消息列表后才可能被模型看到。上下文太大时需要裁剪旧消息、摘要历史或检索相关资料。

费用估算：

```text
estimated_cost =
  prompt_tokens × input_price / 1,000,000
  + completion_tokens × output_price / 1,000,000
```

厂商价格和计费口径会变化，因此代码将价格放在环境变量中，UI 明确显示“估算”。

Temperature 控制采样随机性。较低值更稳定，适合代码审查和结构化输出；较高值更发散，适合创意内容。它不改变上下文窗口，也不保证 JSON 合法。

## 4. OpenAI 兼容流式响应

DeepSeek 与 Qwen 的兼容接口通常返回如下 SSE：

```text
data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}

data: [DONE]
```

后端把这些上游 chunk 重新组织成稳定的事件协议：

```text
event: message
data: {"id":"assistant_x","role":"assistant","provider":"deepseek"}

event: token
data: {"text":"你"}

event: done
data: {"finish_reason":"stop","usage":{...}}
```

应用没有直接把上游协议暴露给前端，前端因此不依赖具体模型厂商。

## 5. SSE 协议

SSE 响应头：

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

一条事件由多个字段行和一个空行组成：

```text
event: token
data: {"text":"Hello"}

```

浏览器的一次 `reader.read()` 可能拿到：

- 半行 JSON；
- 两条完整事件；
- 多个事件的中间一段；
- 只有注释心跳。

所以不能对每个网络 chunk 直接 `JSON.parse`。正确做法是维护字符串缓冲区，按 `\r\n`、`\n` 或 `\r` 切行，只有遇到空行才 dispatch 一条事件。

## 6. 重试、超时和降级

本项目把失败分成三类：

| 类型 | 示例 | 策略 |
| --- | --- | --- |
| 可重试 | 429、5xx、连接超时 | 同一模型最多重试一次，使用退避 |
| 不可重试 | 400、401、内容格式错误 | 不重复请求，输出明确错误 |
| 可降级 | 主模型连接失败且尚未输出 token | 切换配置的 fallback，最后可降级到演示模型 |

关键边界：如果主模型已经向前端输出部分 token，就不应悄悄切换模型重来，否则用户会看到重复或互相冲突的内容。此时保留已输出内容并报告错误更诚实。

## 7. Prompt 设计

### System Prompt

定义稳定行为，例如翻译助手“只翻译、不扩写”，代码审查助手“按 P0/P1/P2 报告”。

### Few-shot

用输入输出示例固定格式和风格。翻译预设包含两个中英示例，让模型更容易保持表达一致。

### Chain-of-Thought

CoT 的价值是让模型充分分析问题，但最终回答没有必要暴露完整内部推理。生产 Prompt 更常使用明确检查清单、证据要求和答案结构来获得可验证结果。

### 结构化输出

Prompt 中加入 JSON Schema，服务端再执行：

```text
模型输出 -> 去除意外代码围栏 -> json.loads
         -> jsonschema.validate
         -> SSE structured 事件
         -> 前端运行时类型守卫
         -> 卡片
```

模型“说自己是 JSON”不等于它就是合法 JSON。只有解析与 Schema 校验都通过，才能展示为结构化卡片。

## 8. 后端模块

```text
backend/
  main.py          HTTP/SSE 路由、工具演示、上下文组装
  chat_models.py   请求协议与 Pydantic 校验
  prompts.py       System Prompt 与 JSON Schema
  llm.py           OpenAI 兼容调用、重试、超时、降级
  sse.py           SSE 帧编码
  verify_stream.py 验收脚本
```

`_event_stream` 是异步生成器。每次 `yield` 一个完整 SSE 帧，FastAPI 就把它写入 `StreamingResponse`。

## 9. 前端流式渲染

`lib/sse.ts` 不依赖第三方库：

1. 从 `response.body.getReader()` 读取 `Uint8Array`。
2. `TextDecoder` 解决 UTF-8 字符可能跨 chunk 的问题。
3. parser 缓冲并解析 `event`、`data`、`id` 字段。
4. 事件回调把 token 写入待提交缓冲。
5. `requestAnimationFrame` 每帧最多提交一次，避免每 token 触发 React 重渲染。

停止生成：

```text
AbortController.abort()
  -> 浏览器取消 fetch stream
  -> FastAPI 检测 request.is_disconnected()
  -> 异步生成器停止继续调用模型
```

## 10. 验收

```powershell
docker compose exec -T backend python verify_stream.py
```

脚本验证：

- 假天气工具产生 `tool_start -> tool_result`。
- 长文本包含多个 token 事件。
- 10 次结构化输出全部通过 JSON Schema。
- 客户端读取第一个 token 后关闭流，验证取消链路。

浏览器中还应手动验证：

- 停止按钮能立即结束生成。
- Enter 发送，Shift+Enter 换行。
- 重新生成只使用最后一条用户消息及其之前的历史。
- 清除会话能取消正在运行的流。
- Markdown 表格、列表和代码块正常显示，代码可复制。
