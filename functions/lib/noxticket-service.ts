export interface NoxTicketScope {
  orgId: number;
  userLogin: string;
  isAdmin?: boolean;
}

export interface NoxTicketServiceResult {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

export interface NoxTicketServiceBinding {
  listSpecs(scope: NoxTicketScope, filters?: { featureNumber?: number | "unfiled"; includeArchived?: boolean }): Promise<NoxTicketServiceResult>;
  getSpec(scope: NoxTicketScope, id: number): Promise<NoxTicketServiceResult>;
  createSpec(scope: NoxTicketScope, input: unknown): Promise<NoxTicketServiceResult>;
  updateSpec(scope: NoxTicketScope, id: number, input: unknown): Promise<NoxTicketServiceResult>;
  setSpecArchived(scope: NoxTicketScope, id: number, archived: boolean): Promise<NoxTicketServiceResult>;
  listAttachments(scope: NoxTicketScope, specId: number): Promise<NoxTicketServiceResult>;
  putAttachment(scope: NoxTicketScope, specId: number, filename: string, bytes: ArrayBuffer): Promise<NoxTicketServiceResult>;
  getAttachment(scope: NoxTicketScope, specId: number, attachmentId: number): Promise<Response>;
  deleteAttachment(scope: NoxTicketScope, specId: number, attachmentId: number): Promise<NoxTicketServiceResult>;
  listFeatures(scope: NoxTicketScope, state?: string): Promise<NoxTicketServiceResult>;
  prepareFeatureCreate(scope: NoxTicketScope, input: unknown): Promise<NoxTicketServiceResult>;
  prepareFeatureUpdate(scope: NoxTicketScope, number: number, input: unknown): Promise<NoxTicketServiceResult>;
  prepareFeatureClose(scope: NoxTicketScope, number: number): Promise<NoxTicketServiceResult>;
  commitFeatureReceipt(scope: NoxTicketScope, projection: Record<string, unknown>, receipt: unknown): Promise<NoxTicketServiceResult>;
  buildActivityMessage(input: unknown): Promise<{ text: string; blocks: unknown[]; client_msg_id?: string }>;
  buildTestMessage(orgLogin: string): Promise<{ text: string; blocks: unknown[] }>;
}

export interface NoxTicketEnvironment {
  NOXTICKET_SERVICE?: NoxTicketServiceBinding;
}

export function serviceResultResponse(result: NoxTicketServiceResult): Response {
  return Response.json(result.ok ? result.data : { error: result.error ?? "NoxTicket request failed" }, {
    status: result.status,
  });
}

export async function callNoxTicket(
  env: NoxTicketEnvironment,
  operation: (binding: NoxTicketServiceBinding) => Promise<NoxTicketServiceResult>,
): Promise<Response | null> {
  if (!env.NOXTICKET_SERVICE) return null;
  try {
    return serviceResultResponse(await operation(env.NOXTICKET_SERVICE));
  } catch (error) {
    console.error(JSON.stringify({
      event: "noxticket_service_unavailable",
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json({ error: "NoxTicket is temporarily unavailable", code: "service_unavailable", service: "noxticket" }, { status: 503 });
  }
}
