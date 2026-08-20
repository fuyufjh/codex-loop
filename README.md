# Codex Timer MCP

一个面向短周期任务的内存定时器 MCP。它在定时器到期时调用 Codex app-server 的实验性 `thread/queue/add`，把一条新用户消息发送回创建定时器的 Codex thread。

设计目标是“10 分钟后提醒我”或“每 1 分钟检查一次”这类任务。所有状态仅存在于 MCP 进程内；MCP、Codex 或 app-server 重启后，尚未触发的定时器会消失。

## 要求

- Node.js 20 或更新版本；不需要安装 npm 依赖。
- Codex CLI 0.148.0 或更新版本。
- 当前 Codex 使用本地 app-server daemon，并允许本地 MCP 进程访问其 Unix socket。

## 配置

使用绝对路径注册 STDIO MCP：

```bash
codex mcp add codex-timer -- node /absolute/path/to/codex-loop-skill/bin/codex-timer-mcp.mjs
```

也可以直接写入 Codex 配置：

```toml
[mcp_servers.codex-timer]
command = "node"
args = ["/absolute/path/to/codex-loop-skill/bin/codex-timer-mcp.mjs"]
tool_timeout_sec = 10
```

配置后需要重启 Codex 客户端或刷新 MCP server。

## Tools

- `schedule_once(delay_seconds, message)`：延迟一次发送。
- `schedule_interval(interval_seconds, message)`：按固定间隔重复发送，第一次在一个完整间隔后触发。
- `list_timers()`：列出当前 thread 的活动定时器。
- `cancel_timer(timer_id)`：取消当前 thread 的定时器。

示例请求：

```text
10 分钟后提醒我检查训练任务。
每 1 分钟让我检查一次服务状态。
列出当前对话的定时器。
取消刚才创建的定时器。
```

Codex 0.148.0 会把当前 thread ID 放在 MCP tool call 的 `_meta.threadId` 中。本 MCP 只信任该元数据，不允许工具参数指定其他 thread。

## 行为与限制

- 单个延迟或间隔必须在 1 秒到 24 小时之间。
- 到期时如果 thread 空闲，消息会立即开始一个新 turn；如果 thread 正忙，消息进入 FIFO 队列等待空闲。
- 重复任务不会等待该消息对应的 Codex turn 完成。若 turn 长于间隔，队列可能积压。
- `cancel_timer` 只取消未来触发；已经提交给 Codex 队列的消息不会撤回。
- 投递失败不会重试。重复定时器会在下一个间隔继续尝试。
- `thread/queue/add` 是 Codex experimental API。

可选环境变量：

- `CODEX_BIN`：Codex CLI 路径，默认 `codex`。
- `CODEX_APP_SERVER_SOCKET`：直接指定 app-server Unix socket，跳过 `codex app-server daemon version` 探测。

## 开发

```bash
npm test

# 启动临时 app-server，通过真实 Codex MCP 客户端调用 list_timers
set_proxy
npm run test:codex
```
