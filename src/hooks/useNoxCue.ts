import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type {
  NoxCueEventsResponse,
  NoxCueCustomFeatureInput,
  NoxCueCustomFeatureUpdate,
  NoxCueCustomMetricInput,
  NoxCueCustomMetricUpdate,
  NoxCueCustomMetricsResponse,
  NoxCueDashboardShare,
  NoxCueFeaturesResponse,
  NoxCueGithubIssueProject,
  NoxCueGithubIssueSettingsResponse,
  NoxCueMetricsResponse,
  NoxCueProjectMetricsResponse,
  NoxCueSourceInput,
  NoxCueSourcesResponse,
  NoxCueUserMetricKey,
} from "@/lib/noxcue-api";

const sourcesKey = (org: string | null | undefined) => ["noxcue-sources", org];
const featuresKey = (org: string | null | undefined, sourceId: string) => ["noxcue-features", org, sourceId];
const customMetricsKey = (org: string | null | undefined, sourceId: string) => ["noxcue-custom-metrics", org, sourceId];
const githubIssuesKey = (org: string | null | undefined) => ["noxcue-github-issues", org];

export function useNoxCueGithubIssueSettings() {
  const { selectedOrg } = useAuth();
  return useQuery({
    queryKey: githubIssuesKey(selectedOrg),
    queryFn: () => apiGet<NoxCueGithubIssueSettingsResponse>("/api/v1/cues/github-issues"),
    enabled: Boolean(selectedOrg),
  });
}

export function useSaveNoxCueGithubIssueSettings() {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<NoxCueGithubIssueProject, "projectName" | "repo" | "openIncidents">) =>
      apiPut<{ project: NoxCueGithubIssueProject }>("/api/v1/cues/github-issues", input),
    onSuccess: ({ project }) => client.setQueryData<NoxCueGithubIssueSettingsResponse>(
      githubIssuesKey(selectedOrg),
      (current) => current ? {
        ...current,
        projects: current.projects.map((item) => item.projectId === project.projectId
          ? { ...project, openIncidents: item.openIncidents }
          : item),
      } : current,
    ),
  });
}

export function useNoxCueSources() {
  const { selectedOrg } = useAuth();
  return useQuery({
    queryKey: sourcesKey(selectedOrg),
    queryFn: () => apiGet<NoxCueSourcesResponse>("/api/v1/cues/sources"),
    enabled: Boolean(selectedOrg),
  });
}

const dashboardSharesKey = (org: string | null | undefined) => ["noxcue-dashboard-shares", org];

export function useNoxCueDashboardShares() {
  const { selectedOrg } = useAuth();
  return useQuery({
    queryKey: dashboardSharesKey(selectedOrg),
    queryFn: () => apiGet<{ shares: NoxCueDashboardShare[] }>("/api/v1/cues/shares"),
    enabled: Boolean(selectedOrg),
  });
}

export function useUpsertNoxCueDashboardShare() {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; password: string }) =>
      apiPost<{ share: NoxCueDashboardShare }>("/api/v1/cues/shares", input),
    onSuccess: () => client.invalidateQueries({ queryKey: dashboardSharesKey(selectedOrg) }),
  });
}

export function useDeleteNoxCueDashboardShare() {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) => apiDelete<{ ok: true }>(`/api/v1/cues/shares/${encodeURIComponent(shareId)}`),
    onSuccess: () => client.invalidateQueries({ queryKey: dashboardSharesKey(selectedOrg) }),
  });
}

export function useCreateNoxCueSource() {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NoxCueSourceInput) => apiPost<{ id: string }>("/api/v1/cues/sources", input),
    onSuccess: () => client.invalidateQueries({ queryKey: sourcesKey(selectedOrg) }),
  });
}

export function useSaveNoxCueSource() {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, input }: { sourceId: string; input: NoxCueSourceInput }) =>
      apiPut<{ ok: true }>(`/api/v1/cues/sources/${encodeURIComponent(sourceId)}`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: sourcesKey(selectedOrg) }),
  });
}

export function useTestNoxCueEndpoint() {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => apiPost<{
      healthy: boolean;
      statusCode: number | null;
      latencyMs: number;
      error: string | null;
      queued: true;
      channelConfigured: true;
      deliveryId: string;
      delivered: boolean;
      checkedAt: string;
    }>(`/api/v1/cues/sources/${encodeURIComponent(sourceId)}/health/test`, {}),
    onSettled: () => client.invalidateQueries({ queryKey: sourcesKey(selectedOrg) }),
  });
}

export function useDeleteNoxCueSource() {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => apiDelete<{ ok: true }>(`/api/v1/cues/sources/${encodeURIComponent(sourceId)}`),
    onSuccess: () => client.invalidateQueries({ queryKey: sourcesKey(selectedOrg) }),
  });
}

export function useCreateNoxCueKey() {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, name, kind }: { sourceId: string; name: string; kind: "publishable" | "secret" }) =>
      apiPost<{ key: { id: string; name: string; kind: "publishable" | "secret"; prefix: string; value: string }; warning: string }>(
        `/api/v1/cues/sources/${encodeURIComponent(sourceId)}/keys`, { name, kind },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: sourcesKey(selectedOrg) }),
  });
}

export function useNoxCueFeatures(sourceId: string) {
  const { selectedOrg } = useAuth();
  return useQuery({
    queryKey: featuresKey(selectedOrg, sourceId),
    queryFn: () => apiGet<NoxCueFeaturesResponse>(`/api/v1/cues/sources/${encodeURIComponent(sourceId)}/features`),
    enabled: Boolean(selectedOrg && sourceId),
    refetchInterval: 15_000,
  });
}

