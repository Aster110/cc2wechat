# Codex backend — how it works and what bit us

Field notes from wiring the codex backend on a remote box (2026-08-06/07). Same spirit as
[tmux-delivery-lessons.md](tmux-delivery-lessons.md): the design is short, the failure modes are
the expensive part.

## Design

`CodexBackend` implements the same four-method `AIBackend` interface as `ClaudeCodeBackend`.
Everything codex-specific lives in one file (`src/v5/backends/codex.ts`); nothing else in the
codebase knows codex exists except one line in `main.ts` that picks the backend.

```
chat()  →  codex exec [resume <thread>] --dangerously-bypass-approvals-and-sandbox --json
             │
             ├─ thread.started      → remember thread_id for this bridge session
             ├─ item.completed      → agent_message items are candidate replies
             └─ turn.failed / error → surfaced to the user instead of silence
```

**Session mapping.** Codex has no "create a session with this id" — the thread id comes back from
the first run. So the bridge keeps its own map in
`~/.cc2wechat/codex-threads-<port>.json`: bridge sessionId → codex thread id. `resetSession()`
(wired to `/new` and `/exit`) deletes the entry; the rollout file itself is left alone since it's
the user's history.

## Failure modes, in the order they bit

### 1. `codex exec resume` does not accept `-C/--cd`

`codex exec` has it, `codex exec resume` does not — its grammar is
`[SESSION_ID] [PROMPT]`. Passing `-C` makes clap bail with
`to pass '-C' as a value, use '-- -C'` **before the model is ever reached**: no rollout file, no
tokens spent, and the calling process only sees a nonzero exit.

Symptom in production: the first message of a conversation works (fresh `exec`), every message
after it fails (`exec resume`). Easy to misread as an auth or permission problem.

Fix: pass the working directory via the child process `cwd` (or `cd` for the shell-string path),
never `-C`. Use `--` before positionals so user text starting with `-` isn't parsed as a flag.
Regression test: `never passes -C to codex`.

### 2. "Is bypass actually on?" — read the rollout, don't guess

Each turn's rollout (`~/.codex/sessions/**/rollout-*.jsonl`) contains a `turn_context` entry with
the effective `approval_policy` and `sandbox_policy`. That's the ground truth. If a turn produced
no rollout at all, the request never reached the model — look at argument parsing, not at
permissions.

### 3. Blocking the poll loop reads as "bot offline"

The original poller did `await processMessage(...)` inside the long-poll loop. With a backend that
takes minutes per turn, the bridge stops long-polling for minutes, and the platform decides the
bot is gone — the user sees "temporarily unable to connect" while everything is technically fine.
Incoming messages also aren't fetched until the current turn ends, so they look swallowed.

Fix: per-user serial queue (ordering preserved per user), poll loop never awaits the agent.

### 4. Typing indicator needs a real ticket, and needs renewing

`sendTyping` requires a `typing_ticket` from `getConfig`. Calling it with an empty string is a
silent no-op. The indicator also expires, so a slow backend must re-send roughly every 15s and
send the stop status when done.

### 5. Silence on timeout

The watchdog kills the child with `SIGKILL`, which makes the close code `null`. `code ?? 0` reads
that as success, so a timed-out turn degraded into an empty reply. Track the timeout explicitly
and emit a real message.

### 6. Auth files are not portable between machines

Copying `~/.codex/auth.json` to another machine works right up until either machine refreshes its
token: refresh tokens are single-use, so the second machine's refresh is treated as replay and the
whole grant is revoked (`refresh token was revoked`, websocket 401). It survived about three hours
for us.

Run `codex login` on each machine instead. For a headless box:

```bash
ssh -L 1455:localhost:1455 <host>
# then, in that session:
codex login
# open the printed URL in your local browser
```

The browser only carries a one-time authorization code; the token is exchanged by — and stored
on — the remote machine, and your local login is untouched.

### 7. Context: codex doesn't know where it is

Without an `AGENTS.md`, "check my machine" gets answered about whatever hardware the agent can
see, which on a VM is nonsense. A `$CODEX_HOME/AGENTS.md` stating the host identity, that replies
go to WeChat (so: short), and that permissions are already granted (so: don't ask) fixes the
class of problem.

Also worth knowing: instructions the user gives in chat can end up in the agent's *persistent*
memory and slow every later turn. "Delegate every task to a subagent, no matter how small" turned
one-line questions into multi-minute `spawn_agent` + `wait_agent` rounds. When a bridge feels slow
and the code checks out, read the agent's memory/instruction files.

## Known debt

- `SDKDelivery`/`PipeDelivery` remember the last backend (`lastBackend`) so `closeSession(userId)`
  can reach it — the interface should take the backend explicitly instead.
- tmux delivery × codex backend is untested (SDK delivery is what runs in practice).
- `extractResult` depends on codex's JSON event names; a schema change degrades replies to
  `[No response]` (the error path still reports, but less usefully).
- `UserQueues` has no depth limit — fine for a personal bridge, not for many users.
