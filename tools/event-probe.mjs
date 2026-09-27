// Diagnostic probe used while tuning ari (not needed to use ari). It sends real requests through your
// pi ChatGPT/Codex login and counts against your quota. Run from the repo root after `npm ci`: node tools/event-probe.mjs
// Stream timing at high effort: does the reasoning summary give a heartbeat while the model thinks?
// usage: node event-probe.mjs <model-id> <priority|standard> <effort> <summary: auto|off> [n]
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { loaderOptions } from "../lib.mjs";

const [id = "gpt-6-sol", tier = "priority", level = "xhigh", summary = "auto", n = 3] = process.argv.slice(2);
const agentDir = path.join(os.homedir(), ".local/state/ari/pi");
const rt = await ModelRuntime.create({ authPath: path.join(os.homedir(), ".pi/agent/auth.json"), modelsPath: path.join(agentDir, "models.json") });
const model = { ...rt.getModel("openai-codex", "gpt-6-astra"), id, name: id, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } };
const one = async (i) => {
  let t0 = 0, last = 0, maxGap = 0, deltas = 0, think = 0, visible = 0;
  const loader = new DefaultResourceLoader(loaderOptions({
    cwd: "/tmp", agentDir, prompt: "Answer with the number only.", context: false,
    extensionFactories: [(pi) => pi.on("before_provider_request", (e) => {
      t0 = last = Date.now();
      const p = { ...e.payload, service_tier: tier === "priority" ? "priority" : undefined };
      if (summary === "off" && p.reasoning) p.reasoning = { effort: p.reasoning.effort };
      return p;
    })],
  }));
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: "/tmp", agentDir, model, thinkingLevel: level, modelRuntime: rt, noTools: "all", resourceLoader: loader,
    sessionManager: SessionManager.inMemory("/tmp"), settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
  });
  session.subscribe((e) => {
    if (e.type !== "message_update" && !(e.type === "message_start" && e.message?.role === "assistant")) return;
    const now = Date.now(), k = e.assistantMessageEvent?.type;
    if (k === "thinking_start") think ||= now;
    if (/^(text|toolcall)_/.test(k ?? "")) visible ||= now;
    if (k === "thinking_delta") deltas++;
    if (process.env.TRACE) console.error(((now - t0) / 1000).toFixed(1), e.type, k ?? "", k === "thinking_delta" ? JSON.stringify(e.assistantMessageEvent.delta).slice(0, 60) : "");
    if (think && !visible) maxGap = Math.max(maxGap, now - last);
    last = now;
  });
  await session.prompt(`How many integers n with 1 <= n <= ${40000 + i * 13} have a digit sum divisible by 7, are not divisible by 3, and contain no digit 5? Work it out exactly.`);
  const m = session.messages.at(-1);
  const s = (t) => ((t - t0) / 1000).toFixed(1);
  return { i, total: s(Date.now()), thinkStart: s(think), firstVisible: visible ? s(visible) : null, maxSilentGapDuringReasoning: (maxGap / 1000).toFixed(1), summaryDeltas: deltas, reasoning: m.usage?.reasoning, out: m.usage?.output, stop: m.stopReason };
};
for (const r of await Promise.all(Array.from({ length: +n }, (_, i) => one(i)))) console.log(JSON.stringify(r));
process.exit(0);