export function useCreateNoxCueFeature(sourceId: string) {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NoxCueCustomFeatureInput) => apiPost<NoxCueFeaturesResponse>(
      `/api/v1/cues/sources/${encodeURIComponent(sourceId)}/features`, input,
    ),
    onSuccess: (data) => client.setQueryData(featuresKey(selectedOrg, sourceId), data),
  });
}

export function useSaveNoxCueFeature(sourceId: string) {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ key, input }: { key: string; input: NoxCueCustomFeatureUpdate }) => apiPut<NoxCueFeaturesResponse>(
      `/api/v1/cues/sources/${encodeURIComponent(sourceId)}/features/${encodeURIComponent(key)}`, input,
    ),
    onSuccess: (data) => client.setQueryData(featuresKey(selectedOrg, sourceId), data),
  });
}

export function useDeleteNoxCueFeature(sourceId: string) {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => apiDelete<NoxCueFeaturesResponse>(
      `/api/v1/cues/sources/${encodeURIComponent(sourceId)}/features/${encodeURIComponent(key)}`,
    ),
    onSuccess: (data) => client.setQueryData(featuresKey(selectedOrg, sourceId), data),
  });
}

export function useNoxCueCustomMetrics(sourceId: string) {
  const { selectedOrg } = useAuth();
  return useQuery({
    queryKey: customMetricsKey(selectedOrg, sourceId),
    queryFn: () => apiGet<NoxCueCustomMetricsResponse>(`/api/v1/cues/sources/${encodeURIComponent(sourceId)}/custom-metrics`),
    enabled: Boolean(selectedOrg && sourceId),
  });
}

export function useCreateNoxCueCustomMetric(sourceId: string) {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NoxCueCustomMetricInput) => apiPost<NoxCueCustomMetricsResponse>(
      `/api/v1/cues/sources/${encodeURIComponent(sourceId)}/custom-metrics`, input,
    ),
    onSuccess: (data) => client.setQueryData(customMetricsKey(selectedOrg, sourceId), data),
  });
}

export function useSaveNoxCueCustomMetric(sourceId: string) {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ key, input }: { key: string; input: NoxCueCustomMetricUpdate }) => apiPut<NoxCueCustomMetricsResponse>(
      `/api/v1/cues/sources/${encodeURIComponent(sourceId)}/custom-metrics/${encodeURIComponent(key)}`, input,
    ),
    onSuccess: (data) => client.setQueryData(customMetricsKey(selectedOrg, sourceId), data),
  });
}

export function useDeleteNoxCueCustomMetric(sourceId: string) {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => apiDelete<NoxCueCustomMetricsResponse>(
      `/api/v1/cues/sources/${encodeURIComponent(sourceId)}/custom-metrics/${encodeURIComponent(key)}`,
    ),
    onSuccess: (data) => client.setQueryData(customMetricsKey(selectedOrg, sourceId), data),
  });
}

export function useRevokeNoxCueKey() {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, keyId }: { sourceId: string; keyId: string }) =>
      apiDelete<{ ok: true }>(`/api/v1/cues/sources/${encodeURIComponent(sourceId)}/keys/${encodeURIComponent(keyId)}`),
    onSuccess: () => client.invalidateQueries({ queryKey: sourcesKey(selectedOrg) }),
  });
}

export function useNoxCueEvents(sourceId: string) {
  const { selectedOrg } = useAuth();
  return useQuery({
    queryKey: ["noxcue-events", selectedOrg, sourceId],
    queryFn: () => apiGet<NoxCueEventsResponse>(`/api/v1/cues/events?sourceId=${encodeURIComponent(sourceId)}&limit=10`),
    enabled: Boolean(selectedOrg && sourceId),
  });
}

export function useNoxCueMetrics(sourceId: string) {
  const { selectedOrg } = useAuth();
  return useQuery({
    queryKey: ["noxcue-metrics", selectedOrg, sourceId],
    queryFn: () => apiGet<NoxCueMetricsResponse>(`/api/v1/cues/metrics?sourceId=${encodeURIComponent(sourceId)}&days=31`),
    enabled: Boolean(selectedOrg && sourceId),
  });
}

export function useUpdateNoxCueError(sourceId: string) {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ fingerprint, status }: {
      fingerprint: string;
      status: "open" | "acknowledged" | "resolved";
    }) => apiPut<{ status: "open" | "acknowledged" | "resolved"; updatedAt: string }>(
      `/api/v1/cues/errors/${encodeURIComponent(sourceId)}/${encodeURIComponent(fingerprint)}`,
      { status },
    ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["noxcue-metrics", selectedOrg, sourceId] }),
  });
}

const projectMetricsKey = (org: string | null | undefined, projectId: string | null) =>
  ["noxcue-project-metrics", org, projectId];

export function useNoxCueProjectMetrics(projectId: string | null) {
  const { selectedOrg } = useAuth();
  return useQuery({
    queryKey: projectMetricsKey(selectedOrg, projectId),
    queryFn: () => apiGet<NoxCueProjectMetricsResponse>(
      `/api/v1/cues/projects/${encodeURIComponent(projectId!)}/metrics`,
    ),
    enabled: Boolean(selectedOrg && projectId),
  });
}

export function useSaveNoxCueProjectMetrics(projectId: string | null) {
  const { selectedOrg } = useAuth();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabledMetricKeys: NoxCueUserMetricKey[]) => apiPut<NoxCueProjectMetricsResponse>(
      `/api/v1/cues/projects/${encodeURIComponent(projectId!)}/metrics`,
      { enabledMetricKeys },
    ),
    onSuccess: (data) => client.setQueryData(projectMetricsKey(selectedOrg, projectId), data),
  });
}
