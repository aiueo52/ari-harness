// Sandbox policy for ari: path resolution, the file-tool guards and the bubblewrap command line.
// No side effects on import, so test/sandbox.test.mjs can exercise it without a model.
//
// This is a best-effort guard against accidents and prompt-injected mistakes, not a security boundary
// against a determined adversary. Use a VM or container for untrusted code.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Hidden from sandboxed commands and refused to the read/edit/write tools. Relative to $HOME; missing ones are skipped.
export const SECRET_DEFAULTS = [
  // keys and credential stores
  ".ssh", ".gnupg", ".password-store", ".local/share/keyrings",
  // cloud and container tools
  ".aws", ".azure", ".config/gcloud", ".kube", ".docker/config.json", ".terraform.d/credentials.tfrc.json",
  // git hosts and package registries
  ".netrc", ".git-credentials", ".config/git/credentials", ".config/gh", ".config/hub",
  ".npmrc", ".yarnrc.yml", ".pypirc", ".cargo/credentials", ".cargo/credentials.toml", ".gem/credentials",
  // AI provider logins and keys
  ".codex/auth.json", ".pi/agent/auth.json", ".claude/.credentials.json", ".claude.json", ".config/openrouter", ".config/deepseek",
  ".cache/huggingface/token", ".huggingface/token",
  // shell history and other agents' transcripts often hold pasted tokens
  ".bash_history", ".zsh_history", ".claude/projects", ".codex/sessions", ".pi/agent/sessions",
  // browser and mail profiles (cookies, saved passwords)
  ".mozilla", ".thunderbird", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware",
  ".config/microsoft-edge", ".config/vivaldi", "snap/firefox", "snap/chromium", "snap/thunderbird",
  ".var/app/org.mozilla.firefox", ".var/app/com.google.Chrome", ".var/app/org.chromium.Chromium",
];

// Places whose contents run later outside the sandbox (shell start-up, autostart, user services, PATH).
// Neither ARI_EXTRA_WRITABLE nor the workspace may cover them.
export const ESCAPE_PATHS = [".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshrc", ".zprofile",
  ".zshenv", ".zlogin", ".xprofile", ".xsession", ".xinitrc", ".pam_environment", ".config/fish", ".config/autostart",
  ".config/systemd", ".config/environment.d", ".config/git", ".gitconfig", ".local/bin", ".local/share/applications",
  ".local/share/systemd", "bin", ".cargo/bin", ".cargo/env", ".cargo/config", ".cargo/config.toml", ".npmrc", ".ssh"];

// Never writable, and never a parent of anything writable: the sandbox mounts its own /proc, /dev (with a private
// /dev/shm) and masks over /run/user, so a writable bind on, over or inside one of these would cover them (or
// expose the host's /sys and /run). Checked where a path leads, for the workspace and every writable path.
export const SYSTEM_MOUNTS = ["/proc", "/dev", "/sys", "/run"];

// Never readable by the file tools: other processes' memory maps and environments, devices, ari's own pipes.
const SYSTEM_DENY = ["/proc", "/dev"];

