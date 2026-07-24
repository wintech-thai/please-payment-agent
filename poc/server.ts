/**
 * LINE worker POC — backend.
 *
 * Two jobs against the standalone worker container:
 *   1. Login proxy  — forwards /login/* to the worker with Basic auth so the
 *      HTTP_API_KEY never reaches the browser (also dodges CORS). QR arrives as
 *      a URL string; we render it to a data URL here so the page just <img>s it.
 *   2. Webhook sink — the worker's WEBHOOK_URL points here; every forwarded
 *      group message lands on POST /ingest and shows up in GET /api/messages.
 */

import QRCode from "qrcode";
import indexHtml from "./index.html" with { type: "text" };

const WORKER_URL = process.env.WORKER_URL ?? "http://worker:3000";
const HTTP_API_KEY = process.env.HTTP_API_KEY ?? "";
const PORT = Number(process.env.PORT ?? 8080);

// Same scheme the worker's forwarder uses: Basic base64("api:<key>").
const authHeader = HTTP_API_KEY
  ? { Authorization: "Basic " + Buffer.from(`api:${HTTP_API_KEY}`).toString("base64") }
  : {};

// ponytail: in-memory ring buffers, POC only — no DB.
const MAX = 200;
const messages: unknown[] = [];   // generic WEBHOOK_URL forwards (ForwardedMessage)
const onix: unknown[] = [];       // simulated ONIX NotifyLineMessage calls

// What the worker's onix-client sends as Basic auth: base64("api:<ONIX_API_KEY>").
const ONIX_API_KEY = process.env.ONIX_API_KEY ?? "apikey";
const expectedOnixAuth = "Basic " + Buffer.from(`api:${ONIX_API_KEY}`).toString("base64");

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function proxy(path: string, init?: RequestInit) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: { ...authHeader, ...(init?.headers ?? {}) },
  });
  return res;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/" || pathname === "/index.html") {
      return new Response(indexHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // --- Webhook sink: the worker POSTs ForwardedMessage JSON here ---
    if (pathname === "/ingest" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = { parseError: true, raw: await req.text() };
      }
      const entry = {
        receivedAt: new Date().toISOString(),
        webhookId: req.headers.get("x-webhook-id"),
        signature: req.headers.get("x-webhook-signature"),
        payload: body,
      };
      messages.unshift(entry);
      if (messages.length > MAX) messages.length = MAX;
      return json({ ok: true });
    }

    if (pathname === "/api/messages") return json(messages);

    // --- ONIX simulator: the worker's onix-client POSTs bank-OA messages here ---
    // Path: /admin-api/AdminAgent/org/{org}/action/NotifyLineMessage/{agentId}
    if (pathname.includes("/admin-api/AdminAgent/") && pathname.includes("/action/NotifyLineMessage/") && req.method === "POST") {
      const auth = req.headers.get("authorization");
      const entry = {
        receivedAt: new Date().toISOString(),
        agentId: pathname.split("/NotifyLineMessage/")[1] ?? null,
        authOk: auth === expectedOnixAuth,
        appType: req.headers.get("onix-application-type"),
        body: await req.json().catch(() => null),
      };
      onix.unshift(entry);
      if (onix.length > MAX) onix.length = MAX;
      return json({ status: "ok" });   // onix replies 2xx on success
    }

    if (pathname === "/api/onix") return json(onix);

    if (pathname === "/api/config")
      return json({
        watchChatIds: process.env.WATCH_CHAT_IDS ?? "",
        onixAgentId: process.env.ONIX_AGENT_ID ?? "",
      });

    // --- Login proxy ---
    if (pathname === "/api/health") {
      try {
        const res = await proxy("/health");
        return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 502);
      }
    }

    if (pathname === "/api/login/status") {
      try {
        const res = await proxy("/login/status");
        const data = (await res.json()) as { qrUrl?: string };
        // Render the QR URL string to an image so the browser just drops it in <img>.
        const qrDataUrl = data.qrUrl ? await QRCode.toDataURL(data.qrUrl) : undefined;
        return json({ ...data, qrDataUrl }, res.status);
      } catch (err) {
        return json({ ok: false, error: String(err) }, 502);
      }
    }

    if (pathname === "/api/login/qr" && req.method === "POST") {
      const res = await proxy("/login/qr", { method: "POST" });
      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
    }

    if (pathname === "/api/login/password" && req.method === "POST") {
      const res = await proxy("/login/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await req.text(),
      });
      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
});

console.log(`POC app on :${PORT} → worker ${WORKER_URL}` + (HTTP_API_KEY ? " (auth on)" : " (NO auth key)"));
