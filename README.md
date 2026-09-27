# ari-harness

[日本語版 README](README.ja.md)

`ari` is a small, headless, one-shot coding harness. You hand it a written brief; a root GPT-6 agent plans the work, splits it across parallel sub-agents, optionally runs an acceptance command, and prints a short report with a single status line. It is built to be called by another agent (for example Claude Code) that acts as the manager and treats ari as a contractor.

Not related to the Agent Runtime Interface (ARI) specification (github.com/agent-runtime-interface/ari).

ari is an independent hobby project. It is not affiliated with, endorsed by or supported by OpenAI.

ari is about 1,500 lines of Node.js (`ari.mjs`, the sandbox policy in `sandbox.mjs` and small helpers in `lib.mjs`) on top of the [pi-coding-agent](https://github.com/earendil-works/pi) SDK. The command is `ari`; the repository is called `ari-harness`.

## Who it is for

- You have a ChatGPT Plus/Pro subscription and want to use its Codex models (GPT-6 Sol, Astra, Luna) for implementation work.
- You already drive your work from a manager agent or script and want a worker that takes a brief and returns a short, machine-readable result instead of a long transcript.
- You are on Linux (the default sandbox uses bubblewrap) and are comfortable reviewing diffs yourself.
- You work on your own code. ari's sandbox guards against accidents and prompt-injected mistakes, not against a determined attacker; use a VM or container for untrusted repositories (see [Sandbox](#sandbox-what-it-does-and-does-not-do)).

It is not an interactive assistant and has no UI. ari itself never commits or pushes; the prompts tell agents not to either unless the brief asks, but agents can run git, so this is not enforced.

## How it works

1. The brief (command-line argument, or stdin with `-`) goes to the **root** agent (`/root`). The root gets pi's `read`, `bash`, `edit` and `write` tools plus delegation tools: `spawn_agent`, `wait_agent`, `followup_task`, `send_message`, `interrupt_agent`, `list_agents`.
2. Each **sub-agent** starts with an empty context and sees only its brief (at most about 1500 characters; a longer one is bounced back once). It gets a `scope` (files, directories or globs it may modify) or none, which makes it read-only. Running agents must have disjoint scopes. Sub-agents can't start sub-agents of their own: `--depth` is 0 or 1.
3. Sub-agent reports are capped (6 lines / 900 chars) and the harness, not the model, appends the facts: changed files, check result, model, tool count and time.
4. When the root finishes, ari runs the `--check` command if given. On failure the last lines of its output go back to the root once (the full output is saved to a file named in that message and in the footer), then the check runs again. If it still fails and the root reported `DONE`, the run ends as `PARTIAL` (exit code 2); a `BLOCKED` or `FAILED` report keeps its verdict.
5. ari prints the root's final report (capped at 12 lines / 1800 chars; the full text is saved) and a footer computed by the harness.

Other built-in behaviour, all visible in `ari.mjs`:

- **Budgets:** 250 tool calls for the root, 60 per sub-agent; a 30-minute deadline for each sub-agent task, counted from when it starts running: a model turn still running then is stopped, and no model turn starts after it, not even the retry after a failed check. A check command already running at the deadline isn't stopped (it has its own 10-minute timeout), so a task can end up to that much later; bash output kept in context is trimmed to 12,000 chars; bash commands default to a 600 s timeout.
- **Nudges and guards:** after 4 commands without an edit, the agent is told to stop re-verifying. Creating a *new* Markdown/README-style file is refused once unless the brief mentions docs.
- **Stall watchdog:** a model stream that stays silent too long is cut and reopened (up to 3 times per agent, with doubled limits each time).
- **Context files:** the root loads `AGENTS.md` / `CLAUDE.md` from the working directory and its parents the way pi does (disable with `--no-context`), plus a global one at `~/.local/state/ari/pi/AGENTS.md` if you create it; sub-agents never load them. A context file that is, or links to, a secret is skipped. ari loads none of pi's own configuration: no `.pi/settings.json` (so no packages are installed), no `SYSTEM.md`/`APPEND_SYSTEM.md`, extensions, skills, prompt templates or themes.
- **Priority tier:** requests ask for `service_tier: "priority"` unless `--no-fast` is given.
- **Snapshot:** in a git repository, ari records a dangling `git stash create` commit (it does not touch your working tree or index) and the untracked files with their size and modification time, so the footer can list what the run changed: tracked files exactly (every file git reports, whatever its name; lists are read NUL-separated, so non-ASCII names work), untracked files when they are new or their size or time changed (skipping caches such as `node_modules/`, `__pycache__/` and `*.pyc`).

## Requirements

- Linux, Node.js **22.19 or newer** (required by pi-coding-agent 0.87.0), `bash`.
- [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) for the default sandbox. ari checks at start-up that it works and refuses to run otherwise (unless you pass `--sandbox off`).
- `git` (optional, for the snapshot and the changed-files list) and `ripgrep` (`rg`, recommended; the prompts tell agents to search with it).
- A ChatGPT/Codex subscription login that pi-coding-agent supports (see below).

## Install

```sh
git clone https://github.com/aiueo52/ari-harness.git
cd ari-harness
npm ci
ln -s "$PWD/ari.mjs" ~/.local/bin/ari   # any directory on your PATH
ari --help
```

The symlink is fine: ari resolves its own location to find `prompts/` and its modules. `npm test` runs the unit tests (no model calls). Recent npm versions may list dependency install scripts they did not run; ari does not need them for `--help` to work.

## Log in (prerequisite)

ari does not implement any login itself. It reuses the credentials that pi-coding-agent stores for its **"ChatGPT Plus/Pro (Codex)"** subscription provider, read from pi's default auth file (`~/.pi/agent/auth.json`, entry `openai-codex`).

Log in once with pi's own CLI, which `npm ci` installs:

```sh
npx pi        # then type /login and choose ChatGPT Plus/Pro (Codex)
```

See pi's [provider documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) for details. Never commit that file or paste its contents anywhere.

**Terms:** ari is not affiliated with or endorsed by OpenAI. Before using it, check yourself whether your plan's terms allow third-party clients and automated use like this (a harness running many requests in parallel, unattended). ari also reads your quota from an undocumented ChatGPT endpoint (see [Cost and quota](#cost-and-quota)).

## Usage

```text
usage: ari [options] "task"      (task "-" reads stdin)
  -C DIR            work in DIR (default: cwd)
  -m MODEL          root model: sol (default), astra, luna. Only GPT-6 is worth it; other ChatGPT models cost more for less
  -e EFFORT         root effort: low, medium, high, xhigh, max (default per model: luna max, sol xhigh, astra max)
  --child MODEL     default sub-agent model (luna)
  --child-effort E  force one effort on every sub-agent (default: each sub-agent's model default)
  --max N           sub-agents running at once (12)
  --depth N         0 = no sub-agents, 1 = the root starts sub-agents (default; they can't start their own)
  --check CMD       acceptance command; failure goes back to the root once
  --sandbox MODE    workspace (default: writes limited to DIR, /tmp, caches; secrets hidden) | off
  --allow-secret P  let this run's commands read one hidden secret path, e.g. an API key file (repeatable;
                    the read tool still refuses it). Also ARI_ALLOW_SECRETS
  --no-fast         don't use the priority tier
  --resume ID MSG   continue a finished run with a new message
  --status          show Codex usage and recent runs
  --sandbox-check   set up the sandbox for DIR as a run would, say whether it works, and exit (no task, no model)
  --json            print the result as JSON
  -q                no progress on stderr
env: ARI_EXTRA_SECRETS, ARI_ALLOW_SECRETS, ARI_EXTRA_WRITABLE (colon-separated paths; relative to $HOME or absolute)
```

Two flags exist but are not in `--help`: `--force` (run even when the weekly quota is at 99% or more) and `--no-context` (don't load `AGENTS.md`/`CLAUDE.md` into the root). `ultra` is accepted as an alias for the `max` effort.

The model names map to `gpt-6-sol`, `gpt-6-astra` and `gpt-6-luna` on the `openai-codex` provider. Other ids are passed through as-is.

### Examples

Brief from stdin (the usual way; a heredoc keeps quoting simple):

```sh
ari -C ~/src/myapp - <<'EOF'
Add a --dry-run flag to `myapp export` (src/cli/export.ts). With the flag,
print the files that would be written and write nothing.
Constraints: no new dependencies; keep the existing option parser.
Done when: `npm test` passes and `myapp export --dry-run` writes nothing.
EOF
```

With an acceptance check, stronger sub-agents and a different root model:

```sh
ari -C ~/src/myapp --check "npm test" --child sol -m astra -e high - < brief.txt
```

Continue a finished run (same working directory, root model and effort; the previous `--check` unless you pass a new one; the run id is in the footer):

```sh
ari --resume 202609280130-1a2b "Also skip empty directories in the dry-run listing."
```

Quota and recent runs:

```sh
ari --status
```

## Output

Plain output is the root's report followed by harness lines prefixed `[ari]` (values below are illustrative):

```text
DONE: Added --dry-run to `myapp export`; npm test passes.
src/cli/export.ts: new flag, skips writes when set.
Verified: npm test (42 passed).

[ari] run 202609280130-1a2b · 312s · 3 sub-agents (luna 2, sol 1) · tokens 820k in (610k cached) / 41k out
[ari] changed (2): src/cli/export.ts, test/export.test.ts
[ari] check PASS: npm test
[ari] codex weekly: 41% → 43% used, resets 10/2 09:00
[ari] log: /home/you/.local/state/ari/runs/202609280130-1a2b · snapshot 1a2b3c4d5e6f
```

- The first word is the verdict: `DONE`, `PARTIAL`, `BLOCKED` or `FAILED` (`UNKNOWN` if the model did not follow the format).
- If the final `--check` still fails and the root reported `DONE`, ari puts a line `PARTIAL: the acceptance check failed (<command>); the root's report follows.` above the report, so the first word is never `DONE` for a failed check. A `BLOCKED`, `FAILED` or `PARTIAL` report keeps its verdict.
- If a run created a git redirection file (`.git/commondir`, `.git/config.worktree`), a `WARNING` footer line names it.
- Exit codes: `0` DONE, `2` PARTIAL (including `DONE` with a failed check), `3` BLOCKED (also when the quota stop triggers), `1` FAILED/UNKNOWN or invalid options, `130` interrupted.
- `--json` prints one object: `status`, `report`, `changed`, `check`, `run`, `log`, `secs`, `tokens`, `agents`, `codex`, `warnings` (the same warnings as the footer's `WARNING` lines).
- Progress lines go to stderr (silence them with `-q`).

Run data is kept under `~/.local/state/ari/`: `runs/<id>/` holds `meta.json`, `events.log`, the full pi session files of every agent, and any report or check output that was cut. `pi/` is ari's private pi agent directory; if you put an `AGENTS.md` there, the root reads it as a global context file. These files are plain text and contain everything the agents read, including file contents from your project. `runs/<id>/tmp/` holds pi's full output of long commands and the full output of failed checks (`*.check.txt`). ari keeps the directories private (mode 0700, its own files 0600) and hides the whole state directory from sandboxed commands and the file tools (except the current run's `tmp/`, read-only), so a later run cannot read an earlier run's logs.

## Driving ari from a manager agent

ari is designed so that a manager spends few tokens on it:

1. Write a short standalone brief: the goal, facts the worker can't cheaply find (decisions, constraints, exact names, file paths), and what "done" looks like. Give a runnable `--check` whenever one exists.
2. Run `ari -C <repo> [--check CMD] -` with the brief on stdin, and let it run to the end (runs can take many minutes).
3. Branch on the exit code or the first word of the report. Read the footer, not the transcript.
4. Review the changes yourself, for example `git diff <snapshot>` in the repository (the snapshot id is in the footer) plus `git status` for new files. ari itself never commits, but agents could run `git commit` if a brief asks for it, so check `git log` too.
5. For `PARTIAL` or follow-up work, use `--resume <id> "<what to do next>"` so the root keeps its context.
6. If the output says the weekly quota is nearly exhausted, stop and tell the human.

A good place for these rules is a skill or instruction file in your manager agent's configuration.

## Sandbox: what it does and does not do

**Read this first.** The sandbox is a best-effort guard against accidents and prompt-injected mistakes. It is **not a security boundary against a determined adversary.** Each of the review rounds before release found new ways around it; those are fixed, but more bypasses of the same kind are likely. For untrusted repositories, untrusted briefs or unattended runs, run ari inside a VM or container that holds only the files and credentials the task needs.

With the default `--sandbox workspace`, the list below is **everything ari promises**. Each item is checked by a test in `test/sandbox.test.mjs`. **Anything not listed here is not protected**; the next section names the known gaps.

**Commands** (the agents' `bash` calls, `--check`, and ari's own git calls) run under `bwrap`:

1. **Writes** reach only the workspace, `/tmp` (shared with the host), a private `/dev/shm`, `~/.cache`, `~/.npm`, cargo's `~/.cargo/registry`, `~/.cargo/git` and lock files, and your `ARI_EXTRA_WRITABLE` entries. Everything else is read-only, including `~/.bashrc`, `~/.cargo/bin` and cargo's config.
2. **Unsafe writable places are refused at start-up:** a workspace or writable path that is your home directory or contains it, lies in a secret or the session directory, overlaps a place that runs later outside the sandbox (`ESCAPE_PATHS` in `sandbox.mjs`: shell start-up files, `~/.local/bin`, autostart, systemd, git config, `~/.cargo`, ...), or overlaps `/proc`, `/dev`, `/sys` or `/run`. Paths are checked where their symlinks lead; one that can't be resolved is refused.
3. **Secrets are hidden** (the list is `SECRET_DEFAULTS` in `sandbox.mjs`, plus `ARI_EXTRA_SECRETS`), including ari's own run logs except the current run's temp dir, which is read-only. The list is checked again for every command, so a secret created during the run is hidden from later commands. A secret that is a symlink is hidden through its target. The directories leading from a writable place to a secret can't be renamed.
4. **Session sockets are hidden:** the runtime directory (`$XDG_RUNTIME_DIR`) shows up empty, and `SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS` and `GPG_AGENT_INFO` are unset.
5. **Processes:** each command sees only its own processes.
6. **Shell start-up files:** every bash ari starts runs with `--norc --noprofile`: the one inside the sandbox, and the host-side shell that launches `bwrap` for pi's bash tool.
7. **Git**, for the workspace's own git dir, its submodule git dirs (`.git/modules/**`, any depth), repositories nested in the workspace with their own `.git` directory that exist at start-up, and a git dir outside the workspace that lies in a writable place (a linked worktree's, or the repository's when ari runs in a subdirectory):
   - `config`, `hooks`, and an existing `commondir`, `config.worktree` or worktree `gitdir` are read-only, and so are the `.git` files that name a git dir (a linked worktree's, a submodule checkout's);
   - these git dirs, the directories between them, and the directories leading to a submodule checkout can't be renamed;
   - `commondir`, `config.worktree`, `gitdir` and `.git` files that are created, changed or deleted during the run are reported in the footer and in `--json` `warnings`;
   - ari's own git calls run inside the sandbox, so a filter that a repository's config names doesn't run outside it. Agents can still stage and commit.
   - Linked worktrees (made with `git worktree add`) and subdirectories of a repository work as workspaces. To find the repository's git dir before the sandbox exists, ari runs one `git rev-parse` on the host at start-up, before any agent runs (with fsmonitor and hooks disabled, and refusing a `git` binary that lies in a writable place); every other git call of ari's runs inside the sandbox. `ari --sandbox-check -C DIR` runs this start-up without a task and tells you whether the sandbox works for DIR.
   - One exception to "read-only": ari's own git calls (the snapshot) may write to a git dir outside the workspace (the repository's, when ari runs in a subdirectory or a linked worktree). Its config, hooks and redirect files stay read-only for them too, and agents' commands can't write there unless it lies in a writable place.
8. **ari refuses to start (or refuses the command)** rather than protect a complicated layout: a symbolic link anywhere in or on the way to the git paths above, or on the path that a `.git` file or `commondir` names, when the link lies in a writable place (followed through every link's own target); a git dir without a config file, unless it has a `commondir` that passes the next check; a `commondir` that doesn't name the git dir git's own layout gives it (a linked worktree's names the git dir holding its `worktrees/` entry, any other names its own git dir), or names one without a config file; a read-only git dir whose config, hooks or redirect file leads into a writable place; a `.git` file or `commondir` that names any git dir other than the ones above (wherever it lies; the path is resolved like the kernel and git do, so `link/..` is the parent of the link's target); a variable that changes where git looks for a repository or its config (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`/`VALUE_*`, `GIT_CONFIG_PARAMETERS`, or a relative `XDG_CONFIG_HOME`); any include directive (`include.path`, `includeIf.*.path`) in the repository's, its submodules' or its worktrees' config or config.worktree, in `~/.gitconfig` or in the XDG git config: configs with include directives aren't supported, and ari refuses them without following any; a submodule `core.worktree` that uses an expansion ari doesn't reproduce exactly (`~user/`, `%(prefix)/`, `:(...)`); a global git config in a writable place.

In practice: a background process ends when the command that started it ends, so start a server and use it within one command; commands that need the session sockets (signing a commit with GPG, talking to a desktop app) fail; and pi keeps the full text of long command output in the current run's private temp dir.

**File tools** (`read`, `edit`, `write` run inside the ari process, so ari checks their paths itself, both as written and with symlinks followed). A path given to a tool is first normalized as text, as pi does before it opens it (`hop/../x` becomes `x`, whatever `hop` is); the symlinks on the result, including `..` inside a link's own target, are then followed as the kernel does (there `link/..` is the parent of the link's target). A path that can't be resolved that way is refused by all three: a symlink loop, more than 40 links, a dangling symlink, or `.`/`..` after the part that exists.

9. `edit`/`write` reach only the writable places above, never a secret (even one that doesn't exist yet) and never the git files above.
10. `read` refuses secrets (also an `--allow-secret` one), the session directory, `/proc`, `/dev` and earlier runs' logs, and checks the look-alike names that pi's read tool falls back to. `AGENTS.md`/`CLAUDE.md` context files go through the same check before they are read.

### Letting a program read one secret: `--allow-secret`

Some tasks run code that must read a key file, for example an app that calls an API with the key in `~/.config/openrouter/api_key`. For those runs:

```sh
ari --allow-secret ~/.config/openrouter/api_key -C ~/src/myapp - < brief.txt
# or: ARI_ALLOW_SECRETS=~/.config/openrouter/api_key ari ...
```

This makes that path visible, **read-only**, to **commands** for this run only (even when it lies inside a writable directory such as `~/.cache`). It is repeatable and logged at start-up. Only a hidden secret (from the list above) or a path inside one can be allowed; anything else is refused, and so is a path that contains the workspace or a writable directory. The `read` tool still refuses the file, so the agent is never handed the contents. A command the agent runs *can* still print the file, and command output goes to the model. Only allow a secret for tasks you trust, and prefer allowing a single file over a whole directory.

### What it does not protect against

Anything not in the list above. In particular:

- **Network is open.** Commands can reach the internet, and so can anything they upload.
- **Environment variables are inherited** (except the socket variables above). API keys or tokens in your environment are visible to commands and therefore to the model.
- **Everything not on the secret list is readable**, for example other apps' settings and your projects' `.env` files.
- **`/tmp` is shared** with the host, and so is `/dev` (except `/dev/shm`): commands can use any device your user may open. Sockets that are not files (abstract Unix sockets) stay reachable. In particular an X11 display is reachable (`DISPLAY` is kept): a command can open windows on your screen, and X11 lets clients read and send input to other windows.
- **Writable caches can be poisoned:** `~/.cache` (pip and uv wheels, the Go build cache, ...) and `~/.npm` (including the `npx` cache) are used later by your unsandboxed tools.
- **Whatever the agents write in the workspace runs with your full rights** when you run it: scripts, build files, `package.json`, `.envrc`, hook scripts that git reaches through `core.hooksPath` (e.g. `.husky/`) or a symlinked hook, a script that `core.fsmonitor` or a filter points to. Review diffs before running them or using git in that repository, and heed the footer warnings.
- **Git beyond the list above:** a `commondir` or `config.worktree` that doesn't exist yet can be created (it is only reported); other repositories in writable places (a clone in `/tmp` or `~/.cache` that isn't this run's, a repository nested in the workspace that appears during the run, or one created with `git init`/`git clone`) are not protected.
- **Checks and use are not atomic:** ari checks a path, then pi opens it. A command running in parallel could swap a file or link in between.
- **Your shells after the run:** your own shells on the host read `~/.bashrc` and `~/.profile`. If these source something from a place commands can write (the workspace, `~/.cache`, `~/.npm`, a virtualenv's `activate`, a project `.envrc`), an agent can plant code there that runs with your full rights the next time you open a shell. Keep your start-up files free of such sources. Separately, a `BASH_ENV` you set is still sourced inside the sandbox; unset it before starting ari if it lies in a writable place.
- A sub-agent without a scope is "read-only" only for `edit`/`write`; its commands can still write inside the workspace. Scopes are likewise not enforced on commands.
- `--sandbox off` disables all of the above; ari prints a warning to stderr when you use it. ari's own git calls then run on the host with fsmonitor and hooks disabled, but a repository's filters still run.
- Prompt injection from repository files, issues or command output is possible, as with any coding agent.

pi's own [security notes](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md) apply as well.

## Cost and quota

- ari uses your ChatGPT/Codex subscription quota, not API billing. Parallel sub-agents multiply usage; `--max` limits concurrency and `--child` / `--child-effort` pick cheaper workers.
- The weekly quota is read from a ChatGPT backend endpoint (`chatgpt.com/backend-api/wham/usage`), sending your login token to chatgpt.com. That endpoint is not a documented API and may change; ari takes the longest usage window it reports and shows `unknown` when it cannot read one. Whether calling it fits your plan's terms is for you to check.
- At 99% weekly usage ari refuses to start (exit 3, override with `--force`) and refuses to start new sub-agents; the footer warns when the limit is near.
- Priority tier is requested by default. How your provider counts priority requests against your plan is up to them; use `--no-fast` if in doubt.
- ari does not compute money cost (model costs are set to 0 in its model definitions).

## Known limitations

- Linux only by default (bubblewrap). Other platforms would need `--sandbox off` and are untested.
- Tied to GPT-6 Codex models and the `openai-codex` provider; model limits (272k context, 128k output) are hard-coded.
- Pinned to pi-coding-agent 0.87.0 and uses its SDK hooks directly; other versions may break it.
- `--resume` always reuses the original working directory (`-C` is ignored) and needs the run's files under `~/.local/state/ari/runs/`.
- Outside a git repository the changed-files list only covers files changed through `edit`/`write`. The snapshot commit is dangling and will eventually be garbage-collected by git.
- The check's output fed back to the model is limited to the last 20 lines / 3000 chars (the full output is saved under `runs/<id>/tmp/`), with a 10-minute timeout.
- The stall-watchdog timings were tuned for GPT-6 streaming behaviour.
- pi's own customisation (`.pi/settings.json`, packages, extensions, skills, `SYSTEM.md`/`APPEND_SYSTEM.md`) is ignored on purpose; only `AGENTS.md`/`CLAUDE.md` context files are used.
- Tests (`npm test`) cover the sandbox, the resource-loader settings, the verdict and option parsing, not the agent loop.
- ari sets `TMPDIR` to its private per-run directory. With the sandbox on, commands get your own `TMPDIR` back; with `--sandbox off` they inherit the private one. `tools/` holds two diagnostic probes used while tuning; they make real model requests.

## Credits and licence

ari builds on [pi-coding-agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) by Mario Zechner, published under the MIT licence. pi is installed from npm by `npm ci` and is not included in this repository. All dependencies are installed from npm under their own licences; none of them is redistributed here.

ari itself is released under the [MIT licence](LICENSE). Copyright (c) 2026 aiueo52.
