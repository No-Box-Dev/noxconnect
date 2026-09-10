import { WorkerEntrypoint } from "cloudflare:workers";
import { executeConnectionCapability } from "../../../functions/lib/connection-capability-executor";
import {
  exchangeGitHubOAuthIdentity,
  pollGitHubDeviceIdentity,
  startGitHubDeviceIdentity,
} from "../../../functions/lib/connection-identity";

interface Env {
  DB: D1Database;
  TASK_QUEUE: Queue;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  ENCRYPTION_KEY?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  NOXHERE_OAUTH_CALLBACK_URL?: string;
}

export default class NoxConnectCapabilities extends WorkerEntrypoint<Env> {
  execute(command: unknown) {
    return executeConnectionCapability(this.env, command);
  }

  exchangeGitHubOAuth(input: unknown) {
    return exchangeGitHubOAuthIdentity(this.env, input);
  }

  startGitHubDeviceAuth(input: unknown) {
    return startGitHubDeviceIdentity(this.env, input);
  }

  pollGitHubDeviceAuth(input: unknown) {
    return pollGitHubDeviceIdentity(this.env, input);
  }

  fetch(): Response {
    return Response.json({ error: "private_service" }, { status: 404 });
  }
}
