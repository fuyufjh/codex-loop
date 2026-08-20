---
name: codex-loop
description: Use the codex-timer MCP for delayed or short recurring work when the user asks to do something later or every X seconds/minutes/hours, including periodic monitoring. Recurring schedules require an explicit or reasonably implied stopping condition.
---

# Codex Loop

Use this MCP as a timer that sends a future user message back into the current Codex thread. The MCP only triggers turns; the model must perform the requested work and manage termination.

## Choose a timer

- Use `schedule_once(delay_seconds, message)` for a one-time request such as “remind me in 10 minutes.”
- Use `schedule_interval(interval_seconds, message)` for “check every X minutes” or other fixed-interval requests. The first trigger occurs after one full interval.
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

For example, for “monitor the training job every 5 minutes,” schedule a message equivalent to:

> Check the training job and report its status. If it has succeeded, failed, been cancelled, or reached any other terminal state, call `cancel_timer` to stop this recurring timer and report the final result. Otherwise, leave the timer active for its next trigger.

Do not assume the MCP will detect completion or cancel automatically.

## Limits

Intervals and delays must be between 1 second and 24 hours. Timers live only in the MCP process and disappear if the MCP, Codex, or app-server restarts. If a turn takes longer than its interval, further messages can queue up, so avoid intervals shorter than the work normally takes.
