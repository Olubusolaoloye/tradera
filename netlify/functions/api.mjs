// Netlify Function: every /api/* route is rewritten here (see netlify.toml).
// getStore is imported here, not lazily in lib/, so the bundler ships it.
import { getStore } from "@netlify/blobs";
import serverless from "../../lib/serverless.js";

export default serverless.toWebHandler(serverless.createHandler({ getStore }));