// Files in a git dir that git executes or follows later, outside the sandbox: config and hooks, and the redirect
// files commondir, gitdir (linked worktrees) and config.worktree, plus the .git files of linked worktrees and
// submodule checkouts. Existing ones are read-only to commands; the file tools may not create them. A redirect
// file that doesn't exist yet can't be pre-mounted, so ari fingerprints all of them before and after a run and
// reports new, changed or deleted ones (see gitRedirects).
const GIT_PROTECTED = /(^|\/)\.git((\/(modules|worktrees)\/.+)?\/(config|config\.worktree|commondir|gitdir|hooks)(\/|$)|$)/;
const GIT_REDIRECTS = ["commondir", "config.worktree"];
// core.worktree values that start like this may get an expansion ari doesn't reproduce ("~", "~user/",
// "%(prefix)/", ":(optional)"): refused.
const DOUBTFUL_PATH = /^(~|%\(|:\()/;
// Environment variables that change where git finds a repository or its config (GIT_CONFIG_KEY_n/VALUE_n too).
export const GIT_ENV = ["GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_DIR",
  "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"];
const WORKTREE_FILES = ["commondir", "gitdir", "config.worktree"];

export const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");
const overlap = (a, b) => inside(a, b) || inside(b, a);
const uniq = (a) => [...new Set(a)];
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// The real path of an absolute path, as the kernel resolves it: the longest existing prefix through
// fs.realpathSync.native (Node's plain realpathSync takes "link/.." lexically), then the missing rest as plain
// names. Returns null when that can't be done safely, and callers must refuse: the rest contains "." or "..", or
// its first name exists but doesn't resolve (a dangling link, a loop, an unreadable dir).
const MAX_LINKS = 40;
export function resolvePath(abs) {
  const parts = abs.split("/");
  for (let i = parts.length; i > 0; i--) {
    let real;
    try { real = fs.realpathSync.native(parts.slice(0, i).join("/") || "/"); } catch { continue; }
    const rest = parts.slice(i).filter(Boolean);
    if (rest.some((c) => c === "." || c === "..")) return null;
    try { if (rest.length) { fs.lstatSync(path.join(real, rest[0])); return null; } } catch {}
    return path.join(real, ...rest);
  }
  return null;
}

// A tool path as pi's read/edit/write tools interpret it (unicode spaces, "@" prefix, "~", file:// URLs,
// relative to cwd), without following symlinks.
export function lexicalPath(p, cwd, home) {
  let s = String(p).replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (s.startsWith("@")) s = s.slice(1);
  if (s === "~") s = home;
  else if (s.startsWith("~/")) s = path.join(home, s.slice(2));
  else if (s.startsWith("file://")) s = fileURLToPath(s);
  return path.resolve(cwd, s);
}
// The same path with symlinks followed: the file that is really touched (null if it can't be resolved).
export const realPath = (p, cwd, home) => resolvePath(lexicalPath(p, cwd, home));

// pi's read tool (not edit/write) opens the first of these spellings that exists, to find macOS screenshot names:
// as given, " AM."/" PM." with a narrow no-break space, NFD, ' as \u2019, and NFD with \u2019. The guard checks
// every spelling, so a look-alike name can't lead somewhere the given one may not.
export function readTargets(p, cwd, home) {
  const given = lexicalPath(p, cwd, home), nfd = given.normalize("NFD"), curly = (x) => x.replace(/'/g, "\u2019");
  return uniq([given, given.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, curly(given), curly(nfd)])
    .map((lexical) => ({ lexical, real: resolvePath(lexical) }));
}

// First absolute `name` on PATH, resolved. Relative PATH entries are ignored.
export function findExecutable(name, pathVar = process.env.PATH ?? "") {
  for (const dir of pathVar.split(":").filter((d) => path.isAbsolute(d))) {
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); return fs.realpathSync.native(f); } catch {}
  }
  return null;
}

// Everything to protect under a git dir, with no depth limit: the git dir itself and every submodule git dir
// (.git/modules/**), the per-worktree dirs of linked worktrees (.git/worktrees/*, also inside submodules), and the
// plain directories in between (modules/, worktrees/, the name parts of submodules like "lib/foo"), which are
// pinned so nothing can be moved aside. Symlinks are never followed (so the walk ends); any found where a
// directory could be (modules/, worktrees/, hooks/ or an entry below modules/ or worktrees/) is listed in
// `links`, and the sandbox refuses to run with one in a writable place: it can't protect what a link points to.
function gitLayout(gitDir) {
  const dirs = [], worktrees = [], between = [], links = [];
  const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  const subdirs = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return []; }
    for (const e of entries) if (e.isSymbolicLink()) links.push(path.join(d, e.name));
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(d, e.name));
  };
  const visit = (g) => {
    dirs.push(g);
    for (const n of ["worktrees", "modules", "hooks"]) if (isLink(path.join(g, n))) links.push(path.join(g, n));
    const wt = path.join(g, "worktrees");
    if (!isLink(wt) && isDir(wt)) { between.push(wt); worktrees.push(...subdirs(wt)); }
    const walk = (dir) => {
      between.push(dir);
      for (const sub of subdirs(dir)) fs.existsSync(path.join(sub, "HEAD")) ? visit(sub) : walk(sub);
    };
    const modules = path.join(g, "modules");
    if (!isLink(modules) && isDir(modules)) walk(modules);
  };
  visit(gitDir);
  return { dirs, worktrees, between, links };
}
// Key/value pairs of a git config file, parsed the way git's config.c does: [section "sub"] headers (backslash
// escapes any character), the old [section.sub] form, case-insensitive section and key names, a key on the
// header's line, quoted values, the escapes \\ \" \n \t \b, backslash-newline continuations, ; and # comments,
// CRLF and a UTF-8 BOM. Keys are "section.sub.key" (section and key lowercased). A key without "=" has value
// null. Stops at the first error and returns what came before it (git would reject the whole file).
export function parseGitConfig(text) {
  const out = [], src = text.replace(/^\uFEFF/, "");
  let i = 0;
  const next = () => {
    if (i >= src.length) { i++; return null; } // EOF reads as a newline in git; null here
    let c = src[i++];
    if (c === "\r" && src[i] === "\n") c = src[i++];
    return c;
  };
  const space = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
  const keyChar = (c) => c != null && /[A-Za-z0-9-]/.test(c);
  const eol = (c) => c === null || c === "\n";
  const baseVar = () => {
    let name = "";
    for (;;) {
      let c = next();
      if (c === null) return null;
      if (c === "]") return name;
      if (space(c)) {
        do { if (eol(c)) return null; c = next(); } while (space(c));
        if (c !== '"') return null;
        let sub = "";
        for (;;) {
          c = next();
          if (eol(c)) return null;
          if (c === '"') break;
          if (c === "\\") { c = next(); if (eol(c)) return null; }
          sub += c;
        }
        return next() === "]" ? `${name}.${sub}` : null;
      }
      if (!keyChar(c) && c !== ".") return null;
      name += c.toLowerCase();
    }
  };
  const value = () => {
    let v = "", quote = false, comment = false, pending = 0;
    for (;;) {
      let c = next();
      if (eol(c)) return quote ? undefined : v;
      if (comment) continue;
      if (space(c) && !quote) { if (v) pending++; continue; }
      if (!quote && (c === ";" || c === "#")) { comment = true; continue; }
      v += " ".repeat(pending); pending = 0;
      if (c === "\\") {
        c = next();
        if (eol(c)) continue;
        const esc = { t: "\t", b: "\b", n: "\n", "\\": "\\", '"': '"' }[c];
        if (esc === undefined) return undefined;
        v += esc;
      } else if (c === '"') quote = !quote;
      else v += c;
    }
  };
  let section = null, comment = false;
  for (;;) {
    const c = next();
    if (eol(c)) { if (c === null) return out; comment = false; continue; }
    if (comment || space(c)) continue;
    if (c === "#" || c === ";") { comment = true; continue; }
    if (c === "[") { section = baseVar(); if (!section) return out; continue; }
    if (!/[A-Za-z]/.test(c) || section === null) return out;
    let key = c.toLowerCase(), d;
    for (;;) { d = next(); if (!keyChar(d)) break; key += d.toLowerCase(); }
    while (d === " " || d === "\t") d = next();
    let v = null;
    if (!eol(d)) {
      if (d !== "=") return out;
      v = value();
      if (v === undefined) return out;
    }
    out.push([`${section}.${key}`, v]);
    if (d === null) return out;
  }
}
const readRegular = (f) => { try { return fs.lstatSync(f).isFile() ? fs.readFileSync(f, "utf8") : null; } catch { return null; } };
const readFollowed = (f) => { try { return fs.statSync(f).isFile() ? fs.readFileSync(f, "utf8") : null; } catch { return null; } }; // like git
// The .git entries of submodule checkouts in the workspace (usually a file naming the git dir). Found two ways: the
// submodule.*.path entries of .gitmodules (recursively), and the core.worktree that git records in each
// submodule git dir under the given git dirs, which doesn't depend on .gitmodules at all.
function submoduleGitFiles(cwd, gitDirs = []) {
  const out = [];
  const add = (sub, from) => {
    if (!inside(sub, cwd) || sub === from) return false;
    const f = path.join(sub, ".git");
    try { fs.lstatSync(f); } catch { return false; }
    out.push(f); // a file naming its git dir, an old-style .git directory, or a link (refused later)
    return true;
  };
  const visit = (dir) => {
    const text = readRegular(path.join(dir, ".gitmodules"));
    if (text == null) return;
    for (const [k, v] of parseGitConfig(text))
      if (v && /^submodule\..+\.path$/.test(k) && add(path.resolve(dir, v), dir)) visit(path.resolve(dir, v));
  };
  visit(cwd);
  for (const g of gitDirs)
    for (const d of gitLayout(g).dirs.slice(1)) {
      const text = readRegular(path.join(d, "config"));
      for (const [k, v] of text == null ? [] : parseGitConfig(text)) if (k === "core.worktree" && v) add(path.resolve(d, v), d);
    }
  return uniq(out);
}
// Every .git entry below `cwd` (not its own .git), for a scan at the start of a run: nested clones, old-style
// submodules with a .git directory, submodule .git files, and .git links. Symlinked directories aren't followed;
// .git directories aren't entered.
export function findGitEntries(cwd) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.name === ".git") { if (dir !== cwd) out.push(p); }
      else if (e.isDirectory()) walk(p);
    }
  };
  walk(cwd);
  return out;
}

