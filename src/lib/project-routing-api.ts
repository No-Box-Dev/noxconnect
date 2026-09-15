import { apiGet, apiPut } from "./api";

export interface ProjectDestination {
  connectionId: string;
  channelId: string;
}

export interface ProjectRouting {
  id: string;
  name: string;
  archived: boolean;
  enabled: boolean;
  repositories: string[];
  routes: {
    noxfeedPosts: ProjectDestination;
    noxfeedReleaseNotes: ProjectDestination;
    noxCue: ProjectDestination;
    noxCueAlerts: ProjectDestination;
  };
}

export interface ProjectRoutingResponse {
  projects: ProjectRouting[];
  repositories: string[];
}

export interface SaveProjectRouting {
  enabled: boolean;
  repositories: string[];
  routes: ProjectRouting["routes"];
}

export const fetchProjectRouting = () => apiGet<ProjectRoutingResponse>("/api/v1/projects/routing");

export const saveProjectRouting = (projectId: string, routing: SaveProjectRouting) =>
  apiPut<{ ok: true; projectId: string; enabled: boolean; repositories: string[] }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/routing`,
    routing,
  );
