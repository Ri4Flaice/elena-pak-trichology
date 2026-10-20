import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  validOrigin,
  verifyPassword,
  verifySession,
} from "../lib/auth";
import { greenRequest, sendMessage } from "../lib/green-api";

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
  vi.useRealTimers();
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

  it("показывает метод при 404, не раскрывает токен и не повторяет запрос", async () => {
    setup();
    const mock = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", mock);
    await expect(greenRequest("getSettings")).rejects.toThrow(
      "getSettings вернул HTTP 404",
    );
    expect(mock).toHaveBeenCalledTimes(1);
    try {
      await greenRequest("getStateInstance");
    } catch (error) {
      expect(String(error)).not.toContain("test-token");
    }
  });

  it("после 429 повторяет только проверку, выдерживая Retry-After", async () => {
    setup();
    vi.useFakeTimers();
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "Retry-After": "2" } }),
      )
      .mockResolvedValueOnce(Response.json({ stateInstance: "authorized" }));
    vi.stubGlobal("fetch", mock);
    const result = greenRequest("getStateInstance");
    const assertion = expect(result).resolves.toEqual({
      stateInstance: "authorized",
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(mock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("после повторного 429 останавливает проверку вместо бесконечного повтора", async () => {
    setup();
    vi.useFakeTimers();
    const mock = vi
      .fn()
      .mockImplementation(async () => new Response("", { status: 429 }));
    vi.stubGlobal("fetch", mock);
    const assertion = expect(greenRequest("showMessagesQueue")).rejects.toThrow(
      "showMessagesQueue вернул HTTP 429",
    );
    await vi.advanceTimersByTimeAsync(1200);
    await assertion;
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("не повторяет очистку очереди и отправку сообщения автоматически", async () => {
    setup();
    const mock = vi
      .fn()
      .mockImplementation(async () => new Response("", { status: 429 }));
    vi.stubGlobal("fetch", mock);
    await expect(greenRequest("clearMessagesQueue")).rejects.toThrow(
      "clearMessagesQueue вернул HTTP 429",
    );
    expect((await sendMessage(recipient)).status).toBe("ERROR");
    expect(mock).toHaveBeenCalledTimes(2);
  });

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
