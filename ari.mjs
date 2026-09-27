#!/usr/bin/env node
// ari: headless GPT-6 coding harness on Pi's SDK, built around cheap sub-agents.
// Children never see history: they get a brief, and their reports come back short,
// with changed files and the acceptance check filled in by the harness, not the model.
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  EXIT_CODES, SAFE_GIT, changedFiles, changedUntracked, checkResult, contextAllow, splitNul, statusPaths, writeHostShell, enumOption, fileSig, intOption, loaderOptions, resultJson, runWarnings, scrubHostEnv,
  promptTurn, verdictOf, weeklyWindow,
} from "./lib.mjs";
import {
  SECRET_DEFAULTS, bwrapArgs, changedRedirects, findExecutable, findGitEntries, gitRedirects, inside, lexicalPath, prepareCargo, readBlockReason, readTargets, realPath,
  sandboxPlan, writeBlockReason,
} from "./sandbox.mjs";

const HOME = os.homedir();
const HERE = path.dirname(fs.realpathSync.native(fileURLToPath(import.meta.url)));
const STATE = path.join(HOME, ".local/state/ari");
const PI_DIR = path.join(STATE, "pi");
const AUTH = path.join(HOME, ".pi/agent/auth.json");
const MODELS = { astra: "gpt-6-astra", sol: "gpt-6-sol", luna: "gpt-6-luna" };
// Default reasoning effort per model (the author's choice). Other ChatGPT models aren't worth their cost; they get medium.
const EFFORTS = { astra: "max", sol: "xhigh", luna: "max" };
const defaultEffort = (name) => EFFORTS[name] ?? EFFORTS[Object.keys(MODELS).find((k) => MODELS[k] === name)] ?? "medium";
const LIMIT = {
  brief: 1500, // chars; a longer brief bounces once
  report: [6, 900], // child report: lines, chars
  final: [12, 1800], // root report: lines, chars
  tools: { child: 60, root: 250 },
  childMs: 30 * 60_000,
  nudge: 4, // commands since the last edit before a "stop verifying" note
  output: 12_000, // bash output chars kept in context
  bashTimeout: 600, // seconds, when the model sets none
  checkMs: 10 * 60_000,
  stopAt: 99, // Codex weekly usage % at which new work is refused
  firstEventMs: 20_000, // until the model's first output; healthy: ~2s (+1s per 10K uncached context)
  // GPT-6 streams reasoning in ~500-token segments at any effort, 6-17s apart, so a healthy stream is never this silent.
  silenceMs: 45_000,
  stalls: 3, // reconnects per agent before giving up; each one doubles the limits
  slowMs: 30_000, // requests slower than this are logged with their timeline
};
// Keep Python bytecode out of the repo.
process.env.PYTHONPYCACHEPREFIX ??= path.join(HOME, ".cache/ari/pycache");
// Path lists from the environment: colon-separated, relative to $HOME, "~/..." or absolute.
const envList = (name) => (process.env[name] ?? "").split(":").filter(Boolean);
// Hidden from sandboxed commands and the file tools (see sandbox.mjs). ARI_EXTRA_SECRETS adds more.
// ari's own state (run logs may quote credentials a command printed) is hidden too.
const SECRETS = [...SECRET_DEFAULTS, STATE, ...envList("ARI_EXTRA_SECRETS")];
// Writable inside the sandbox besides the workspace. Only cargo's caches and locks, never ~/.cargo/bin, env or config.
// ARI_EXTRA_WRITABLE adds more (e.g. a game engine's user data dir); sandbox.mjs refuses unsafe ones.
const WRITABLE = ["/tmp", ".cache", ".npm", ".cargo/registry", ".cargo/git", ".cargo/.package-cache", ".cargo/.package-cache-mutate",
  ".cargo/.global-cache"];
const EXTRA_WRITABLE = envList("ARI_EXTRA_WRITABLE");
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc)$|(^|\/)(README|NOTES|TODO|CHANGELOG)$/i;
const JUNK = /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|node_modules|\.cache)(\/|$)|\.pyc$/;
const DOC_ASK = /\b(docs?|readme|markdown|documentation|document)\b|\.md\b|文書|ドキュメント|説明書|手順書|メモ/i;

const USAGE = `usage: ari [options] "task"      (task "-" reads stdin)
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
  -h, --help        show this help
env: ARI_EXTRA_SECRETS, ARI_ALLOW_SECRETS, ARI_EXTRA_WRITABLE (colon-separated paths; relative to $HOME or absolute)`;
// An unknown option or a missing value is reported like the other option errors, not as a stack trace.
let o, positionals;
try {
  ({ values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cd: { type: "string", short: "C" },
      model: { type: "string", short: "m", default: "sol" },
      effort: { type: "string", short: "e" },
      child: { type: "string", default: "luna" },
      "child-effort": { type: "string" },
      max: { type: "string", default: "12" },
      depth: { type: "string", default: "1" },
      check: { type: "string" },
      sandbox: { type: "string", default: "workspace" },
      "allow-secret": { type: "string", multiple: true },
      "no-fast": { type: "boolean" },
      "no-context": { type: "boolean" },
      resume: { type: "string" },
      status: { type: "boolean" },
      json: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      "sandbox-check": { type: "boolean" },
    },
  }));
} catch (e) {
  console.log(`FAILED: ${e.message}\n${USAGE}`);
  process.exit(1);
}


let run; // the one run this process executes

