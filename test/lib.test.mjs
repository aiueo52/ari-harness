// Unit tests for lib.mjs. CPU only: the loader test reads files in a temp dir and makes no model calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import {
  EXIT_CODES, SAFE_GIT, changedFiles, changedUntracked, checkResult, contextAllow, splitNul, statusPaths, writeHostShell, contextFiles, enumOption, fileSig, intOption, loaderOptions, resultJson, runWarnings,
  promptTurn, scrubHostEnv, verdictOf, weeklyWindow,
} from "../lib.mjs";

test("a failed check turns DONE into PARTIAL with a non-zero exit code", () => {
  assert.equal(verdictOf("DONE: ok", true), "DONE");
  assert.equal(verdictOf("DONE: ok", undefined), "DONE");
  assert.equal(verdictOf("DONE: ok", false), "PARTIAL");
  assert.equal(verdictOf("BLOCKED: need a human", false), "BLOCKED");
  assert.equal(verdictOf("FAILED: broke", false), "FAILED");
  assert.equal(verdictOf("PARTIAL: half", false), "PARTIAL");
  assert.equal(verdictOf("all good", true), "UNKNOWN");
  assert.equal(EXIT_CODES[verdictOf("DONE: ok", false)], 2);
});

test("the weekly window is the longest one", () => {
  const five = { used_percent: 80, limit_window_seconds: 18_000 }, week = { used_percent: 30, limit_window_seconds: 604_800 };
  assert.equal(weeklyWindow({ primary_window: five, secondary_window: week }), week);
  assert.equal(weeklyWindow({ primary_window: week, secondary_window: five }), week);
  assert.equal(weeklyWindow({ primary_window: { used_percent: 5 } }).used_percent, 5);
  assert.equal(weeklyWindow(undefined), null);
});

test("--max, --depth and --sandbox are validated", () => {
  assert.equal(intOption("12", "--max", 1, 100), 12);
  assert.equal(intOption("0", "--depth", 0, 10), 0);
  for (const bad of ["0", "-1", "abc", "1.5", "", undefined, "101", "9".repeat(400), "99999999999999999999"])
    assert.throws(() => intOption(bad, "--max", 1, 100), /--max/, String(bad));
  assert.equal(enumOption("off", "--sandbox", ["workspace", "off"]), "off");
  for (const bad of ["of", "none", "", undefined]) assert.throws(() => enumOption(bad, "--sandbox", ["workspace", "off"]), /--sandbox/);
});

