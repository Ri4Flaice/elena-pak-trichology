import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { normalizePhone } from "@/lib/clients";
import { senderTransaction } from "@/lib/sender";

export async function POST(request: Request) {
  const denied = await requireAuth(request, true);
  if (denied) return denied;
  try {
    const body = await request.json();
    if (body.action === "lookup") {
      if (
        !Array.isArray(body.phones) ||
        body.phones.length > 20000 ||
        !body.phones.every(
          (p: unknown) => typeof p === "string" && normalizePhone(p) === p,
        )
      )
        throw new Error("Некорректные телефоны");
      const contacts = await senderTransaction((tx) =>
        tx.contactPreference.findMany({
          where: { phone: { in: body.phones } },
        }),
      );
      return NextResponse.json({ contacts });
    }
    const phone =
      typeof body.phone === "string" ? normalizePhone(body.phone) : null;
    if (!phone) throw new Error("Некорректный телефон");
    await senderTransaction(async (tx) => {
      if (body.action === "opt-out" || body.action === "resolve-chat") {
        if (body.action === "resolve-chat") {
          if (typeof body.chatId !== "string") throw new Error("Укажите чат");
          const identity = await tx.chatIdentity.findUnique({
            where: { chatId: body.chatId },
          });
          if (!identity?.optedOutAt || identity.phone)
            throw new Error("Неизвестная отписка не найдена");
          await tx.chatIdentity.update({
            where: { chatId: body.chatId },
            data: { phone },
          });
        }
        await tx.contactPreference.upsert({
          where: { phone },
          create: { phone, optedOutAt: new Date() },
          update: { optedOutAt: new Date() },
        });
        await tx.recipient.updateMany({
          where: { phone, status: "PENDING" },
          data: { status: "SKIPPED", error: "Отказ от рассылок" },
        });
      } else throw new Error("Неизвестное действие");
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Не удалось обновить контакт",
      },
      { status: 400 },
    );
  }
}