// ---------- small helpers ----------
const rel = (p) => path.relative(run.cwd, p) || ".";
const secs = (t0) => Math.round((Date.now() - t0) / 1000);
const at = (t, t0) => (t ? `+${((t - t0) / 1000).toFixed(1)}s` : "never");
const timeline = (a) => `accepted ${at(a.accepted, a.reqAt)}, first output ${at(a.first, a.reqAt)}, text/tool ${at(a.visible, a.reqAt)}`;
const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
const kilo = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
function log(line) {
  fs.appendFileSync(path.join(run.dir, "events.log"), `${new Date().toISOString().slice(11, 19)} ${line}\n`, { mode: 0o600 });
  if (!o.quiet) process.stderr.write(`[ari] ${line}\n`);
}
function save(name, text, dir = run.dir) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text, { mode: 0o600 });
  return f;
}
// Full check output goes to the run's temp dir, which that run's agents (and you) can read.
const saveCheck = (who, chk) => save(`${who}.check.txt`, chk.full, run.tmp);
function cap(text, [lines, chars], name) {
  const all = text.trim().replace(/\n{3,}/g, "\n\n");
  let out = all.split("\n").slice(0, lines).join("\n").slice(0, chars);
  if (out.length < all.length) out += `\n… (cut; full: ${save(name, all)})`;
  return out;
}
// ari's own git calls run inside the sandbox too (git dirs outside the workspace writable for them only), so
// filters, fsmonitor or anything else a repository's config names can't run outside it.
function git(args, timeout = 15_000) {
  try {
    if (run.sandbox) return execFileSync(run.bwrap, bwrapArgs(plan({ gitWritable: run.gitDirs ?? [] }), ["git", ...SAFE_GIT, ...args]),
      { cwd: run.cwd, timeout, stdio: ["ignore", "pipe", "ignore"] }).toString();
    return execFileSync("git", [...SAFE_GIT, ...args], { cwd: run.cwd, timeout, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return null;
  }
}
const lines = (s) => (s ? s.split("\n").filter(Boolean) : []);

// ---------- Codex usage (no inference; the ChatGPT backend endpoint the Codex CLI reads) ----------
async function codexUsage() {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH, "utf8"))["openai-codex"];
    const r = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { authorization: `Bearer ${a.access}`, "chatgpt-account-id": a.accountId },
      signal: AbortSignal.timeout(8000),
    });
    const w = r.ok && weeklyWindow((await r.json()).rate_limit);
    return w ? { used: w.used_percent, resetAt: w.reset_at } : null;
  } catch {
    return null;
  }
}
const usageText = (u) =>
  u ? `${u.used}% used, resets ${new Date(u.resetAt * 1000).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "unknown";

// ---------- sandbox ----------
// The sandbox is planned again for every command and file-tool call, so secrets created during the run count too.
const plan = (extra = {}) => sandboxPlan({ ...run.planInput, ...extra });
// A shell command line for pi's bash tool. bwrap is called by the absolute path found at start-up, and the host
// shell that runs this line has BASH_ENV/ENV removed (see main), so nothing the sandbox can edit runs outside it.
function sandboxed(cmd) {
  return [run.bwrap, ...bwrapArgs(plan(), cmd)].map(quote).join(" ");
}
function runCheck(cmd) {
  let argv;
  try { argv = run.sandbox ? [run.bwrap, bwrapArgs(plan(), cmd)] : [run.bash ?? "bash", ["--norc", "--noprofile", "-c", cmd]]; }
  catch (e) { return Promise.resolve(checkResult(e, "", `ari's sandbox refused to run the check: ${e.message}\n`)); }
  return new Promise((done) =>
    execFile(...argv, { cwd: run.cwd, timeout: LIMIT.checkMs, maxBuffer: 1 << 26 }, (err, out, errOut) => done(checkResult(err, out, errOut))));
}

