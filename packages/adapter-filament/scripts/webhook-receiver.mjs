#!/usr/bin/env node
// Receives the webhooks the vectors make, as a site a project notifies would: each POST to
// /hooks/<name> is kept with its event header, its content type, any header the vectors set and its
// body. GET /deliveries hands back what arrived since the last GET, in order.
//
// usage: webhook-receiver.mjs [--port 9555]
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string", default: "9555" } } });

let deliveries = [];
// The headers a webhook's settings add (`x-camis-*` in the vectors) and the ones Strapi always sends.
const kept = (headers) =>
  Object.fromEntries(
    Object.entries(headers)
      .filter(
        ([name]) =>
          ["x-strapi-event", "content-type"].includes(name) || name.startsWith("x-camis-"),
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/deliveries") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(deliveries));
    deliveries = [];
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      // kept as sent
    }
    deliveries.push({ path: req.url, headers: kept(req.headers), body: parsed });
    // A webhook answered with an error status is still delivered; /hooks/failing shows it.
    res.writeHead(req.url === "/hooks/failing" ? 500 : 200, { "Content-Type": "text/plain" });
    res.end(req.url === "/hooks/failing" ? "no thanks" : "ok");
  });
}).listen(Number(values.port), "127.0.0.1", () =>
  console.log(`webhook receiver on http://127.0.0.1:${values.port}`),
);
