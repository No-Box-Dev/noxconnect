import { apiGet, apiPut } from "./api";

export type AiMode = "managed" | "disabled";

export type ManagedAiServiceStatus = {
  provider: string;
  model: string;
  available: boolean;
};

export type LlmSettings = {
  mode: AiMode;
  managed: ManagedAiServiceStatus & {
    services: {
      noxfeed: ManagedAiServiceStatus;
      noxconnect: ManagedAiServiceStatus;
    };
  };
};

export const fetchLlmSettings = () => apiGet<LlmSettings>("/api/v1/llm-settings");

export const setAiMode = (mode: AiMode) =>
  apiPut<LlmSettings>("/api/v1/llm-settings", { mode });
