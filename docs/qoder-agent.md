# Qoder CLI (`qoder`) as a nodeterm agent

Alibaba's Qoder CLI (measured on **1.1.67**, macOS arm64, on this host on **2026-10-10**) is a
builtin agent id — the **minimal, native managed adaptation** (`docs/qoder-agent.md` is the record
of what was measured; `src/shared/agents/config.ts`'s `qoder` entry is the decision): `AGENT_CONFIG.qoder`
— label `Qoder`, colour `#4f46e5`, `launchCmd: 'qoder'`, `expectedProcess: 'qodercli'`,
`promptInjectionMode: 'flag-interactive'` with **`promptFlag: '--prompt-interactive'`**.

Membership: `AGENT_HOOK_TARGETS` (the RUNNING / NEEDS YOU badge, unread dot, completion
notifications, `--after` dependencies), `RESUMABLE_AGENTS` (`qoder --resume <id>`),
`CANVAS_CONTROL_CAPABLE` + `CONTEXT_LINK_CAPABLE` (the fleet-message surface: the two skills and
`NODETERM_CANVAS_CONTROL=1`), and `SESSION_END_CAPABLE`. It is in `LOCAL_ONLY_HOOK_AGENTS` beside
antigravity: **no SSH leg** — a remote Qoder node reports nothing, so nothing may wait on it.

Deliberately **not** capabilities (each with its reason in §7): chat panel, context meter, model
switching, permission-mode flag, session-id minting, subagent cards, title read/rename, transfer.

> Sibling documents: `docs/antigravity-agent.md`, `docs/copilot-agent.md`, `docs/grok-agent.md`,
> `docs/gemini-agent.md`. The distilled rules are **Adding a new agent** in `CLAUDE.md`.

> **Where the facts come from.** Everything marked *measured* was run against the installed
> `qodercli` 1.1.67 on this host: `--help` / `status` / `--list-sessions`, argument-parse probes that
> could not reach the model, ONE real launch in an isolated tmux pane
> (`tmux -L nodeterm-qprobe-t262`, cwd `/tmp` then `/Users/f/code/manager`), and a hook-capture run
> against a **scratch config dir** (`--config-dir /tmp/qoder-probe2`) — never the employer's real
> `~/.qoder` (its `settings.json` was only read, never written; its hash was checked before and
> after every probe). The rest was read out of the shipped single-file binary
> (`~/.qoder/bin/qodercli/qodercli-1.1.67`, 160 MB) by string extraction, and is marked
*emitter* where it names the binary's own functions. §8 lists what was NOT run.

## 1. The binary and its names

| Name | What it is | Evidence |
| --- | --- | --- |
| `qoder` | The documented entry point: a **bash dispatcher** (`~/.qoder/entry/qoder`, on `PATH`) that resolves the CLI with `type -P qodercli` and `exec`s it for a CLI invocation (or the IDE launcher for an IDE one) | read the script (`exec "$cli" "$@"`) |
| `qodercli` | Symlink `~/.local/bin/qodercli` → `~/.qoder/bin/qodercli/qodercli-1.1.67` | `ls -la` |
| `qodercli-1.1.67` | The real single-file binary (160 MB, Bun-compiled) | `file` |

`launchCmd` is `qoder` (what a user types) and `expectedProcess` is **`qodercli`** — the name
`AGENT_BINARIES.qoder` (the pane-ownership security predicate) must match. MEASURED in the probe
pane: `ps -ww -o pid=,pgid=,stat=,args= -t <pane tty>` shows the foreground `S+` line as
`/Users/f/.local/bin/qodercli --permission-mode dont_ask --prompt-interactive …` — the dispatcher
execs the **symlink**, so argv[0]'s basename is `qodercli` and never the versioned target
(`…/qodercli/qodercli-1.1.67`). That is what keeps the name stable across the CLI's own self-updates.

## 2. Config layout (Claude Code's shape)

The binary's own path table (`configDirName: '.qoder'`, `globalConfigDirOverride`) resolves:

| Path | Role |
| --- | --- |
| `~/.qoder/settings.json` | user settings — **where our `hooks` block is merged** |
| `~/.qoder/skills/`, `commands/`, `agents/`, `output-styles/` | user-level skills etc. (each a dir beside the settings file) |
| `~/.qoder/projects/<slug>/<sessionId>.jsonl` | transcripts; the file stem **is** the session id (matches the on-disk `-Users-f-code-manager/` slug) |
| `<cwd>/.qoder/settings.json` + `settings.local.json`, `<cwd>/.mcp.json` | project scope |

`QODER_CONFIG_DIR` is **not** a config-root override, and nodeterm's installer must not honor it:
the binary (a) *exports* it to the commands it spawns, set to `getGlobalConfigDir()`, and (b) reads
it only to put `<dir>/bin` on PATH for external commands. Honoring it would let a stray value in the
app's environment send our hooks where Qoder never reads them — a silent, total integration failure.
The override the CLI actually honors is its own `--config-dir` FLAG (MEASURED: a scratch dir got its
own `.auth/`, `logs/runs/…`, `installation_id`, `umid-cache.json`), which is per-invocation and
cannot be satisfied by a machine-level install.

## 3. Launch: why the first order rides a flag, not the positional

Qoder has BOTH a positional query and a subcommand list (`mcp`, `plugins`, `skills`, `hooks`,
`agents`, `login`, `rollback`, `update`, `status`, `commit`, `feedback`, `security`,
`remote-control`, `wiki`). MEASURED (no model call involved in the first three; the fourth did run
one small turn):

```
$ qoder status                                # the subcommand: prints Version / Username / Email / …
$ qoder -p status --model X                   # error: unknown option '--model'   ← the SUBCOMMAND parsed it
$ qoder --model X -p -- status                # the status output again           ← `--` does NOT re-route it
$ qoder --model X -p not-a-subcommand         # a real turn ran and answered      ← non-command text reaches the model
```

So a one-word brief that names a subcommand is **executed**, and the `--` separator that fixes
exactly this on grok does not work here. The brief therefore rides
**`-i, --prompt-interactive <text>`** ("Execute prompt and continue in interactive mode"), which
cannot be read as a command name and is precisely the station shape. MEASURED end to end in the
probe pane: `qoder --permission-mode dont_ask --prompt-interactive "Reply with the single word READY
and nothing else"` started the TUI, submitted the prompt, answered `READY`, and stayed interactive.

(Also observed in that pane: with the cwd **not** in Qoder's `permissions.trustDirectories`, Qoder
showed its trust dialog and a `Stop hook error: Security: Blocked execution of hook (system) in
untrusted folder` — Qoder gates hook execution on folder trust. See §8.)

## 4. Hooks

Qoder's `hooks` block is **Claude Code's shape**: one key per event, each holding
`[{matcher?, hooks: [{type: 'command', command, timeout?, …}]}]`. Two proofs:

1. **Schema** (the settings zod schema in the binary): "Array of hook definition objects for a
   specific event … Pattern to match against the event context (tool name, notification type, etc.).
   Supports exact match, regex (`/pattern/`), and wildcards (`*`)" ; hook types `command | http |
   prompt | agent`; fields `timeout` (seconds), `asyncRewake`, `statusMessage`, `once`, `if`. The
   plugin-variable error text distinguishes a plugin's `hooks/hooks.json` from `settings.json`, so
   user settings carry hooks too.
2. **Live**: a hook written into `<scratch configDir>/settings.json` FIRED — the payloads below were
   captured from its stdin.

Event names the settings schema declares: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`SubagentStart`, `SubagentStop`, `Notification`, `SessionEnd`, `PreCompact`, `PostCompact`,
`QueryEnd`, `UserPromptSubmit`, `ConfigChange`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`,
`CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `Elicitation`,
`ElicitationResult`, `TaskCreated`, `TaskCompleted`, `PermissionRequest`, `PermissionDenied` (plus
`SessionStart` / `Stop` / `Setup`, which the emitters fire).

`QODER_HOOK_EVENTS` (`src/shared/agents/hook-events.ts`) subscribes to NINE: `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`,
`Notification`, `SessionEnd`. What is left out and why is written on that list; the short version:
`PermissionRequest` is a DECISION hook (a synchronous gate in front of every permission prompt)
whose held-approval contract is claude-only, and the rest render nothing we show.

### Payloads (captured + emitters)

Base (LIVE capture), snake_case:

```json
{"session_id":"c87e162b-…","transcript_path":"<configDir>/projects/<slug>/c87e162b-….jsonl",
 "cwd":"…","hook_event_name":"SessionStart","permission_mode":"dontAsk","source":"startup"}
```

Per event, from the binary's emitters (`createBaseInput`, `fireUserPromptSubmitEvent`,
`fireStopEvent`, `fireStopFailureEvent`, `fireNotificationEvent`, `fireSubagentStartEvent`, …):

| Event | Extra fields |
| --- | --- |
| `SessionStart` | `source` ∈ startup / resume / clear / new / compact |
| `UserPromptSubmit` | `prompt`, optional `request_set_id`, `image_urls` |
| `PreToolUse` / `PostToolUse` | `tool_name`, `tool_input` |
| `PostToolUseFailure` | `original_request_name`, `is_interrupt` |
| `Stop` | `stop_hook_active`, `last_assistant_message` |
| `StopFailure` | `error`, `error_details?`, `last_assistant_message` — fires INSTEAD of `Stop` on an API/model error |
| `Notification` | `notification_type`, `message`, `details`, `title?` |
| `SubagentStart` / `SubagentStop` | `agent_id`, `agent_type` (+ `agent_transcript_path`, `last_assistant_message` on stop) |

LIVE capture of the idle one:

```json
{"…base…","hook_event_name":"Notification","notification_type":"idle_prompt",
 "message":"Qoder CLI finished responding and is awaiting input.","details":{"streamingState":"idle"}}
```

`notification_type` is a closed enum in the binary: `permission_prompt`, `idle_prompt`,
`auth_success`, `elicitation_dialog`, `elicitation_response`, `elicitation_complete`.

`session_id` is the transcript's own file stem — the same id `--resume <id>` accepts, which is why
the resume grammar is safe to build from that field.

**Trust gate:** hooks are blocked in an untrusted folder (MEASURED error in §3). The trust list is
`permissions.trustDirectories` in settings.json; this host's already carries
`/Users/f/code/manager`. A node whose cwd Qoder does not trust will block hooks until the folder is
trusted once in Qoder — expect "no badge" there, not a crash.

## 5. What nodeterm writes

| Consent = enabled | Path | Shape |
| --- | --- | --- |
| status hook | `~/.qoder/settings.json` → `hooks.<Event>` | the shared merge helper's guarded `if [ -r ~/.nodeterm/agent-hooks/qoder.sh ]` command, one handler per subscribed event, foreign entries preserved |
| managed script | `~/.nodeterm/agent-hooks/qoder.sh` | the shared managed script, POSTing to `/hook/qoder` |
| manage-nodeterm-canvas skill | `~/.qoder/skills/manage-nodeterm-canvas/SKILL.md` | app-authored body |
| get-linked-context skill | `~/.qoder/skills/get-linked-context/SKILL.md` | app-authored body |

Declined removes exactly those (exact-command match for the hook; exact-content receipts for the
skills — a file the user edited is kept and reported). Undecided writes nothing.

## 6. Renderer surfacing

Dock, ⌘K palette, pane menus, Settings → Agents and the integration rows all enumerate
`BUILTIN_AGENT_IDS` / `INTEGRATION_AGENT_IDS` and label from `AGENT_CONFIG`, so `qoder` appears with
no per-surface code. New code: the `node.newAgent.qoder` chord command (unbound by default, like
every per-agent create) and its Canvas handler. No brand asset: `AGENT_LOGO` is
`Partial<Record<…>>`, so Qoder nodes fall back to the plain pulsing dot until someone contributes a
mark.

## 7. Deliberate omissions

| Leaf | Why it stays off |
| --- | --- |
| `SESSION_ID_CAPABLE` (minting `--session-id`) | minting needs a per-CLI capability probe (an unknown flag kills a launch); the hook already reports the id on every session |
| permission-mode flag | `--permission-mode` exists with its own vocabulary (default, accept_edits, bypass_permissions, dont_ask, auto), and payloads spell it `dontAsk` — mapping our modes onto it unmeasured would be a guess |
| chat panel (⌘M) | the transcript is a real JSONL we have not parsed |
| context meter | no measured used/window pair anywhere we can read |
| subagent cards | `SubagentStart`/`Stop` are not subscribed (see `QODER_HOOK_EVENTS`) |
| model switching | `--model` exists, but an invalid value silently falls back to "auto" (MEASURED), and per-agent model plumbing is out of scope |
| SSH hosts | no `RemoteHooks` leg: `LOCAL_ONLY_HOOK_AGENTS`, so nothing may WAIT on a remote Qoder node |
| `QODER_CONFIG_DIR` in the installer | the CLI never reads it as a config-root override (MEASURED) — see §2 |

## 8. Not yet run (the honest list)

- A real turn **on the employer's real `~/.qoder`** with our hook installed — the live payload
  capture ran in a scratch config dir (its own `.auth`, so it was signed out; only `SessionStart`
  and the idle `Notification` fired before the auth wall). Everything else is emitter-derived.
- `--resume <id>` against a real session id (the grammar is pinned by tests; the flag's semantics
  with our stored ids are not yet exercised live).
- That a skill dropped into `~/.qoder/skills/<name>/SKILL.md` is actually **discovered** — the path
  is measured (the binary's own `skillsDir`), the `SKILL.md` frontmatter requirement is measured,
  discovery is not.
- `SessionEnd`, `PreToolUse`/`PostToolUse`/`PostToolUseFailure` and `Stop`/`StopFailure` live
  payloads (emitter-derived; the two live captures cover `SessionStart` + `Notification`).
- `PermissionRequest` / `PermissionDenied` semantics (deliberately unsubscribed — see §4).
- The trust dialog's exact behaviour for a **trusted** folder that later gains hooks.
