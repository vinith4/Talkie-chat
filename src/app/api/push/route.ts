import webpush from "web-push";

export const runtime = "nodejs";

type Body = { subscriptions: webpush.PushSubscription[]; payload: { kind?: string } & Record<string, unknown> };

/** Called by a Postgres trigger (pg_net) when a call starts or a message arrives. */
export async function POST(req: Request) {
  if (!process.env.PUSH_SECRET || req.headers.get("x-push-secret") !== process.env.PUSH_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  const { subscriptions, payload } = (await req.json()) as Body;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
    process.env.VAPID_PRIVATE_KEY ?? "",
  );
  const results = await Promise.allSettled(
    subscriptions.map((s) => webpush.sendNotification(s, JSON.stringify(payload), { TTL: payload.kind === "call" ? 45 : 3600, urgency: "high" })),
  );
  return Response.json({ sent: results.filter((r) => r.status === "fulfilled").length, total: results.length });
}
