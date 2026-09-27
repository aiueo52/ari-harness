// Diagnostic probe used while tuning ari (not needed to use ari). It sends real requests through your
// pi ChatGPT/Codex login and counts against your quota. Run from the repo root after `npm ci`: node tools/concurrency-probe.mjs
// How many GPT-6 requests can run at once on this account? Fires N tiny Luna prompts together.
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { loaderOptions } from "../lib.mjs";

const n = +(process.argv[2] || 12);
const agentDir = path.join(os.homedir(), ".local/state/ari/pi");
const rt = await ModelRuntime.create({ authPath: path.join(os.homedir(), ".pi/agent/auth.json"), modelsPath: path.join(agentDir, "models.json") });
const model = { ...rt.getModel("openai-codex", "gpt-6-astra"), id: "gpt-6-luna", name: "gpt-6-luna" };
const t0 = Date.now();
const one = async (i) => {
  const loader = new DefaultResourceLoader(loaderOptions({ cwd: "/tmp", agentDir, prompt: "Be terse.", context: false }));
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: "/tmp", agentDir, model, thinkingLevel: "low", modelRuntime: rt, noTools: "all", resourceLoader: loader,
    sessionManager: SessionManager.inMemory("/tmp"), settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
  });
  const s = Date.now();
  await session.prompt(`Reply with exactly: ${i}`);
  const m = session.messages.at(-1);
  return { i, ok: m.stopReason === "stop", ms: Date.now() - s, err: m.errorMessage?.slice(0, 120) };
};
const res = await Promise.all(Array.from({ length: n }, (_, i) => one(i)));
const ok = res.filter((r) => r.ok);
console.log(JSON.stringify({ n, ok: ok.length, wallMs: Date.now() - t0, maxMs: Math.max(...res.map((r) => r.ms)), errors: res.filter((r) => !r.ok) }, null, 1));
process.exit(0);
