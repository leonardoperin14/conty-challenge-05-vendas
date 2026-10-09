import { buildApp } from "./app.js";

const app = buildApp({
  databasePath: process.env.DB_PATH,
  seed: process.env.SEED_DEMO === "true",
});

try {
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ host: process.env.HOST ?? "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
