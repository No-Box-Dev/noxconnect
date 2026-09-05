import { parseServiceId } from "../../../lib/service-capabilities";
import { API_VERSION, v1Error, v1Response } from "../../../lib/api-v1";
import { loadServiceCatalog, type ServiceCatalogContext } from "./index";

interface Ctx extends ServiceCatalogContext {
  params: { service: string };
}

// GET /api/v1/services/:service — focus, capabilities, and setup state for one service.
export async function onRequestGet(context: Ctx): Promise<Response> {
  const serviceId = parseServiceId(context.params.service);
  if (!serviceId) return v1Error("service_not_found", "Unknown Nox service", 404);

  const result = await loadServiceCatalog(context);
  if (result.response) return result.response;
  const service = result.body?.services.find((item) => item.id === serviceId);
  if (!service) return v1Error("service_not_found", "Unknown Nox service", 404);

  return v1Response({
    apiVersion: API_VERSION,
    organization: result.body.organization,
    canConfigure: result.body.canConfigure,
    service,
  });
}
