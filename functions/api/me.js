import { getCtx, jsonResponse } from "../lib/db";

// GET /api/me — returns the authenticated user's identity for the current org
// plus the app-level admin flag bootstrapped in `functions/_middleware.js`.
// Clients use this in place of GitHub's /orgs/{org}/memberships/{user}, which
// is a heavy authz check on every load and doesn't carry app-level state.
export async function onRequestGet(context) {
  const { userLogin, orgLogin, isAdmin, isPlatformOperator, projectId, auth } = getCtx(context);
  const projectServices = projectId ? auth?.guestAccess?.projects?.[projectId] : undefined;
  return jsonResponse({
    login: userLogin,
    org: orgLogin,
    isAdmin: Boolean(isAdmin),
    isPlatformOperator: Boolean(isPlatformOperator),
    accessLevel: auth?.accessLevel ?? "member",
    allowedServices: auth?.accessLevel === "guest"
      ? (auth.guestAccess?.organizationWide === true || projectServices === null
        ? ["noxticket", "noxfeed", "noxspot", "noxcue"]
        : projectServices ?? [])
      : ["noxticket", "noxfeed", "noxspot", "noxcue"],
  });
}
