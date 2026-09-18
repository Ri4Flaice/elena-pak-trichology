import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, errorResponse } from "@/lib/api";
import { batchSize, sendDelay, sendMessage } from "@/lib/green-api";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const denied = await requireAuth(request, true);
  if (denied) return denied;
  const { id } = await context.params;
  const leaseToken = randomUUID();
  let acquired = false;
  try {
    if (
      !process.env.GREEN_API_URL ||
      !process.env.GREEN_API_ID_INSTANCE ||
      !process.env.GREEN_API_TOKEN
    ) {
      return NextResponse.json(
        { error: "Настройте GreenAPI перед отправкой" },
        { status: 503 },
      );
    }
    const now = new Date();
    const locked = await db.campaign.updateMany({
      where: { id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: {
        leaseToken,
        leaseUntil: new Date(Date.now() + 180_000),
        status: "RUNNING",
      },
    });
    if (!locked.count) {
      const exists = await db.campaign.findUnique({
        where: { id },
        select: { id: true },
      });
      return NextResponse.json(
        {
          error: exists
            ? "Другой пакет уже отправляется"
            : "Рассылка не найдена",
        },
        { status: exists ? 409 : 404 },
      );
    }
    acquired = true;
    await db.recipient.updateMany({
      where: {
        campaignId: id,
        status: "SENDING",
        updatedAt: { lt: new Date(Date.now() - 5 * 60_000) },
      },
      data: {
        status: "UNKNOWN",
        error: "Предыдущий запрос прервался; проверьте отправку вручную",
      },
    });
    const candidates = await db.recipient.findMany({
      where: { campaignId: id, status: "PENDING" },
      orderBy: { rowNumber: "asc" },
      take: batchSize(),
    });
    const claimed = [];
    for (const candidate of candidates) {
      const result = await db.recipient.updateMany({
        where: { id: candidate.id, status: "PENDING" },
        data: { status: "SENDING" },
      });
      if (result.count) claimed.push(candidate);
    }
    for (let index = 0; index < claimed.length; index++) {
      const recipient = claimed[index];
      let outcome;
      try {
        outcome = await sendMessage(recipient);
      } catch (error) {
        outcome = {
          status: "ERROR" as const,
          error:
            error instanceof Error ? error.message : "Ошибка настроек GreenAPI",
        };
      }
      await db.recipient.update({
        where: { id: recipient.id },
        data: {
          status: outcome.status,
          idMessage: outcome.idMessage,
          error: outcome.error,
        },
      });
      if (index < claimed.length - 1 && sendDelay()) {
        await new Promise((resolve) => setTimeout(resolve, sendDelay()));
      }
    }
    const [pending, sending] = await Promise.all([
      db.recipient.count({ where: { campaignId: id, status: "PENDING" } }),
      db.recipient.count({ where: { campaignId: id, status: "SENDING" } }),
    ]);
    if (!pending && !sending) {
      await db.campaign.update({
        where: { id },
        data: { status: "COMPLETED" },
      });
    }
    return NextResponse.json({
      processed: claimed.length,
      pending,
      sending,
      done: !pending && !sending,
    });
  } catch (error) {
    return errorResponse(error, "Не удалось отправить пакет");
  } finally {
    if (acquired) {
      await db.campaign
        .updateMany({
          where: { id, leaseToken },
          data: { leaseToken: null, leaseUntil: null },
        })
        .catch(console.error);
    }
  }
}
