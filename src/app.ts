import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase, seedCreators } from "./database.js";
import { ConflictError, getAttribution, ingestOrder, ingestRefund } from "./service.js";
import { orderWebhookSchema, refundWebhookSchema } from "./schemas.js";

export interface AppOptions {
  database?: DatabaseSync;
  databasePath?: string;
  seed?: boolean;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const database = options.database ?? createDatabase(options.databasePath);
  if (options.seed) seedCreators(database);

  const app = Fastify({ logger: false });
  app.addHook("onClose", async () => {
    if (!options.database) database.close();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_request", details: error.issues });
    }
    if (error instanceof ConflictError) {
      return reply.code(409).send({ error: "conflict", message: error.message });
    }
    const caught = error instanceof Error ? error : new Error(String(error));
    const code = "code" in caught ? String(caught.code) : "";
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database is (?:locked|busy)/i.test(caught.message)) {
      return reply.code(503).send({ error: "database_busy", retryable: true });
    }
    const statusCode = "statusCode" in caught && typeof caught.statusCode === "number" ? caught.statusCode : 500;
    if (statusCode === 400) return reply.code(400).send({ error: "invalid_json", message: caught.message });
    app.log.error(caught);
    return reply.code(500).send({ error: "internal_error" });
  });

  app.post("/webhooks/orders", async (request, reply) => {
    const input = orderWebhookSchema.parse(request.body);
    const result = ingestOrder(database, input);
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.post("/webhooks/refunds", async (request, reply) => {
    const input = refundWebhookSchema.parse(request.body);
    const result = ingestRefund(database, input);
    return reply.code(result.duplicate ? 200 : result.refund.status === "PENDING_ORDER" ? 202 : 201).send(result);
  });

  app.get<{ Params: { id: string } }>("/orders/:id/attribution", async (request, reply) => {
    const result = getAttribution(database, request.params.id);
    if (!result) return reply.code(404).send({ error: "not_found" });
    return reply.code(200).send(result);
  });

  return app;
}
