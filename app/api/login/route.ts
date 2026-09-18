import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  createSession,
  sessionCookie,
  validOrigin,
  verifyPassword,
} from "@/lib/auth";

export async function POST(request: Request) {
  if (!validOrigin(request))
    return NextResponse.json(
      { error: "Некорректный источник запроса" },
      { status: 403 },
    );
  const ip = (request.headers.get("x-forwarded-for") ?? "local")
    .split(",")[0]
    .trim();
  const key = createHash("sha256").update(ip).digest("hex");
  try {
    const now = new Date();
    const attempt = await db.loginAttempt.findUnique({ where: { key } });
    if (attempt && attempt.expiresAt > now && attempt.count >= 5) {
      return NextResponse.json(
        { error: "Слишком много попыток. Повторите через 15 минут." },
        { status: 429 },
      );
    }
    const body = await request.json().catch(() => ({}));
    const password = typeof body.password === "string" ? body.password : "";
    if (!verifyPassword(password)) {
      await db.loginAttempt.upsert({
        where: { key },
        create: {
          key,
          count: 1,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        },
        update:
          attempt && attempt.expiresAt > now
            ? { count: { increment: 1 } }
            : { count: 1, expiresAt: new Date(Date.now() + 15 * 60_000) },
      });
      return NextResponse.json({ error: "Неверный пароль" }, { status: 401 });
    }
    await db.loginAttempt.deleteMany({ where: { key } });
    const response = NextResponse.json({ ok: true });
    response.cookies.set(
      sessionCookie.name,
      createSession(),
      sessionCookie.options,
    );
    return response;
  } catch (error) {
    console.error("Login failed", error);
    return NextResponse.json(
      { error: "Вход временно недоступен. Проверьте настройки сервера." },
      { status: 503 },
    );
  }
}
