// Shared DTO shape + row-to-DTO mapper for the manual Specs feature.
// Both /api/specs and /api/specs/:id return the same shape, so the mapper
// lives here (Pages Functions can't safely cross-import between route files).

import { sanitizeSpecLinks, type SpecLink } from "./spec-links";

export interface SpecRow {
  id: number;
  org_id: number;
  project_id: string;
  feature_number: number | null;
  is_primary: number;
  title: string;
  description: string;
  links_json: string;
  archived: number;
  archived_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SpecDto {
  id: number;
  projectId: string;
  /** Issue number of the Feature this spec belongs to, or null when unfiled. */
  featureNumber: number | null;
  /** The spec selected as this Feature's direct card link. */
  isPrimary: boolean;
  title: string;
  description: string;
  links: SpecLink[];
  archived: boolean;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function specRowToDto(row: SpecRow): SpecDto {
  let links: SpecLink[] = [];
  try {
    const parsed = JSON.parse(row.links_json || "[]");
    links = sanitizeSpecLinks(parsed);
  } catch {
    links = [];
  }
  return {
    id: row.id,
    projectId: row.project_id,
    featureNumber: row.feature_number,
    isPrimary: row.is_primary === 1,
    title: row.title,
    description: row.description ?? "",
    links,
    archived: row.archived === 1,
    archivedAt: row.archived_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
