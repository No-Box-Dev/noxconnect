import { createTestHarness } from "wrangler";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

// Apply NoxTicket's own migrations so this check exercises the real schema.
async function applyMigrations(db, configPath) {
  const dir = join(dirname(configPath), "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, file), "utf8").replace(/--.*$/gm, "");
    const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
}

const [configPath] = process.argv.slice(2);
if (!configPath) {
  console.error("Usage: node scripts/check-noxticket-data.mjs <noxticket-wrangler-config>");
  process.exitCode = 2;
} else {
  const server = createTestHarness({ workers: [{ configPath }] });
  try {
    await server.listen();
    const worker = server.getWorker("noxticket");
    const env = await worker.getEnv();
    await applyMigrations(env.DB, configPath);
    const api = await worker.getExport();
    const scope = { orgId: 1, projectId: "proj_a", userLogin: "alice", isAdmin: true };
    const feature = await api.createFeature(scope, { title: "Checkout", status: "specced" });
    if (!feature.ok || feature.status !== 201) throw new Error(`Feature create failed: ${JSON.stringify(feature)}`);
    const created = await api.createSpec(scope, {
      title: "Checkout contract",
      featureNumber: feature.data.number,
      links: [{ url: "https://example.com/spec" }, { url: "javascript:alert(1)" }],
    });
    if (!created.ok || created.status !== 201 || created.data.links.length !== 1) throw new Error(`Create failed: ${JSON.stringify(created)}`);
    const foreignRead = await api.getSpec({ orgId: 1, projectId: "proj_b", userLogin: "mallory" }, created.data.id);
    if (foreignRead.status !== 404) throw new Error(`Cross-project read was not denied: ${JSON.stringify(foreignRead)}`);
    const updated = await api.updateSpec(scope, created.data.id, { description: "Versioned behavior" });
    if (!updated.ok || updated.data.description !== "Versioned behavior") throw new Error(`Update failed: ${JSON.stringify(updated)}`);
    const archived = await api.setSpecArchived(scope, created.data.id, true);
    if (!archived.ok || !archived.data.archived) throw new Error(`Archive failed: ${JSON.stringify(archived)}`);
    const active = await api.listSpecs(scope);
    const all = await api.listSpecs(scope, { includeArchived: true });
    if (active.data.specs.length !== 0 || all.data.specs.length !== 1) throw new Error("Archive filtering failed");
    const attachment = await api.putAttachment(scope, created.data.id, "contract.md", new TextEncoder().encode("# Contract").buffer);
    if (!attachment.ok || attachment.status !== 201) throw new Error(`Attachment upload failed: ${JSON.stringify(attachment)}`);
    const downloaded = await api.getAttachment(scope, created.data.id, attachment.data.id);
    if (!downloaded.ok || await downloaded.text() !== "# Contract") throw new Error("Attachment download failed");
    const removed = await api.deleteAttachment(scope, created.data.id, attachment.data.id);
    if (!removed.ok) throw new Error("Attachment delete failed");
    const moved = await api.updateFeature(scope, feature.data.number, { status: "staging" });
    if (!moved.ok || moved.data.statusHistory.length !== 2) throw new Error(`Feature update failed: ${JSON.stringify(moved)}`);
    const foreignFeatures = await api.listFeatures({ ...scope, projectId: "proj_b" }, "open");
    if (!foreignFeatures.ok || foreignFeatures.data.length !== 0) throw new Error("Feature project isolation failed");
    const featureList = await api.listFeatures(scope, "open");
    if (!featureList.ok || featureList.data.length !== 1) throw new Error("Feature list failed");
    console.log(JSON.stringify({ service: "noxticket", rpc: "pass", data: "spec+attachment+feature lifecycle and isolation", specId: created.data.id, featureId: feature.data.number }));
  } finally {
    await server.close();
  }
}
