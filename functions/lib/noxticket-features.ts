import { callNoxTicket, type NoxTicketEnvironment, type NoxTicketScope, type NoxTicketServiceBinding, type NoxTicketServiceResult } from "./noxticket-service";

// Features are owned by the NoxTicket service (its own D1, scoped per project).
// NoxConnect only authenticates the caller and forwards the request.
export async function callFeatureService(
  env: NoxTicketEnvironment,
  scope: NoxTicketScope,
  operation: (service: NoxTicketServiceBinding) => Promise<NoxTicketServiceResult>,
): Promise<Response> {
  if (!scope.projectId) return Response.json({ error: "Select a project to use NoxTicket features" }, { status: 400 });
  const response = await callNoxTicket(env, operation);
  if (response) return response;
  console.error(JSON.stringify({ event: "noxticket_feature_service_missing" }));
  return Response.json({ error: "NoxTicket is not available in this environment", code: "service_unavailable", service: "noxticket" }, { status: 503 });
}
