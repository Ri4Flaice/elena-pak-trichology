import { describe, expect, it } from "vitest";
import {
  confirmationExpired,
  isStopCommand,
  isWorkingTime,
  localTime,
  mergeDelivery,
  phoneFromChat,
} from "../lib/sending-policy";

const policy = {
  intervalMs: 60000,
  dailyLimit: 50,
  seriesLimit: 25,
  seriesPauseMs: 1800000,
  timeZone: "Asia/Qyzylorda",
  startHour: 10,
  endHour: 18,
};

describe("ограничения отправки", () => {
  it("считает сутки в часовом поясе бизнеса, независимо от часового пояса сервера", () => {
    expect(
      localTime(new Date("2026-10-20T18:59:59Z"), policy.timeZone).day,
    ).toBe("2026-10-20");
    expect(
      localTime(new Date("2026-10-20T19:00:00Z"), policy.timeZone).day,
    ).toBe("2026-10-21");
  });
  it("включает начало и исключает конец рабочего времени", () => {
    expect(isWorkingTime(new Date("2026-10-20T04:59:59Z"), policy)).toBe(false);
    expect(isWorkingTime(new Date("2026-10-20T05:00:00Z"), policy)).toBe(true);
    expect(isWorkingTime(new Date("2026-10-20T12:59:59Z"), policy)).toBe(true);
    expect(isWorkingTime(new Date("2026-10-20T13:00:00Z"), policy)).toBe(false);
  });
  it("требует проверки по истечении пяти минут без подтверждения", () => {
    const sent = new Date("2026-10-20T06:00:00Z");
    expect(confirmationExpired(sent, new Date("2026-10-20T06:04:59Z"))).toBe(
      false,
    );
    expect(confirmationExpired(sent, new Date("2026-10-20T06:05:00Z"))).toBe(
      true,
    );
  });
});

describe("входящие события", () => {
  it.each(["stop", " STOP ", "стоп", "\nОтписка\t"])(
    "распознаёт точную команду %s",
    (text) => {
      expect(isStopCommand(text)).toBe(true);
    },
  );
  it.each(["не стоп", "Хочу записаться", "stop!", ""])(
    "не считает отказом произвольный текст %s",
    (text) => {
      expect(isStopCommand(text)).toBe(false);
    },
  );
  it("не понижает доставку и сохраняет ошибки для проверки", () => {
    expect(mergeDelivery("read", "sent")).toBe("read");
    expect(mergeDelivery("delivered", "read")).toBe("read");
    expect(mergeDelivery(null, "sent")).toBe("sent");
    expect(mergeDelivery("sent", "failed")).toBe("failed");
    expect(mergeDelivery("failed", "delivered")).toBe("failed");
  });
  it("не принимает lid и групповой чат за телефон", () => {
    expect(phoneFromChat("77771234567@c.us")).toBe("77771234567");
    expect(phoneFromChat("77771234567@lid")).toBeNull();
    expect(phoneFromChat("77771234567@g.us")).toBeNull();
  });
});
