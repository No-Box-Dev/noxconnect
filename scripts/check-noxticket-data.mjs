import { createTestHarness } from "wrangler";
import process from "node:process";

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
    await env.DB.exec("CREATE TABLE features (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'open', body TEXT NOT NULL DEFAULT '', assignees_json TEXT NOT NULL DEFAULT '[]', labels_json TEXT NOT NULL DEFAULT '[]', milestone_title TEXT, html_url TEXT, created_at TEXT, updated_at TEXT, gh_synced_at TEXT, UNIQUE(org_id, number))");
    await env.DB.exec("CREATE TABLE specs (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, feature_number INTEGER, is_primary INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', links_json TEXT NOT NULL DEFAULT '[]', archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))");
    await env.DB.exec("CREATE UNIQUE INDEX uq_specs_primary_per_feature ON specs (org_id, feature_number) WHERE is_primary = 1 AND archived = 0 AND feature_number IS NOT NULL");
    await env.DB.exec("CREATE TABLE config (org_id INTEGER NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(org_id, key))");
    await env.DB.exec("CREATE TABLE spec_attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, spec_id INTEGER NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, r2_key TEXT NOT NULL UNIQUE, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))");
    await env.DB.exec("INSERT INTO features (org_id, number, title, state) VALUES (1, 42, 'Seed feature', 'open'), (2, 42, 'Foreign feature', 'open')");
    const api = await worker.getExport();
    const scope = { orgId: 1, userLogin: "alice", isAdmin: true };
    const created = await api.createSpec(scope, {
      title: "Checkout contract",
      featureNumber: 42,
      links: [{ url: "https://example.com/spec" }, { url: "javascript:alert(1)" }],
    });
    if (!created.ok || created.status !== 201 || created.data.links.length !== 1) throw new Error(`Create failed: ${JSON.stringify(created)}`);
    const foreignRead = await api.getSpec({ orgId: 2, userLogin: "mallory" }, created.data.id);
    if (foreignRead.status !== 404) throw new Error(`Cross-org read was not denied: ${JSON.stringify(foreignRead)}`);
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
    const prepared = await api.prepareFeatureCreate(scope, { title: "New checkout", status: "specced" });
    if (!prepared.ok || prepared.data.issue.labels.some((label) => "token" in label)) throw new Error("Feature intent failed");
    const featureReceipt = {
      contract: "noxconnect.connection-receipt", version: 1, commandId: "health-create", idempotencyKey: "health-create",
      capability: "github.issue.create", provider: "github", status: "completed",
      result: { issueNumber: 43, url: "https://github.com/acme/noxconnect/issues/43", state: "open", created: true },
    };
    const committed = await api.commitFeatureReceipt(scope, prepared.data.projection, featureReceipt);
    if (!committed.ok || committed.data.id !== 43) throw new Error(`Feature receipt failed: ${JSON.stringify(committed)}`);
    const featureList = await api.listFeatures(scope, "open");
    if (!featureList.ok || featureList.data.length !== 2) throw new Error("Feature projection failed");
    console.log(JSON.stringify({ service: "noxticket", rpc: "pass", data: "spec+attachment+feature lifecycle and isolation", specId: created.data.id, featureId: 43 }));
  } finally {
    await server.close();
  }
}
