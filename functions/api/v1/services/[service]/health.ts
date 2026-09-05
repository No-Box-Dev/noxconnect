import { API_VERSION, requireV1Member, v1Error, v1Response } from "../../../../lib/api-v1";
import { parseServiceId } from "../../../../lib/service-capabilities";
import { serviceConfigLinks } from "../../../../lib/service-config";
import { loadServiceCatalog, type ServiceCatalogContext } from "../index";

interface Ctx extends ServiceCatalogContext { params: { service: string } }

export async function onRequestGet(context: Ctx): Promise<Response> {
  const accessError = requireV1Member(context);
  if (accessError) return accessError;
  const serviceId = parseServiceId(context.params.service);
  if (!serviceId) return v1Error("service_not_found", "Unknown Nox service", 404);
  const result = await loadServiceCatalog(context);
  if (result.response) return result.response;
  const service = result.body!.services.find((item) => item.id === serviceId)!;
  const checks = [
    { id: "service_enabled", state: service.enabled ? "pass" : "fail", required: true },
    ...service.setup.connections.map((connection) => ({
      id: `${connection.provider}_connection`,
      state: connection.state === "ready" ? "pass" : connection.state === "degraded" ? "warn" : "fail",
      required: connection.requirement === "required",
      detail: connection.state,
    })),
  ];
  const state = !service.enabled ? "disabled" : checks.some((check) => check.required && check.state === "fail") ? "blocked" : checks.some((check) => check.state === "warn") ? "degraded" : "healthy";
  return v1Response({
    apiVersion: API_VERSION,
    organization: result.body!.organization,
    service: service.id,
    state,
    checkedAt: new Date().toISOString(),
    checks,
    links: serviceConfigLinks(serviceId),
  });
}
