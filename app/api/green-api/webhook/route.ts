import { NextResponse } from "next/server";
import { instanceId } from "@/lib/green-api";
import {
  parseGreenEvent,
  receiveGreenEvent,
  validWebhookAuthorization,
} from "@/lib/green-webhooks";

export async function POST(request: Request) {
  const secret = process.env.GREEN_API_WEBHOOK_SECRET ?? "";
  if (!validWebhookAuthorization(request.headers.get("authorization"), secret))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const reader = request.body?.getReader();
  if (!reader)
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 256_000) {
      await reader.cancel();
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    chunks.push(value);
  }
  let event;
  try {
    event = parseGreenEvent(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
      instanceId(),
    );
  } catch {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  }
  try {
    await receiveGreenEvent(event);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Could not persist event" },
      { status: 503 },
    );
  }
}
