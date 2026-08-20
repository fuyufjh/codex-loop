---
name: codex-timer
description: Use the codex-timer MCP for delayed or short recurring work when the user asks to do something later or every X seconds/minutes/hours, including periodic monitoring. Recurring schedules require an explicit or reasonably implied stopping condition.
---

# Codex Timer

Use this MCP as a timer that sends a future user message back into the current Codex thread. The MCP only triggers turns; the model must perform the requested work and manage termination.

## Choose a timer

- Use `schedule_once(delay_seconds, message)` for a one-time request such as “10 分钟后提醒我”。
- Use `schedule_interval(interval_seconds, message)` for “每 X 分钟检查一次” or other fixed-interval requests. The first trigger occurs after one full interval.
- Use `list_timers()` to inspect active timers in the current thread.
- Use `cancel_timer(timer_id)` to stop a recurring timer. It only prevents future triggers; messages already queued are not withdrawn.

## Recurring schedules must terminate

Before calling `schedule_interval`, identify a stopping condition. It may be:

- Explicit: a deadline, number of checks, or stated target condition.
- Implied by the task: monitoring a job implies stopping when the job reaches a terminal state; waiting for a service to recover implies stopping once recovery is confirmed.

If no defensible stopping condition exists, ask the user for one instead of creating an unbounded recurring timer.

Put the complete recurring workflow in `message`, because that message drives every future turn. It must tell the future model to:

1. Perform the requested action.
2. Evaluate the stopping condition on every trigger.
3. If the condition is met, call `cancel_timer` for this recurring timer and report completion; otherwise leave it active.

Use the timer ID returned by `schedule_interval` when cancelling. If it is not readily available in the future turn, call `list_timers()` and identify the matching recurring timer before calling `cancel_timer`.

For example, for “每 5 分钟监控训练任务”，schedule a message equivalent to:

> 检查该训练任务的状态并汇报。若任务已成功、失败、取消或进入其他终态，调用 `cancel_timer` 停止本重复定时器并汇报最终结果；否则继续等待下一次触发。

Do not assume the MCP will detect completion or cancel automatically.

## Limits

Intervals and delays must be between 1 second and 24 hours. Timers live only in the MCP process and disappear if the MCP, Codex, or app-server restarts. If a turn takes longer than its interval, further messages can queue up, so avoid intervals shorter than the work normally takes.
