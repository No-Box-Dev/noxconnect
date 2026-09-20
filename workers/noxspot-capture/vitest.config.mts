import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: { NOXCUE_INGEST_KEY: "nox_test_key" },
      serviceBindings: {
        NOXCONNECT: async () => Response.json({ error: "rpc_only" }, { status: 404 }),
        NOXCUE_INGEST: async (request) => {
          const body = await request.clone().json() as Record<string, unknown>;
          const data = body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : {};
          if (body.type === "error.occurred" && typeof data.environment === "string") {
            return Response.json({ error: "environment_mismatch" }, { status: 409 });
          }
          if (JSON.stringify(body).includes("SAFE_DIAGNOSTIC_TEST")) {
            const attributes = data.attributes as Record<string, unknown> | undefined;
            const valid = attributes?.["renderer.phase"] === "rasterize"
              && attributes?.["renderer.attempts[0].outcome"] === "image_error"
              && attributes?.["renderer.phaseMs.pin-scroll"] === 42
              && attributes?.["resources.brokenImages[0].origin"] === "https://images.example"
              && !JSON.stringify(attributes).includes("private-user")
              && !JSON.stringify(attributes).includes("top-secret");
            if (!valid) return Response.json({ error: "invalid_diagnostics" }, { status: 422 });
          }
          return body.type === "error.occurred" && JSON.stringify(body).includes("FORCE_NOXCUE_FAILURE")
            ? new Response(null, { status: 503 })
            : new Response(null, { status: 202 });
        },
      },
    },
  })],
});
