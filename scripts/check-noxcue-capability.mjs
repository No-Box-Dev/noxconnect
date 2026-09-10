import { createTestHarness } from "wrangler";
import process from "node:process";

const [noxCueConfig] = process.argv.slice(2);
if (!noxCueConfig) {
  console.error("Usage: node scripts/check-noxcue-capability.mjs <noxcue-wrangler-config>");
  process.exitCode = 2;
} else {
  const server = createTestHarness({ workers: [
    { configPath: noxCueConfig, bindingOverrides: { NOXCONNECT_CAPABILITIES: "fake-connection-capability" } },
    { configPath: "scripts/fake-connection-capability/wrangler.jsonc" },
  ] });
  try {
    await server.listen();
    const noxCue = await server.getWorker("noxcue").getExport();
    const response = await noxCue.buildDigestResponse(
      "Playnist", "2026-09-05",
      { "users.new": 12 },
      { "users.new": { yesterday: 8, average30d: 9.5, sampleDays: 30 } },
      {},
      { organizationId: 1, projectId: "project-1", sourceId: "source-1" },
    );
    if (response?.contract !== "noxcue.response" || !JSON.stringify(response).includes("12 new users")) {
      throw new Error(`NoxCue capability RPC failed: ${JSON.stringify(response)}`);
    }
    console.log(JSON.stringify({ service: "noxcue", rpc: "pass", capability: "project-scoped managed AI", credentialInProduct: false }));
  } finally { await server.close(); }
}
