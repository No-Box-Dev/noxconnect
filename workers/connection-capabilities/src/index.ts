import { WorkerEntrypoint } from "cloudflare:workers";
import { executeConnectionCapability } from "../../../functions/lib/connection-capability-executor";

interface Env {
  DB: D1Database;
  TASK_QUEUE: Queue;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  ENCRYPTION_KEY?: string;
}

export default class NoxConnectCapabilities extends WorkerEntrypoint<Env> {
  execute(command: unknown) {
    return executeConnectionCapability(this.env, command);
  }

  fetch(): Response {
    return Response.json({ error: "private_service" }, { status: 404 });
  }
}
