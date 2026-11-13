// Netlify Scheduled Function — refreshes quotes and fires entry alerts.
// Configured in netlify.toml ([functions."poll"] schedule = "*/2 * * * *").
import deskCore from "../../lib/desk-core.js";
import serverless from "../../lib/serverless.js";
import { getStore } from "@netlify/blobs";

export default async function poll() {
  const desk = deskCore.createDesk({
    store: serverless.createBlobsStore(undefined, getStore),
    realtime: false,
    timeoutMs: 8000,
    onAlert() {},
    onAlerts() {},
    onSnapshot() {}
  });
  await desk.load();
  await desk.poll();
  await desk.save();
  return new Response("polled");
}
