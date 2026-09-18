import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const COOKIE = "ep_session";
const SESSION_SECONDS = 12 * 60 * 60;

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32)
    throw new Error("SESSION_SECRET должен содержать не менее 32 символов");
  return value;
}

function signature(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

export function verifyPassword(input: string) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || expected.length < 12)
    throw new Error("ADMIN_PASSWORD должен содержать не менее 12 символов");
  const left = createHmac("sha256", "password-check").update(input).digest();
  const right = createHmac("sha256", "password-check")
    .update(expected)
    .digest();
  return timingSafeEqual(left, right);
}

export function createSession() {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = `v1.${expires}`;
  return `${payload}.${signature(payload)}`;
}

export function verifySession(value?: string) {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expires = Number(parts[1]);
  if (!Number.isSafeInteger(expires) || expires < Date.now() / 1000)
    return false;
  const expected = Buffer.from(signature(`${parts[0]}.${parts[1]}`));
  const actual = Buffer.from(parts[2]);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function isAuthenticated() {
  return verifySession((await cookies()).get(COOKIE)?.value);
}

export const sessionCookie = {
  name: COOKIE,
  options: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_SECONDS,
  },
};

export function validOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
