import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, errorResponse } from "@/lib/api";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const denied = await requireAuth(request, true);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    const campaign = await db.campaign.findUnique({
      where: { id },
      select: { leaseUntil: true },
    });
    if (!campaign)
      return NextResponse.json(
        { error: "Рассылка не найдена" },
        { status: 404 },
      );
    if (campaign.leaseUntil && campaign.leaseUntil > new Date()) {
      return NextResponse.json(
        { error: "Дождитесь завершения текущего пакета" },
        { status: 409 },
      );
    }
    const changed = await db.recipient.updateMany({
      where: { campaignId: id, status: "ERROR" },
      data: { status: "PENDING", error: null, idMessage: null },
    });
    if (changed.count)
      await db.campaign.update({ where: { id }, data: { status: "CREATED" } });
    return NextResponse.json({ count: changed.count });
  } catch (error) {
    return errorResponse(error);
  }
}
