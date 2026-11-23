// Netlify Scheduled Function — refreshes quotes and fires entry alerts for
// every account. Configured in netlify.toml ([functions."poll"] schedule).
import serverless from "../../lib/serverless.js";
import { getStore } from "@netlify/blobs";
import webPush from "web-push";
import pushLib from "../../lib/webpush.js";

pushLib.useWebPush(webPush);

export default async function poll() {
  const result = await serverless.pollAll(getStore);
  return new Response("polled " + result.polled + " of " + result.journals);
}
