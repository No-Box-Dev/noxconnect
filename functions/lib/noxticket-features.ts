import { executeConnectionCapability } from "./connection-capability-executor";
import { serviceResultResponse, type NoxTicketEnvironment, type NoxTicketScope, type NoxTicketServiceResult } from "./noxticket-service";

interface Environment extends NoxTicketEnvironment {
  DB: D1Database;
  TASK_QUEUE: Queue;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  ENCRYPTION_KEY?: string;
}

interface PreparedFeature {
  repository?: string;
  issue?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  noop?: boolean;
  feature?: unknown;
}

function key(request: Request) {
  const supplied = request.headers.get("Idempotency-Key")?.trim();
  return supplied && supplied.length <= 200 ? supplied : crypto.randomUUID();
}

async function projectIdForRepository(db: D1Database, orgId: number, repository: string) {
  const row = await db.prepare(
    `SELECT project.id
       FROM projects project
       JOIN orgs org ON org.github_login = project.owner_id
      WHERE org.id = ? AND project.repo = ? AND COALESCE(project.archived, 0) = 0
      LIMIT 1`,
  ).bind(orgId, repository).first<{ id: string }>();
  return row?.id ?? null;
}

function unavailable(error: unknown) {
  console.error(JSON.stringify({ event: "noxticket_feature_service_failed", error: error instanceof Error ? error.message : String(error) }));
  return Response.json({ error: "NoxTicket is temporarily unavailable", code: "service_unavailable", service: "noxticket" }, { status: 503 });
}

export async function delegateFeatureList(env: Environment, scope: NoxTicketScope, state: string): Promise<Response | null> {
  if (!env.NOXTICKET_SERVICE) return null;
  try { return serviceResultResponse(await env.NOXTICKET_SERVICE.listFeatures(scope, state)); }
  catch (error) { return unavailable(error); }
}

export async function delegateFeatureMutation(
  env: Environment,
  scope: NoxTicketScope,
  request: Request,
  operation: "create" | "update" | "close",
  number?: number,
  input?: unknown,
): Promise<Response | null> {
  const service = env.NOXTICKET_SERVICE;
  if (!service) return null;
  try {
    let prepared: NoxTicketServiceResult;
    if (operation === "create") prepared = await service.prepareFeatureCreate(scope, input);
    else if (operation === "update") prepared = await service.prepareFeatureUpdate(scope, number!, input);
    else prepared = await service.prepareFeatureClose(scope, number!);
    if (!prepared.ok) return serviceResultResponse(prepared);
    const data = prepared.data as PreparedFeature;
    if (data.noop) return Response.json(data.feature);
    if (!data.repository || !data.issue || !data.projection) throw new Error("NoxTicket returned an incomplete feature intent");
    const projectId = await projectIdForRepository(env.DB, scope.orgId, data.repository);
    if (!projectId) return Response.json({ error: `Feature repository ${data.repository} is not an active project` }, { status: 412 });
    const idempotencyKey = key(request);
    const commandId = crypto.randomUUID();
    const receipt = await executeConnectionCapability(env, {
      contract: "noxconnect.connection-capability",
      version: 1,
      commandId,
      idempotencyKey,
      service: "noxticket",
      organizationId: scope.orgId,
      projectId,
      capability: operation === "create" ? "github.issue.create" : "github.issue.update",
      input: operation === "create"
        ? { repository: data.repository, idempotencyMarker: `<!-- nox-command:${idempotencyKey} -->`, issue: data.issue }
        : { repository: data.repository, issueNumber: number, issue: data.issue },
    });
    const committed = await service.commitFeatureReceipt(scope, data.projection, receipt);
    if (!committed.ok) return serviceResultResponse(committed);
    const response = operation === "close" ? Response.json({ ok: true }) : serviceResultResponse(committed);
    response.headers.set("Idempotency-Key", idempotencyKey);
    return response;
  } catch (error) {
    return unavailable(error);
  }
}