// The repository's git dirs outside the workspace (DIR is a subdirectory, or a linked worktree), which the sandbox
// must know before it can be planned. Found with one `git rev-parse` on the host at start-up, before any agent has
// run; the git binary must not lie where sandboxed commands can write.
function hostGitDirs(cwd) {
  const bin = findExecutable("git");
  if (!bin) return [];
  const writable = [cwd, ...[...WRITABLE, ...EXTRA_WRITABLE].map((n) => realPath(n, HOME, HOME)).filter(Boolean)];
  if (writable.some((w) => inside(bin, w))) throw new Error(`git resolves to ${bin}, which sandboxed commands can write; install it system-wide.`);
  let out;
  try {
    out = execFileSync(bin, [...SAFE_GIT, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { cwd, timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return []; // not a git repository
  }
  return [...new Set(lines(out).map((g) => { try { return fs.realpathSync.native(g); } catch { return g; } }))].filter((g) => !inside(g, cwd));
}

// ---------- scopes ----------
const scopeBase = (s) => path.resolve(run.cwd, s.split(/[*?[{]/)[0] || ".");
function inScope(abs, scope) {
  return scope.some((s) => { if (/[*?[{]/.test(s)) return path.matchesGlob(rel(abs), s); const r = realPath(s, run.cwd, HOME); return !!r && inside(abs, r); });
}
function overlaps(a, b) {
  return a.some((x) => b.some((y) => inside(scopeBase(x), scopeBase(y)) || inside(scopeBase(y), scopeBase(x))));
}
function scopeStatus(scope) {
  return new Set(statusPaths(git(["status", "--porcelain", "-z", "-uall", "--", ...scope])));
}

// ---------- models ----------
function model(name) {
  const id = MODELS[name] ?? name;
  return {
    id, name: id, api: "openai-codex-responses", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000, maxTokens: 128_000,
    thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true, supportsMidConvoSystemMessages: true },
  };
}
const effort = (e) => (e === "ultra" ? "max" : e);

class Slots {
  constructor(n) { this.n = n; this.q = []; }
  async take() { if (this.n > 0) this.n--; else await new Promise((r) => this.q.push(r)); }
  give() { const r = this.q.shift(); if (r) r(); else this.n++; }
}

// ---------- agents ----------
class Agent {
  constructor({ name, parent = null, modelName, effortName, scope = null, check = null, brief = "" }) {
    Object.assign(this, { parent, modelName, effortName, scope, check, brief });
    this.path = parent ? `${parent.path}/${name}` : "/root";
    this.depth = parent ? parent.depth + 1 : 0;
    this.readOnly = !!parent && !scope;
    this.state = "new";
    this.tools = 0;
    this.sinceEdit = 0;
    this.edited = new Set();
    this.bounced = new Set();
    this.inbox = [];
    this.waiters = [];
    this.notes = [];
    this.t0 = Date.now();
    this.stalls = 0; // stalled requests so far; each one reconnects under a fresh cache key
  }
  get busy() { return this.state === "queued" || this.state === "running"; }
  kids() { return [...run.agents.values()].filter((a) => a.parent === this); }
  usage() {
    const u = { input: 0, cached: 0, output: 0 };
    for (const m of this.session?.messages ?? []) if (m.role === "assistant" && m.usage) {
      u.input += m.usage.input + m.usage.cacheRead;
      u.cached += m.usage.cacheRead;
      u.output += m.usage.output;
    }
    return u;
  }

  async open(sessionManager) {
    const root = !this.parent;
    let prompt = fs.readFileSync(path.join(HERE, "prompts", root ? "root.md" : "child.md"), "utf8");
    const loader = new DefaultResourceLoader(loaderOptions({
      cwd: run.cwd, agentDir: PI_DIR, prompt, context: root && !o["no-context"],
      // Context files go to the model, so they pass the same secret check as the read tool.
      // ari's own pi dir is hidden with the rest of its state, but a global AGENTS.md there is yours to read.
      allowFile: run.sandbox ? contextAllow({ agentDir: PI_DIR, isBlocked: (f) => { try { return readBlockReason(toolPaths(f), plan()); } catch (e) { return e.message; } } }) : () => true,
      onSkip: (f) => log(`~ skipped context file ${f}: it is a secret`),
      extensionFactories: [(pi) => hooks(pi, this)],
    }));
    await loader.reload();
    const custom = this.depth < run.depth ? collabTools(this) : [];
    ({ session: this.session } = await createAgentSession({
      cwd: run.cwd, agentDir: PI_DIR, model: model(this.modelName), thinkingLevel: effort(this.effortName),
      modelRuntime: run.rt, resourceLoader: loader, customTools: custom,
      tools: ["read", "bash", "edit", "write", ...custom.map((t) => t.name)],
      sessionManager: sessionManager ?? SessionManager.create(run.cwd, path.join(run.dir, "agents")),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 4 }, shellPath: run.shell }),
    }));
    // Stream heartbeat for the stall watchdog. message_start only means the server accepted the
    // request; `first` is the model's first output (reasoning start), `visible` its first text or tool call.
    this.session.subscribe((e) => {
      if (e.type === "compaction_start") this.compacting = true;
      else if (e.type === "compaction_end") this.compacting = false;
      else if (e.type === "message_start" && e.message?.role === "assistant") this.beat = this.accepted = Date.now();
      else if (e.type === "message_update") {
        this.beat = Date.now();
        this.first ||= this.beat;
        if (/^(text|toolcall)_/.test(e.assistantMessageEvent?.type)) this.visible ||= this.beat;
      } else if (e.type === "message_end" && e.message?.role === "assistant") {
        this.inReq = false;
        if (Date.now() - this.reqAt > LIMIT.slowMs && !this.stalled)
          log(`~ ${this.path} slow request ${secs(this.reqAt)}s (${timeline(this)}, ${e.message.usage?.output ?? 0} tok out)`);
      }
    });
  }

  // One prompt to completion; returns the final assistant text.
  async turn(text) {
    this.state = "running";
    return promptTurn(this, text, LIMIT.stalls);
  }

  // Run a turn, then keep feeding sub-agent reports back in until none are pending.
  async settle(text) {
    let out = await this.turn(text);
    while (this.inbox.length || this.kids().some((k) => k.busy)) {
      const release = this.slot && !this.inbox.length; // don't hold a slot while only waiting
      if (release) run.slots.give();
      const reports = await nextReports(this, LIMIT.childMs * 2);
      if (release) await run.slots.take();
      if (!reports.length) break;
      out = await this.turn(`${reports.join("\n\n")}\n\nIntegrate these reports, then give your final report.`);
    }
    return out;
  }
}

// Tool policy for one agent: budget, scope, sandbox, doc guard, output trimming, fast tier.
function hooks(pi, agent) {
  pi.on("before_provider_request", (e) => {
    const p = { ...e.payload };
    if (run.fast) p.service_tier = "priority";
    if (p.reasoning) p.reasoning = { effort: p.reasoning.effort };
    // A stalled session may be pinned to a slow server by its cache key; move it.
    if (agent.stalls) p.prompt_cache_key = `${p.prompt_cache_key ?? agent.path}-r${agent.stalls}`;
    const u = agent.session?.messages.findLast((m) => m.role === "assistant")?.usage;
    agent.ctx = u ? u.input + u.cacheRead + u.output : 0;
    agent.inReq = true;
    agent.accepted = agent.first = agent.visible = 0;
    agent.beat = agent.reqAt = Date.now();
    return p;
  });
  pi.on("tool_call", (e) => {
    // The sandbox refuses (throws) when it can't be set up safely, for example a git file turned into a symlink.
    try { return toolCall(e); } catch (err) { return { block: true, reason: `ari's sandbox refused this call: ${err.message}` }; }
  });
  const toolCall = (e) => {
    const inp = e.input;
    if (++agent.tools > (agent.parent ? LIMIT.tools.child : LIMIT.tools.root))
      return { block: true, reason: "Tool budget used up. Stop now and write your final report." };
    if (e.toolName === "bash") {
      agent.sinceEdit++;
      inp.timeout ??= LIMIT.bashTimeout;
      if (run.sandbox) inp.command = sandboxed(inp.command);
    } else if (e.toolName === "edit" || e.toolName === "write") {
      const paths = toolPaths(inp.path);
      const why = writeBlock(paths, agent);
      if (why) return { block: true, reason: why };
      agent.edited.add(paths.real);
      agent.sinceEdit = 0;
    } else if (e.toolName === "read" && run.sandbox) {
      const p = plan();
      const why = readTargets(inp.path, run.cwd, HOME).map((t) => readBlockReason(t, p)).find(Boolean);
      if (why) return { block: true, reason: why };
    }
  };
  pi.on("tool_result", (e) => {
    if (e.toolName !== "bash") return;
    // pi keeps long output in a file under TMPDIR, which is this run's private temp dir.
    if (e.details?.fullOutputPath) try { fs.chmodSync(e.details.fullOutputPath, 0o600); } catch {}
    let text = e.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const before = text;
    if (text.length > LIMIT.output) text = `${text.slice(0, 2000)}\n… [${text.length - LIMIT.output} chars cut; narrow the command for more] …\n${text.slice(-(LIMIT.output - 2000))}`;
    if (agent.edited.size && agent.sinceEdit === LIMIT.nudge) text += `\n[ari] ${LIMIT.nudge} commands since your last edit. If the change works, stop checking and write your report.`;
    if (text !== before) return { content: [{ type: "text", text }] };
  });
}

const toolPaths = (p) => ({ lexical: lexicalPath(p, run.cwd, HOME), real: realPath(p, run.cwd, HOME) });
function writeBlock(paths, agent) {
  const abs = paths.real;
  if (!abs) return "This path can't be resolved (a symbolic link loop or too many links).";
  const why = run.sandbox && writeBlockReason(paths, plan());
  if (why) return why;
  if (agent.readOnly) return "This is a read-only task: don't modify files. Put what you found in your report.";
  if (agent.scope && !inScope(abs, agent.scope)) return `Outside your scope (${agent.scope.join(", ")}). Don't make this change; say in your report that it is needed.`;
  for (const other of run.agents.values())
    if (other !== agent && other.busy && other.scope && inScope(abs, other.scope)) return `${rel(abs)} belongs to ${other.path}, which is still running. Wait for its report or leave the file alone.`;
  if (DOC_FILE.test(abs) && !fs.existsSync(abs) && !DOC_ASK.test(agent.brief) && !agent.bounced.has(abs)) {
    agent.bounced.add(abs);
    return "Nobody asked for docs. Put what matters in your final report instead. Only if the task truly requires this file, write it again.";
  }
  return null;
}

// ---------- delegation ----------
function deliver(agent, report) {
  agent.inbox.push(report);
  for (const w of agent.waiters.splice(0)) w();
}

// Resolves with every waiting report, as soon as one exists (plus a short grace to batch
// agents that finish together), or [] when nothing is running or the timeout passes.
function nextReports(agent, timeoutMs) {
  return new Promise((resolve) => {
    if (agent.inbox.length) return resolve(agent.inbox.splice(0));
    if (!agent.kids().some((k) => k.busy)) return resolve([]);
    let done = false; // a stale waiter must not drain reports after we resolved
    const take = () => { if (done) return; done = true; clearTimeout(timer); resolve(agent.inbox.splice(0)); };
    const timer = setTimeout(take, timeoutMs);
    agent.waiters.push(() => setTimeout(take, 1500));
  });
}

function briefText(a) {
  return [
    `You are ${a.path}. Brief from ${a.parent.path}:`, "", a.brief, "",
    a.scope ? `Scope: you may modify only ${a.scope.join(", ")}. Everything else is read-only.` : "Scope: read-only. Don't modify any files.",
    a.check && `Check (the harness runs it when you finish): \`${a.check}\``,
    `Working directory: ${run.cwd}`,
  ].filter((l) => l !== null && l !== undefined && l !== false).join("\n");
}

// Run one task for a child under the concurrency limit, then report to its parent.
async function work(agent, text) {
  agent.state = "queued";
  await run.slots.take();
  agent.slot = true;
  // The task's deadline: the running model turn is aborted then, and no turn starts after it (a check command
  // can outlast it, and the retry after a failed check must not resume the model).
  agent.deadline = Date.now() + LIMIT.childMs;
  const timer = setTimeout(() => agent.session?.abort(), LIMIT.childMs);
  let out, chk, err;
  try {
    if (!agent.session) await agent.open();
    const before = agent.scope && run.git ? scopeStatus(agent.scope) : null;
    const pending = agent.notes.splice(0);
    out = await agent.settle(pending.length ? `${text}\n\nAlso: ${pending.join("\n")}` : text);
    if (agent.check && !out.startsWith("PARTIAL: interrupted")) {
      chk = await runCheck(agent.check);
      if (!chk.ok && !agent.retried) {
        agent.retried = true;
        log(`~ ${agent.path} check failed, sent back once`);
        out = await agent.settle(`The acceptance check failed (last lines below; full output: ${saveCheck(agent.path.slice(1).replaceAll("/", "_"), chk)}):\n$ ${agent.check}\n${chk.tail}\nFix it, then give your report again.`);
        if (!out.startsWith("PARTIAL: interrupted")) chk = await runCheck(agent.check);
      }
    }
    if (before) for (const f of scopeStatus(agent.scope)) if (!before.has(f)) agent.edited.add(path.resolve(run.cwd, f));
  } catch (e) {
    err = e;
  } finally {
    clearTimeout(timer);
    agent.deadline = null;
    agent.slot = false;
    run.slots.give();
  }
  agent.state = err ? "failed" : "idle";
  const body = err ? `FAILED: ${err.message}` : out || "PARTIAL: (no report)";
  const facts = [];
  const edited = [...agent.edited].map(rel).filter((f) => !JUNK.test(f));
  if (edited.length) facts.push(`changed ${edited.join(", ")}`);
  if (chk) facts.push(chk.ok ? "check PASS" : `check FAIL: ${chk.tail.split("\n").at(-1).slice(0, 200)} (full output: ${saveCheck(agent.path.slice(1).replaceAll("/", "_"), chk)})`);
  facts.push(`${agent.modelName}/${agent.effortName} · ${agent.tools} tools · ${secs(agent.t0)}s`);
  log(`= ${agent.path} ${body.split("\n")[0].slice(0, 100)} (${secs(agent.t0)}s${chk ? chk.ok ? ", check PASS" : ", check FAIL" : ""} · report ${body.length}c)`);
  deliver(agent.parent, [
    "Message Type: FINAL_ANSWER", `Task name: ${agent.path}`, `Sender: ${agent.path}`, "Payload:",
    cap(body, LIMIT.report, `${agent.path.slice(1).replaceAll("/", "_")}.report.md`), `[ari] ${facts.join(" · ")}`,
  ].join("\n"));
}

function spawn(parent, p) {
  const name = String(p.task_name ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40) || "task";
  const agentPath = `${parent.path}/${name}`;
  if (run.agents.has(agentPath)) return `${agentPath} already exists. Use followup_task, or pick another task_name.`;
  if (run.usage?.used >= LIMIT.stopAt) return `Refused: Codex weekly usage is at ${run.usage.used}%. Finish with what you have.`;
  const brief = String(p.message ?? "").trim();
  if (!brief) return "message is empty. Write a standalone brief.";
  if (brief.length > LIMIT.brief && !parent.bounced.has(`brief:${name}`)) {
    parent.bounced.add(`brief:${name}`);
    return `Brief is ${brief.length} chars (limit ${LIMIT.brief}). Cut it to the goal, facts it can't find itself, and file paths; don't paste code or history. To send it as is, call spawn_agent again with the same task_name.`;
  }
  const scope = Array.isArray(p.scope) && p.scope.length ? p.scope.map(String) : null;
  for (const other of run.agents.values())
    if (scope && other.busy && other.scope && other !== parent && overlaps(scope, other.scope))
      return `Scope overlaps with ${other.path} (${other.scope.join(", ")}), which is still running. Give agents disjoint scopes, or wait for it first.`;
  const modelName = p.model && (MODELS[p.model] || p.model.startsWith("gpt-")) ? p.model : run.childModel;
  const child = new Agent({ name, parent, modelName, effortName: run.childEffort || p.reasoning_effort || defaultEffort(modelName), scope, check: p.check || null, brief });
  run.agents.set(agentPath, child);
  log(`+ ${agentPath} ${child.modelName}/${child.effortName}${scope ? ` scope=${scope.join(",")}` : " read-only"}${child.check ? " +check" : ""} · brief ${brief.length}c`);
  work(child, briefText(child));
  const unseen = (scope ?? []).filter((s) => !/[*?[{]/.test(s) && !fs.existsSync(path.resolve(run.cwd, s)));
  return `Started ${agentPath} (${child.modelName}/${child.effortName}). Its report will arrive through wait_agent.${unseen.length ? ` Note: ${unseen.join(", ")} don't exist yet; if you guessed them, interrupt_agent and respawn with the real paths.` : ""}`;
}

function collabTools(agent) {
  const tool = (name, description, properties, required, fn) => defineTool({
    name, label: name, description,
    parameters: { type: "object", properties, required, additionalProperties: false },
    execute: async (_id, params, signal) => ({ content: [{ type: "text", text: await fn(params, signal) }], details: {} }),
  });
  const target = { type: "string", description: "Agent name or path from spawn_agent." };
  const find = (t) => agent.kids().find((k) => k.path === t || k.path.endsWith(`/${t}`));
  const missing = (t) => `No sub-agent named ${t}. Yours: ${agent.kids().map((k) => k.path).join(", ") || "none"}.`;
  return [
    tool("spawn_agent",
      "Start a sub-agent on one bounded subtask; it runs in parallel with you and returns immediately. It begins with an EMPTY context and sees only `message`, so the brief must stand alone: the goal, facts it can't cheaply find itself (decisions, constraints, exact names, file paths with lines), and what done looks like. Point to files instead of pasting them. Its short report arrives through wait_agent.",
      {
        task_name: { type: "string", description: "Short name: lowercase letters, digits, underscores." },
        message: { type: "string", description: "The standalone brief, at most about 120 words." },
        scope: { type: "array", items: { type: "string" }, description: "Files or directories (globs allowed) the agent may modify. Must not overlap other running agents. Omit for read-only work." },
        check: { type: "string", description: "Shell command that must succeed when the agent is done. The harness runs it and sends a failure back to the agent once." },
        model: { type: "string", enum: ["luna", "sol", "astra"], description: "luna (default): lookups and mechanical or fully specified edits. sol: non-trivial coding or debugging. astra: only the hardest reasoning." },
        reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "Omit: each model has a tuned default (luna max, sol xhigh, astra max)." },
      },
      ["task_name", "message"], (p) => spawn(agent, p)),
    tool("wait_agent",
      "Wait until at least one of your sub-agents reports, then return every report received so far. Returns at once if reports are waiting or none are running. Do your own non-overlapping work before calling it.",
      { timeout_ms: { type: "number", description: "Default 1800000 (30 min)." } }, [],
      async (p) => {
        await new Promise((r) => setTimeout(r, 100)); // let spawns from the same turn register
        const reports = await nextReports(agent, Math.min(Math.max(p.timeout_ms ?? 1_800_000, 10_000), 3_600_000));
        const running = agent.kids().filter((k) => k.busy).map((k) => k.path);
        return `${reports.join("\n\n") || "No new reports."}${running.length ? `\n\nStill running: ${running.join(", ")}` : ""}`;
      }),
    tool("followup_task",
      "Give an existing sub-agent a correction or a new task. It keeps its own context, so write only what is new. Its next report arrives through wait_agent.",
      { target, message: { type: "string", description: "What to do now." } }, ["target", "message"],
      (p) => {
        const k = find(p.target);
        if (!k) return missing(p.target);
        if (k.state === "running") { k.session.steer(p.message); return `Delivered to ${k.path} while it runs.`; }
        if (k.state === "queued") { k.notes.push(p.message); return `${k.path} hasn't started; the note goes with its brief.`; }
        k.retried = false;
        k.t0 = Date.now();
        log(`> ${k.path} follow-up`);
        work(k, p.message);
        return `Follow-up started on ${k.path}.`;
      }),
    tool("send_message",
      "Send a note to a running sub-agent without starting a new task. It sees the note at its next step.",
      { target, message: { type: "string", description: "The note." } }, ["target", "message"],
      (p) => {
        const k = find(p.target);
        if (!k) return missing(p.target);
        if (k.state === "running") k.session.steer(p.message);
        else k.notes.push(p.message);
        return `Sent to ${k.path}.`;
      }),
    tool("interrupt_agent", "Stop a sub-agent's current work. It reports what it has and stays available for followup_task.",
      { target }, ["target"],
      (p) => {
        const k = find(p.target);
        if (!k) return missing(p.target);
        k.session?.abort();
        return `Interrupt sent to ${k.path}.`;
      }),
    tool("list_agents", "List your sub-agents with status, model, and elapsed time.", {}, [],
      () => agent.kids().map((k) => `${k.path} ${k.state} ${k.modelName}/${k.effortName} ${k.tools} tools ${secs(k.t0)}s ${k.scope ? `scope=${k.scope.join(",")}` : "read-only"}`).join("\n") || "No sub-agents."),
  ];
}

// ---------- run ----------
function readTask() {
  const t = positionals.join(" ").trim();
  return t === "-" ? fs.readFileSync(0, "utf8").trim() : t;
}

async function status() {
  console.log(`Codex weekly: ${usageText(await codexUsage())}`);
  const dir = path.join(STATE, "runs");
  const runs = fs.existsSync(dir) ? fs.readdirSync(dir).sort().slice(-5) : [];
  for (const id of runs) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, id, "meta.json"), "utf8"));
      console.log(`${id}  ${m.status ?? "?"}  ${m.cwd}  ${(m.task ?? "").slice(0, 60).replaceAll("\n", " ")}`);
    } catch {}
  }
}

