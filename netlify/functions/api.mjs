// Netlify Function: every /api/* route is rewritten here (see netlify.toml).
// getStore and the Anthropic SDK are imported here, not lazily in lib/, so
// the bundler ships them.
import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";
import serverless from "../../lib/serverless.js";
import reader from "../../lib/setup-reader.js";

reader.useAnthropic(Anthropic);

export default serverless.toWebHandler(serverless.createHandler({ getStore }));
