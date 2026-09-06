import { createTestHarness } from "wrangler";
import process from "node:process";

const [configPath] = process.argv.slice(2);
if (!configPath) process.exitCode = 2;
else {
  const server = createTestHarness({ workers: [{ configPath }] });
  try {
    await server.listen();
    const api = await server.getWorker("noxfeed-response").getExport();
    const event = { type: "github:pr:opened", repo: "app", created_at: "2026-09-06T10:00:00Z", payload: { pr: { number: 1, title: "Fix checkout" } } };
    const prompt = await api.buildPrompt("actor", { actorName: "Alex", projectName: "App", event });
    const response = await api.buildSlackResponse("posts", { actorName: "Alex", projectName: "App", summary: "Duplicate payments are prevented.", prUrl: "https://github.com/acme/app/pull/1", prNumber: 1 });
    if (!prompt?.prompt?.system || !prompt?.prompt?.user || response?.contract !== "noxfeed.response") throw new Error("NoxFeed policy RPC failed");
    if (/authorization|api[_-]?key|token/i.test(JSON.stringify({ prompt, response }))) throw new Error("Credential-shaped output detected");
    console.log(JSON.stringify({ service: "noxfeed", rpc: "pass", policy: "prompt+Slack presentation", credentialInProduct: false }));
  } finally { await server.close(); }
}