// Fingerprints of every git redirect file (existing or not) in the given git dirs, of the workspace's own .git and
// of its submodules' .git files; compare the result before and after a run with changedRedirects(). Pass the
// earlier fingerprint's files as `also`, so a file that is no longer listed (say .gitmodules changed) is still checked.
export function gitRedirects(gitDirs, cwd, also = []) {
  const files = [];
  for (const g of gitDirs) {
    const { dirs, worktrees } = gitLayout(g);
    files.push(...dirs.flatMap((d) => GIT_REDIRECTS.map((f) => path.join(d, f))), ...worktrees.flatMap((w) => WORKTREE_FILES.map((f) => path.join(w, f))));
  }
  if (cwd) files.push(path.join(cwd, ".git"), ...submoduleGitFiles(cwd, gitDirs));
  files.push(...also);
  const print = (f) => {
    try {
      const st = fs.lstatSync(f);
      return st.isFile() ? createHash("sha256").update(fs.readFileSync(f)).digest("hex") : st.isDirectory() ? "dir" : "other";
    } catch { return null; }
  };
  return Object.fromEntries(uniq(files).map((f) => [f, print(f)]));
}
// Redirect files created, changed or deleted between two fingerprints.
export const changedRedirects = (before, after) =>
  uniq([...Object.keys(before), ...Object.keys(after)]).filter((f) => (before[f] ?? null) !== (after[f] ?? null));

