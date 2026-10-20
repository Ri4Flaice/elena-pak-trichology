import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Run the real Prisma queries and migrations against an isolated WASM Postgres.
// One DB connection mirrors PGlite's single backend; no production DB/env is used.
const connection = vi.hoisted(() => ({ client: null as PrismaClient | null }));
vi.mock("../lib/db", () => ({
  get db() {
    return connection.client!;
  },
}));
vi.mock("../lib/api", () => ({
  requireAuth: async () => null,
  errorResponse: () =>
    Response.json({ error: "Request failed" }, { status: 500 }),
}));

import { receiveGreenEvent, type GreenEvent } from "../lib/green-webhooks";
import { sendNext, resumeCampaign, senderTransaction } from "../lib/sender";
import { POST as createCampaign } from "../app/api/campaigns/route";
import { DELETE as deleteCampaign } from "../app/api/campaigns/[id]/route";
import { POST as retryErrors } from "../app/api/campaigns/[id]/retry/route";
import {
  GET as getSettings,
  POST as updateSettings,
} from "../app/api/green-api/settings/route";
import { POST as webhookRoute } from "../app/api/green-api/webhook/route";

let pg: PGlite;
let server: PGLiteSocketServer;
let migrated: {
  status: string;
  outcome: string;
  deliveryStatus: string | null;
  count: number;
};
const now = new Date("2026-10-20T06:00:00Z");
const secret = "test-webhook-secret-for-isolated-tests";
const phone = "77771234567";
const event = (idMessage: string, status: string): GreenEvent => ({
  type: "outgoingMessageStatus",
  timestamp: Math.floor(Date.now() / 1000),
  idMessage,
  status,
  chatId: `${phone}@c.us`,
  phone,
  stop: false,
  sendByApi: true,
});
const client = () => connection.client!;
const jsonRequest = (body: unknown) =>
  new Request("https://mailer.test/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const context = { params: Promise.resolve({ id: "campaign" }) };

beforeAll(async () => {
  vi.stubEnv("GREEN_API_ID_INSTANCE", "123");
  vi.stubEnv("GREEN_API_URL", "https://green.test");
  vi.stubEnv("GREEN_API_TOKEN", "test-token");
  vi.stubEnv(
    "GREEN_API_WEBHOOK_URL",
    "https://mailer.test/api/green-api/webhook",
  );
  vi.stubEnv("GREEN_API_WEBHOOK_SECRET", secret);
  pg = await PGlite.create();
  await pg.exec(
    await readFile(
      new URL(
        "../prisma/migrations/20260918000000_init/migration.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await pg.exec(`INSERT INTO "Campaign" (id, "fileName", template, "updatedAt") VALUES ('legacy', 'old.xlsx', 'text', NOW());
    INSERT INTO "Recipient" (id, "campaignId", "rowNumber", "firstName", "lastName", phone, message, status, "updatedAt")
    VALUES ('legacy-recipient', 'legacy', 2, 'A', 'B', '${phone}', 'text', 'SENDING', NOW());`);
  await pg.exec(
    await readFile(
      new URL(
        "../prisma/migrations/20261020000000_green_api_safety/migration.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const migrationResult = await pg.query<{
    status: string;
    outcome: string;
    deliveryStatus: string | null;
  }>(
    `SELECT r.status, a.outcome, r."deliveryStatus" FROM "Recipient" r JOIN "SendAttempt" a ON a."recipientId" = r.id`,
  );
  migrated = { ...migrationResult.rows[0], count: migrationResult.rows.length };
  server = new PGLiteSocketServer({
    db: pg,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 1,
  });
  await server.start();
  const address = server.getServerConn();
  const url = address.startsWith("postgres")
    ? new URL(address)
    : new URL(`postgresql://postgres:postgres@${address}/postgres`);
  url.searchParams.set("connection_limit", "1");
  connection.client = new PrismaClient({ datasourceUrl: url.toString() });
  await client().$connect();
}, 60000);

beforeEach(async () => {
  await client().$executeRawUnsafe(
    `TRUNCATE "Campaign", "Recipient", "SenderState", "ContactPreference", "ChatIdentity", "SendAttempt", "GreenWebhookEvent" CASCADE`,
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await client().senderState.create({
    data: { id: "123", activeCampaignId: "campaign" },
  });
  await client().campaign.create({
    data: {
      id: "campaign",
      fileName: "clients.xlsx",
      template: "Привет",
      status: "RUNNING",
      recipients: {
        create: [2, 3].map((rowNumber) => ({
          id: `recipient-${rowNumber}`,
          rowNumber,
          firstName: "Имя",
          lastName: "Фамилия",
          phone: rowNumber === 2 ? phone : "77771234568",
          message: "Привет",
        })),
      },
    },
  });
  await client().contactPreference.createMany({
    data: [phone, "77771234568"].map((phone) => ({
      phone,
      consentAt: now,
      consentSource: "Анкета клиента",
    })),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.includes("/getSettings/"))
        return Response.json({
          webhookUrl: "https://mailer.test/api/green-api/webhook",
          webhookUrlToken: `Bearer ${secret}`,
          delaySendMessagesMilliseconds: 15000,
          incomingWebhook: "yes",
          outgoingWebhook: "yes",
          outgoingAPIMessageWebhook: "yes",
          stateWebhook: "yes",
        });
      if (input.includes("/getStateInstance/"))
        return Response.json({ stateInstance: "authorized" });
      if (input.includes("/showMessagesQueue/")) return Response.json([]);
      if (input.includes("/sendMessage/"))
        return Response.json({ idMessage: "message-1" });
      throw new Error(
        `Unexpected test request: ${new URL(input).pathname.split("/")[2]}`,
      );
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await connection.client?.$disconnect();
  await server?.stop();
  await pg?.close();
  vi.unstubAllEnvs();
}, 30000);

describe("миграция и ограничения на реальных Prisma-запросах", () => {
  it("сохраняет старую попытку и не выдумывает доставку", () => {
    expect(migrated).toEqual({
      status: "UNKNOWN",
      outcome: "UNKNOWN",
      deliveryStatus: null,
      count: 1,
    });
  });
  it("параллельные запросы создают только одну внешнюю отправку и резерв квоты", async () => {
    await Promise.all([sendNext("campaign"), sendNext("campaign")]);
    expect(await client().sendAttempt.count()).toBe(1);
    const calls = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).includes("/sendMessage/"));
    expect(calls).toHaveLength(1);
  });
  it("соблюдает интервал после статуса sent, затем допускает следующее сообщение", async () => {
    await sendNext("campaign");
    await receiveGreenEvent(event("message-1", "sent"));
    const waiting = await sendNext("campaign");
    expect(waiting.processed).toBe(0);
    vi.setSystemTime(new Date(now.getTime() + 60000));
    // Use a new ID for the second external send.
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).includes("/sendMessage/")
        ? Response.json({ idMessage: "message-2" })
        : original(input, init),
    );
    expect(await sendNext("campaign")).toMatchObject({ processed: 1 });
    expect(await client().sendAttempt.count()).toBe(2);
  });
  it("не отправляет без согласия и после отказа, даже если кампания уже создана", async () => {
    await client().contactPreference.update({
      where: { phone },
      data: { optedOutAt: now },
    });
    await client().contactPreference.update({
      where: { phone: "77771234568" },
      data: { consentAt: null },
    });
    expect((await sendNext("campaign")).done).toBe(true);
    expect(await client().sendAttempt.count()).toBe(0);
    expect(
      await client().recipient.count({ where: { status: "SKIPPED" } }),
    ).toBe(2);
  });
  it("не разрешает параллельную другую кампанию", async () => {
    await client().campaign.create({
      data: { id: "other", fileName: "other.xlsx", template: "Привет" },
    });
    await expect(resumeCampaign("other")).rejects.toThrow("другую");
    expect(await client().sendAttempt.count()).toBe(0);
  });
  it("общий дневной лимит остаётся после удаления другой кампании", async () => {
    await client().senderState.update({
      where: { id: "123" },
      data: { dailyLimit: 1 },
    });
    await client().sendAttempt.create({
      data: {
        instanceId: "123",
        campaignId: "deleted",
        recipientId: "deleted",
        phone,
        quotaDay: "2026-10-20",
        outcome: "ACCEPTED",
        deliveryStatus: "sent",
        reservedAt: now,
      },
    });
    const result = await sendNext("campaign");
    expect(result.processed).toBe(0);
    expect(
      (await client().campaign.findUniqueOrThrow({ where: { id: "campaign" } }))
        .status,
    ).toBe("PAUSED");
    expect(await client().sendAttempt.count()).toBe(1);
    vi.setSystemTime(new Date("2026-10-21T06:00:00Z"));
    await resumeCampaign("campaign");
    expect((await sendNext("campaign")).processed).toBe(1);
  });
  it("по окончании серии ставит паузу, которую нельзя обойти новым resume", async () => {
    await client().senderState.update({
      where: { id: "123" },
      data: { seriesLimit: 1 },
    });
    const result = await sendNext("campaign");
    expect(result.manual).toBe(true);
    await receiveGreenEvent(event("message-1", "sent"));
    await expect(resumeCampaign("campaign")).rejects.toThrow("после");
    vi.setSystemTime(new Date(now.getTime() + 1800000));
    await resumeCampaign("campaign");
    expect(
      (await client().campaign.findUniqueOrThrow({ where: { id: "campaign" } }))
        .status,
    ).toBe("RUNNING");
  });
  it("фиксирует паузу серии до запроса провайдеру, даже если отправка прервётся", async () => {
    await client().senderState.update({
      where: { id: "123" },
      data: { seriesLimit: 1 },
    });
    const original = vi.mocked(fetch).getMockImplementation()!;
    let pauseWasCommitted = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/sendMessage/")) {
        const state = await client().senderState.findUniqueOrThrow({
          where: { id: "123" },
        });
        pauseWasCommitted =
          state.nextAllowedAt?.getTime() === now.getTime() + 1800000;
        throw new Error("interrupted");
      }
      return original(input, init);
    });
    await sendNext("campaign");
    expect(pauseWasCommitted).toBe(true);
    expect(
      (
        await client().senderState.findUniqueOrThrow({ where: { id: "123" } })
      ).nextAllowedAt?.getTime(),
    ).toBe(now.getTime() + 1800000);
    expect(await client().sendAttempt.count()).toBe(1);
  });
  it("останавливается при UNKNOWN и не повторяет запрос", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/sendMessage/")) throw new Error("timeout");
      return original(input, init);
    });
    await sendNext("campaign");
    expect((await client().sendAttempt.findFirstOrThrow()).outcome).toBe(
      "UNKNOWN",
    );
    await sendNext("campaign");
    await expect(resumeCampaign("campaign")).rejects.toThrow(
      "неподтверждённую",
    );
    expect(await client().sendAttempt.count()).toBe(1);
  });
  it("останавливается через пять минут без подтверждения отправки", async () => {
    await sendNext("campaign");
    vi.setSystemTime(new Date(now.getTime() + 300000));
    expect((await sendNext("campaign")).manual).toBe(true);
    expect(
      (await client().senderState.findUniqueOrThrow({ where: { id: "123" } }))
        .pauseReason,
    ).toContain("подтверждения");
    expect(await client().sendAttempt.count()).toBe(1);
  });
  it("сопоставляет ранний webhook и не понижает read поздним sent", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/sendMessage/")) {
        await receiveGreenEvent(event("message-1", "read"));
        return Response.json({ idMessage: "message-1" });
      }
      return original(input, init);
    });
    await sendNext("campaign");
    await receiveGreenEvent(event("message-1", "sent"));
    await receiveGreenEvent(event("message-1", "sent"));
    expect(
      (
        await client().recipient.findUniqueOrThrow({
          where: { id: "recipient-2" },
        })
      ).deliveryStatus,
    ).toBe("read");
    expect(await client().greenWebhookEvent.count()).toBe(2);
  });
  it("сохраняет отписку без телефона и блокирует до привязки", async () => {
    await receiveGreenEvent({
      ...event("stop", ""),
      type: "incomingMessageReceived",
      chatId: "12345@lid",
      phone: null,
      stop: true,
    });
    await expect(resumeCampaign("campaign")).rejects.toThrow("неизвестным");
    expect(
      await client().chatIdentity.count({
        where: { optedOutAt: { not: null } },
      }),
    ).toBe(1);
    expect((await sendNext("campaign")).processed).toBe(0);
  });
  it("повторный STOP идемпотентен и исключает все ожидающие сообщения номера", async () => {
    const stop = {
      ...event("stop", ""),
      type: "incomingMessageReceived",
      stop: true,
    };
    await receiveGreenEvent(stop);
    await receiveGreenEvent(stop);
    expect(
      (await client().contactPreference.findUniqueOrThrow({ where: { phone } }))
        .optedOutAt,
    ).not.toBeNull();
    expect(
      (
        await client().recipient.findUniqueOrThrow({
          where: { id: "recipient-2" },
        })
      ).status,
    ).toBe("SKIPPED");
    expect(await client().greenWebhookEvent.count()).toBe(1);
  });
  it("устаревшая авторизация не отменяет новый suspended", async () => {
    await receiveGreenEvent({
      ...event("", "suspended"),
      type: "stateInstanceChanged",
    });
    await receiveGreenEvent({
      ...event("", "authorized"),
      type: "stateInstanceChanged",
      timestamp: Math.floor(now.getTime() / 1000) - 60,
    });
    expect(
      (await client().senderState.findUniqueOrThrow({ where: { id: "123" } }))
        .stateInstance,
    ).toBe("suspended");
    expect((await sendNext("campaign")).processed).toBe(0);
  });
  it("не отправляет за пределами рабочего времени", async () => {
    vi.setSystemTime(new Date("2026-10-20T13:00:00Z"));
    expect((await sendNext("campaign")).processed).toBe(0);
    expect(await client().sendAttempt.count()).toBe(0);
    await expect(resumeCampaign("campaign")).rejects.toThrow("Время отправки");
  });
  it("старый SENDING становится UNKNOWN без повторной отправки", async () => {
    await client().sendAttempt.create({
      data: {
        instanceId: "123",
        campaignId: "campaign",
        recipientId: "recipient-2",
        phone,
        quotaDay: "2026-10-20",
        reservedAt: new Date(now.getTime() - 300000),
      },
    });
    await client().recipient.update({
      where: { id: "recipient-2" },
      data: { status: "SENDING" },
    });
    expect((await sendNext("campaign")).manual).toBe(true);
    expect((await client().sendAttempt.findFirstOrThrow()).outcome).toBe(
      "UNKNOWN",
    );
    expect(
      (
        await client().recipient.findUniqueOrThrow({
          where: { id: "recipient-2" },
        })
      ).status,
    ).toBe("UNKNOWN");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });
  it("ошибка noAccount без ID не сопоставляется ошибочно по телефону", async () => {
    await sendNext("campaign");
    await receiveGreenEvent(event("", "noAccount"));
    const attempt = await client().sendAttempt.findFirstOrThrow();
    expect(attempt.deliveryStatus).toBeNull();
    expect(
      (await client().senderState.findUniqueOrThrow({ where: { id: "123" } }))
        .pauseReason,
    ).toContain("noAccount");
  });
  it("удаление кампании сохраняет журнал и дневную квоту", async () => {
    await sendNext("campaign");
    await receiveGreenEvent(event("message-1", "sent"));
    expect((await deleteCampaign(jsonRequest({}), context)).status).toBe(200);
    expect(await client().campaign.count()).toBe(0);
    expect(await client().recipient.count()).toBe(0);
    expect(await client().sendAttempt.count()).toBe(1);
    const snapshot = await (
      await getSettings(
        new Request("https://mailer.test/api/green-api/settings"),
      )
    ).json();
    expect(snapshot.used).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(JSON.stringify(snapshot)).not.toContain("test-token");
  });
  it("импорт 800 клиентов сохраняет согласия массово, не снимая существующий отказ", async () => {
    await client().contactPreference.update({
      where: { phone },
      data: { optedOutAt: now },
    });
    const rows = Array.from({ length: 800 }, (_, index) => ({
      rowNumber: index + 2,
      firstName: "Имя",
      lastName: "Фамилия",
      rawPhone: String(Number(phone) + index),
    }));
    const response = await createCampaign(
      jsonRequest({
        fileName: "800.xlsx",
        template: "Здравствуйте, {{Имя}}",
        rows,
        selectedRowNumbers: rows.map((row) => row.rowNumber),
        consentRowNumbers: rows.map((row) => row.rowNumber),
        consentSource: "Анкеты с согласием на сообщения",
      }),
    );
    expect(response.status).toBe(201);
    const { id } = await response.json();
    expect(
      await client().recipient.count({
        where: { campaignId: id, status: "PENDING" },
      }),
    ).toBe(799);
    expect(
      await client().recipient.count({
        where: {
          campaignId: id,
          status: "SKIPPED",
          error: "Отказ от рассылок",
        },
      }),
    ).toBe(1);
    expect(
      (await client().contactPreference.findUniqueOrThrow({ where: { phone } }))
        .optedOutAt,
    ).not.toBeNull();
  });
  it("UNKNOWN нельзя подготовить к повтору кнопкой ошибок", async () => {
    await client().sendAttempt.create({
      data: {
        instanceId: "123",
        campaignId: "campaign",
        recipientId: "recipient-2",
        phone,
        quotaDay: "2026-10-20",
        outcome: "UNKNOWN",
        reservedAt: now,
      },
    });
    const response = await retryErrors(jsonRequest({}), context);
    expect(response.status).toBe(500);
    expect(await client().sendAttempt.count()).toBe(1);
  });
  it("только проверенный повторяемый отказ подготавливается, но не отправляется кнопкой ошибок", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).includes("/sendMessage/")
        ? new Response("", { status: 429 })
        : original(input, init),
    );
    await sendNext("campaign");
    const response = await retryErrors(jsonRequest({}), context);
    expect(await response.json()).toEqual({ count: 1 });
    expect(
      (
        await client().recipient.findUniqueOrThrow({
          where: { id: "recipient-2" },
        })
      ).status,
    ).toBe("PENDING");
    expect(await client().sendAttempt.count()).toBe(1);
    expect(
      (await client().campaign.findUniqueOrThrow({ where: { id: "campaign" } }))
        .status,
    ).toBe("PAUSED");
  });
  it("ручное подтверждение отсутствия отправки требует пустую очередь и сохраняет квоту", async () => {
    await sendNext("campaign");
    const attempt = await client().sendAttempt.findFirstOrThrow();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).includes("/showMessagesQueue/")
        ? Response.json([{ idMessage: "message-1" }])
        : original(input, init),
    );
    const body = {
      action: "resolve-attempt",
      attemptId: attempt.id,
      result: "not-sent",
      note: "Проверено в журнале WhatsApp",
    };
    expect((await updateSettings(jsonRequest(body))).status).toBe(409);
    expect((await client().sendAttempt.findFirstOrThrow()).outcome).toBe(
      "ACCEPTED",
    );
    vi.setSystemTime(new Date(now.getTime() + 90000));
    vi.mocked(fetch).mockImplementation(original);
    expect((await updateSettings(jsonRequest(body))).status).toBe(200);
    expect((await client().sendAttempt.findFirstOrThrow()).retryable).toBe(
      true,
    );
    expect((await client().sendAttempt.findFirstOrThrow()).quotaDay).toBe(
      "2026-10-20",
    );
  });
  it("вебхук отклоняет неверный секрет и слишком большой запрос", async () => {
    const request = jsonRequest({});
    expect((await webhookRoute(request)).status).toBe(401);
    const oversized = new Request("https://mailer.test/api/green-api/webhook", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: "x".repeat(256001),
    });
    expect((await webhookRoute(oversized)).status).toBe(413);
    expect(await client().greenWebhookEvent.count()).toBe(0);
  });
  it("настройки инстанса применяются только отдельным действием и без отправки сообщений", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let applied: Record<string, unknown> = {};
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/setSettings/")) {
        applied = JSON.parse(String(init?.body));
        return Response.json({ saveSettings: true });
      }
      return original(input, init);
    });
    expect(
      (await updateSettings(jsonRequest({ action: "configure" }))).status,
    ).toBe(200);
    expect(applied).toMatchObject({
      delaySendMessagesMilliseconds: 15000,
      autoTyping: 2,
      outgoingWebhook: "yes",
      webhookUrlToken: `Bearer ${secret}`,
    });
    expect(await client().sendAttempt.count()).toBe(0);
    expect(
      (await client().campaign.findUniqueOrThrow({ where: { id: "campaign" } }))
        .status,
    ).toBe("PAUSED");
    await expect(resumeCampaign("campaign")).rejects.toThrow("Обслуживание");
    expect(
      (
        await updateSettings(
          jsonRequest({
            action: "clear-queue",
            confirm: "CLEAR INSTANCE QUEUE",
          }),
        )
      ).status,
    ).toBe(409);
  });
  it("критическая ошибка после резервирования сохраняет занятый слот при откате записи результата", async () => {
    // A committed reservation survives interruption before the external result.
    await senderTransaction(async (tx) => {
      await tx.sendAttempt.create({
        data: {
          instanceId: "123",
          campaignId: "campaign",
          recipientId: "recipient-2",
          phone,
          quotaDay: "2026-10-20",
          reservedAt: now,
        },
      });
      await tx.recipient.update({
        where: { id: "recipient-2" },
        data: { status: "SENDING" },
      });
    });
    await expect(
      senderTransaction(async (tx) => {
        await tx.sendAttempt.updateMany({ data: { outcome: "ACCEPTED" } });
        throw new Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");
    expect((await sendNext("campaign")).processed).toBe(0);
    expect(await client().sendAttempt.count()).toBe(1);
    expect((await client().sendAttempt.findFirstOrThrow()).outcome).toBe(
      "SENDING",
    );
  });
});