async function main() {
  if (o.help) return console.log(USAGE);
  if (o.status) return status();
  const meta = o.resume ? JSON.parse(fs.readFileSync(path.join(STATE, "runs", o.resume, "meta.json"), "utf8")) : null;
  const task = o["sandbox-check"] ? "" : readTask();
  if (!task && !o["sandbox-check"]) return console.log(USAGE);
  const id = meta ? o.resume : `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${randomBytes(2).toString("hex")}`;
  const cwd = fs.realpathSync.native(path.resolve(meta?.cwd ?? o.cd ?? process.cwd()));
  let max, depth;
  try {
    max = intOption(o.max, "--max", 1, 100);
    // Only the root may start sub-agents: multi-level delegation isn't supported.
    if (!["0", "1"].includes(String(o.depth).trim())) throw new Error(`--depth must be 0 (no sub-agents) or 1 (the root starts sub-agents; they can't start their own); got "${o.depth}"`);
    depth = intOption(o.depth, "--depth", 0, 1);
    enumOption(o.sandbox, "--sandbox", ["workspace", "off"]);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  run = {
    id, cwd, dir: path.join(STATE, "runs", id), agents: new Map(), slots: new Slots(max),
    depth, sandbox: o.sandbox !== "off", fast: !o["no-fast"],
    childModel: o.child, childEffort: o["child-effort"], t0: Date.now(),
    bash: fs.existsSync("/bin/bash") ? "/bin/bash" : findExecutable("bash"), // pi's own choice of shell
  };
  // pi writes long command output to files under TMPDIR: give it this run's private temp dir. Commands get the
  // user's TMPDIR back inside the sandbox, and can read (not write) this run's temp dir.
  run.tmp = path.join(run.dir, "tmp");
  const restoreEnv = { TMPDIR: process.env.TMPDIR };
  if (run.sandbox) {
    Object.assign(restoreEnv, scrubHostEnv(process.env));
    try {
      run.gitDirs = hostGitDirs(cwd);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    // .git entries below the workspace (nested clones, submodules), found once: they stay protected for the run.
    // Git dirs outside it (gitProtect): their config, hooks and redirect files stay read-only to agents.
    run.planInput = { cwd, home: HOME, writable: WRITABLE, extraWritable: EXTRA_WRITABLE, secrets: SECRETS, readable: [run.tmp], restoreEnv,
      gitProtect: run.gitDirs,
      gitNested: (() => { try { return findGitEntries(fs.realpathSync.native(cwd)); } catch { return []; } })(),
      allow: [...(o["allow-secret"] ?? []), ...envList("ARI_ALLOW_SECRETS")] };
    try {
      run.plan = plan();
      // Submodule .git files found now stay read-only for the whole run, whatever happens to .gitmodules.
      run.planInput.gitFiles = run.plan.submoduleGitFiles;
      run.bwrap = findExecutable("bwrap");
      for (const [name, p] of [["bwrap", run.bwrap], ["bash", run.bash]])
        if (p && [run.plan.cwd, ...run.plan.writable].some((w) => inside(p, w)))
          throw new Error(`${name} resolves to ${p}, which sandboxed commands can write; install it system-wide.`);
      bwrapArgs(plan({ gitWritable: run.gitDirs }), "true"); // what ari's own git calls will use
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    prepareCargo(HOME);
    try {
      if (!run.bwrap) throw new Error("bwrap: not found on PATH");
      execFileSync(run.bwrap, bwrapArgs(run.plan, "true"), { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
    } catch (e) {
      console.log(`FAILED: the workspace sandbox needs bubblewrap (bwrap) and it did not run (${(e.stderr?.toString().trim() || e.message).split("\n").at(-1)}). Install bubblewrap, or pass --sandbox off to run without a sandbox.`);
      process.exitCode = 1;
      return;
    }
    if (o["sandbox-check"]) return console.log(`OK: the sandbox works for ${cwd}${run.gitDirs.length ? ` (git dirs outside it: ${run.gitDirs.join(", ")})` : ""}.`);
  } else {
    if (o["sandbox-check"]) return console.log("OK: --sandbox off, nothing to check.");
    process.stderr.write("[ari] WARNING: --sandbox off: agent commands and file edits run with your full user rights. Nothing limits writes, secrets are not hidden.\n");
  }
  // Run logs hold whatever the agents saw: keep them private to you.
  for (const d of [STATE, path.join(STATE, "runs"), run.dir, path.join(run.dir, "agents"), run.tmp, PI_DIR]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }
  process.env.TMPDIR = run.tmp;
  if (run.bash) run.shell = writeHostShell(run.dir, run.bash);
  run.git = git(["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
  // A repository whose git dir lies outside the workspace (DIR is a subdirectory, or a linked worktree): ari's own
  // git calls may write there (for the snapshot); agents' commands still may not.
  if (!run.sandbox) run.gitDirs = run.git ? lines(git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])).filter((g) => !inside(g, cwd)) : [];
  // Fingerprint git's redirect files (commondir, gitdir, config.worktree, .git) to report ones this run creates or changes.
  // Fingerprint the redirect files of every git dir, and every .git file in the workspace (nested ones included).
  const plan0 = run.sandbox ? plan({ gitWritable: run.gitDirs }) : null;
  run.redirectDirs = plan0?.gitDirs ?? [];
  const redirects0 = run.sandbox ? gitRedirects(run.redirectDirs, cwd, plan0.submoduleGitFiles) : {};
  run.usage = await codexUsage();
  const usage0 = run.usage;
  if (usage0?.used >= LIMIT.stopAt && !o.force) {
    console.log(`BLOCKED: Codex weekly usage is at ${usage0.used}%. Ask the user to use a reset ticket, or rerun with --force.`);
    process.exitCode = 3;
    return;
  }
  setInterval(async () => { run.usage = (await codexUsage()) ?? run.usage; }, 180_000).unref();
  run.rt = await ModelRuntime.create({ authPath: AUTH, modelsPath: path.join(PI_DIR, "models.json") });
  // Stall watchdog: in a parallel run the slowest agent sets the pace, so a stuck stream
  // is cut and reopened instead of waited out.
  setInterval(() => {
    const now = Date.now();
    for (const a of run.agents.values()) {
      if (!a.inReq || a.stalled || a.compacting) continue;
      const limit = (a.first ? LIMIT.silenceMs : LIMIT.firstEventMs + a.ctx / 10) * 2 ** a.stalls;
      if (now - (a.first ? a.beat : a.reqAt) < limit) continue;
      a.stalled = true;
      a.inReq = false;
      log(`! ${a.path} stream stalled after ${secs(a.reqAt)}s (${timeline(a)}), reconnecting`);
      a.session.abort();
    }
  }, 3000).unref();

  // Snapshot tracked files (a dangling commit, nothing in the worktree or index changes)
  // and remember untracked files, so the footer can list exactly what this run changed.
  const snap = meta?.snapshot ?? (run.git ? (git(["stash", "create", `ari ${id}`])?.trim() || git(["rev-parse", "HEAD"])?.trim()) : null);
  // Untracked files with their size and mtime, so edits by commands to files git doesn't track show up as changes.
  const untrackedSig = (f) => fileSig(path.join(cwd, f));
  const untracked0 = meta?.untracked0
    ? new Map(Array.isArray(meta.untracked0) ? meta.untracked0.map((f) => [f, null]) : Object.entries(meta.untracked0))
    : run.git ? new Map(splitNul(git(["ls-files", "--others", "--exclude-standard", "-z"])).map((f) => [f, untrackedSig(f)])) : null;

  const rootModel = meta?.model ?? o.model;
  const root = new Agent({ name: "root", modelName: rootModel, effortName: meta?.effort ?? o.effort ?? defaultEffort(rootModel), check: o.check ?? meta?.check ?? null, brief: meta ? meta.task : task });
  run.agents.set(root.path, root);
  await root.open(meta ? SessionManager.open(meta.session) : SessionManager.create(cwd, run.dir));
  const saveMeta = (extra = {}) => fs.writeFileSync(path.join(run.dir, "meta.json"), JSON.stringify({
    cwd, task: root.brief, model: root.modelName, effort: root.effortName, check: root.check, session: root.session.sessionFile,
    snapshot: snap, untracked0: untracked0 ? Object.fromEntries(untracked0) : null, ...extra,
  }, null, 1), { mode: 0o600 });
  saveMeta({ status: "running" });
  if (run.sandbox && run.plan.allowed.length) log(`secrets readable by commands this run: ${run.plan.allowed.join(", ")}`);
  log(`${meta ? "resume" : "run"} ${id} · ${root.modelName}/${root.effortName} · children ${run.childModel}${run.childEffort ? `/${run.childEffort}` : ""} ×${o.max} · ${run.fast ? "fast" : "standard"} · sandbox ${run.sandbox ? "workspace" : "off"} · codex ${usageText(usage0)}`);

  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => {
    for (const a of run.agents.values()) a.session?.abort();
    log("interrupted");
    saveMeta({ status: "interrupted" });
    process.exit(130);
  });

  let out, chk;
  try {
    const first = meta ? task : [task, "", `Working directory: ${cwd}`, root.check && `Acceptance check: \`${root.check}\`. The harness runs it after your final report; don't run it yourself.`].filter(Boolean).join("\n");
    out = await root.settle(first);
    if (root.check) {
      chk = await runCheck(root.check);
      if (!chk.ok) {
        log("check failed, sent back to root once");
        out = await root.settle(`The acceptance check failed (last lines below; full output: ${saveCheck("root", chk)}):\n$ ${root.check}\n${chk.tail}\nFix it, then give your final report again.`);
        chk = await runCheck(root.check);
      }
    }
  } catch (e) {
    out = `FAILED: ${e.message}`;
  }
  out ||= "PARTIAL: (no report)";

  // Footer facts come from the harness, not from the model.
  const changed = changedFiles({
    tracked: run.git && snap ? splitNul(git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--relative", snap])) : [],
    edited: [...run.agents.values()].flatMap((a) => [...a.edited].map(rel)),
    untracked: untracked0 ? changedUntracked(untracked0, splitNul(git(["ls-files", "--others", "--exclude-standard", "-z"])), untrackedSig) : [],
    junk: JUNK,
  });
  const kids = [...run.agents.values()].filter((a) => a.parent);
  const tok = [...run.agents.values()].map((a) => a.usage()).reduce((s, u) => ({ input: s.input + u.input, cached: s.cached + u.cached, output: s.output + u.output }), { input: 0, cached: 0, output: 0 });
  const usage1 = (await codexUsage()) ?? run.usage;
  const byModel = {};
  for (const k of kids) byModel[k.modelName] = (byModel[k.modelName] ?? 0) + 1;
  let sandboxError;
  if (run.sandbox) try { run.redirectDirs = plan({ gitWritable: run.gitDirs }).gitDirs; } catch (e) { sandboxError = e.message; }
  const redirects = run.sandbox ? changedRedirects(redirects0, gitRedirects(run.redirectDirs, cwd, Object.keys(redirects0))) : [];
  const warnings = runWarnings({ usedPercent: usage1?.used, stopAt: LIMIT.stopAt, redirects, sandboxError });
  const footer = [
    `run ${id} · ${secs(run.t0)}s · ${kids.length} sub-agents${kids.length ? ` (${Object.entries(byModel).map(([m, n]) => `${m} ${n}`).join(", ")})` : ""} · tokens ${kilo(tok.input)} in (${kilo(tok.cached)} cached) / ${kilo(tok.output)} out`,
    changed.length ? `changed (${changed.length}): ${changed.slice(0, 12).join(", ")}${changed.length > 12 ? " …" : ""}` : "changed: nothing",
    chk && `check ${chk.ok ? "PASS" : "FAIL"}: ${root.check}${chk.ok ? "" : ` (full output: ${saveCheck("root", chk)})`}`,
    `codex weekly: ${usage0 && usage1 && usage1.used !== usage0.used ? `${usage0.used}% → ` : ""}${usageText(usage1)}`,
    ...warnings.map((w) => `WARNING: ${w}`),
    `log: ${run.dir}${snap ? ` · snapshot ${snap.slice(0, 12)}` : ""}`,
  ].filter(Boolean).map((l) => `[ari] ${l}`);
  let report = cap(out, LIMIT.final, "final.report.md");
  const verdict = verdictOf(report, chk?.ok);
  // A failed acceptance check overrides the root's DONE, so callers that read line 1 or the exit code see it.
  if (verdict !== verdictOf(report)) report = `PARTIAL: the acceptance check failed (${root.check}); the root's report follows.\n${report}`;
  saveMeta({ status: verdict, changed, report: out, warnings });
  const agents = [...run.agents.values()].map((a) => ({ path: a.path, model: a.modelName, effort: a.effortName, state: a.state, tools: a.tools, ...a.usage() }));
  if (o.json) console.log(resultJson({ status: verdict, report, changed, check: chk ? chk.ok : null, run: id, log: run.dir, secs: secs(run.t0), tokens: tok, agents, codex: usage1, warnings }));
  else console.log(`${report}\n\n${footer.join("\n")}`);
  process.exitCode = EXIT_CODES[verdict] ?? 1;
  for (const a of run.agents.values()) a.session?.dispose();
}

try {
  await main();
} catch (e) {
  console.log(`FAILED: ${e.stack || e.message}`);
  process.exitCode = 1;
}
// Pi keeps sockets open; flush stdout, then leave.
process.stdout.write("", () => process.exit(process.exitCode ?? 0));
