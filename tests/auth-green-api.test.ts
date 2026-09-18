import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  validOrigin,
  verifyPassword,
  verifySession,
} from "../lib/auth";
import { sendMessage } from "../lib/green-api";

const oldEnv = {
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  SESSION_SECRET: process.env.SESSION_SECRET,
  GREEN_API_URL: process.env.GREEN_API_URL,
  GREEN_API_ID_INSTANCE: process.env.GREEN_API_ID_INSTANCE,
  GREEN_API_TOKEN: process.env.GREEN_API_TOKEN,
};

afterEach(() => {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

describe("служебный доступ", () => {
  it("проверяет пароль и подпись сессии", () => {
    process.env.ADMIN_PASSWORD = "long-private-password";
    process.env.SESSION_SECRET = "a-very-long-random-secret-for-tests-only";
    expect(verifyPassword("long-private-password")).toBe(true);
    expect(verifyPassword("wrong-password")).toBe(false);
    const token = createSession();
    expect(verifySession(token)).toBe(true);
    expect(verifySession(`${token}x`)).toBe(false);
  });

  it("отклоняет запрос с другого сайта", () => {
    expect(
      validOrigin(
        new Request("https://mailer.example/api/login", {
          headers: {
            origin: "https://mailer.example",
            host: "mailer.example",
          },
        }),
      ),
    ).toBe(true);
    expect(
      validOrigin(
        new Request("https://mailer.example/api/login", {
          headers: {
            origin: "https://another.example",
            host: "mailer.example",
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("результат GreenAPI", () => {
  const recipient = { phone: "77771234567", message: "Привет" };
  function setup() {
    process.env.GREEN_API_URL = "https://api.green-api.com";
    process.env.GREEN_API_ID_INSTANCE = "123";
    process.env.GREEN_API_TOKEN = "test-token";
  }

  it("считает ответ с idMessage принятым в очередь", async () => {
    setup();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ idMessage: "message-id" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendMessage(recipient)).toEqual({
      status: "ACCEPTED",
      idMessage: "message-id",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).chatId).toBe(
      "77771234567@c.us",
    );
  });

  it("различает явный отказ и неопределённый результат", async () => {
    setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 400 }))
        .mockResolvedValueOnce(new Response("", { status: 502 }))
        .mockRejectedValueOnce(new Error("timeout")),
    );
    expect((await sendMessage(recipient)).status).toBe("ERROR");
    expect((await sendMessage(recipient)).status).toBe("UNKNOWN");
    expect((await sendMessage(recipient)).status).toBe("UNKNOWN");
  });
});
