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
  const capabilities = new Map(service.capabilities.map((capability) => [capability.id, capability]));
  const sections = service.setup.sections.map((section) => {
    const states = section.capabilityIds.map((id) => capabilities.get(id)?.state);
    const state = states.every((item) => item === "disabled") ? "disabled" : states.some((item) => item === "blocked") ? "blocked" : "ready";
    return { ...section, state };
  });
  return v1Response({
    apiVersion: API_VERSION,
    organization: result.body!.organization,
    canConfigure: result.body!.canConfigure,
    service: service.id,
    state: service.setup.state,
    blockers: service.setup.blockers,
    connections: service.setup.connections,
    sections,
    capabilities: service.capabilities,
    links: serviceConfigLinks(serviceId),
  });
}
