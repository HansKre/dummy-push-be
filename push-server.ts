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

// ── Types ─────────────────────────────────────────────────────
type Topic = { antragId: string };

type StoredSubscription = {
  subscription: webpush.PushSubscription;
  topics: Topic[];
  lastSavedAt: string;
};

// ── In-memory subscription store ──────────────────────────────
const subscriptions = new Map<string, StoredSubscription>();

function normalizeTopics(topics: Topic[]): Topic[] {
  const seen = new Set<string>();
  const result: Topic[] = [];
  for (const topic of topics) {
    const id = topic.antragId.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push({ antragId: id });
    }
  }
  return result;
}

function isValidTopicsArray(value: unknown): value is Topic[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (t) =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as Topic).antragId === "string" &&
        (t as Topic).antragId.trim().length > 0,
    )
  );
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
// Body: { subscription: PushSubscription, topics: [{ antragId: "12345" }] }
app.post("/push/subscribe", (req, res) => {
  const { subscription, topics } = req.body;

  if (!subscription?.endpoint) {
    res.status(400).json({ error: "Invalid subscription: missing endpoint" });
    return;
  }

  if (!isValidTopicsArray(topics)) {
    res
      .status(400)
      .json({ error: "topics must be a non-empty array of { antragId: string }" });
    return;
  }

  const normalized = normalizeTopics(topics);
  subscriptions.set(subscription.endpoint, {
    subscription,
    topics: normalized,
    lastSavedAt: new Date().toISOString(),
  });
  console.log(
    `[push] subscribed (${subscriptions.size} total), topics: ${JSON.stringify(normalized)}`,
  );
  res.status(201).json({ ok: true, topics: normalized });
});

// Unsubscribe
app.post("/push/unsubscribe", (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    res.status(400).json({ error: "Missing endpoint" });
    return;
  }
  subscriptions.delete(endpoint);
  console.log(`[push] unsubscribed (${subscriptions.size} total)`);
  res.status(200).json({ ok: true });
});

// Update topics — replace the full topic set for an existing subscription
// Body: { endpoint: string, topics: [{ antragId: string }] }
// Empty topics → auto-unsubscribe
app.put("/push/topics", (req, res) => {
  const { endpoint, topics } = req.body;

  if (!endpoint) {
    res.status(400).json({ error: "Missing endpoint" });
    return;
  }

  const stored = subscriptions.get(endpoint);
  if (!stored) {
    res.status(404).json({ error: "Subscription not found" });
    return;
  }

  if (!Array.isArray(topics)) {
    res.status(400).json({ error: "topics must be an array" });
    return;
  }

  if (topics.length === 0) {
    subscriptions.delete(endpoint);
    console.log(
      `[push] auto-unsubscribed (topics empty, ${subscriptions.size} remaining)`,
    );
    res.status(200).json({ unsubscribed: true });
    return;
  }

  if (!isValidTopicsArray(topics)) {
    res
      .status(400)
      .json({ error: "topics must contain objects with { antragId: string }" });
    return;
  }

  const normalized = normalizeTopics(topics);
  stored.topics = normalized;
  stored.lastSavedAt = new Date().toISOString();
  console.log(
    `[push] topics updated for ${endpoint.slice(0, 40)}…: ${JSON.stringify(normalized)}`,
  );
  res.status(200).json({ topics: normalized });
});

// Send push to subscribers matching a topic
// Body: { topic: { antragId: "12345" }, title: "...", body: "..." }
app.post("/push/send", async (req, res) => {
  if (!vapidConfigured) {
    res.status(503).json({
      error:
        "Push sending is disabled: set valid VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.",
    });
    return;
  }

  const { topic, title = "MBFS Point of Sales", body, url, icon } = req.body;

  if (!topic?.antragId) {
    res
      .status(400)
      .json({ error: "topic is required: { antragId: string }" });
    return;
  }

  const targetAntragId = topic.antragId.trim();
  const matchingSubs = [...subscriptions.entries()].filter(([, stored]) =>
    stored.topics.some((t) => t.antragId === targetAntragId),
  );

  const payload = JSON.stringify({
    title,
    body: body ?? "Sie haben einen offenen Antrag.",
    icon,
    data: { url: url ?? "/" },
  });

  const results = await Promise.allSettled(
    matchingSubs.map(([, stored]) =>
      webpush.sendNotification(stored.subscription, payload),
    ),
  );

  const gone: string[] = [];
  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      failed += 1;
      if (isPermanentPushError(r.reason)) {
        const endpoint = matchingSubs[i][0];
        subscriptions.delete(endpoint);
        gone.push(endpoint);
      }
    }
  });

  const sent = results.filter((r) => r.status === "fulfilled").length;
  console.log(
    `[push] topic=${targetAntragId} matched=${matchingSubs.length} sent=${sent} failed=${failed} removed=${gone.length}`,
  );
  res.json({
    sent,
    failed,
    removed: gone.length,
    matched: matchingSubs.length,
    total: subscriptions.size,
  });
});

// List current subscribers (debug)
app.get("/push/subscriptions", (req, res) => {
  const antragIdFilter = req.query.antragId as string | undefined;

  const entries = [...subscriptions.values()]
    .filter(
      (stored) =>
        !antragIdFilter ||
        stored.topics.some((t) => t.antragId === antragIdFilter.trim()),
    )
    .map((stored) => ({
      endpoint: stored.subscription.endpoint,
      topics: stored.topics,
      lastSavedAt: stored.lastSavedAt,
    }));

  res.json({ count: entries.length, subscriptions: entries });
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
  console.log(`  POST /push/subscribe      — register with topics`);
  console.log(`  POST /push/unsubscribe    — remove a subscription`);
  console.log(`  PUT  /push/topics         — replace topics for a subscription`);
  console.log(`  POST /push/send           — send to matching subscribers`);
  console.log(`  GET  /push/subscriptions  — list current subscribers`);
});
