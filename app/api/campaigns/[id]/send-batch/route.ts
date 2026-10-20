import { NextResponse } from "next/server";
import { requireAuth, errorResponse } from "@/lib/api";
import { sendNext } from "@/lib/sender";

export const maxDuration = 120;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await requireAuth(request, true);
  if (denied) return denied;
  try {
    return NextResponse.json(await sendNext((await context.params).id));
  } catch (error) {
    return errorResponse(
      error,
      "Не удалось отправить сообщение. Проверьте настройки и журнал",
    );
  }
}
