import { getCtx, errorResponse } from "./db.js";

export function requireMember(context) {
  const { orgId, orgLogin } = getCtx(context) ?? {};
  if (!orgId || !orgLogin) return errorResponse("Missing org context", 400);
  return null;
}

export function requireAdmin(context) {
  const memberError = requireMember(context);
  if (memberError) return memberError;
  if (!getCtx(context).isAdmin) {
    return errorResponse("Only an organization admin can change this resource", 403);
  }
  return null;
}
