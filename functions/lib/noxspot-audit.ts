type NoxSpotAuditAction = "site.created" | "site.updated" | "site.deleted" | "site.migrated";

export function noxSpotAuditStatement(
  db: D1Database,
  input: {
    orgId: number;
    projectId: string;
    siteId: string;
    actorLogin: string;
    action: NoxSpotAuditAction;
    changes?: Record<string, unknown>;
  },
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO noxspot_config_audit
       (id, org_id, project_id, site_id, actor_login, action, changes_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    input.orgId,
    input.projectId,
    input.siteId,
    input.actorLogin,
    input.action,
    JSON.stringify(input.changes ?? {}),
  );
}
