// /api/features/:number — update or close one feature. NoxTicket owns the data.
// PATCH covers title, status, backlog, owners, plan, and state (reopen/close);
// DELETE is kept as the close shortcut.

import { getCtx, errorResponse } from "../../lib/db";
import { callFeatureService } from "../../lib/noxticket-features";
import type { NoxTicketEnvironment } from "../../lib/noxticket-service";

interface Ctx {
  env: NoxTicketEnvironment;
  data: { orgId: number; projectId?: string | null; userLogin: string; isAdmin?: boolean };
  request: Request;
  params?: { number?: string };
}

function scope(context: Ctx) {
  const { orgId, projectId, userLogin, isAdmin } = getCtx(context) as Ctx["data"];
  return { orgId, projectId, userLogin, isAdmin };
}

function featureNumber(context: Ctx): number | null {
  const number = Number(context.params?.number);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export async function onRequestPatch(context: Ctx): Promise<Response> {
  const number = featureNumber(context);
  if (!number) return errorResponse("Invalid feature number", 400);
  let body: unknown;
  try { body = await context.request.json(); } catch {
    return errorResponse("Invalid JSON body", 400);
  }
  const caller = scope(context);
  return callFeatureService(context.env, caller, (service) => service.updateFeature(caller, number, body));
}

export async function onRequestDelete(context: Ctx): Promise<Response> {
  const number = featureNumber(context);
  if (!number) return errorResponse("Invalid feature number", 400);
  const caller = scope(context);
  return callFeatureService(context.env, caller, (service) => service.updateFeature(caller, number, { state: "closed" }));
}