// Resolve everything the sandbox needs. Name lists hold paths relative to $HOME, "~/..." or absolute.
// Throws on a workspace, ARI_EXTRA_WRITABLE entry or --allow-secret path that would open too much.
// Cheap enough to redo for every command and every file-tool call, so secrets created during a run count too.
//   extraWritable: user-supplied, checked. gitWritable: git dirs outside the workspace, only for ari's own git calls.
//   gitProtect: the git dirs outside the workspace (a linked worktree's, or the repository's when the workspace is
//   a subdirectory): their config, hooks and redirect files stay read-only even if they lie in a writable place.
//   readable: shown read-only to commands and the read tool even inside a secret (the run's own temp dir).
//   gitFiles: submodule .git files to keep read-only even if .gitmodules no longer lists them.
//   restoreEnv: variables to set (or unset, when undefined) inside the sandbox, e.g. the user's TMPDIR.
export function sandboxPlan({ cwd, home, writable = [], extraWritable = [], secrets = SECRET_DEFAULTS, allow = [], readable = [],
  gitWritable = [], gitProtect = [], gitFiles = [], gitNested = [], restoreEnv = {}, env = process.env, uid = process.getuid?.() }) {
  const names = (list) => list.filter(Boolean).map(String);
  const lexical = (list) => names(list).map((n) => lexicalPath(n, home, home));
  // Names that can't be resolved (a symlink loop) are dropped here; writable ones are refused below instead.
  const resolve = (list) => uniq(names(list).map((n) => realPath(n, home, home)).filter(Boolean));
  const existing = (list) => resolve(list).filter((p) => fs.existsSync(p));
  const realCwd = fs.realpathSync.native(cwd);
  // For the file-tool guards, both spellings: the path as named and where it leads now, so a symlink created later
  // still counts. The masks use only the resolved paths (bwrap can't mount onto a symlink, and masking the target
  // hides it through the link too).
  const secretsReal = resolve(secrets);
  const secretsAll = uniq([...secretsReal, ...lexical(secrets)]);
  const escapes = uniq([...resolve(ESCAPE_PATHS), ...lexical(ESCAPE_PATHS)]);
  const runtime = env.XDG_RUNTIME_DIR || (uid != null ? `/run/user/${uid}` : "");
  // Session sockets: D-Bus, keyrings, gpg/ssh agents and systemd --user live in the runtime dir; tmux in /tmp.
  const sessionAll = resolve([runtime, uid != null && `/tmp/tmux-${uid}`, env.SSH_AUTH_SOCK]);

  const system = (p) => SYSTEM_MOUNTS.find((m) => overlap(p, m));
  const systemWhy = (p) => system(p) && `it overlaps ${system(p)}, which the sandbox mounts itself or keeps from commands`;
  const cwdWhy = systemWhy(realCwd) || (inside(home, realCwd) ? "it contains your home directory"
    : secretsAll.find((s) => inside(realCwd, s)) ? `it is inside the secret ${secretsAll.find((s) => inside(realCwd, s))}`
    : sessionAll.find((s) => inside(realCwd, s)) ? `it is inside ${sessionAll.find((s) => inside(realCwd, s))}, which holds session sockets`
    : escapes.find((e) => overlap(realCwd, e)) ? `it overlaps ${escapes.find((e) => overlap(realCwd, e))}, which runs outside the sandbox later`
    : null);
  if (cwdWhy) throw new Error(`refusing to sandbox the workspace ${realCwd}: ${cwdWhy}. Use a project directory, or --sandbox off.`);
  for (const n of names([...writable, ...extraWritable]))
    if (!realPath(n, home, home)) throw new Error(`refusing to make ${n} writable: it can't be resolved (a symbolic link loop?).`);
  for (const n of names([...gitWritable, ...gitProtect, ...gitNested, ...gitFiles, runtime, env.SSH_AUTH_SOCK]))
    if (!realPath(n, home, home)) throw new Error(`${n} can't be resolved (a symbolic link loop?), so ari can't protect it.`);
  for (const w of resolve(extraWritable)) {
    const why = systemWhy(w) || (inside(home, w) ? "it contains your home directory"
      : secretsAll.find((s) => overlap(w, s)) ? `it overlaps the secret ${secretsAll.find((s) => overlap(w, s))}`
      : escapes.find((e) => overlap(w, e)) ? `it overlaps ${escapes.find((e) => overlap(w, e))}, which runs outside the sandbox later`
      : sessionAll.find((s) => overlap(w, s)) ? `it overlaps ${sessionAll.find((s) => overlap(w, s))}, which holds session sockets`
      : null);
    if (why) throw new Error(`ARI_EXTRA_WRITABLE: refusing to make ${w} writable: ${why}.`);
  }
  // The defaults are checked where they lead too: a ~/.cache that is a symlink to $HOME must not open $HOME.
  for (const n of names(writable)) {
    const w = realPath(n, home, home);
    const why = system(w) ? `that overlaps ${system(w)}, which the sandbox mounts itself or keeps from commands`
      : inside(home, w) ? "that contains your home directory"
      : secretsAll.find((s) => inside(w, s)) ? `that is inside the secret ${secretsAll.find((s) => inside(w, s))}`
      : sessionAll.find((s) => inside(w, s)) ? `that holds session sockets`
      : escapes.find((e) => overlap(w, e)) ? `that overlaps ${escapes.find((e) => overlap(w, e))}, which runs outside the sandbox later`
      : null;
    if (why) throw new Error(`refusing to make ${n} writable: it resolves to ${w}, ${why}. Fix the link or pass --sandbox off.`);
  }
  for (const g of existing([...gitWritable, ...gitProtect])) if (system(g)) throw new Error(`refusing to make the git dir ${g} writable: ${systemWhy(g)}.`);
  const allWritable = uniq([...existing([...writable, ...extraWritable]), ...existing(gitWritable)]);
  // Only a listed secret, or a path inside one, can be allowed.
  for (const n of names(allow)) {
    const a = realPath(n, home, home);
    if (!a || !secretsReal.some((s) => inside(a, s))) throw new Error(`--allow-secret: ${n} isn't one of the hidden secrets or inside one.`);
  }
  const allowed = existing(allow);
  for (const a of allowed)
    if (inside(realCwd, a) || allWritable.some((w) => inside(w, a))) throw new Error(`--allow-secret: ${a} contains the workspace or a writable directory; name the secret file or directory itself.`);
  const session = existing(sessionAll);
  const hidden = secretsReal.filter((s) => fs.existsSync(s) && !allowed.some((a) => inside(s, a)));

  // ---- Git: every git dir, and every .git entry in the workspace ----
  // Variables that change where git finds a repository or its config would make git read something other than
  // what is checked here: refuse them rather than follow them.
  const gitVar = Object.keys(env).find((k) => env[k] != null && (GIT_ENV.includes(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)));
  if (gitVar) throw new Error(`${gitVar} is set; ari can't check what git will read with it. Unset it, or use --sandbox off.`);
  if (env.XDG_CONFIG_HOME && !path.isAbsolute(env.XDG_CONFIG_HOME)) throw new Error("XDG_CONFIG_HOME is a relative path; ari can't check what git will read with it. Make it absolute, or use --sandbox off.");
  const lstat = (f) => { try { return fs.lstatSync(f); } catch { return null; } };
  const cwdGit = path.join(realCwd, ".git");
  // .git entries in the workspace: its own, submodules' (through .gitmodules and core.worktree, now), and those
  // found by the scan at the start of the run (gitNested) or earlier plans (gitFiles), so they stay protected
  // whatever happens to .gitmodules. A directory is a git dir of its own (an old-style submodule, a nested clone).
  const entries = uniq([cwdGit, ...names(gitNested), ...names(gitFiles)].map((f) => path.resolve(realCwd, f)));
  const outsideDirs = existing([...gitProtect, ...gitWritable]).filter(isDir);
  let gitDirs = uniq([...entries.filter((f) => lstat(f)?.isDirectory()), ...outsideDirs]);
  const moreEntries = submoduleGitFiles(realCwd, gitDirs);
  gitDirs = uniq([...gitDirs, ...moreEntries.filter((f) => lstat(f)?.isDirectory())]);
  const gitEntryFiles = uniq([...entries, ...moreEntries]).filter((f) => { const st = lstat(f); return st && !st.isDirectory(); });
  const layouts = gitDirs.map(gitLayout);
  // Config files git reads for these repositories.
  const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const globalConfigs = [path.join(home, ".gitconfig"), path.join(xdg, "git/config"), "/etc/gitconfig"];
  const configs = [...layouts.flatMap((l) => [...l.dirs.flatMap((d) => ["config", "config.worktree"].map((n) => path.join(d, n))),
    ...l.worktrees.map((w) => path.join(w, "config.worktree"))]), ...globalConfigs];

  // ---- Mount targets, all computed and checked here ----
  const roots = uniq([realCwd, ...allWritable]);
  const inRoots = (p) => roots.some((r) => inside(p, r));
  const refuse = (what) => { throw new Error(`${what}; ari can't keep this safe from sandboxed commands. Change it, or use --sandbox off.`); };
  // Git dirs in a writable place get their config, hooks and redirect files read-only and become mount points.
  // One elsewhere is read-only already (and binding it onto itself would make it writable).
  const wLayouts = layouts.filter((l) => inRoots(l.dirs[0]));
  const link = wLayouts.flatMap((l) => l.links)[0];
  if (link) refuse(`${link} is a symbolic link in a git dir`);
  const gitDirsW = wLayouts.flatMap((l) => l.dirs), worktreesW = wLayouts.flatMap((l) => l.worktrees);
  // Anything git reads for these repositories must not lead into a writable place from outside it (a read-only
  // git dir whose config or hooks is a link into ~/.cache, a symlinked submodule dir), and every git dir a .git
  // file or commondir names from a writable place must be one protected here.
  const knownDirs = new Set(layouts.flatMap((l) => [...l.dirs, ...l.worktrees]));
  // A symbolic link on a path (as written, and along every link's own target) that lives in a writable place:
  // a command could point it elsewhere later.
  const swappable = (p, hops = 0) => {
    if (hops > MAX_LINKS) return p;
    for (let q = p; path.dirname(q) !== q; q = path.dirname(q)) {
      if (!lstat(q)?.isSymbolicLink()) continue;
      let parent;
      try { parent = fs.realpathSync.native(path.dirname(q)); } catch { return q; }
      if (inRoots(parent)) return q;
      let target;
      try { target = fs.readlinkSync(q); } catch { return q; }
      if (!target.startsWith("/")) target = `${parent}/${target}`; // as written: "link/.." is left to the kernel
      const inner = swappable(target, hops + 1);
      if (inner) return inner;
    }
    return null;
  };
  const checkPath = (p, what) => {
    const link = swappable(p);
    if (link) refuse(`${what} ${p} goes through the symbolic link ${link}, which lies in a writable place`);
    const real = resolvePath(p);
    if (!real) refuse(`${what} ${p} can't be resolved`);
    return real;
  };
  for (const l of layouts) {
    const spots = [...l.links, ...l.dirs.flatMap((d) => ["config", "hooks", ...GIT_REDIRECTS].map((n) => path.join(d, n))),
      ...l.worktrees.flatMap((w) => WORKTREE_FILES.map((n) => path.join(w, n)))];
    for (const p of spots) {
      if (!lstat(p)) continue;
      const real = checkPath(p, "the git file");
      if (real !== p && inRoots(real)) refuse(`${p} leads into ${real}, a place commands can write`);
    }
    for (const d of l.dirs.slice(1)) {
      const text = readRegular(path.join(d, "config"));
      for (const [k, v] of text == null ? [] : parseGitConfig(text))
        if (k === "core.worktree" && v && DOUBTFUL_PATH.test(v)) refuse(`${path.join(d, "config")} sets core.worktree to ${v}, a form ari doesn't resolve`);
    }
  }
  // What a .git file or commondir names, read exactly like git: a .git file must start with "gitdir: " and a
  // commondir is the whole file; trailing newlines are dropped, and a relative path is relative to the file's dir.
  // The path is kept as written (not normalized): "link/.." means the link target's parent to the kernel, and to git.
  const pointer = (f) => {
    const text = readFollowed(f);
    if (text == null) return null;
    const body = path.basename(f) === "commondir" ? text : text.startsWith("gitdir: ") ? text.slice(8) : null;
    const v = body?.replace(/[\r\n]+$/, "");
    return v ? (v.startsWith("/") ? v : `${path.dirname(f)}/${v}`) : null;
  };
  const pointers = [...gitEntryFiles.filter((f) => lstat(f)?.isFile()), ...layouts.flatMap((l) => [...l.dirs, ...l.worktrees].map((d) => path.join(d, "commondir")))];
  const commonOK = new Set();
  for (const f of pointers) {
    const target = pointer(f);
    if (!target) continue;
    if (swappable(target)) refuse(`${f} names ${target}, which goes through the symbolic link ${swappable(target)} in a writable place`);
    let real;
    try { real = fs.realpathSync.native(target); } catch { refuse(`${f} names ${target}, which doesn't exist`); }
    // Only git dirs checked here as a whole (their config, hooks and links) may be named.
    if (!knownDirs.has(real)) refuse(`${f} names the git dir ${real}, which isn't one ari checks (the workspace's own, its submodules', or the repository's)`);
    // A commondir only as git lays it out: a linked worktree's (in <common>/worktrees/<name>) names <common>, any
    // other names its own git dir; and the dir named has a config (git reads that one, not one next to commondir).
    if (path.basename(f) !== "commondir") continue;
    const own = path.dirname(f), common = path.basename(path.dirname(own)) === "worktrees" ? path.dirname(path.dirname(own)) : own;
    if (real !== resolvePath(common)) refuse(`${f} names ${real}; ari only supports a commondir that names ${common}`);
    if (!lstat(path.join(real, "config"))) refuse(`${f} names ${real}, which has no config file`);
    commonOK.add(f);
  }
  // A git dir without a config file would let a command create one; a linked worktree's git dir (with the
  // commondir checked above) has none.
  for (const g of gitDirsW)
    if (!lstat(path.join(g, "config")) && !commonOK.has(path.join(g, "commondir"))) refuse(`the git dir ${g} has no config file, and commands could create one`);
  // Config files that include other files aren't supported: a plain key scan, no path resolution.
  for (const c of configs) {
    const inc = parseGitConfig(readFollowed(c) ?? "").find(([k]) => /^include(if\..*)?\.path$/.test(k));
    if (inc) refuse(`the git config ${c} has an include (${inc[0]}); configs with include directives aren't supported`);
  }
  for (const c of globalConfigs) checkPath(c, "the git config");
  for (const c of globalConfigs) if (inRoots(c) || inRoots(resolvePath(c) ?? c)) refuse(`the git config ${c} lies in a writable place`);
  const hooks = gitDirsW.map((g) => path.join(g, "hooks"));
  const gitFilesW = [
    ...gitDirsW.flatMap((g) => ["config", ...GIT_REDIRECTS].map((n) => path.join(g, n))),
    ...worktreesW.flatMap((w) => WORKTREE_FILES.map((n) => path.join(w, n))),
    ...gitEntryFiles,
  ];
  const roGit = uniq([...gitFilesW, ...hooks]).filter((f) => lstat(f));
  const tmpfsHooks = hooks.filter((h) => !lstat(h));
  const gitPinDirs = uniq([...gitDirsW, ...wLayouts.flatMap((l) => l.between), ...worktreesW]);
  // Every target must be its own real path: bwrap follows symlinks, so a link anywhere in it would put the mount
  // somewhere else while the link itself stayed replaceable. And every directory between a writable root and a
  // target (or a writable root nested in another) becomes a mount point too: a mount point can't be renamed or
  // removed, but its parent directories can, which would move the protected thing aside.
  const targets = [...session, ...hidden, ...allowed, ...existing(readable), ...gitPinDirs, ...roGit, ...tmpfsHooks, ...roots];
  const pins = new Set(gitPinDirs);
  for (const t of targets)
    for (const r of roots)
      if (inside(t, r) && t !== r) for (let d = path.dirname(t); d !== r; d = path.dirname(d)) pins.add(d);
  for (const p of uniq([...targets, ...pins])) {
    const parent = path.dirname(p);
    let real;
    try { real = fs.realpathSync.native(parent); } catch { real = null; }
    if (lstat(p)?.isSymbolicLink() || (parent !== p && real !== parent))
      throw new Error(`${p} is or lies under a symbolic link, so ari can't keep it in place; replace the link, or use --sandbox off.`);
  }
  return {
    cwd: realCwd, home, allowed, secretsAll, sessionAll, env: restoreEnv,
    writable: allWritable,
    hidden,
    session: session.filter((s, i) => !session.some((t, j) => j !== i && inside(s, t))),
    reveal: allowed, // bound read-only, even inside a writable directory such as ~/.cache
    readable: existing(readable),
    gitDirs,
    // A linked worktree's .git is a file naming its git dir; keep it from being pointed elsewhere.
    gitFile: lstat(cwdGit) && !lstat(cwdGit).isDirectory() ? cwdGit : null,
    // The workspace's .git entries other than a git dir (submodules' .git files); pass them back as `gitFiles`.
    submoduleGitFiles: gitEntryFiles.filter((f) => f !== cwdGit),
    // For bwrapArgs: directories to bind onto themselves (in parent-first order), read-only binds, and missing
    // hooks directories to cover with an empty read-only tmpfs.
    pins: [...pins].sort(), roGit, tmpfsHooks,
    // Every file or directory git would run or follow later, for the file-tool guard (any git dir, wherever it
    // lies and whatever it is called).
    gitProtected: uniq([
      ...layouts.flatMap((l) => l.dirs.flatMap((d) => ["config", "hooks", ...GIT_REDIRECTS].map((n) => path.join(d, n)))),
      ...layouts.flatMap((l) => l.worktrees.flatMap((w) => WORKTREE_FILES.map((n) => path.join(w, n)))),
      ...gitEntryFiles,
    ]),
  };
}

