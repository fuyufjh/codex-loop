# Codex Loop

English | [简体中文](README.zh.md)

Codex Loop is a persistent timer MCP for short-cycle tasks. When a timer fires, it calls the experimental Codex app-server method `thread/queue/add` to send a new user message back to the Codex thread that created the timer.

It is designed for requests such as “remind me in 10 minutes” or “check every minute.” Pending timers are stored in an atomic JSON state file and restored when the MCP process restarts.

## Requirements

- Node.js 20 or later; no npm dependencies are required.
- Codex CLI 0.148.0 or later.
- Codex must use the local app-server daemon and allow the local MCP process to access its Unix socket.

## Configuration

Register the STDIO MCP using an absolute path:

```bash
codex mcp add codex-timer -- node /absolute/path/to/codex-loop/bin/codex-timer-mcp.mjs
```

Alternatively, add it directly to the Codex configuration:

```toml
[mcp_servers.codex-timer]
command = "node"
args = ["/absolute/path/to/codex-loop/bin/codex-timer-mcp.mjs"]
tool_timeout_sec = 10
```

Restart the Codex client or refresh its MCP servers after updating the configuration.

## Tools

- `schedule_once(delay_seconds, message)`: send one message after a delay.
- `schedule_interval(interval_seconds, message)`: send a message repeatedly at a fixed interval; the first message is sent after one full interval.
- `list_timers()`: list active timers for the current thread.
- `cancel_timer(timer_id)`: cancel a timer owned by the current thread.

Example requests:

```text
Remind me to check the training job in 10 minutes.
Have me check the service status every minute.
List the timers in this conversation.
Cancel the timer I just created.
```

Codex 0.148.0 supplies the current thread ID in `_meta.threadId` on each MCP tool call. This MCP trusts only that metadata and does not allow tool arguments to target another thread.

## Behavior and limitations

- Each delay or interval must be between 1 second and 24 hours.
- If the thread is idle when a timer fires, the message starts a new turn immediately. If the thread is busy, the message enters a FIFO queue and waits for the thread to become idle.
- A recurring timer does not wait for the Codex turn created by its previous message to finish. Messages can accumulate if a turn takes longer than the interval.
- `cancel_timer` prevents future deliveries only; it cannot retract messages already submitted to the Codex queue.
- Failed deliveries are not retried. A recurring timer will attempt delivery again at its next interval.
- Timers that became due while the MCP was stopped fire once as soon as it restarts. Recurring timers do not replay every missed interval.
- An abrupt restart during delivery can cause that delivery to be attempted again. Messages are therefore delivered at least once across process failures, not exactly once.
- `thread/queue/add` is an experimental Codex API.

Optional environment variables:

- `CODEX_BIN`: path to the Codex CLI; defaults to `codex`.
- `CODEX_APP_SERVER_SOCKET`: app-server Unix socket path; skips discovery through `codex app-server daemon version`.
- `CODEX_TIMER_STATE_FILE`: timer state file path. It defaults to `$CODEX_HOME/codex-timer/timers.json`, or `~/.codex/codex-timer/timers.json` when `CODEX_HOME` is unset.

## Development

```bash
npm test

# Start a temporary app-server and call list_timers through a real Codex MCP client.
npm run test:codex
```
