import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { resumeCampaign, senderTransaction } from "@/lib/sender";

export const maxDuration = 120;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await requireAuth(request, true);
  if (denied) return denied;
  const { id } = await context.params;
  try {
    const body = await request.json();
    if (body.action === "resume") await resumeCampaign(id);
    else if (body.action === "pause")
      await senderTransaction(async (tx, state) => {
        await tx.campaign.update({
          where: { id },
          data: {
            status: "PAUSED",
            pauseReason: "Остановлено администратором",
          },
        });
        if (state.activeCampaignId === id)
          await tx.senderState.update({
            where: { id: state.id },
            data: { activeCampaignId: null },
          });
      });
    else
      return NextResponse.json(
        { error: "Неизвестное действие" },
        { status: 400 },
      );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Не удалось изменить состояние",
      },
      { status: 409 },
    );
  }
}