// Why an edit/write is refused in the sandbox, or null. `paths` = { lexical, real } of the target.
export function writeBlockReason({ lexical, real }, plan) {
  if (!real) return "This path can't be resolved (a symbolic link loop or too many links); not writable here.";
  const both = [lexical, real];
  if (both.some((p) => plan.secretsAll.some((s) => inside(p, s)))) return "Secret file; not writable here.";
  if (!inside(real, plan.cwd) && !plan.writable.some((w) => inside(real, w))) return `Outside the workspace (${plan.cwd}).`;
  if (both.some((p) => GIT_PROTECTED.test(p) || plan.gitProtected.some((g) => inside(p, g)))) return "Git config, hooks and redirection files are read-only here.";
  return null;
}

// Why a read is refused, or null. Secrets stay unreadable to the read tool even when --allow-secret opens them
// to commands: the model must never see their contents.
export function readBlockReason({ lexical, real }, plan) {
  const system = "System and process files (/proc, /dev) are not readable here.";
  if (SYSTEM_DENY.some((d) => inside(lexical, d))) return system;
  if (!real) return "This path can't be resolved (a symbolic link loop or too many links); not readable here.";
  const both = [lexical, real];
  if (plan.readable.some((r) => inside(real, r) && inside(lexical, r))) return null;
  if (both.some((p) => SYSTEM_DENY.some((d) => inside(p, d)))) return system;
  if (both.some((p) => plan.secretsAll.some((s) => inside(p, s)))) return "Secret file; not readable here.";
  if (both.some((p) => plan.sessionAll.some((s) => inside(p, s)))) return "Session files; not readable here.";
  return null;
}

