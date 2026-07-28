import { createChernozemAgent, InMemoryAgentEventSink } from "@chernozem/agent-runtime";
import { getEnvApiKey, getModels, getProviders, type KnownProvider } from "@mariozechner/pi-ai";

const providerName = process.env.PI_PROVIDER;
const modelId = process.env.PI_MODEL;

if (!providerName || !modelId) {
  throw new Error("Set PI_PROVIDER and PI_MODEL before running pnpm agent:smoke.");
}

if (!getProviders().includes(providerName as KnownProvider)) {
  throw new Error(`Unknown PI_PROVIDER: ${providerName}`);
}

const provider = providerName as KnownProvider;
const model = getModels(provider).find((candidate) => candidate.id === modelId);
if (!model) {
  throw new Error(`Unknown model ${modelId} for provider ${provider}.`);
}

const eventSink = new InMemoryAgentEventSink();
const agent = createChernozemAgent({
  model,
  eventSink,
  getApiKey: (requestedProvider) => getEnvApiKey(requestedProvider),
  scope: {
    organizationId: "demo-organization",
    taskId: "demo-task",
    fieldIds: ["field-001"],
    crop: "corn",
    period: { start: "2026-06-01", end: "2026-06-30" },
  },
});

await agent.prompt("读取当前任务范围，然后用一句中文说明分析对象。 ");
await agent.waitForIdle();

const finalMessage = agent.state.messages.at(-1);
console.log(JSON.stringify({ finalMessage, events: eventSink.records }, null, 2));
