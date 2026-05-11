import cors from "cors";
import express from "express";
import webpush from "web-push";

// ── VAPID keys ────────────────────────────────────────────────
// Generate once:  npx web-push generate-vapid-keys
// Then put the public key in your .env as VITE_VAPID_PUBLIC_KEY
const VAPID_PUBLIC_KEY =
  "BNLCvzttW4HPf74o5Eb-50OMawqmXi-W2Ub7eop9n6tm9ydXipi5VF3ArSoHopBBObbbeTgB5wxLdJogWFgYtc8";
const VAPID_PRIVATE_KEY = "MraS3Mj5a6rdrUg3K2_6nF88ynvPChBVm7YSD8FyOm4";

let vapidConfigured = false;
try {
  webpush.setVapidDetails(
    "mailto:admin@example.com",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY,
  );
  vapidConfigured = true;
} catch {
  console.warn(
    "[push-server] VAPID keys are missing/invalid. /push/send is disabled until valid VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are provided.",
  );
}

// ── In-memory subscription store ──────────────────────────────
const subscriptions = new Map<string, webpush.PushSubscription>();

function keyOf(sub: webpush.PushSubscription): string {
  return sub.endpoint;
}

function isPermanentPushError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const statusCode = (error as { statusCode?: number }).statusCode;
  return statusCode === 404 || statusCode === 410;
}

// ── Express app ───────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Subscribe — called from the frontend after pushManager.subscribe()
app.post("/push/subscribe", (req, res) => {
  const sub = req.body as webpush.PushSubscription;
  if (!sub?.endpoint) {
    res.status(400).json({ error: "Invalid subscription: missing endpoint" });
    return;
  }
  subscriptions.set(keyOf(sub), sub);
  console.log(`[push] subscribed (${subscriptions.size} total)`);
  res.status(201).json({ ok: true });
});

// Unsubscribe
app.post("/push/unsubscribe", (req, res) => {
  const sub = req.body as webpush.PushSubscription;
  if (!sub?.endpoint) {
    res.status(400).json({ error: "Invalid subscription: missing endpoint" });
    return;
  }
  subscriptions.delete(keyOf(sub));
  console.log(`[push] unsubscribed (${subscriptions.size} total)`);
  res.status(200).json({ ok: true });
});

// Send push to ALL subscribers
// Body: { "title": "...", "body": "..." }
app.post("/push/send", async (req, res) => {
  if (!vapidConfigured) {
    res.status(503).json({
      error:
        "Push sending is disabled: set valid VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.",
    });
    return;
  }

  const {
    title = "MBFS Point of Sales",
    body = "Sie haben einen offenen Antrag.",
    url,
    icon,
  } = req.body;
  const payload = JSON.stringify({
    title,
    body,
    icon,
    data: { url: url ?? "/" },
  });

  const results = await Promise.allSettled(
    [...subscriptions.values()].map((sub) =>
      webpush.sendNotification(sub, payload),
    ),
  );

  // Remove only expired / invalid subscriptions (permanent failures)
  const gone: string[] = [];
  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      failed += 1;
      if (isPermanentPushError(r.reason)) {
        const endpoint = [...subscriptions.keys()][i];
        subscriptions.delete(endpoint);
        gone.push(endpoint);
      }
    }
  });

  const sent = results.filter((r) => r.status === "fulfilled").length;
  console.log(`[push] sent=${sent}, failed=${failed}, removed=${gone.length}`);
  res.json({ sent, failed, removed: gone.length, total: subscriptions.size });
});

// List current subscribers (debug)
app.get("/push/subscriptions", (_, res) => {
  res.json({
    count: subscriptions.size,
    endpoints: [...subscriptions.values()].map((s) => s.endpoint),
  });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = Number(process.env.PUSH_PORT ?? 3050);
if (!vapidConfigured) {
  console.error(
    "[push-server] not starting because VAPID keys are missing/invalid.",
  );
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`[push-server] running on http://localhost:${PORT}`);
  console.log(`  POST /push/subscribe     — register a subscription`);
  console.log(`  POST /push/unsubscribe   — remove a subscription`);
  console.log(`  POST /push/send          — send to all subscribers`);
  console.log(`  GET  /push/subscriptions  — list current subscribers`);
});