// bwrap arguments that run `cmd` (a shell string, or an argv array) in the workspace sandbox.
export function bwrapArgs(plan, cmd) {
  // A PID namespace with a fresh /proc: other processes (and their /proc/<pid>/root and environ) are out of reach.
  const a = ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", "--unshare-pid", "--proc", "/proc"];
  // A private /dev/shm per command, like a private /tmp would be (the real /tmp stays shared).
  if (isDir("/dev/shm")) a.push("--tmpfs", "/dev/shm");
  for (const w of [plan.cwd, ...plan.writable]) a.push("--bind", w, w);
  // Mount points can't be renamed or removed: see sandboxPlan for what is pinned and why.
  for (const d of plan.pins) a.push("--bind", d, d);
  const mask = (p) => a.push(...(isDir(p) ? ["--tmpfs", p] : ["--ro-bind", "/dev/null", p]));
  plan.session.forEach(mask);
  plan.hidden.forEach(mask);
  for (const r of [...plan.reveal, ...plan.readable, ...plan.roGit]) a.push("--ro-bind", r, r);
  for (const h of plan.tmpfsHooks) a.push("--tmpfs", h, "--remount-ro", h);
  for (const [k, v] of Object.entries(plan.env)) a.push(...(v == null ? ["--unsetenv", k] : ["--setenv", k, v]));
  for (const v of ["SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "GPG_AGENT_INFO"]) a.push("--unsetenv", v);
  // --norc/--noprofile: with a socket on stdin and SHLVL unset, bash would otherwise run ~/.bashrc, which may
  // source files from places commands can write.
  a.push("--die-with-parent", "--chdir", plan.cwd, ...(Array.isArray(cmd) ? cmd : ["bash", "--norc", "--noprofile", "-c", cmd]));
  return a;
}

// Cargo writes its package-cache locks and usage database in $CARGO_HOME itself. Create them up front so
// only these files (plus registry/ and git/) need to be writable, not bin/, env or config.toml.
export function prepareCargo(home) {
  const c = path.join(home, ".cargo");
  if (!isDir(c)) return;
  for (const d of ["registry", "git"]) fs.mkdirSync(path.join(c, d), { recursive: true });
  for (const f of [".package-cache", ".package-cache-mutate", ".global-cache"]) fs.closeSync(fs.openSync(path.join(c, f), "a"));
}
