import { createServerContext } from "../src/server/context";
import { runModelProbe } from "../src/server/model-probe-service";

const nodeMajor = Number(process.versions.node.split(".")[0]);
console.log("Society doctor · 本机发布自检");

if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  console.error(`✗ Node.js ${process.versions.node} 不受支持，需要 Node.js 22 或更高版本。`);
  process.exitCode = 1;
} else {
  console.log(`✓ Node.js ${process.versions.node}`);
}

let context;
try {
  context = createServerContext();
} catch (error) {
  console.error(`✗ 启动配置：${safeMessage(error)}`);
  process.exitCode = 1;
  process.exit();
}

const beforeStorage = context.storage.snapshot();
if (beforeStorage.status === "degraded") {
  console.error(`✗ 本机存储存在 ${beforeStorage.issues.length} 项问题：${beforeStorage.issues.map((issue) => `${issue.store}/${issue.code}`).join("、")}`);
  process.exitCode = 1;
} else {
  console.log("✓ 本机 JSON 存储可读");
}

const enabled = context.models.listModelProfiles().filter((profile) => {
  const provider = context.models.providerProfile(profile.providerProfileId);
  return profile.enabled && provider?.enabled;
});

if (!enabled.length) {
  console.error("✗ 没有已启用的模型。请配置 .env.local 或在模型设置页添加模型。");
  process.exitCode = 1;
} else {
  console.log(`→ 将顺序检查 ${enabled.length} 个已启用模型；禁用模型不会被调用。`);
}

let passed = 0;
for (const profile of enabled) {
  const startedAt = Date.now();
  try {
    const result = await runModelProbe(context, profile.id, profile.defaults.reasoningEffort);
    const elapsed = Date.now() - startedAt;
    if (result.ok) { passed++; console.log(`✓ ${profile.name} · 工具调用通过 · ${elapsed}ms`); }
    else {
      console.error(`✗ ${profile.name} · ${result.protocol.check.errorCode ?? "PROTOCOL_FAILED"} · ${safeMessage(result.message)}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`✗ ${profile.name} · ${safeMessage(error)}`);
    process.exitCode = 1;
  }
}

console.log(`结果：${passed}/${enabled.length} 个模型通过本次连通性检查。`);
if (!passed || context.storage.snapshot().status === "degraded") process.exitCode = 1;
context.runs.store.close();

function safeMessage(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/https?:\/\/[^\s,;]+/gi, "[endpoint]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .slice(0, 300);
}
