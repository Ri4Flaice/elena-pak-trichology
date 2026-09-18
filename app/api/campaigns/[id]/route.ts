import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, errorResponse } from "@/lib/api";

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
    await db.campaign.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
