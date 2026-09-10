import { createTestHarness } from "wrangler";
import process from "node:process";

const [configPath] = process.argv.slice(2);
if (!configPath) process.exitCode = 2;
else {
  const server = createTestHarness({ workers: [
    { configPath, bindingOverrides: { NOXCUE_INGEST: "fake-connection-capability" } },
    { configPath: "scripts/fake-connection-capability/wrangler.jsonc" },
  ] });
  try {
    await server.listen();
    const worker = server.getWorker("noxspot-api");
    const api = await worker.getExport();
    const manifest = await api.describe();
    const health = await worker.fetch("/health");
    const body = await health.json();
    if (manifest?.service?.id !== "noxspot" || body?.owner !== "noxspot") throw new Error("NoxSpot relocated runtime health failed");
    console.log(JSON.stringify({ service: "noxspot", rpc: "pass", runtimeOwner: body.owner, providerCredentials: false }));
  } finally { await server.close(); }
}
