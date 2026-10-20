import { NextResponse } from "next/server";
import { requireAuth, errorResponse } from "@/lib/api";
import { senderTransaction, outstandingAttempt } from "@/lib/sender";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const denied = await requireAuth(request, true);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    const count = await senderTransaction(async (tx, state) => {
      const campaign = await tx.campaign.findUnique({
        where: { id },
        select: { leaseUntil: true },
      });
      if (!campaign) throw new Error("Рассылка не найдена");
      if (await outstandingAttempt(tx))
        throw new Error("Сначала проверьте неподтверждённые отправки");
      if (state.activeCampaignId)
        throw new Error("Сначала приостановите активную рассылку");
      const recipients = await tx.recipient.findMany({
        where: { campaignId: id, status: "ERROR" },
      });
      let count = 0;
      for (const recipient of recipients) {
        const latest = await tx.sendAttempt.findFirst({
          where: { recipientId: recipient.id },
          orderBy: { reservedAt: "desc" },
        });
        const contact = await tx.contactPreference.findUnique({
          where: { phone: recipient.phone },
        });
        if (
          !latest?.retryable ||
          latest.outcome !== "ERROR" ||
          contact?.optedOutAt
        )
          continue;
        count += (
          await tx.recipient.updateMany({
            where: { id: recipient.id, status: "ERROR" },
            data: {
              status: "PENDING",
              error: null,
              idMessage: null,
              deliveryStatus: null,
            },
          })
        ).count;
      }
      if (count)
        await tx.campaign.update({
          where: { id },
          data: {
            status: "PAUSED",
            pauseReason: "Ошибки подготовлены. Продолжите вручную",
          },
        });
      return count;
    });
    return NextResponse.json({ count });
  } catch (error) {
    return errorResponse(error);
  }
}
