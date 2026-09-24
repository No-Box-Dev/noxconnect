// Browser-side feature CRUD. Features live in NoxTicket's own database; the
// Pages Functions under functions/api/v1/features* forward to it. Failures go
// through the shared api helpers so they surface as a toast.
import { apiGet, apiPost, apiPatch, apiDelete } from "./api";
import type { Feature, FeatureStatus } from "./types";

// Feature shape returned by NoxTicket via /api/v1/features
interface NoxTicketFeature {
  number: number;
  title: string;
  status: string;
  backlog: boolean;
  state: "open" | "closed";
  owners: string[];
  statusHistory: Array<{ status: string; at: string }>;
  updatedAt: string;
}

export function withStatusTransition(feature: Feature, newStatus: FeatureStatus): Feature {
  if (feature.status === newStatus) return feature;
  const history = [...(feature.statusHistory ?? [])];
  history.push({ status: newStatus, timestamp: new Date().toISOString() });
  return { ...feature, status: newStatus, statusHistory: history };
}

function toFeature(row: NoxTicketFeature): Feature {
  return {
    id: row.number,
    title: row.title,
    owners: row.owners,
    status: row.status as FeatureStatus,
    backlog: row.backlog,
    updatedAt: row.updatedAt,
    statusHistory: row.statusHistory.map((change) => ({ status: change.status as FeatureStatus, timestamp: change.at })),
  };
}

export async function fetchFeaturesFromD1(state: "open" | "closed" = "open"): Promise<Feature[]> {
  const rows = await apiGet<NoxTicketFeature[]>(`/api/v1/features?state=${state}`);
  return rows.map(toFeature);
}

export async function createFeature(
  _org: string,
  title: string,
  opts: {
    status: FeatureStatus;
    owners?: string[];
    backlog?: boolean;
  },
): Promise<Feature> {
  return toFeature(await apiPost<NoxTicketFeature>("/api/v1/features", {
    title,
    status: opts.status,
    owners: opts.owners ?? [],
    backlog: opts.backlog ?? false,
  }));
}

export async function updateFeature(_org: string, updated: Feature): Promise<Feature> {
  return toFeature(await apiPatch<NoxTicketFeature>(`/api/v1/features/${updated.id}`, {
    title: updated.title,
    status: updated.status,
    owners: updated.owners,
    backlog: updated.backlog ?? false,
  }));
}

export async function deleteFeature(_org: string, issueNumber: number): Promise<void> {
  await apiDelete<unknown>(`/api/v1/features/${issueNumber}`);
}
