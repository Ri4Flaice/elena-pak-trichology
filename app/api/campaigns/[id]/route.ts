import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, errorResponse } from "@/lib/api";
import { senderTransaction } from "@/lib/sender";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const denied = await requireAuth(request);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    const campaign = await db.campaign.findUnique({
      where: { id },
      include: { recipients: { orderBy: { rowNumber: "asc" } } },
    });
    if (!campaign)
      return NextResponse.json(
        { error: "Рассылка не найдена" },
        { status: 404 },
      );
    return NextResponse.json({ campaign });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  const denied = await requireAuth(request, true);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    const result = await senderTransaction(async (tx, state) => {
      const campaign = await tx.campaign.findUnique({
        where: { id },
        select: { leaseUntil: true },
      });
      if (!campaign) return { error: "Рассылка не найдена", status: 404 };
      const inFlight = await tx.sendAttempt.count({
        where: { campaignId: id, outcome: "SENDING" },
      });
      if (
        inFlight ||
        (campaign.leaseUntil && campaign.leaseUntil > new Date())
      ) {
        return {
          error:
            "Дождитесь завершения текущей отправки или проверьте её результат",
          status: 409,
        };
      }
      await tx.campaign.delete({ where: { id } });
      if (state.activeCampaignId === id)
        await tx.senderState.update({
          where: { id: state.id },
          data: { activeCampaignId: null },
        });
      return null;
    });
    if (result)
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
