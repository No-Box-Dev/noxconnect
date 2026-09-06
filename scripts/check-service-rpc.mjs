import { createTestHarness } from "wrangler";
import process from "node:process";

const [configPath, expectedService, workerName = expectedService] = process.argv.slice(2);
if (!configPath || !expectedService) {
  console.error("Usage: node scripts/check-service-rpc.mjs <service-wrangler-config> <service-id> [worker-name]");
  process.exitCode = 2;
} else {
  const server = createTestHarness({
    root: process.cwd(),
    workers: [
      {
        configPath: "scripts/service-rpc-health/wrangler.jsonc",
        bindingOverrides: { PRODUCT_SERVICE: workerName },
      },
      { configPath },
    ],
  });

  try {
    await server.listen();
    const response = await server.fetch("/health");
    const manifest = await response.json();
    if (!response.ok || manifest?.contract !== "nox.service-manifest" || manifest?.service?.id !== expectedService) {
      throw new Error(`Invalid ${expectedService} service manifest: ${JSON.stringify(manifest)}`);
    }
    console.log(JSON.stringify({
      service: expectedService,
      rpc: "pass",
      contract: manifest.contract,
      version: manifest.version,
      capabilities: manifest.service.capabilities.length,
    }));
  } finally {
    await server.close();
  }
}
