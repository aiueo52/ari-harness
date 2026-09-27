// Unit tests for sandbox.mjs. CPU only: no model calls, no network. Run with `npm test`.
// The "bubblewrap" suite runs real bwrap commands and is skipped when bwrap is not installed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { SAFE_GIT } from "../lib.mjs";
import {
  SYSTEM_MOUNTS, bwrapArgs, changedRedirects, findExecutable, findGitEntries, gitRedirects, lexicalPath, parseGitConfig, prepareCargo, readBlockReason, readTargets, realPath, resolvePath, sandboxPlan,
  writeBlockReason,
} from "../sandbox.mjs";

let root, home, ws, out, state, runTmp, plan;
const w = (rel) => path.join(ws, rel);
const h = (rel) => path.join(home, rel);
const tp = (p, cwd = ws) => ({ lexical: lexicalPath(p, cwd, home), real: realPath(p, cwd, home) });
const mkPlan = (extra = {}) => sandboxPlan({
  cwd: path.join(root, "ws-link"), home,
  writable: [".cache", ".cargo/registry", ".cargo/git"],
  secrets: [".ssh", ".netrc", ".config/openrouter", ".config/gcloud", ".cache/huggingface/token", ".cache/later-secret", ".missing", state],
  readable: [runTmp], restoreEnv: { TMPDIR: "/tmp", BASH_ENV: "/etc/hostname", ENV: undefined },
  env: { XDG_RUNTIME_DIR: h("run") }, uid: null, ...extra,
});
const writeCheck = (p) => writeBlockReason(tp(p), plan);
const readCheck = (p) => readBlockReason(tp(p), plan);
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const hostGit = (cwd, ...a) => execFileSync("git", a, { cwd, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).toString();

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ari-test-")));
  home = path.join(root, "home");
  ws = path.join(home, "src", "app");
  out = path.join(root, "outside");
  state = path.join(root, "state");
  runTmp = path.join(state, "runs/r1/tmp");
  for (const d of [ws, out, runTmp, h(".config/someengine"), h(".local/bin"), h(".ssh"), h(".config/openrouter"), h(".cache/huggingface/hub"),
    h(".cargo/bin"), h(".cargo/registry"), h("run"), w(".git/hooks"), w(".git/modules/sub/hooks")])
    fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(h(".bashrc"), "# rc\n");
  fs.writeFileSync(h(".ssh/id_ed25519"), "PRIVATE\n");
  fs.writeFileSync(h(".config/openrouter/api_key"), "KEY\n");
  fs.writeFileSync(h(".cache/huggingface/token"), "HF\n");
  fs.writeFileSync(h(".netrc"), "machine x\n");
  fs.writeFileSync(h("run/marker"), "session\n");
  fs.writeFileSync(path.join(state, "old-run.log"), "old secret output\n");
  fs.writeFileSync(path.join(runTmp, "pi-bash-1.log"), "this run's output\n");
  fs.writeFileSync(w("main.js"), "1\n");
  fs.writeFileSync(w(".git/config"), "[core]\n");
  fs.writeFileSync(w(".git/HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(w(".git/modules/sub/HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(w(".git/modules/sub/config"), "[core]\n");
  fs.symlinkSync(h(".bashrc"), w("rc-link"));
  fs.symlinkSync(out, w("out-link"));
  fs.symlinkSync(h(".config/autostart/evil.desktop"), w("dangling-link"));
  fs.symlinkSync(h(".ssh/id_ed25519"), w("key-link"));
  fs.symlinkSync(ws, path.join(root, "ws-link"));
  plan = mkPlan();
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe("paths", () => {
  test("expand ~, @ and file:// like pi", () => {
    assert.equal(realPath("~/.bashrc", ws, home), h(".bashrc"));
    assert.equal(realPath("@~/.bashrc", ws, home), h(".bashrc"));
    assert.equal(realPath("@main.js", ws, home), w("main.js"));
    assert.equal(realPath(pathToFileURL(h(".bashrc")).href, ws, home), h(".bashrc"));
    assert.equal(realPath("../../.bashrc", ws, home), h(".bashrc"));
  });
  test("follow symlinks, including through missing children; a dangling link doesn't resolve", () => {
    assert.equal(realPath("rc-link", ws, home), h(".bashrc"));
    assert.equal(lexicalPath("rc-link", ws, home), w("rc-link"));
    assert.equal(realPath("out-link/new/file.txt", ws, home), path.join(out, "new/file.txt"));
    assert.equal(realPath("dangling-link", ws, home), null);
    assert.equal(realPath("dangling-link/x", ws, home), null);
    // Below the part that exists, only plain names: "." or ".." there is refused, not taken lexically.
    assert.equal(resolvePath(`${ws}/missing/new.txt`), w("missing/new.txt"));
    assert.equal(resolvePath(`${ws}/missing/../main.js`), null);
    assert.equal(resolvePath(`${ws}/missing/./x`), null);
    assert.equal(resolvePath(`${ws}/./main.js`), w("main.js"));
  });
  test("regression: \"link/..\" inside a link's target is resolved like the kernel, for existing and missing paths", () => {
    // hop -> ~/.ssh/inner, so "hop/.." is ~/.ssh to the kernel (lexically it would be the workspace).
    fs.mkdirSync(h(".ssh/inner"), { recursive: true });
    fs.symlinkSync(h(".ssh/inner"), w("hop"));
    fs.symlinkSync("hop/../id_ed25519", w("via-hop"));       // an existing file
    fs.symlinkSync("hop/..", w("dir-via-hop"));              // an existing dir, then missing names below it
    fs.symlinkSync("hop/../not-yet", w("new-via-hop"));      // a missing file (dangling)
    try {
      assert.equal(realPath("via-hop", ws, home), h(".ssh/id_ed25519"));
      assert.equal(realPath("dir-via-hop/new/file.txt", ws, home), h(".ssh/new/file.txt"));
      assert.equal(realPath("new-via-hop", ws, home), null);
      assert.match(readCheck("via-hop"), /Secret/);
      assert.match(writeCheck("via-hop"), /Secret/);
      assert.match(readCheck("dir-via-hop/new/file.txt"), /Secret/);
      assert.match(writeCheck("dir-via-hop/new/file.txt"), /Secret/);
      assert.match(writeCheck("new-via-hop"), /can't be resolved/);
      assert.match(readCheck("new-via-hop"), /can't be resolved/);
      // "hop/.." typed in the tool's input is different: pi normalizes the input as text before it opens anything
      // (path.resolve), so it opens the workspace's main.js, and ari checks that same file.
      assert.equal(lexicalPath("hop/../main.js", ws, home), w("main.js"));
      assert.equal(realPath("hop/../main.js", ws, home), w("main.js"));
      assert.equal(readCheck("hop/../main.js"), null);
      assert.equal(writeCheck("hop/../main.js"), null);
      assert.equal(realPath("hop/../id_ed25519", ws, home), w("id_ed25519")); // not ~/.ssh/id_ed25519: pi won't open that
      // The same rule for writable paths: ~/.wl -> tools/lk/.. is ~/.ssh, not ~/tools.
      fs.mkdirSync(h("tools"), { recursive: true });
      fs.symlinkSync(h(".ssh/inner"), h("tools/lk"));
      fs.symlinkSync("tools/lk/..", h(".wl"));
      assert.throws(() => mkPlan({ extraWritable: [".wl"] }), /refusing to make .*\.ssh writable: it overlaps the secret/);
    } finally {
      for (const f of ["hop", "via-hop", "dir-via-hop", "new-via-hop"]) fs.rmSync(w(f));
      fs.rmSync(h(".wl")); fs.rmSync(h("tools"), { recursive: true }); fs.rmSync(h(".ssh/inner"), { recursive: true });
    }
  });
  test("regression: deep missing paths resolve fully; unresolvable ones are refused, not treated as lexical", () => {
    // Far more missing components than the symlink limit, below a link that leads out of the workspace.
    const deep = Array.from({ length: 60 }, (_, i) => `d${i}`).join("/");
    assert.equal(realPath(`out-link/${deep}/f.txt`, ws, home), path.join(out, deep, "f.txt"));
    assert.match(writeCheck(`out-link/${deep}/f.txt`), /Outside the workspace/);
    // A chain of links: 40 are followed, 41 are not (like the kernel), and a loop never resolves.
    const chain = (n, name) => {
      fs.writeFileSync(w(`${name}-target`), "");
      for (let i = 0; i < n; i++) fs.symlinkSync(i + 1 < n ? `${name}${i + 1}` : `${name}-target`, w(`${name}${i}`));
    };
    chain(40, "ok");
    chain(41, "far");
    assert.equal(realPath("ok0", ws, home), w("ok-target"));
    assert.equal(realPath("far0", ws, home), null);
    fs.symlinkSync("loop-b", w("loop-a"));
    fs.symlinkSync("loop-a", w("loop-b"));
    for (const p of ["far0", "loop-a/x.txt", "loop-a"]) {
      assert.equal(realPath(p, ws, home), null, p);
      assert.match(writeCheck(p), /can't be resolved/, p);
      assert.match(readCheck(p), /can't be resolved/, p);
    }
    fs.symlinkSync(w("loop-a"), h(".loop-cache"));
    assert.throws(() => mkPlan({ extraWritable: [".loop-cache"] }), /can't be resolved/);
    fs.rmSync(h(".loop-cache"));
  });
  test("findExecutable ignores relative PATH entries", () => {
    fs.mkdirSync(w("fakebin"), { recursive: true });
    fs.writeFileSync(w("fakebin/bwrap"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(findExecutable("bwrap", `fakebin:${out}`), null);
    assert.equal(findExecutable("bwrap", w("fakebin")), w("fakebin/bwrap"));
  });
});

describe("sandboxPlan", () => {
  test("uses the workspace's real path and keeps cargo narrow", () => {
    assert.equal(plan.cwd, ws);
    assert.deepEqual(plan.writable, [h(".cache"), h(".cargo/registry")]);
  });
  test("hides ari's state dir but shows this run's temp dir", () => {
    assert.ok(plan.hidden.includes(state));
    assert.deepEqual(plan.readable, [runTmp]);
  });
  test("refuses unsafe workspaces", () => {
    const at = (cwd, why) => assert.throws(() => sandboxPlan({ cwd, home, secrets: [".ssh", state], env: { XDG_RUNTIME_DIR: h("run") }, uid: null }), why, cwd);
    at(home, /contains your home/);
    at(root, /contains your home/);
    at(h(".ssh"), /inside the secret/);
    at(state, /inside the secret/);
    at(h("run"), /session sockets/);
    at(h(".local/bin"), /runs outside/);
  });
  test("regression: refuses a workspace or writable path on, over or inside /proc, /dev, /sys or /run", () => {
    const shm = fs.realpathSync(fs.mkdtempSync("/dev/shm/ari-test-"));
    try {
      const mk = (extra) => () => sandboxPlan({ cwd: ws, home, secrets: [], env: {}, uid: null, ...extra });
      for (const cwd of [shm, "/proc/self", "/sys/kernel", "/run", "/dev"].filter((p) => fs.existsSync(p)))
        assert.throws(mk({ cwd }), /refusing to sandbox the workspace .*which the sandbox mounts itself/, cwd);
      for (const x of ["/proc", "/proc/sys", "/dev", "/dev/shm", `${shm}/later`, "/sys", "/sys/fs", "/run", "/run/lock", "/run/user/12345/x", "/"])
        assert.throws(mk({ extraWritable: [x] }), /ARI_EXTRA_WRITABLE: .*overlaps \/(proc|dev|sys|run)/, x);
      assert.throws(mk({ gitWritable: [shm] }), /git dir .*overlaps \/dev/);
      const alt = path.join(root, "alt-sys");
      fs.mkdirSync(path.join(alt, "proj"), { recursive: true });
      for (const target of [shm, "/proc/self", "/run", "/sys"]) {
        fs.rmSync(path.join(alt, ".cache"), { force: true });
        fs.symlinkSync(target, path.join(alt, ".cache"));
        assert.throws(() => sandboxPlan({ cwd: path.join(alt, "proj"), home: alt, writable: [".cache"], secrets: [], env: {}, uid: null }),
          /\.cache writable: it resolves to .* overlaps \/(proc|dev|sys|run)/, target);
      }
    } finally {
      fs.rmSync(shm, { recursive: true, force: true });
    }
    // And the plan in use never binds anything writable over them.
    const a = bwrapArgs(plan, "true");
    for (let i = 0; i < a.length; i++)
      if (a[i] === "--bind") assert.ok(!SYSTEM_MOUNTS.some((m) => a[i + 2] === m || a[i + 2].startsWith(`${m}/`) || m.startsWith(`${a[i + 2]}/`)), a[i + 2]);
  });
  test("refuses default writable paths that lead somewhere unsafe", () => {
    const alt = path.join(root, "alt-home");
    fs.mkdirSync(path.join(alt, "proj"), { recursive: true });
    fs.mkdirSync(path.join(alt, ".config/autostart"), { recursive: true });
    fs.writeFileSync(path.join(alt, ".bashrc"), "# rc\n");
    const at = (target, why) => {
      fs.rmSync(path.join(alt, ".cache"), { force: true });
      fs.symlinkSync(target, path.join(alt, ".cache"));
      assert.throws(() => sandboxPlan({ cwd: path.join(alt, "proj"), home: alt, writable: [".cache"], secrets: [], env: {}, uid: null }), why, target);
    };
    at(alt, /\.cache writable: it resolves to .* contains your home/);
    at(path.join(alt, ".config/autostart"), /runs outside/);
    at(path.join(alt, ".bashrc"), /runs outside/);
    fs.rmSync(path.join(alt, ".cache"));
    fs.mkdirSync(path.join(alt, ".cache"));
    assert.deepEqual(sandboxPlan({ cwd: path.join(alt, "proj"), home: alt, writable: [".cache"], secrets: [], env: {}, uid: null }).writable, [path.join(alt, ".cache")]);
  });
  test("refuses unsafe ARI_EXTRA_WRITABLE entries, existing or not", () => {
    const tryW = (x) => () => sandboxPlan({ cwd: ws, home, extraWritable: [x], secrets: [".ssh", ".cache/huggingface/token"], env: { XDG_RUNTIME_DIR: h("run") }, uid: null });
    for (const [x, why] of [["/", /overlaps \/proc/], [home, /home directory/], [".cache", /secret/], [".ssh", /secret/], [".local/bin", /runs outside/],
      [".cargo", /runs outside/], [".config/fish/conf.d", /runs outside/], ["run", /session/]])
      assert.throws(tryW(x), why, x);
    assert.deepEqual(sandboxPlan({ cwd: ws, home, extraWritable: [".config/someengine"], secrets: [], env: {}, uid: null }).writable, [h(".config/someengine")]);
  });
  test("--allow-secret un-hides a secret, re-binds it read-only, and refuses broad paths", () => {
    const p1 = sandboxPlan({ cwd: ws, home, secrets: [".ssh", ".config/openrouter"], allow: [".config/openrouter"], env: {}, uid: null });
    assert.deepEqual([p1.hidden, p1.reveal], [[h(".ssh")], [h(".config/openrouter")]]);
    const p2 = sandboxPlan({ cwd: ws, home, secrets: [".ssh", ".config/openrouter"], allow: ["~/.config/openrouter/api_key"], env: {}, uid: null });
    assert.deepEqual([p2.hidden, p2.reveal], [[h(".ssh"), h(".config/openrouter")], [h(".config/openrouter/api_key")]]);
    assert.throws(() => sandboxPlan({ cwd: ws, home, secrets: [".ssh"], allow: ["~"], env: {}, uid: null }), /allow-secret/);
    assert.throws(() => sandboxPlan({ cwd: ws, home, writable: [".cache"], secrets: [".ssh"], allow: [".cache"], env: {}, uid: null }), /allow-secret/);
    // Only a listed secret or a path inside one.
    for (const a of ["~/.bashrc", ".config/someengine", ".netrc", "src/app"])
      assert.throws(() => sandboxPlan({ cwd: ws, home, secrets: [".ssh"], allow: [a], env: {}, uid: null }), /--allow-secret: .* isn't one of the hidden secrets or inside one/, a);
    assert.doesNotThrow(() => sandboxPlan({ cwd: ws, home, secrets: [".ssh"], allow: [".ssh/not-there-yet"], env: {}, uid: null }));
  });
});

describe("git config parsing", () => {
  const tricky = [
    "\uFEFF# comment", '[submodule "a b"]', '\tpath = "dir with ; semi"', "\tURL = x # c",
    '[submodule "q\\"uote"] path = libs/q\\"x ; trailing', '[Submodule "cr"]\r', "\tPATH=cr/path\r",
    '[submodule "cont"]', "\tpath = long\\", "  name  here   ", "[submodule.Old]", "\tpath = old/one",
    '[submodule "tab"]', "\tpath = a\\tb", "\tflag", "[core]", "\tworktree = ../../x", "",
  ].join("\n");
  test("reads .gitmodules the way git does", () => {
    const paths = parseGitConfig(tricky).filter(([k]) => k.endsWith(".path")).map(([, v]) => v);
    assert.deepEqual(paths, ["dir with ; semi", 'libs/q"x', "cr/path", "long  name  here", "old/one", "a\tb"]);
    assert.deepEqual(parseGitConfig('[s]\nk = "unterminated\nafter = 1\n'), []);
  });
  test("matches git config itself", { skip: !findExecutable("git") && "git not installed" }, () => {
    const f = path.join(root, "tricky.cfg");
    fs.writeFileSync(f, tricky);
    const git = execFileSync("git", ["config", "-f", f, "--null", "--list"], { encoding: "utf8" }).split("\0").filter(Boolean)
      .map((e) => (e.includes("\n") ? [e.slice(0, e.indexOf("\n")), e.slice(e.indexOf("\n") + 1)] : [e, null]));
    assert.deepEqual(parseGitConfig(tricky), git);
  });
});

describe("write guard", () => {
  test("allows the workspace and writable caches", () => {
    for (const p of ["main.js", "a/b/new.js", "@main.js", w("x.txt"), "~/.cache/tool/data", path.join(root, "ws-link", "y.txt"), ".gitignore"])
      assert.equal(writeCheck(p), null, p);
  });
  test("blocks ~/.bashrc however it is spelled, and symlinks out", () => {
    for (const p of ["~/.bashrc", "@~/.bashrc", pathToFileURL(h(".bashrc")).href, "../../.bashrc", "rc-link", "out-link/new.txt", "~/.cargo/bin/x"])
      assert.match(writeCheck(p), /Outside the workspace/, p);
    assert.match(writeCheck("dangling-link"), /can't be resolved/);
  });
  test("blocks secrets, even inside a writable dir or not created yet", () => {
    for (const p of ["~/.cache/huggingface/token", "~/.cache/later-secret", "key-link"]) assert.match(writeCheck(p), /Secret/, p);
  });
  test("blocks git config, hooks and redirection files, also in submodules", () => {
    for (const p of [".git", "sub/.git", ".git/config", ".git/hooks/pre-commit", ".git/commondir", ".git/config.worktree", ".git/modules/sub/config",
      ".git/modules/sub/hooks/post-checkout", "vendor/lib/.git/hooks/x"])
      assert.match(writeCheck(p), /Git config/, p);
  });
});

describe("read guard", () => {
  test("blocks secrets however they are spelled", () => {
    for (const p of ["~/.ssh/id_ed25519", "@~/.ssh/id_ed25519", pathToFileURL(h(".ssh/id_ed25519")).href, "../../.ssh/id_ed25519", "key-link", "~/.netrc"])
      assert.match(readCheck(p), /Secret/, p);
  });
  test("blocks /proc, /dev and session files", () => {
    for (const p of ["/proc/self/environ", `/proc/${process.pid}/environ`, "/proc/1/root/etc/passwd", "/dev/fd/0", "/dev/stdin"])
      assert.match(readCheck(p), /\/proc, \/dev/, p);
    assert.match(readCheck(h("run/marker")), /Session/);
  });
  test("blocks old run logs but allows this run's temp dir", () => {
    assert.match(readCheck(path.join(state, "old-run.log")), /Secret/);
    assert.equal(readCheck(path.join(runTmp, "pi-bash-1.log")), null);
  });
  test("keeps allowed secrets away from the read tool", () => {
    const p = sandboxPlan({ cwd: ws, home, secrets: [".config/openrouter"], allow: [".config/openrouter"], env: {}, uid: null });
    assert.match(readBlockReason(tp("~/.config/openrouter/api_key"), p), /Secret/);
  });
  test("a secret that becomes a symlink later is still blocked on the next call", () => {
    fs.mkdirSync(path.join(out, "gcloud-creds"), { recursive: true });
    fs.writeFileSync(path.join(out, "gcloud-creds/token"), "T\n");
    assert.equal(readCheck(path.join(out, "gcloud-creds/token")), null);
    fs.symlinkSync(path.join(out, "gcloud-creds"), h(".config/gcloud"));
    const fresh = mkPlan();
    for (const p of ["~/.config/gcloud/token", path.join(out, "gcloud-creds/token")]) assert.match(readBlockReason(tp(p), fresh), /Secret/, p);
    fs.rmSync(h(".config/gcloud"));
  });
  test("checks the look-alike names pi's read tool falls back to", () => {
    fs.symlinkSync(h(".netrc"), w("guide\u2019s.txt"));
    fs.symlinkSync(h(".ssh/id_ed25519"), w("Shot 10.00\u202FPM.png"));
    const readAll = (p) => readTargets(p, ws, home).map((t) => readBlockReason(t, plan)).find(Boolean) ?? null;
    assert.match(readAll("guide's.txt"), /Secret/);
    assert.match(readAll("Shot 10.00 PM.png"), /Secret/);
    assert.equal(readAll("main.js"), null);
    fs.rmSync(w("guide\u2019s.txt"));
    fs.rmSync(w("Shot 10.00\u202FPM.png"));
  });
  test("allows ordinary files", () => {
    assert.equal(readCheck("main.js"), null);
    assert.equal(readCheck("~/.bashrc"), null);
  });
});

const hasBwrap = !!findExecutable("bwrap");
describe("bubblewrap", { skip: !hasBwrap && "bwrap not installed" }, () => {
  const run = (p, cmd, opts = {}) => execFileSync(findExecutable("bwrap"), bwrapArgs(p, cmd),
    { env: { ...process.env, SSH_AUTH_SOCK: "/nonexistent", ...opts.env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const sh = (p, cmd) => run(p, cmd);
  test("writes land only in the workspace and writable dirs", () => {
    assert.equal(sh(plan, "echo ok > new.txt && cat new.txt"), "ok");
    assert.equal(sh(plan, `echo c > ${h(".cache/c")} && cat ${h(".cache/c")}`), "c");
    for (const t of [h(".bashrc"), h(".cargo/bin/evil"), path.join(out, "x"), w(".git/config"), w(".git/hooks/pre-commit"), w(".git/modules/sub/config")])
      assert.equal(sh(plan, `echo x >> ${t} 2>/dev/null && echo wrote || echo refused`), "refused", t);
  });
  test("secrets, the session dir and old runs are hidden; this run's temp dir is read-only", () => {
    assert.equal(sh(plan, `cat ${h(".netrc")} ${h(".cache/huggingface/token")} 2>/dev/null; find ${h(".ssh")} ${h("run")} -mindepth 1 | wc -l`), "0");
    assert.equal(sh(plan, `find ${state} -type f`), path.join(runTmp, "pi-bash-1.log"));
    assert.equal(sh(plan, `cat ${runTmp}/pi-bash-1.log; echo x >> ${runTmp}/pi-bash-1.log 2>/dev/null && echo wrote || echo refused`), "this run's output\nrefused");
    assert.equal(run(plan, 'echo "${SSH_AUTH_SOCK-unset} ${DBUS_SESSION_BUS_ADDRESS-unset} ${GPG_AGENT_INFO-unset}"',
      { env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent", GPG_AGENT_INFO: "/nonexistent" } }), "unset unset unset");
  });
  test("a secret's parent directories and .git can't be renamed away", () => {
    assert.equal(sh(plan, `mv ${h(".cache/huggingface")} ${h(".cache/hf2")} 2>/dev/null && echo moved || echo refused`), "refused");
    assert.equal(sh(plan, `mkdir -p ${h(".cache/huggingface/hub/x")} && echo hub-ok`), "hub-ok");
    assert.equal(sh(plan, "mv .git .git-old 2>/dev/null && echo moved || echo refused"), "refused");
  });
  test("variables are restored inside: the user's TMPDIR, BASH_ENV; ENV unset", () => {
    assert.equal(run(plan, 'echo "$TMPDIR|${BASH_ENV-}|${ENV-unset}"', { env: { TMPDIR: runTmp, ENV: "/x" } }), "/tmp|/etc/hostname|unset");
  });
  test("regression: commands don't run ~/.bashrc, even with a socket on stdin and SHLVL unset", () => {
    const rc = fs.readFileSync(h(".bashrc"));
    fs.writeFileSync(h(".bashrc"), "echo RC-RAN\n");
    try {
      const env = { PATH: process.env.PATH, HOME: home }; // no SHLVL; stdin is a socketpair from node
      const out = execFileSync(findExecutable("bwrap"), bwrapArgs(plan, "echo ran"), { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: "" });
      assert.equal(out.trim(), "ran");
      // control: plain bash in the same situation does run it
      assert.match(execFileSync("/bin/bash", ["-c", "true"], { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: "" }), /RC-RAN/);
    } finally {
      fs.writeFileSync(h(".bashrc"), rc);
    }
  });
  test("secrets created during a run are hidden from later commands", () => {
    fs.writeFileSync(h(".cache/later-secret"), "LATE\n");
    assert.equal(sh(mkPlan(), `cat ${h(".cache/later-secret")} 2>/dev/null; true`), "");
    fs.rmSync(h(".cache/later-secret"));
  });
  test("--allow-secret keeps a secret inside a writable dir read-only", () => {
    const p = sandboxPlan({ cwd: ws, home, writable: [".cache"], secrets: [".cache/huggingface/token"], allow: [".cache/huggingface/token"], env: {}, uid: null });
    assert.equal(sh(p, `cat ${h(".cache/huggingface/token")}; echo x >> ${h(".cache/huggingface/token")} 2>/dev/null && echo wrote || echo refused`), "HF\nrefused");
  });
  test("a secret that is a symlink to another secret is masked through its target", () => {
    fs.mkdirSync(h(".codex2"), { recursive: true });
    fs.symlinkSync(h(".netrc"), h(".codex2/auth.json"));
    const p = mkPlan({ secrets: [".netrc", ".codex2/auth.json"] });
    assert.equal(sh(p, `cat ${h(".codex2/auth.json")} 2>/dev/null; echo ran`), "ran");
    assert.match(readBlockReason(tp("~/.codex2/auth.json"), p), /Secret/);
  });
  test("/dev/shm is private to each command", () => {
    const name = `ari-test-${process.pid}`;
    assert.equal(sh(plan, `echo x > /dev/shm/${name} && cat /dev/shm/${name}`), "x");
    assert.equal(fs.existsSync(`/dev/shm/${name}`), false);
  });
  test("commands see only their own processes", () => assert.ok(Number(sh(plan, "ls /proc | grep -c '^[0-9]'")) < 10));

  describe("git", () => {
    let repo, marker, p;
    before(() => {
      repo = h("src/repo");
      marker = path.join(out, "FILTER-RAN");
      fs.mkdirSync(repo, { recursive: true });
      hostGit(repo, "init", "-q");
      fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
      hostGit(repo, "add", "a.txt");
      hostGit(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
      // A malicious clean filter, as if an earlier run or a cloned repo had set it up.
      hostGit(repo, "config", "filter.evil.clean", `sh -c 'touch ${marker}; cat'`);
      fs.writeFileSync(path.join(repo, ".gitattributes"), "*.txt filter=evil\n");
      fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
      p = sandboxPlan({ cwd: repo, home, secrets: [], env: {}, uid: null });
    });
    test("ari's git calls inside the sandbox can't run a filter outside it", () => {
      const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
      run(p, ["git", ...SAFE_GIT, "diff", "--no-ext-diff", "--no-textconv", "--name-only", "HEAD"], { env });
      run(p, ["git", ...SAFE_GIT, "stash", "create", "snap"], { env });
      assert.equal(fs.existsSync(marker), false);
      hostGit(repo, "diff", "--name-only", "HEAD"); // control: on the host the filter runs
      assert.equal(fs.existsSync(marker), true);
      fs.rmSync(marker);
    });
    test("agents can still commit inside the sandbox", () => {
      assert.equal(run(p, "git add a.txt && git -c user.name=t -c user.email=t@example.com commit -qm c && git log --oneline | wc -l", { env: { GIT_CONFIG_GLOBAL: "/dev/null" } }), "2");
    });
    test("in a subdirectory, only ari's own git calls may write the git dir outside the workspace", () => {
      fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
      fs.writeFileSync(path.join(repo, "a.txt"), "again\n");
      const snap = (gitWritable) => { try { return run(sandboxPlan({ cwd: path.join(repo, "sub"), home, secrets: [], gitWritable, env: {}, uid: null }), ["git", ...SAFE_GIT, "stash", "create"], { env: { GIT_CONFIG_GLOBAL: "/dev/null" } }); } catch { return "failed"; } };
      assert.equal(snap([]), "failed");
      assert.match(snap([path.join(repo, ".git")]), /^[0-9a-f]{40}$/);
      // Even for ari's own git calls, that git dir's config and hooks stay read-only.
      const own = sandboxPlan({ cwd: path.join(repo, "sub"), home, secrets: [], gitWritable: [path.join(repo, ".git")], env: {}, uid: null });
      for (const f of ["config", "hooks/pre-commit"])
        assert.equal(run(own, `echo x >> ${path.join(repo, ".git", f)} 2>/dev/null && echo wrote || echo refused`), "refused", f);
    });
    test("a linked worktree's .git file is read-only, and a new .git in the workspace is reported", () => {
      const wt = h("src/repo-wt");
      hostGit(repo, "worktree", "add", "-q", "--detach", wt);
      // As ari does: the worktree's git dir and the common dir (from git rev-parse) are passed as gitProtect.
      const pw = sandboxPlan({ cwd: wt, home, secrets: [], gitProtect: [path.join(repo, ".git/worktrees/repo-wt"), path.join(repo, ".git")], env: {}, uid: null });
      assert.equal(pw.gitFile, path.join(wt, ".git"));
      assert.equal(run(pw, "echo 'gitdir: /elsewhere' > .git 2>/dev/null && echo wrote || echo refused; mv .git g 2>/dev/null && echo moved || echo refused"), "refused\nrefused");
      const plain = h("src/plain");
      fs.mkdirSync(plain, { recursive: true });
      const pp = sandboxPlan({ cwd: plain, home, secrets: [], env: {}, uid: null });
      const before = gitRedirects(pp.gitDirs, plain);
      run(pp, "git init -q");
      assert.deepEqual(changedRedirects(before, gitRedirects(pp.gitDirs, plain)), [path.join(plain, ".git")]);
    });
    test("regression: the main repo's .git/worktrees/* redirect files stay read-only; new ones are reported", () => {
      p = sandboxPlan({ cwd: repo, home, secrets: [], env: {}, uid: null }); // plans are per command: see the new worktree
      const wtDir = path.join(repo, ".git/worktrees/repo-wt");
      assert.ok(fs.existsSync(path.join(wtDir, "gitdir")) && fs.existsSync(path.join(wtDir, "commondir")));
      for (const f of ["gitdir", "commondir"])
        assert.equal(run(p, `echo x >> .git/worktrees/repo-wt/${f} 2>/dev/null && echo wrote || echo refused`), "refused", f);
      assert.equal(run(p, "mv .git/worktrees/repo-wt .git/worktrees/moved 2>/dev/null && echo moved || echo refused"), "refused");
      for (const f of [".git/worktrees/repo-wt/gitdir", ".git/worktrees/repo-wt/commondir", ".git/worktrees/repo-wt/config.worktree"])
        assert.match(writeBlockReason(tp(f, repo), p), /Git config/, f);
      const before = gitRedirects(p.gitDirs, repo);
      run(p, "echo '[core]' > .git/worktrees/repo-wt/config.worktree");
      assert.deepEqual(changedRedirects(before, gitRedirects(p.gitDirs, repo)), [path.join(wtDir, "config.worktree")]);
      fs.rmSync(path.join(wtDir, "config.worktree"));
    });
    test("regression: an external git dir in a writable place keeps its config, hooks and redirect files read-only", () => {
      // A work tree whose git dir (not named .git) lies in ~/.cache, which commands may write.
      const sep = h("src/sep"), gd = h(".cache/sep-gitdir");
      fs.mkdirSync(sep, { recursive: true });
      execFileSync("git", ["init", "-q", `--separate-git-dir=${gd}`, sep], { env: gitEnv });
      fs.mkdirSync(path.join(gd, "hooks"), { recursive: true });
      const mk = (gitProtect) => sandboxPlan({ cwd: sep, home, writable: [".cache"], secrets: [], gitProtect, env: {}, uid: null });
      const tryWrite = (q, f) => run(q, `echo x >> ${f} 2>/dev/null && echo wrote || echo refused`);
      // Without knowing the git dir (gitProtect), the .git file names an unprotected git dir in a writable place: refused.
      assert.throws(() => mk([]), /names the git dir .*isn't one ari checks/);
      const q = mk([gd]);
      for (const f of ["config", "hooks/pre-commit"]) assert.equal(tryWrite(q, path.join(gd, f)), "refused", f);
      assert.equal(run(q, `mv ${gd} ${gd}-old 2>/dev/null && echo moved || echo refused`), "refused");
      assert.equal(tryWrite(q, path.join(gd, "description")), "wrote"); // objects etc. stay writable: commits work
      for (const f of ["config", "hooks/post-checkout", "commondir"]) assert.match(writeBlockReason(tp(path.join(gd, f), sep), q), /Git config/, f);
    });
    test("regression: git mount targets that are symlinks are refused, not followed", () => {
      const lr = h("src/linky");
      fs.mkdirSync(path.join(lr, ".git/hooks"), { recursive: true });
      fs.writeFileSync(path.join(lr, ".git/HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(path.join(lr, "real-config"), "[core]\n");
      fs.symlinkSync("../real-config", path.join(lr, ".git/config"));
      const q = () => sandboxPlan({ cwd: lr, home, secrets: [], env: {}, uid: null });
      assert.throws(q, /\.git\/config (is or lies under a symbolic link|leads into|goes through the symbolic link)/);
      fs.rmSync(path.join(lr, ".git/config"));
      fs.writeFileSync(path.join(lr, ".git/config"), "[core]\n");
      fs.rmSync(path.join(lr, ".git/hooks"), { recursive: true });
      fs.symlinkSync(path.join(out, "hooks-elsewhere"), path.join(lr, ".git/hooks")); // dangling
      assert.throws(q, /\.git\/hooks is a symbolic link in a git dir/);
      fs.rmSync(path.join(lr, ".git/hooks"));
      assert.doesNotThrow(() => bwrapArgs(q(), "true"));
      // A workspace whose .git is itself a link to a git dir elsewhere.
      const ll = h("src/linked-git");
      fs.mkdirSync(ll, { recursive: true });
      fs.symlinkSync(path.join(lr, ".git"), path.join(ll, ".git"));
      assert.throws(() => sandboxPlan({ cwd: ll, home, secrets: [], env: {}, uid: null }), /linked-git\/\.git is or lies under a symbolic link/);
    });
    describe("regression: the whole class (symlinks, ancestors, nested repositories, includes)", () => {
      const mv = (q, from, to) => run(q, `mv '${from}' '${to}' 2>/dev/null && echo moved || echo refused`);
      const tryWrite = (q, f) => run(q, `echo x >> '${f}' 2>/dev/null && echo wrote || echo refused`);
      const repoAt = (dir) => {
        fs.mkdirSync(path.join(dir, ".git/hooks"), { recursive: true });
        fs.writeFileSync(path.join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
        fs.writeFileSync(path.join(dir, ".git/config"), "[core]\n");
      };
      test("a symlink where git dirs are enumerated is refused, not skipped", () => {
        const r = h("src/enum-links");
        repoAt(r);
        const q = () => sandboxPlan({ cwd: r, home, secrets: [], env: {}, uid: null });
        fs.mkdirSync(path.join(r, "elsewhere"), { recursive: true });
        fs.writeFileSync(path.join(r, "elsewhere/HEAD"), "ref: refs/heads/main\n");
        fs.mkdirSync(path.join(r, ".git/modules/lib"), { recursive: true });
        for (const [link, target] of [[".git/modules/lib/sm", "../../../elsewhere"], [".git/worktrees", "../elsewhere"], [".git/modules/deep-link", "../../elsewhere"]]) {
          fs.mkdirSync(path.dirname(path.join(r, link)), { recursive: true });
          fs.symlinkSync(target, path.join(r, link));
          assert.throws(q, /is a symbolic link in a git dir/, link);
          fs.rmSync(path.join(r, link));
        }
        fs.rmSync(path.join(r, ".git/modules"), { recursive: true });
        fs.symlinkSync("../elsewhere", path.join(r, ".git/modules"));
        assert.throws(q, /\.git\/modules is a symbolic link in a git dir/);
        fs.rmSync(path.join(r, ".git/modules"));
        assert.doesNotThrow(() => bwrapArgs(q(), "true"));
      });
      test("writable ancestors of an external git dir, an allowed secret and a nested workspace are pinned", () => {
        // External git dir two levels down in ~/.cache.
        const sep = h("src/sep2"), gd = h(".cache/deep/sep2-gitdir");
        fs.mkdirSync(sep, { recursive: true });
        fs.mkdirSync(path.dirname(gd), { recursive: true });
        execFileSync("git", ["init", "-q", `--separate-git-dir=${gd}`, sep], { env: gitEnv });
        const q = sandboxPlan({ cwd: sep, home, writable: [".cache"], secrets: [], gitProtect: [gd], env: {}, uid: null });
        assert.equal(mv(q, h(".cache/deep"), h(".cache/deep-old")), "refused");
        assert.equal(tryWrite(q, path.join(gd, "config")), "refused");
        // An allowed secret deep in ~/.cache stays readable, read-only, and in place.
        fs.mkdirSync(h(".cache/tok/sub"), { recursive: true });
        fs.writeFileSync(h(".cache/tok/sub/token"), "T\n");
        const qa = sandboxPlan({ cwd: ws, home, writable: [".cache"], secrets: [".cache/tok/sub/token"], allow: [".cache/tok/sub/token"], env: {}, uid: null });
        assert.equal(run(qa, `cat ${h(".cache/tok/sub/token")}`), "T");
        assert.equal(tryWrite(qa, h(".cache/tok/sub/token")), "refused");
        for (const d of [".cache/tok", ".cache/tok/sub"]) assert.equal(mv(qa, h(d), h(`${d}-old`)), "refused", d);
        // A workspace inside a writable directory: its parents there can't be renamed either.
        const nestedWs = h(".cache/work/proj");
        repoAt(nestedWs);
        const qw = sandboxPlan({ cwd: nestedWs, home, writable: [".cache"], secrets: [], env: {}, uid: null });
        assert.equal(mv(qw, h(".cache/work"), h(".cache/work-old")), "refused");
      });
      test("nested repositories and old-style submodule git dirs in the workspace are protected", () => {
        const r = h("src/nests");
        repoAt(r);
        repoAt(path.join(r, "vendor/lib")); // a nested clone, not a submodule
        repoAt(path.join(r, "old/sm")); // an old-style submodule with its own .git directory
        fs.writeFileSync(path.join(r, ".gitmodules"), '[submodule "sm"]\n\tpath = old/sm\n');
        fs.mkdirSync(path.join(r, "linkdir-target/inner"), { recursive: true });
        fs.symlinkSync("linkdir-target", path.join(r, "linkdir")); // not followed by the scan
        assert.deepEqual(findGitEntries(r).sort(), [path.join(r, "old/sm/.git"), path.join(r, "vendor/lib/.git")]);
        const q = sandboxPlan({ cwd: r, home, secrets: [], gitNested: findGitEntries(r), env: {}, uid: null });
        for (const d of ["vendor/lib", "old/sm"]) {
          for (const f of ["config", "hooks/pre-commit"]) assert.equal(tryWrite(q, path.join(r, d, ".git", f)), "refused", `${d} ${f}`);
          assert.equal(mv(q, path.join(r, d), path.join(r, `${d}-old`)), "refused", d);
          assert.equal(mv(q, path.join(r, d, ".git"), path.join(r, d, "g")), "refused", d);
        }
        // Found through .gitmodules alone, too (the scan result isn't needed for a listed submodule).
        const q2 = sandboxPlan({ cwd: r, home, secrets: [], env: {}, uid: null });
        assert.equal(tryWrite(q2, path.join(r, "old/sm/.git/config")), "refused");
      });
      test("git redirections from a read-only place into a writable one are refused, and so is a missing config", () => {
        // A repository outside the writable places whose hooks (or config) is a link into one.
        const ro = h("src/ro-repo"), cache = h(".cache/hooks-here");
        repoAt(ro);
        fs.mkdirSync(cache, { recursive: true });
        const q = (cwd) => () => sandboxPlan({ cwd, home, writable: [".cache"], secrets: [], gitProtect: [path.join(ro, ".git")], env: {}, uid: null });
        const sub = path.join(ro, "sub");
        fs.mkdirSync(sub, { recursive: true });
        assert.doesNotThrow(q(sub));
        fs.rmSync(path.join(ro, ".git/hooks"), { recursive: true });
        fs.symlinkSync(cache, path.join(ro, ".git/hooks"));
        assert.throws(q(sub), /\.git\/hooks leads into .*hooks-here, a place commands can write/);
        fs.rmSync(path.join(ro, ".git/hooks"));
        fs.mkdirSync(path.join(ro, ".git/hooks"));
        fs.writeFileSync(path.join(cache, "config"), "[core]\n");
        fs.renameSync(path.join(ro, ".git/config"), path.join(ro, ".git/config.real"));
        fs.symlinkSync(path.join(cache, "config"), path.join(ro, ".git/config"));
        assert.throws(q(sub), /\.git\/config leads into .*hooks-here\/config, a place commands can write/);
        fs.rmSync(path.join(ro, ".git/config"));
        fs.renameSync(path.join(ro, ".git/config.real"), path.join(ro, ".git/config"));
        fs.writeFileSync(path.join(cache, "commondir"), ".\n");
        fs.symlinkSync(path.join(cache, "commondir"), path.join(ro, ".git/commondir")); // a redirect file, a link into ~/.cache
        assert.throws(q(sub), /\.git\/commondir leads into .*hooks-here\/commondir, a place commands can write/);
        fs.rmSync(path.join(ro, ".git/commondir"));
        fs.symlinkSync(path.join(cache, "no-commondir"), path.join(ro, ".git/commondir")); // dangling: refused as well
        assert.throws(q(sub), /\.git\/commondir can't be resolved/);
        fs.rmSync(path.join(ro, ".git/commondir"));
        // A nested .git file that names a git dir in a writable place ari doesn't protect.
        const n = h("src/pointer");
        repoAt(n);
        fs.mkdirSync(path.join(n, "sub"), { recursive: true });
        fs.mkdirSync(h(".cache/other-gitdir"), { recursive: true });
        fs.writeFileSync(path.join(n, "sub/.git"), `gitdir: ${h(".cache/other-gitdir")}\n`);
        const qn = () => sandboxPlan({ cwd: n, home, writable: [".cache"], secrets: [], gitNested: findGitEntries(n), env: {}, uid: null });
        assert.throws(qn, /sub\/\.git names the git dir .*other-gitdir, which isn't one ari checks/);
        // Also a git dir in a read-only place: its config or includes could still lead into a writable one.
        fs.writeFileSync(path.join(n, "sub/.git"), `gitdir: ${path.join(ro, ".git")}\n`);
        assert.throws(qn, /sub\/\.git names the git dir .*ro-repo\/\.git, which isn't one ari checks/);
        fs.rmSync(path.join(n, "sub/.git"));
        assert.doesNotThrow(qn);
        // A commondir that names a git dir ari doesn't check.
        fs.writeFileSync(path.join(n, ".git/commondir"), `${path.join(ro, ".git")}\n`);
        assert.throws(qn, /\.git\/commondir names the git dir .*ro-repo\/\.git, which isn't one ari checks/);
        fs.rmSync(path.join(n, ".git/commondir"));
        // A git dir in the workspace without a config file.
        fs.rmSync(path.join(n, ".git/config"));
        assert.throws(qn, /has no config file/);
        fs.writeFileSync(path.join(n, ".git/config"), "[core]\n");
      });
      test("a git reference through a symlink in a writable place is refused, even when it ends at a known git dir", () => {
        const r = h("src/ref-link");
        repoAt(r);
        fs.mkdirSync(path.join(r, ".git/modules/x"), { recursive: true });
        fs.writeFileSync(path.join(r, ".git/modules/x/HEAD"), "ref: refs/heads/main\n");
        fs.writeFileSync(path.join(r, ".git/modules/x/config"), "[core]\n");
        fs.mkdirSync(path.join(r, "deps/x"), { recursive: true });
        const q = () => sandboxPlan({ cwd: r, home, secrets: [], gitNested: findGitEntries(r), env: {}, uid: null });
        fs.writeFileSync(path.join(r, "deps/x/.git"), "gitdir: ../../.git/modules/x\n");
        assert.doesNotThrow(q);
        fs.symlinkSync(".git", path.join(r, "gitlink")); // a link in the workspace, which commands could re-point
        fs.writeFileSync(path.join(r, "deps/x/.git"), "gitdir: ../../gitlink/modules/x\n");
        assert.throws(q, /deps\/x\/\.git names .* goes through the symbolic link .*gitlink/);
        // A link in a read-only place whose own target runs through a link in a writable one is caught too.
        fs.symlinkSync(path.join(r, "gitlink"), h("ro-link"));
        fs.writeFileSync(path.join(r, "deps/x/.git"), `gitdir: ${h("ro-link")}/modules/x\n`);
        assert.throws(q, /goes through the symbolic link .*gitlink/);
        fs.writeFileSync(path.join(r, "deps/x/.git"), "gitdir: ../../.git/modules/x\n");
        fs.rmSync(h("ro-link"));
        // A read-only link whose target is "<workspace>/wl/../x": wl is a link in the workspace, which the target
        // passes through before "..". It must be found as written, not after taking "wl/.." away.
        fs.mkdirSync(path.join(r, ".git/modules/y"));
        fs.symlinkSync(path.join(r, ".git/modules/y"), path.join(r, "wl"));
        fs.symlinkSync(`${path.join(r, "wl")}/../x`, h("ro-dd"));
        fs.writeFileSync(path.join(r, "deps/x/.git"), `gitdir: ${h("ro-dd")}\n`);
        assert.throws(q, /deps\/x\/\.git names .*ro-dd, which goes through the symbolic link .*ref-link\/wl in a writable place/);
        fs.writeFileSync(path.join(r, "deps/x/.git"), "gitdir: ../../.git/modules/x\n");
        fs.rmSync(h("ro-dd"));
      });
      test("git configs with include directives are refused (no include is followed)", () => {
        const r = h("src/incl");
        repoAt(r);
        fs.mkdirSync(path.join(r, ".git/modules/m"), { recursive: true });
        fs.writeFileSync(path.join(r, ".git/modules/m/HEAD"), "ref: refs/heads/main\n");
        fs.writeFileSync(path.join(r, ".git/modules/m/config"), "[core]\n");
        const wtg = path.join(r, ".git/worktrees/w");
        fs.mkdirSync(wtg, { recursive: true });
        fs.writeFileSync(path.join(wtg, "HEAD"), "ref: refs/heads/main\n");
        fs.writeFileSync(path.join(wtg, "commondir"), "../..\n");
        const q = (env = {}) => () => sandboxPlan({ cwd: r, home, secrets: [], env, uid: null });
        assert.doesNotThrow(q());
        const xdg = h("xdg-cfg");
        fs.mkdirSync(path.join(xdg, "git"), { recursive: true });
        const cases = [[path.join(r, ".git/config"), {}], [path.join(r, ".git/config.worktree"), {}], [path.join(r, ".git/modules/m/config"), {}],
          [path.join(wtg, "config.worktree"), {}],
          [h(".gitconfig"), {}], [path.join(xdg, "git/config"), { XDG_CONFIG_HOME: xdg }]];
        for (const [file, env] of cases)
          for (const directive of ['[include]\n\tpath = /nonexistent/x\n', '[includeIf "gitdir:/nowhere/"]\n\tpath = x\n', '[Include]\n\tPATH = ~root/x\n']) {
            const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
            fs.writeFileSync(file, `[core]\n${directive}`);
            assert.throws(q(env), /has an include \(include.*\.path\); configs with include directives aren't supported/, `${file} ${directive}`);
            saved ? fs.writeFileSync(file, saved) : fs.rmSync(file);
          }
        assert.doesNotThrow(q());
        // A ~/.gitconfig that is a link (into a dotfiles repository, say) is read through the link, as git reads it.
        fs.mkdirSync(h("dotfiles"), { recursive: true });
        fs.writeFileSync(h("dotfiles/gitconfig"), "[include]\n\tpath = more\n");
        fs.symlinkSync(h("dotfiles/gitconfig"), h(".gitconfig"));
        assert.throws(q(), /\.gitconfig has an include \(include\.path\)/);
        fs.rmSync(h(".gitconfig"));
        assert.doesNotThrow(q());
        // core.worktree with an expansion ari doesn't reproduce is refused as well.
        fs.writeFileSync(path.join(r, ".git/modules/m/config"), "[core]\n\tworktree = ~root/y\n");
        assert.throws(q(), /sets core\.worktree to ~root\/y, a form ari doesn't resolve/);
        fs.writeFileSync(path.join(r, ".git/modules/m/config"), "[core]\n");
      });
      test("a .git file resolves \"link/..\" like the kernel and git do, not lexically", () => {
        // sub/.git names ../../lnk/../dotdot/.git/modules/x. Lexically that is the workspace's own (known)
        // .git/modules/x, but lnk -> ~/elsewhere/inner, so the kernel and git take lnk/.. as ~/elsewhere and
        // reach elsewhere/dotdot/.git/modules/x, a git dir ari doesn't check. The link is outside the writable
        // places, so only the resolution decides.
        const r = h("src/dotdot"), known = path.join(r, ".git/modules/x"), other = h("elsewhere/dotdot/.git/modules/x");
        repoAt(r);
        for (const g of [known, other]) {
          fs.mkdirSync(g, { recursive: true });
          fs.writeFileSync(path.join(g, "HEAD"), "ref: refs/heads/main\n");
          fs.writeFileSync(path.join(g, "config"), "[core]\n\tbare = false\n");
          for (const d of ["objects", "refs"]) fs.mkdirSync(path.join(g, d)); // enough for git to take it as a git dir
        }
        fs.mkdirSync(h("elsewhere/inner"), { recursive: true });
        fs.mkdirSync(path.join(r, "sub"), { recursive: true });
        fs.symlinkSync(h("elsewhere/inner"), h("src/lnk"));
        fs.writeFileSync(path.join(r, "sub/.git"), "gitdir: ../../lnk/../dotdot/.git/modules/x\n");
        if (findExecutable("git")) {
          const seen = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: path.join(r, "sub"), env: gitEnv, encoding: "utf8" }).trim();
          assert.equal(seen, other);
        }
        assert.throws(() => sandboxPlan({ cwd: r, home, secrets: [], gitNested: findGitEntries(r), env: {}, uid: null }),
          new RegExp(`sub/\\.git names the git dir ${other}, which isn't one ari checks`));
        fs.writeFileSync(path.join(r, "sub/.git"), "gitdir: ../.git/modules/x\n"); // the usual form, with "..": fine
        assert.doesNotThrow(() => sandboxPlan({ cwd: r, home, secrets: [], gitNested: findGitEntries(r), env: {}, uid: null }));
      });
      test("a commondir must name the repository's own git dir, which must have a config", () => {
        const r = h("src/wt-noconf");
        repoAt(r);
        const wtg = path.join(r, ".git/worktrees/w"), other = path.join(r, ".git/worktrees/other");
        for (const g of [wtg, other]) {
          fs.mkdirSync(g, { recursive: true });
          fs.writeFileSync(path.join(g, "HEAD"), "ref: refs/heads/main\n");
          fs.writeFileSync(path.join(g, "commondir"), "../..\n");
        }
        const q = () => sandboxPlan({ cwd: r, home, secrets: [], gitProtect: [wtg], env: {}, uid: null });
        assert.doesNotThrow(q);
        fs.rmSync(path.join(r, ".git/config"));
        assert.throws(q, /worktrees\/(w|other)\/commondir names .*wt-noconf\/\.git, which has no config file/);
        fs.writeFileSync(path.join(r, ".git/config"), "[core]\n");
        // Naming another worktree's admin dir (whose config git would read, and ari doesn't check).
        fs.writeFileSync(path.join(other, "config"), "[core]\n");
        fs.writeFileSync(path.join(wtg, "commondir"), "../other\n");
        assert.throws(q, /worktrees\/w\/commondir names .*worktrees\/other; ari only supports a commondir that names .*wt-noconf\/\.git;/);
        fs.writeFileSync(path.join(wtg, "commondir"), "../..\n");
        // A git dir without config is only fine with a commondir checked as above: an empty one (which names
        // nothing) doesn't count.
        const z = path.join(r, ".git/modules/z");
        fs.mkdirSync(z, { recursive: true });
        fs.writeFileSync(path.join(z, "HEAD"), "ref: refs/heads/main\n");
        fs.writeFileSync(path.join(z, "commondir"), "");
        assert.throws(q, /the git dir .*modules\/z has no config file/);
        fs.rmSync(z, { recursive: true });
        assert.doesNotThrow(q);
        // A read-only repository elsewhere, whose worktree admin dir has a config of its own: git reads the common
        // dir's config, so that one must exist.
        const ext = h("ext-common"), extWt = path.join(ext, ".git/worktrees/w"), co = h("src/ext-checkout");
        repoAt(ext);
        fs.mkdirSync(extWt, { recursive: true });
        fs.mkdirSync(co, { recursive: true });
        fs.writeFileSync(path.join(extWt, "HEAD"), "ref: refs/heads/main\n");
        fs.writeFileSync(path.join(extWt, "commondir"), "../..\n");
        fs.writeFileSync(path.join(extWt, "config"), "[core]\n");
        fs.writeFileSync(path.join(co, ".git"), `gitdir: ${extWt}\n`);
        const q2 = () => sandboxPlan({ cwd: co, home, secrets: [], gitProtect: [extWt, path.join(ext, ".git")], env: {}, uid: null });
        assert.doesNotThrow(q2);
        fs.rmSync(path.join(ext, ".git/config"));
        assert.throws(q2, /ext-common\/\.git\/worktrees\/w\/commondir names .*ext-common\/\.git, which has no config file/);
      });
      test("variables that change where git looks are refused", () => {
        const q = (env) => () => sandboxPlan({ cwd: ws, home, secrets: [], env, uid: null });
        for (const k of ["GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_3", "GIT_CONFIG_PARAMETERS",
          "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
          "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"])
          assert.throws(q({ [k]: "x" }), new RegExp(`^Error: ${k} is set`), k);
        assert.throws(q({ XDG_CONFIG_HOME: "rel/cfg" }), /XDG_CONFIG_HOME is a relative path/);
        assert.doesNotThrow(q({ GIT_EDITOR: "vi", GIT_CONFIG_NOSYSTEM: "1" }));
      });
      test("nested .git files are fingerprinted, so a change from outside the sandbox is reported", () => {
        const r = h("src/nested-print");
        repoAt(r);
        fs.mkdirSync(path.join(r, ".git/modules/x"), { recursive: true });
        fs.writeFileSync(path.join(r, ".git/modules/x/HEAD"), "ref: refs/heads/main\n");
        fs.writeFileSync(path.join(r, ".git/modules/x/config"), "[core]\n");
        fs.mkdirSync(path.join(r, "deps/x"), { recursive: true });
        fs.writeFileSync(path.join(r, "deps/x/.git"), `gitdir: ${path.join(r, ".git/modules/x")}\n`); // not in .gitmodules
        const q = sandboxPlan({ cwd: r, home, secrets: [], gitNested: findGitEntries(r), env: {}, uid: null });
        assert.ok(q.submoduleGitFiles.includes(path.join(r, "deps/x/.git")));
        const before = gitRedirects(q.gitDirs, r, q.submoduleGitFiles); // what ari records at the start
        fs.writeFileSync(path.join(r, "deps/x/.git"), `gitdir: ${path.join(r, ".git/modules/x")}/\n`); // a host-side change
        assert.deepEqual(changedRedirects(before, gitRedirects(q.gitDirs, r, Object.keys(before))), [path.join(r, "deps/x/.git")]);
      });
      test("git dirs and session paths that can't be resolved are refused, not dropped", () => {
        fs.symlinkSync("loop-y", h("loop-x"));
        fs.symlinkSync("loop-x", h("loop-y"));
        assert.throws(() => sandboxPlan({ cwd: ws, home, secrets: [], gitProtect: [h("loop-x")], env: {}, uid: null }), /can't be resolved/);
        assert.throws(() => sandboxPlan({ cwd: ws, home, secrets: [], env: { XDG_RUNTIME_DIR: h("loop-x") }, uid: null }), /can't be resolved/);
        fs.rmSync(h("loop-x"));
        fs.rmSync(h("loop-y"));
      });
    });
    test("new git redirection files are detected", () => {
      const before = gitRedirects(p.gitDirs);
      run(p, "echo /elsewhere > .git/commondir.tmp && mv .git/commondir.tmp .git/commondir");
      assert.deepEqual(changedRedirects(before, gitRedirects(p.gitDirs)), [path.join(repo, ".git/commondir")]);
      fs.rmSync(path.join(repo, ".git/commondir"));
    });
    test("redirect fingerprints notice changed content, not just new files", () => {
      const f = path.join(repo, ".git/worktrees/repo-wt/gitdir");
      const before = gitRedirects(p.gitDirs), saved = fs.readFileSync(f);
      fs.writeFileSync(f, "/elsewhere/.git\n"); // as a host-side change would
      assert.deepEqual(changedRedirects(before, gitRedirects(p.gitDirs)), [f]);
      fs.writeFileSync(f, saved);
    });

    describe("regression: submodules and existing redirect files", () => {
      let top, deep, q;
      const g = (rel) => path.join(top, rel);
      before(() => {
        // A hand-made layout (no git commands needed): the main git dir and one shallow and one deeply nested
        // submodule git dir each already have commondir and config.worktree; libs/sm is a submodule checkout.
        top = h("src/layered");
        deep = ".git/modules/a/b/c/d/e/f/g/h/i/j/k/l/deep";
        for (const d of [".git/hooks", ".git/modules/sm/hooks", `${deep}/hooks`, "libs/sm"]) fs.mkdirSync(g(d), { recursive: true });
        for (const d of [".git", ".git/modules/sm", deep]) {
          fs.writeFileSync(g(`${d}/HEAD`), "ref: refs/heads/main\n");
          fs.writeFileSync(g(`${d}/config`), "[core]\n");
          fs.writeFileSync(g(`${d}/commondir`), ".\n");
          fs.writeFileSync(g(`${d}/config.worktree`), "[core]\n");
        }
        fs.writeFileSync(g(".gitmodules"), '[submodule "sm"]\n\tpath = libs/sm\n');
        fs.writeFileSync(g("libs/sm/.git"), "gitdir: ../../.git/modules/sm\n");
        q = sandboxPlan({ cwd: top, home, secrets: [], env: {}, uid: null });
      });
      test("existing commondir and config.worktree stay read-only in the main repo and in submodules", () => {
        for (const d of [".git", ".git/modules/sm", deep])
          for (const f of ["commondir", "config.worktree"]) {
            assert.equal(run(q, `echo x >> ${d}/${f} 2>/dev/null && echo wrote || echo refused`), "refused", `${d}/${f}`);
            assert.equal(run(q, `rm -f ${d}/${f} 2>/dev/null; mv ${d}/${f} ${d}/${f}.old 2>/dev/null; cat ${d}/${f}`), f === "commondir" ? "." : "[core]", `${d}/${f}`);
          }
      });
      test("submodule git dirs at any depth are protected, and the directories leading to them are pinned", () => {
        assert.ok(bwrapArgs(q, "true").includes(g(`${deep}/config`)));
        assert.equal(run(q, `echo x >> ${deep}/config 2>/dev/null && echo wrote || echo refused`), "refused");
        assert.equal(run(q, `echo x > ${deep}/hooks/post-checkout 2>/dev/null && echo wrote || echo refused`), "refused");
        for (const d of [".git/modules", ".git/modules/a", ".git/modules/a/b/c", deep])
          assert.equal(run(q, `mv ${d} ${d}-old 2>/dev/null && echo moved || echo refused`), "refused", d);
        assert.match(writeBlockReason(tp(`${deep}/config`, top), q), /Git config/);
      });
      test("a submodule's .git file is read-only, its checkout can't be moved, and it stays protected if .gitmodules changes", () => {
        assert.deepEqual(q.submoduleGitFiles, [g("libs/sm/.git")]);
        assert.equal(run(q, "echo 'gitdir: /elsewhere' > libs/sm/.git 2>/dev/null && echo wrote || echo refused"), "refused");
        for (const d of ["libs/sm", "libs"]) assert.equal(run(q, `mv ${d} ${d}-old 2>/dev/null && echo moved || echo refused`), "refused", d);
        const saved = fs.readFileSync(g(".gitmodules"));
        fs.writeFileSync(g(".gitmodules"), ""); // as if an agent had emptied it earlier in the run
        const later = sandboxPlan({ cwd: top, home, secrets: [], gitFiles: q.submoduleGitFiles, env: {}, uid: null });
        assert.equal(run(later, "echo 'gitdir: /elsewhere' > libs/sm/.git 2>/dev/null && echo wrote || echo refused"), "refused");
        fs.writeFileSync(g(".gitmodules"), saved);
      });
      test("regression: .gitmodules is parsed like git, and submodules are also found through core.worktree", () => {
        const subs = ["libs/with space", 'libs/q"uote', "libs/semi;colon", "libs/by-worktree"];
        for (const d of subs) { fs.mkdirSync(g(d), { recursive: true }); fs.writeFileSync(g(`${d}/.git`), `gitdir: ${g(".git/modules/sm")}\n`); }
        const saved = fs.readFileSync(g(".gitmodules"));
        fs.writeFileSync(g(".gitmodules"), `${saved}[submodule "sp"]\r\n\tpath = "libs/with space"\r\n[submodule "q"]\n\tPath = libs/q\\"uote\n` +
          '[submodule "sc"]\n\tpath = "libs/semi;colon" ; comment\n');
        fs.mkdirSync(g(".git/modules/wt"), { recursive: true });
        fs.writeFileSync(g(".git/modules/wt/HEAD"), "ref: refs/heads/main\n");
        fs.writeFileSync(g(".git/modules/wt/config"), "[core]\n\tworktree = ../../../libs/by-worktree\n"); // not in .gitmodules
        try {
          const r = sandboxPlan({ cwd: top, home, secrets: [], env: {}, uid: null });
          assert.deepEqual([...r.submoduleGitFiles].sort(), ["libs/sm/.git", ...subs.map((d) => `${d}/.git`)].map(g).sort());
          for (const d of subs)
            assert.equal(run(r, `echo 'gitdir: /elsewhere' > '${d.replaceAll("'", "'\\''")}/.git' 2>/dev/null && echo wrote || echo refused`), "refused", d);
          assert.ok(Object.keys(gitRedirects(r.gitDirs, top)).includes(g("libs/by-worktree/.git")));
        } finally {
          fs.writeFileSync(g(".gitmodules"), saved);
          fs.rmSync(g(".git/modules/wt"), { recursive: true });
          for (const d of subs) fs.rmSync(g(d), { recursive: true });
        }
      });
      test("a .gitmodules that is not a regular file is skipped, not read", () => {
        const saved = fs.readFileSync(g(".gitmodules"));
        fs.rmSync(g(".gitmodules"));
        execFileSync("mkfifo", [g(".gitmodules")]); // reading it would hang
        try {
          // In a child process with a timeout, so a regression fails instead of hanging the suite.
          const code = `const { sandboxPlan } = await import(${JSON.stringify(new URL("../sandbox.mjs", import.meta.url).href)});
            console.log(JSON.stringify(sandboxPlan({ cwd: ${JSON.stringify(top)}, home: ${JSON.stringify(home)}, secrets: [], env: {}, uid: null }).submoduleGitFiles));`;
          const outp = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 10_000 });
          assert.deepEqual(JSON.parse(outp), []);
        } finally {
          fs.rmSync(g(".gitmodules"));
          fs.writeFileSync(g(".gitmodules"), saved);
        }
      });
      test("deleted redirect files are reported, not only new or changed ones", () => {
        const files = [".git/config.worktree", `${deep}/commondir`, "libs/sm/.git"].map(g);
        const before = gitRedirects(q.gitDirs, top);
        for (const f of files) assert.ok(before[f], f);
        const saved = files.map((f) => fs.readFileSync(f));
        files.forEach((f) => fs.rmSync(f)); // host-side deletions
        assert.deepEqual(changedRedirects(before, gitRedirects(q.gitDirs, top)).sort(), [...files].sort());
        files.forEach((f, i) => fs.writeFileSync(f, saved[i]));
        assert.deepEqual(changedRedirects(before, gitRedirects(q.gitDirs, top)), []);
        // A submodule dropped from .gitmodules while its .git file is left alone is not a change.
        const modules = fs.readFileSync(g(".gitmodules"));
        fs.writeFileSync(g(".gitmodules"), "");
        assert.deepEqual(changedRedirects(before, gitRedirects(q.gitDirs, top, Object.keys(before))), []);
        fs.writeFileSync(g(".gitmodules"), modules);
      });
    });
  });

  test("prepareCargo creates the lock files cargo needs", () => {
    prepareCargo(home);
    for (const f of ["registry", "git", ".package-cache", ".package-cache-mutate", ".global-cache"]) assert.ok(fs.existsSync(h(`.cargo/${f}`)), f);
  });
});
