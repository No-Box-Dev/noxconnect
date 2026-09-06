import { WorkerEntrypoint } from "cloudflare:workers";

export default class FakeConnectionCapability extends WorkerEntrypoint {
  execute(command: { commandId: string; idempotencyKey: string; capability: string }) {
    if (command.capability !== "ai.complete") throw new Error("Unexpected capability");
    return {
      contract: "noxconnect.connection-receipt",
      version: 1,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      capability: command.capability,
      provider: "ai",
      status: "completed",
      result: { text: "12 new users signed up, up from 8 yesterday.", model: "local-health" },
    };
  }
}