test("the host shell never sources BASH_ENV or ENV", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-env-")));
  try {
    const marker = path.join(root, "SOURCED"), rc = path.join(root, "rc");
    fs.writeFileSync(rc, `touch ${marker}\n`);
    // A minimal explicit environment and stdin from /dev/null, so the result doesn't depend on what the test runner
    // inherited: with a socket on stdin and SHLVL unset or 0, bash takes itself for an ssh/rsh session and skips BASH_ENV.
    const env = { PATH: process.env.PATH, HOME: root, BASH_ENV: rc, ENV: rc };
    const stdio = ["ignore", "pipe", "pipe"];
    const saved = scrubHostEnv(env);
    assert.deepEqual(saved, { BASH_ENV: rc, ENV: rc });
    execFileSync("/bin/bash", ["-c", "true"], { env, stdio });
    assert.equal(fs.existsSync(marker), false);
    execFileSync("/bin/bash", ["-c", "true"], { env: { ...env, ...saved }, stdio }); // control
    assert.equal(fs.existsSync(marker), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("regression: the host-side shell of pi's bash tool doesn't run ~/.bashrc, even under ssh", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-shell-")));
  try {
    fs.writeFileSync(path.join(root, ".bashrc"), "echo RC-RAN\n");
    // SSH_CLIENT set and SHLVL unset: bash takes itself for an ssh session and reads ~/.bashrc even for -c.
    const env = { PATH: process.env.PATH, HOME: root, SSH_CLIENT: "192.0.2.1 50000 22" };
    const runWith = async (shellPath) => {
      let out = "";
      await createLocalBashOperations({ shellPath }).exec("echo ok", root, { onData: (d) => { out += d; }, env });
      return out.trim();
    };
    const shell = writeHostShell(root, "/bin/bash");
    assert.equal(fs.statSync(shell).mode & 0o777, 0o700);
    assert.equal(await runWith(shell), "ok");
    assert.match(await runWith("/bin/bash"), /RC-RAN/); // control: pi's default shell does run it
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ari hands pi the host-shell wrapper and checks run bash without start-up files", () => {
  const src = fs.readFileSync(new URL("../ari.mjs", import.meta.url), "utf8");
  assert.match(src, /SettingsManager\.inMemory\(\{[^)]*shellPath: run\.shell/);
  assert.match(src, /run\.shell = writeHostShell\(run\.dir, run\.bash\)/);
  assert.match(src, /gitProtect: run\.gitDirs,/); // external git dirs protected for agents too
  assert.match(src, /try \{ return toolCall\(e\); \} catch/); // a sandbox that can't be set up blocks the call
  assert.match(src, /gitRedirects\(run\.redirectDirs, cwd, plan0\.submoduleGitFiles\)/); // nested .git files fingerprinted
  assert.match(src, /\[run\.bash \?\? "bash", \["--norc", "--noprofile", "-c", cmd\]\]/);
});

test("regression: no model turn starts after a task's deadline, also on a retry after a slow check", async () => {
  // A fake pi session and clock: each prompt takes `step` ms and answers (or is cut off as stalled).
  let clock = 0, sent = [];
  const reply = (stopReason, text = "ok") => ({ role: "assistant", stopReason, content: [{ type: "text", text }] });
  const agent = { stalls: 0, stalled: false, deadline: 100, session: { messages: [], async prompt(m) { sent.push(m); clock += 30; this.messages.push(reply("stop", `done ${sent.length}`)); } } };
  const now = () => clock;
  assert.equal(await promptTurn(agent, "task", 3, now), "done 1");
  clock += 200; // the check command ran past the deadline; the retry must not reach the model
  assert.match(await promptTurn(agent, "check failed, fix it", 3, now), /^PARTIAL: interrupted\. The task's time limit had passed/);
  assert.deepEqual(sent, ["task"]);
  // A stalled request isn't continued after the deadline either.
  clock = 0; sent = [];
  agent.session.prompt = async function (m) { sent.push(m); clock += 150; agent.stalled = true; this.messages.push(reply("aborted", "")); };
  assert.match(await promptTurn(agent, "task", 3, now), /^PARTIAL: interrupted\. The task's time limit had passed/);
  assert.equal(sent.length, 1);
  // Without a deadline (the root), stalls are continued up to the limit.
  agent.deadline = null; agent.stalls = 0; sent = [];
  await assert.rejects(promptTurn(agent, "task", 3, now), /kept stalling/);
  assert.equal(sent.length, 4);
  // ari sets the deadline for every sub-agent task and sends every turn through promptTurn.
  const src = fs.readFileSync(new URL("../ari.mjs", import.meta.url), "utf8");
  assert.match(src, /agent\.deadline = Date\.now\(\) \+ LIMIT\.childMs;\n  const timer = setTimeout\(\(\) => agent\.session\?\.abort\(\), LIMIT\.childMs\);/);
  assert.match(src, /return promptTurn\(this, text, LIMIT\.stalls\);/);
  assert.match(src, /if \(!out\.startsWith\("PARTIAL: interrupted"\)\) chk = await runCheck\(agent\.check\);/); // no second check after it
  assert.doesNotMatch(src, /session\.prompt\(/);
});

test("regression: git file lists are read NUL-separated, so non-ASCII and quoted names are exact", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-z-")));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...a) => execFileSync("git", a, { cwd: root, env, encoding: "utf8" });
    git("init", "-q");
    const names = ["日本語.txt", 'q"uote.txt', "tab\tname.txt", "plain.txt"];
    for (const n of names) fs.writeFileSync(path.join(root, n), "1\n");
    assert.match(git("ls-files", "--others", "--exclude-standard"), /"\\346/); // without -z git quotes the name
    const sig = (f) => fileSig(path.join(root, f));
    const before = new Map(splitNul(git("ls-files", "--others", "--exclude-standard", "-z")).map((f) => [f, sig(f)]));
    assert.deepEqual([...before.keys()].sort(), [...names].sort());
    for (const [f, s] of before) assert.ok(s, f);
    fs.appendFileSync(path.join(root, "日本語.txt"), "more\n");
    assert.deepEqual(changedUntracked(before, splitNul(git("ls-files", "--others", "--exclude-standard", "-z")), sig), ["日本語.txt"]);
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "c");
    git("mv", "日本語.txt", "名前.txt");
    fs.writeFileSync(path.join(root, 'q"uote.txt'), "2\n");
    assert.deepEqual(statusPaths(git("status", "--porcelain", "-z", "-uall")).sort(), ['q"uote.txt', "名前.txt"].sort());
    const src = fs.readFileSync(new URL("../ari.mjs", import.meta.url), "utf8");
    for (const call of src.match(/git\(\["(ls-files|diff|status)"[^\]]*\]/g)) assert.match(call, /"-z"/, call);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("check results keep the full output; the tail is for messages", () => {
  const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const r = checkResult(null, long, "\nwarning at the end\n");
  assert.equal(r.ok, true);
  assert.equal(r.full, `${long}\nwarning at the end\n`);
  assert.equal(r.tail.split("\n").length, 20);
  assert.match(r.tail, /warning at the end$/);
  assert.equal(checkResult(new Error("exit 1"), "", "boom").ok, false);
});

test("tracked changes are listed even when their names look like junk", () => {
  const junk = /(^|\/)(node_modules|__pycache__|\.cache)(\/|$)|\.pyc$/;
  assert.deepEqual(changedFiles({ tracked: ["src/a.js", "vendor/node_modules/x.js", "tool.pyc"], edited: ["src/a.js", "b/__pycache__/m.pyc", "c.md"],
    untracked: ["node_modules/y/index.js", "new.txt"], junk }), ["src/a.js", "vendor/node_modules/x.js", "tool.pyc", "c.md", "new.txt"]);
});

test("--depth above 1 is refused before anything runs: sub-agents can't start sub-agents", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-depth-")));
  try {
    const env = { PATH: process.env.PATH, HOME: root, XDG_STATE_HOME: path.join(root, "state") }; // nothing real is touched
    const ari = fileURLToPath(new URL("../ari.mjs", import.meta.url));
    for (const d of ["2", "10"]) {
      let out = "", code = 0;
      try { out = execFileSync(process.execPath, [ari, "--depth", d, "-C", root, "a task"], { env, encoding: "utf8", timeout: 20_000 }); }
      catch (e) { out = e.stdout; code = e.status; }
      assert.equal(code, 1, d);
      assert.match(out, /^FAILED: --depth must be 0 \(no sub-agents\) or 1/, d);
    }
    assert.deepEqual(fs.readdirSync(root), [], "no state or run dir was created");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The real start-up path (ari --sandbox-check) on real git layouts, under a fake home the test creates. That home
// can't live under /tmp, which ari makes writable (a writable place may not contain the home directory), so it
// goes under ARI_TEST_HOME_BASE if set, else the first of the OS temp dir, /var/tmp and the home directory that
// is writable and not under /tmp.
const bwrapThere = fs.existsSync("/usr/bin/bwrap") || process.env.PATH.split(":").some((d) => fs.existsSync(path.join(d, "bwrap")));
const homeBase = (process.env.ARI_TEST_HOME_BASE ? [process.env.ARI_TEST_HOME_BASE] : [os.tmpdir(), "/var/tmp", os.homedir()])
  .map((b) => { try { fs.accessSync(b, fs.constants.W_OK); return fs.realpathSync(b); } catch { return null; } })
  .find((b) => b && !["/tmp", "/run", "/proc", "/dev", "/sys"].some((m) => b === m || b.startsWith(`${m}/`)));
test("start-up accepts a linked worktree and a subdirectory, and refuses git location variables",
  { skip: !bwrapThere ? "needs bwrap" : !homeBase && "needs a writable base outside /tmp and /run for a fake home (set ARI_TEST_HOME_BASE)" }, (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(homeBase, "ari-home-")));
  try {
    const env = { PATH: process.env.PATH, HOME: home };
    const git = (cwd, ...a) => execFileSync("git", a, { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] }).toString();
    const repo = path.join(home, "src/repo"), wt = path.join(home, "src/repo-wt"), plain = path.join(home, "src/plain");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(plain);
    git(repo, "init", "-q");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
    git(repo, "worktree", "add", "-q", "--detach", wt);
    fs.mkdirSync(path.join(repo, "sub"));
    const ari = fileURLToPath(new URL("../ari.mjs", import.meta.url));
    const start = (dir, extra = {}) => {
      try { return { code: 0, out: execFileSync(process.execPath, [ari, "--sandbox-check", "-C", dir], { env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 }) }; }
      catch (e) { return { code: e.status, out: e.stdout }; }
    };
    // If even a plain directory under this fake home can't be sandboxed, the environment can't host this test
    // (the base lies in a git repository or a secret, bwrap can't nest here, ...): say why and skip.
    const pre = start(plain);
    if (pre.code !== 0) return t.skip(`ari --sandbox-check refuses a plain directory under the fake home ${home}, so this environment can't run the test (set ARI_TEST_HOME_BASE to a writable place outside /tmp, /run, git repositories and secrets): ${String(pre.out ?? "").trim()}`);
    for (const dir of [repo, wt, path.join(repo, "sub")]) assert.deepEqual(start(dir).code, 0, `${dir}: ${start(dir).out}`);
    assert.match(start(wt).out, new RegExp(`git dirs outside it: .*${path.join(repo, ".git")}`));
    const bad = start(wt, { GIT_DIR: path.join(repo, ".git") });
    assert.equal(bad.code, 1);
    assert.match(bad.out, /^FAILED: GIT_DIR is set/);
    assert.equal(fs.existsSync(path.join(home, ".local/state/ari/runs")), false, "a check creates no run");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the diagnostic probes use the same loader options", () => {
  for (const f of ["concurrency-probe.mjs", "event-probe.mjs"]) {
    const src = fs.readFileSync(new URL(`../tools/${f}`, import.meta.url), "utf8");
    assert.match(src, /new DefaultResourceLoader\(loaderOptions\(/, f);
  }
});

test("the resource loader ignores the workspace's pi settings and filters context files", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-lib-")));
  try {
    const ws = path.join(root, "ws"), agentDir = path.join(root, "agent"), marker = path.join(root, "MARKER");
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(ws, ".pi/settings.json"), JSON.stringify({ packages: ["npm:ari-probe@1.0.0"], npmCommand: ["bash", "-c", `touch ${marker}`] }));
    fs.writeFileSync(path.join(ws, ".pi/APPEND_SYSTEM.md"), "appended");
    execFileSync("mkfifo", [path.join(ws, ".pi/SYSTEM.md"), path.join(agentDir, "SYSTEM.md")]); // reading either would hang
    fs.writeFileSync(path.join(root, "secret.txt"), "SECRET");
    fs.symlinkSync(path.join(root, "secret.txt"), path.join(ws, "AGENTS.md"));
    fs.writeFileSync(path.join(root, "AGENTS.md"), "parent rules");
    const load = async (opts) => { const l = new DefaultResourceLoader(loaderOptions({ cwd: ws, agentDir, prompt: "P", ...opts })); await l.reload(); return l; };
    const skipped = [], asked = [];
    const l = await load({ context: true, allowFile: (f) => (asked.push(f), fs.realpathSync(f) !== path.join(root, "secret.txt")), onSkip: (f) => skipped.push(f) });
    assert.equal(fs.existsSync(marker), false, "workspace npmCommand must not run");
    assert.deepEqual(l.getAppendSystemPrompt(), []);
    assert.equal(l.getSystemPrompt(), "P");
    assert.deepEqual(l.getAgentsFiles().agentsFiles.map((f) => f.content), ["parent rules"]);
    assert.deepEqual(skipped, [path.join(ws, "AGENTS.md")]);
    assert.deepEqual(asked, [path.join(root, "AGENTS.md"), path.join(ws, "AGENTS.md")]);
    assert.deepEqual((await load({ context: false })).getAgentsFiles().agentsFiles, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ari's git calls don't run the repository's fsmonitor or hooks", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-git-")));
  try {
    const marker = path.join(root, "MARKER"), script = path.join(root, "fsmonitor.sh");
    fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const git = (...a) => execFileSync("git", a, { cwd: root, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString();
    git("init", "-q");
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    git("add", "a.txt");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
    git("config", "core.fsmonitor", script);
    fs.writeFileSync(path.join(root, "a.txt"), "b");
    git(...SAFE_GIT, "status", "--porcelain");
    git(...SAFE_GIT, "stash", "create");
    git(...SAFE_GIT, "diff", "--name-only", "HEAD");
    assert.equal(fs.existsSync(marker), false);
    git("status", "--porcelain"); // control: plain git does run it
    assert.equal(fs.existsSync(marker), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context files are checked before they are read, and only regular files are read", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-ctx-")));
  try {
    const ws = path.join(root, "ws"), agentDir = path.join(root, "agent");
    fs.mkdirSync(ws); fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(root, "secret.txt"), "SECRET");
    fs.chmodSync(path.join(root, "secret.txt"), 0o000); // reading it would throw
    fs.symlinkSync(path.join(root, "secret.txt"), path.join(ws, "CLAUDE.md"));
    execFileSync("mkfifo", [path.join(agentDir, "AGENTS.md")]);
    fs.writeFileSync(path.join(agentDir, "CLAUDE.md"), "global");
    const files = contextFiles({ cwd: ws, agentDir, allowFile: (f) => !f.startsWith(ws) });
    assert.deepEqual(files.map((f) => f.content), ["global"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the global AGENTS.md in ari's own pi dir is allowed; links out of it are not", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-allow-")));
  try {
    const agentDir = path.join(root, "state/pi");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "global");
    fs.writeFileSync(path.join(root, "secret"), "S");
    fs.symlinkSync(path.join(root, "secret"), path.join(agentDir, "CLAUDE.md"));
    const allow = contextAllow({ agentDir, isBlocked: (f) => f.startsWith(root) }); // everything under root counts as secret
    assert.equal(allow(path.join(agentDir, "AGENTS.md")), true);
    assert.equal(allow(path.join(agentDir, "CLAUDE.md")), false);
    assert.equal(allow(path.join(root, "secret")), false);
    assert.equal(allow("/elsewhere/AGENTS.md"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("edits to files git doesn't track are noticed", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-untracked-")));
  try {
    const f = (n) => path.join(root, n);
    fs.writeFileSync(f("old.txt"), "a"); fs.writeFileSync(f("same.txt"), "s"); fs.writeFileSync(f("legacy.txt"), "l");
    const before = new Map([["old.txt", fileSig(f("old.txt"))], ["same.txt", fileSig(f("same.txt"))], ["legacy.txt", null]]);
    fs.writeFileSync(f("old.txt"), "changed");
    fs.writeFileSync(f("legacy.txt"), "changed too");
    fs.writeFileSync(f("new.txt"), "n");
    assert.deepEqual(changedUntracked(before, ["old.txt", "same.txt", "legacy.txt", "new.txt"], (n) => fileSig(f(n))), ["old.txt", "new.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("warnings reach the text footer and --json alike", () => {
  const warnings = runWarnings({ usedPercent: 99, stopAt: 99, redirects: ["/r/.git/commondir"] });
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /\/r\/\.git\/commondir/);
  assert.deepEqual(runWarnings({ usedPercent: 10, stopAt: 99, redirects: [] }), []);
  assert.deepEqual(JSON.parse(resultJson({ status: "DONE", warnings })).warnings, warnings);
});

test("an unknown option or a missing value fails like other option errors: message, usage, exit code 1", () => {
  const ari = fileURLToPath(new URL("../ari.mjs", import.meta.url));
  for (const args of [["--version"], ["--sandbox-chek"], ["-C"]]) {
    let r;
    try { execFileSync(process.execPath, [ari, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { r = e; }
    assert.equal(r?.status, 1, args.join(" "));
    assert.match(r.stdout, /^FAILED: (Unknown option|Option '-C, --cd <value>' argument missing)/, args.join(" "));
    assert.match(r.stdout, /\nusage: ari \[options\]/);
    assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
  }
});

const readme = new URL("../README.md", import.meta.url);
test("the README's usage block is exactly ari --help", { skip: !fs.existsSync(readme) && "no README.md in this copy" }, () => {
  const help = execFileSync(process.execPath, [fileURLToPath(new URL("../ari.mjs", import.meta.url)), "--help"], { encoding: "utf8" });
  const block = fs.readFileSync(readme, "utf8").match(/## Usage\n\n```text\n([\s\S]*?)```/)?.[1];
  assert.equal(block, help);
  assert.match(help, /^  -h, --help +show this help$/m);
});

test("ari starts from an install path with spaces and non-ASCII characters", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-path-")));
  try {
    const dir = path.join(root, "my tools", "エージェント");
    fs.mkdirSync(dir, { recursive: true });
    const src = new URL("..", import.meta.url);
    for (const f of ["ari.mjs", "lib.mjs", "sandbox.mjs"]) fs.copyFileSync(new URL(f, src), path.join(dir, f));
    fs.cpSync(new URL("prompts", src), path.join(dir, "prompts"), { recursive: true });
    fs.symlinkSync(fileURLToPath(new URL("node_modules", src)), path.join(dir, "node_modules"));
    const out = execFileSync(process.execPath, [path.join(dir, "ari.mjs"), "--help"], { encoding: "utf8" });
    assert.match(out, /^usage: ari/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
