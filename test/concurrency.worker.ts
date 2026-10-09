import { parentPort, workerData } from "node:worker_threads";
import { createDatabase } from "../src/database.js";
import { ingestRefund } from "../src/service.js";

const { path, refund } = workerData as {
  path: string;
  refund: { id: string; order_id: string; amount_cents: number };
};
const database = createDatabase(path);
try {
  parentPort?.postMessage(ingestRefund(database, refund));
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
  database.close();
}
