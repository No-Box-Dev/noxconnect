import { z } from "zod";
import {
  SERVICE_DEFINITIONS,
  type ServiceDefinition,
  type ServiceId,
} from "./service-capabilities";

const OperationSchema = z.object({
  id: z.string().min(1).max(100),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1).max(500),
  authentication: z.enum(["member", "admin", "public", "ingest_key"]),
  description: z.string().min(1).max(500),
}).strict();

const CapabilitySchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  access: z.enum(["member", "admin"]),
  requires: z.array(z.enum(["github", "slack"])).max(2).optional(),
  operations: z.array(OperationSchema).max(30),
}).strict();

const SectionSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  capabilityIds: z.array(z.string().min(1).max(100)).max(20),
}).strict();

const DefinitionSchema = z.object({
  id: z.enum(["noxticket", "noxfeed", "noxspot", "noxcue"]),
  name: z.string().min(1).max(100),
  kind: z.literal("product"),
  focus: z.string().min(1).max(300),
  description: z.string().min(1).max(1_000),
  requiredConnections: z.array(z.enum(["github", "slack"])).max(2),
  optionalConnections: z.array(z.enum(["github", "slack"])).max(2),
  capabilities: z.array(CapabilitySchema).min(1).max(30),
  setupSections: z.array(SectionSchema).min(1).max(20),
}).strict().superRefine((definition, context) => {
  const capabilityIds = new Set(definition.capabilities.map((capability) => capability.id));
  for (const section of definition.setupSections) {
    for (const capabilityId of section.capabilityIds) {
      if (!capabilityIds.has(capabilityId)) {
        context.addIssue({
          code: "custom",
          path: ["setupSections", section.id, "capabilityIds"],
          message: `Unknown capability ${capabilityId}`,
        });
      }
    }
  }
});

const ManifestSchema = z.object({
  contract: z.literal("nox.service-manifest"),
  version: z.literal(1),
  service: DefinitionSchema,
  configuration: z.object({
    schemaVersion: z.literal(1),
    mode: z.enum(["service", "resource"]),
    writable: z.boolean(),
    writableFields: z.array(z.string().max(100)).max(50),
  }).strict(),
}).strict();

const ConfigValidationSchema = z.discriminatedUnion("valid", [
  z.object({
    contract: z.literal("nox.service-config-validation"),
    version: z.literal(1),
    valid: z.literal(true),
    patch: z.record(z.string(), z.unknown()),
    config: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    contract: z.literal("nox.service-config-validation"),
    version: z.literal(1),
    valid: z.literal(false),
    issues: z.array(z.object({ message: z.string().min(1).max(500) }).strict()).min(1).max(20),
  }).strict(),
]);

export type ServiceManifest = z.infer<typeof ManifestSchema>;

export interface ProductServiceBinding {
  describe(): Promise<unknown>;
  validateConfigPatch?(current: unknown, patch: unknown): Promise<unknown>;
}

export interface ProductServiceEnvironment {
  NOXTICKET_SERVICE?: ProductServiceBinding;
  NOXFEED_RESPONSE?: ProductServiceBinding;
  NOXSPOT_RESPONSE?: ProductServiceBinding;
  NOXCUE_RESPONSE?: ProductServiceBinding;
}

export interface LoadedServiceManifests {
  definitions: ServiceDefinition[];
  manifests: Partial<Record<Exclude<ServiceId, "noxconnect">, ServiceManifest>>;
  runtimeStates: Partial<Record<ServiceId, { state: "ready" | "unavailable"; source: "binding" | "snapshot" }>>;
}

const BINDING_NAMES = {
  noxticket: "NOXTICKET_SERVICE",
  noxfeed: "NOXFEED_RESPONSE",
  noxspot: "NOXSPOT_RESPONSE",
  noxcue: "NOXCUE_RESPONSE",
} as const;

export function parseServiceManifest(value: unknown, expectedService: Exclude<ServiceId, "noxconnect">): ServiceManifest {
  const manifest = ManifestSchema.parse(value);
  if (manifest.service.id !== expectedService) throw new Error(`Expected ${expectedService} manifest`);
  return manifest;
}

export async function loadServiceManifests(env: ProductServiceEnvironment): Promise<LoadedServiceManifests> {
  const manifests: LoadedServiceManifests["manifests"] = {};
  const runtimeStates: LoadedServiceManifests["runtimeStates"] = {
    noxconnect: { state: "ready", source: "binding" },
  };
  const ids = Object.keys(BINDING_NAMES) as Array<Exclude<ServiceId, "noxconnect">>;
  await Promise.all(ids.map(async (serviceId) => {
    const binding = env[BINDING_NAMES[serviceId]];
    if (!binding || typeof binding.describe !== "function") {
      runtimeStates[serviceId] = { state: "unavailable", source: "snapshot" };
      return;
    }
    try {
      const manifest = parseServiceManifest(await binding.describe(), serviceId);
      manifests[serviceId] = manifest;
      runtimeStates[serviceId] = { state: "ready", source: "binding" };
    } catch (error) {
      console.error(JSON.stringify({
        event: "service_manifest_unavailable",
        service: serviceId,
        error: error instanceof Error ? error.message : String(error),
      }));
      runtimeStates[serviceId] = { state: "unavailable", source: "snapshot" };
    }
  }));

  const definitions = SERVICE_DEFINITIONS.map((snapshot) => {
    if (snapshot.id === "noxconnect") return snapshot;
    return manifests[snapshot.id]?.service as ServiceDefinition | undefined ?? snapshot;
  });
  return { definitions, manifests, runtimeStates };
}

export function bindingForService(
  env: ProductServiceEnvironment,
  service: Exclude<ServiceId, "noxconnect">,
): ProductServiceBinding | undefined {
  return env[BINDING_NAMES[service]];
}

export async function validateConfigPatchWithService(
  env: ProductServiceEnvironment,
  service: Exclude<ServiceId, "noxconnect">,
  current: unknown,
  patch: unknown,
): Promise<z.infer<typeof ConfigValidationSchema> | null> {
  const binding = bindingForService(env, service);
  if (!binding || typeof binding.validateConfigPatch !== "function") return null;
  return ConfigValidationSchema.parse(await binding.validateConfigPatch(current, patch));
}
