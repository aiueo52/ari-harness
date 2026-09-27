// Small helpers for ari.mjs, kept apart so test/lib.test.mjs can check them without a model.
import fs from "node:fs";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { inside } from "./sandbox.mjs";

// pi's context-file names, in its order of preference within one directory.
const CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

// AGENTS.md/CLAUDE.md from agentDir, then from the filesystem root down to cwd (pi's order). Each candidate
// is checked with `allowFile` *before* it is read, and only regular files are read.
export function contextFiles({ cwd, agentDir, allowFile = () => true, onSkip = () => {} }) {
  const dirs = [];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) { dirs.unshift(d); if (path.dirname(d) === d) break; }
  const out = [], seen = new Set();
  for (const dir of [path.resolve(agentDir), ...dirs]) {
    for (const name of CONTEXT_NAMES) {
      const f = path.join(dir, name);
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (!st.isFile()) continue;
      if (seen.has(f)) break;
      seen.add(f);
      if (allowFile(f)) out.push({ path: f, content: fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "") });
      else onSkip(f);
      break;
    }
  }
  return out;
}

// Which context files may reach the model: those that really live in ari's own pi dir (`agentDir`, written by you,
// hidden from agents), and otherwise whatever `isBlocked` lets through.
export function contextAllow({ agentDir, isBlocked }) {
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
  return (f) => {
    const dir = real(agentDir), file = real(f);
    return (!!dir && !!file && inside(file, dir) && path.dirname(path.resolve(f)) === path.resolve(agentDir)) || !isBlocked(f);
  };
}

// Size and modification time, to notice commands changing files git doesn't track.
export function fileSig(file) {
  try { const st = fs.statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return null; }
}
// Untracked files that are new, or whose signature changed since `before` (a Map of path -> signature;
// a null signature, from an old run's metadata, means "unknown": only newness counts).
export const changedUntracked = (before, now, sigOf) =>
  now.filter((f) => !before.has(f) || (before.get(f) != null && before.get(f) !== sigOf(f)));

// Options for pi's DefaultResourceLoader. ari uses none of pi's own resources: the loader gets in-memory
// settings, so a workspace's .pi/settings.json (packages, npmCommand, ...) is never read or installed; the
// system prompt is given explicitly, so no SYSTEM.md/APPEND_SYSTEM.md is looked up; no extensions, skills,
// prompt templates or themes. Context files come from contextFiles() above, only when `context` is true.
export function loaderOptions({ cwd, agentDir, prompt, context, allowFile, onSkip, extensionFactories = [] }) {
  return {
    cwd, agentDir, settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: prompt, appendSystemPrompt: [],
    systemPromptOverride: () => prompt,
    agentsFilesOverride: () => ({ agentsFiles: context ? contextFiles({ cwd, agentDir, allowFile, onSkip }) : [] }),
    extensionFactories,
  };
}

// Prefix for ari's own git calls when the sandbox is off: agents may have edited scripts that the repository's
// config points at (core.fsmonitor, hooks). With the sandbox on, ari's git calls also run inside it.
export const SAFE_GIT = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

// Variables the host-side bash (which launches bwrap) must not see: bash sources BASH_ENV (and sh sources ENV)
// before running anything, and that file may be one the sandbox can edit. Removes them from `env` and returns
// the old values so they can be restored inside the sandbox.
export function scrubHostEnv(env = process.env) {
  const saved = {};
  for (const k of ["BASH_ENV", "ENV"]) { saved[k] = env[k]; delete env[k]; }
  return saved;
}

