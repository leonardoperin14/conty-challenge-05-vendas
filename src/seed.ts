import { createDatabase, seedCreators } from "./database.js";

const database = createDatabase();
try {
  seedCreators(database);
  console.log("Demo creators and attribution rules are ready.");
} finally {
  database.close();
}
