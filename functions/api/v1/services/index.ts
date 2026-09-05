import { getCtx } from "../../../lib/db";
import { getEnabledApps } from "../../../lib/apps.js";
import { buildServiceCatalog } from "../../../lib/service-capabilities";
import { getNoxDb, type NoxDatabaseEnv } from "../../../lib/nox-db";
import { API_VERSION, normalizeLegacyError, v1Error, v1Response } from "../../../lib/api-v1";
import { onRequestGet as getIntegrationStatus } from "../../integrations/status";

export interface ServiceCatalogContext {
  env: NoxDatabaseEnv & {
    GITHUB_APP_ID?: string;
    GITHUB_APP_PRIVATE_KEY?: string;
    SLACK_CLIENT_ID?: string;
    SLACK_CLIENT_SECRET?: string;
    SLACK_SIGNING_SECRET?: string;
    SLACK_APP_ID?: string;
    SLACK_ACCEPT_LEGACY_INSTALLS?: string;
  };
  data: { orgId: number; orgLogin: string; isAdmin: boolean };
}

interface IntegrationStatus {
  github: {
    configured: boolean;
    connected: boolean;
    bootstrapping: boolean;
    health: string;
  };
  slack: {
    configured: boolean;
    connected: boolean;
    needsReconnect: boolean;
    health: string;
  };
}

export async function loadServiceCatalog(context: ServiceCatalogContext) {
  const { orgId, orgLogin, isAdmin } = getCtx(context) as ServiceCatalogContext["data"];
  if (!orgId || !orgLogin) return { response: v1Error("missing_org_context", "Missing organization context", 400) };
  const db = getNoxDb(context.env);

  const [rawEnabledApps, statusResponse] = await Promise.all([
    getEnabledApps(db, orgId),
    getIntegrationStatus(context as never),
  ]);
  if (!statusResponse.ok) return { response: await normalizeLegacyError(statusResponse) };

  const integrations = await statusResponse.json() as IntegrationStatus;
  const enabledApps = {
    noxticket: rawEnabledApps.noxticket !== false,
    noxfeed: rawEnabledApps.noxfeed !== false,
    noxspot: rawEnabledApps.noxspot !== false,
    noxcue: rawEnabledApps.noxcue !== false,
  };
  return {
    body: {
      apiVersion: API_VERSION,
      organization: { login: orgLogin },
      canConfigure: Boolean(isAdmin),
      services: buildServiceCatalog({ enabledApps, integrations }),
    },
  };
}

// GET /api/v1/services — capability-first discovery for every Nox service.
export async function onRequestGet(context: ServiceCatalogContext): Promise<Response> {
  const result = await loadServiceCatalog(context);
  if (result.response) return result.response;

  return v1Response(result.body);
}
