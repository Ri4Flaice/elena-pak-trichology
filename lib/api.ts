import { NextResponse } from "next/server";
import { isAuthenticated, validOrigin } from "@/lib/auth";

export async function requireAuth(request: Request, mutation = false) {
  if (!(await isAuthenticated()))
    return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  if (mutation && !validOrigin(request))
    return NextResponse.json(
      { error: "Некорректный источник запроса" },
      { status: 403 },
    );
  return null;
}

export function errorResponse(error: unknown, fallback = "Ошибка сервера") {
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
