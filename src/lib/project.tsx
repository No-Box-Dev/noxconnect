import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { fetchProjects, type FeedProject } from "@/lib/noxlink-api";

interface ProjectContextValue {
  projects: FeedProject[];
  project: FeedProject;
  setProjectId: (id: string) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { selectedOrg } = useAuth();
  const queryClient = useQueryClient();
  const [storedId, setStoredId] = useState(() => localStorage.getItem("ut_project"));
  const query = useQuery({
    queryKey: ["projects", selectedOrg],
    queryFn: fetchProjects,
    enabled: Boolean(selectedOrg),
  });
  const available = useMemo(
    () => (query.data ?? []).filter((item) => item.archived !== 1),
    [query.data],
  );
  const project = available.find((item) => item.id === storedId)
    ?? available.find((item) => item.routing_enabled === 1)
    ?? available[0];

  // Establish the request context before children mount and start their
  // queries. Deferring this until an effect creates a first-render race where
  // service requests can leave without X-Project-ID.
  if (project && localStorage.getItem("ut_project") !== project.id) {
    localStorage.setItem("ut_project", project.id);
  }

  if (query.isLoading) return null;
  if (query.isError) {
    return <div className="min-h-screen bg-stone-50 p-8 text-sm text-red-700">Projects could not be loaded.</div>;
  }
  if (!project) {
    return <div className="min-h-screen bg-stone-50 p-8 text-sm text-stone-600">No project is available for this organization.</div>;
  }

  const setProjectId = (id: string) => {
    if (!available.some((item) => item.id === id)) return;
    localStorage.setItem("ut_project", id);
    setStoredId(id);
    void queryClient.invalidateQueries();
  };

  return (
    <ProjectContext.Provider value={{ projects: available, project, setProjectId }}>
      {children}
    </ProjectContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useProject() {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject must be used within ProjectProvider with an available project");
  return value;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalProject() {
  return useContext(ProjectContext);
}