// The shell pi's bash tool starts on the host: pi runs `<shell> -c <command>`, and with the sandbox on that command
// is the bwrap line. bash runs ~/.bashrc even for -c when it thinks it was started over ssh (SSH_CLIENT set, or a
// socket on stdin, with SHLVL unset), and ~/.bashrc may source files that commands can write. This wrapper starts
// bash with --norc --noprofile instead; /bin/sh reads no start-up files when not interactive, and ENV is removed
// on the host (scrubHostEnv). Write it where sandboxed commands can't (ari's run dir).
export function writeHostShell(dir, bash) {
  const f = path.join(dir, "host-shell");
  fs.writeFileSync(f, `#!/bin/sh\nexec '${bash.replaceAll("'", `'\\''`)}' --norc --noprofile "$@"\n`, { mode: 0o700 });
  fs.chmodSync(f, 0o700);
  return f;
}

// NUL-separated git output (`-z`), so names git would quote (non-ASCII, quotes, newlines) come through as they are.
export const splitNul = (s) => (s ? s.split("\0").filter(Boolean) : []);
// Paths from `git status --porcelain -z`: "XY path" entries; a rename or copy is followed by its old path.
export function statusPaths(out) {
  const items = splitNul(out), paths = [];
  for (let i = 0; i < items.length; i++) { paths.push(items[i].slice(3)); if (/[RC]/.test(items[i].slice(0, 2))) i++; }
  return paths;
}

// An acceptance check's result: the full output (saved to a file) and the tail that goes back to the model.
export function checkResult(err, stdout = "", stderr = "") {
  const full = `${stdout}${stderr}`;
  return { ok: !err, full, tail: full.trim().split("\n").slice(-20).join("\n").slice(-3000) };
}

// The changed-file list: tracked changes from git exactly; files from the edit/write tools and untracked files
// without `junk` (caches, bytecode).
export const changedFiles = ({ tracked = [], edited = [], untracked = [], junk }) =>
  [...new Set([...tracked, ...[...edited, ...untracked].filter((f) => !junk.test(f))])];

// Harness warnings, shared by the text footer and --json.
export function runWarnings({ usedPercent, stopAt, redirects = [], sandboxError }) {
  return [
    sandboxError && `at the end of the run the sandbox could no longer be set up (${sandboxError}); something in the workspace changed. Inspect it before running git here.`,
    usedPercent >= stopAt && "Codex weekly usage is nearly exhausted. Tell the user so they can use a reset ticket.",
    redirects.length > 0 && `this run created or changed ${redirects.join(", ")}; git may now take its config or repository from elsewhere. Inspect before running git here.`,
  ].filter(Boolean);
}
// The --json result.
export const resultJson = ({ status, report, changed, check, run, log, secs, tokens, agents, codex, warnings }) =>
  JSON.stringify({ status, report, changed, check, run, log, secs, tokens, agents, codex, warnings }, null, 1);

// The report's verdict. A failed acceptance check turns DONE into PARTIAL.
export function verdictOf(report, checkOk) {
  const v = report.match(/^(DONE|PARTIAL|BLOCKED|FAILED):/)?.[1] ?? "UNKNOWN";
  return v === "DONE" && checkOk === false ? "PARTIAL" : v;
}
export const EXIT_CODES = { DONE: 0, PARTIAL: 2, BLOCKED: 3 };

// The weekly window of a Codex usage response: the longest window when their lengths are known,
// otherwise the primary one.
export function weeklyWindow(rateLimit) {
  const ws = [rateLimit?.primary_window, rateLimit?.secondary_window].filter(Boolean);
  const sized = ws.filter((w) => Number.isFinite(w.limit_window_seconds));
  return sized.length ? sized.reduce((a, b) => (b.limit_window_seconds > a.limit_window_seconds ? b : a)) : (ws[0] ?? null);
}

export function intOption(value, name, min, max) {
  const s = String(value ?? "").trim(), n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max} (got "${value}")`);
  return n;
}

export function enumOption(value, name, allowed) {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${value}")`);
  return value;
}

const textOf = (m) => (m?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
// One prompt to completion on an agent's pi session; returns the final assistant text. A request cut off as
// stalled (agent.stalled) is continued, up to maxStalls times per agent. Nothing is sent to the model once
// agent.deadline (ms since the epoch) has passed: the turn ends as interrupted instead.
export async function promptTurn(agent, text, maxStalls, now = Date.now) {
  for (let msg = text; ;) {
    if (agent.deadline != null && now() >= agent.deadline) return "PARTIAL: interrupted. The task's time limit had passed, so the model was not resumed.";
    await agent.session.prompt(msg);
    const last = agent.session.messages.findLast((m) => m.role === "assistant");
    if (last?.stopReason === "aborted" && agent.stalled) {
      agent.stalled = false;
      if (++agent.stalls > maxStalls) throw new Error("the model connection kept stalling");
      msg = "(Your last request stalled and was cut off by the harness. Nothing on disk was lost. Continue.)";
      continue;
    }
    if (last?.stopReason === "aborted") return `PARTIAL: interrupted. ${textOf(last)}`.trim();
    if (last?.stopReason === "error") throw new Error(last.errorMessage || "model error");
    return textOf(last);
  }
}
