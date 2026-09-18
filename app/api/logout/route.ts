import { NextResponse } from "next/server";
import { sessionCookie, validOrigin } from "@/lib/auth";

export async function POST(request: Request) {
  if (!validOrigin(request))
    return NextResponse.json(
      { error: "Некорректный источник запроса" },
      { status: 403 },
    );
  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookie.name, "", {
    ...sessionCookie.options,
    maxAge: 0,
  });
  return response;
}
