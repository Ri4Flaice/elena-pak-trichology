import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eventKey,
  parseGreenEvent,
  validWebhookAuthorization,
} from "../lib/green-webhooks";

afterEach(() => vi.useRealTimers());
const base = {
  instanceData: { idInstance: 123, typeInstance: "whatsapp" },
  timestamp: 1_700_000_000,
};

describe("проверка вебхуков", () => {
  it("проверяет полный Bearer-заголовок и не разрешает пустой секрет", () => {
    const secret = "a".repeat(32);
    expect(validWebhookAuthorization(`Bearer ${secret}`, secret)).toBe(true);
    expect(validWebhookAuthorization(secret, secret)).toBe(false);
    expect(validWebhookAuthorization(null, secret)).toBe(false);
    expect(validWebhookAuthorization("Bearer ", "")).toBe(false);
  });
  it("отклоняет другой инстанс, мессенджер и неверное время", () => {
    expect(() => parseGreenEvent(base, "456")).toThrow();
    expect(() =>
      parseGreenEvent(
        {
          ...base,
          instanceData: { idInstance: 123, typeInstance: "telegram" },
        },
        "123",
      ),
    ).toThrow();
    expect(() =>
      parseGreenEvent({ ...base, timestamp: "1700000000" }, "123"),
    ).toThrow();
    expect(() =>
      parseGreenEvent(
        { ...base, timestamp: Math.floor(Date.now() / 1000) + 1000 },
        "123",
      ),
    ).toThrow();
  });
  it("сохраняет СТОП и идентификатор, но не текст переписки", () => {
    const event = parseGreenEvent(
      {
        ...base,
        typeWebhook: "incomingMessageReceived",
        idMessage: "stop-id",
        senderData: { chatId: "77771234567@c.us" },
        messageData: { textMessageData: { textMessage: " стоп " } },
      },
      "123",
    );
    expect(event.stop).toBe(true);
    expect(event.phone).toBe("77771234567");
    expect(JSON.stringify(event)).not.toContain("стоп");
    expect(eventKey("123", event)).toBe(eventKey("123", { ...event }));
  });
  it("не привязывает телефон отправителя к удалённому lid при исходящем API-сообщении", () => {
    const event = parseGreenEvent(
      {
        ...base,
        typeWebhook: "outgoingAPIMessageReceived",
        senderData: { chatId: "998877@lid", sender: "77771234567@c.us" },
      },
      "123",
    );
    expect(event.phone).toBeNull();
    expect(event.chatId).toBe("998877@lid");
  });
  it("не путает телефон отправителя группового сообщения с номером группы", () => {
    const event = parseGreenEvent(
      {
        ...base,
        typeWebhook: "incomingMessageReceived",
        senderData: { chatId: "123@g.us", sender: "77771234567@c.us" },
        messageData: { extendedTextMessageData: { text: "STOP" } },
      },
      "123",
    );
    expect(event.chatId).toBe("123@g.us");
    expect(event.stop).toBe(true);
  });
});
