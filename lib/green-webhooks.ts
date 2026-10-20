import { createHash, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { instanceId } from "./green-api";
import { isStopCommand, mergeDelivery, phoneFromChat } from "./sending-policy";
import { pauseSender, senderTransaction, type SenderTx } from "./sender-store";

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
function string(value: unknown) {
  return typeof value === "string" ? value : "";
}

export type GreenEvent = {
  type: string;
  timestamp: number;
  idMessage: string;
  chatId: string;
  phone: string | null;
  status: string;
  stop: boolean;
  sendByApi: boolean;
};

export function validWebhookAuthorization(
  header: string | null,
  secret: string,
) {
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const received = createHash("sha256")
    .update(header ?? "")
    .digest();
  return secret.length >= 32 && timingSafeEqual(expected, received);
}

export function parseGreenEvent(
  input: unknown,
  expectedInstance: string,
): GreenEvent {
  const body = record(input);
  const instance = record(body.instanceData);
  if (
    String(instance.idInstance) !== expectedInstance ||
    instance.typeInstance !== "whatsapp"
  )
    throw new Error("Неверный инстанс вебхука");
  if (
    !Number.isSafeInteger(body.timestamp) ||
    Number(body.timestamp) < 1 ||
    Number(body.timestamp) > Date.now() / 1000 + 300
  )
    throw new Error("Некорректное время события");
  const sender = record(body.senderData);
  const recipient = record(body.recipientData);
  const message = record(body.messageData);
  const chatId =
    string(body.chatId) || string(sender.chatId) || string(recipient.chatId);
  const text =
    string(record(message.textMessageData).textMessage) ||
    string(record(message.extendedTextMessageData).text);
  return {
    type: string(body.typeWebhook),
    timestamp: Number(body.timestamp),
    idMessage: string(body.idMessage),
    chatId,
    phone:
      phoneFromChat(chatId) ||
      (body.typeWebhook === "incomingMessageReceived"
        ? phoneFromChat(string(sender.sender))
        : null),
    status: string(body.status) || string(body.stateInstance),
    stop: isStopCommand(text),
    sendByApi: body.sendByApi === true,
  };
}

export function eventKey(instance: string, event: GreenEvent) {
  return createHash("sha256")
    .update(JSON.stringify([instance, event]))
    .digest("hex");
}

async function applyEvent(tx: SenderTx, key: string, event: GreenEvent) {
  const id = instanceId();
  if (event.type === "stateInstanceChanged") {
    const changed = await tx.senderState.updateMany({
      where: { id, stateTimestamp: { lt: BigInt(event.timestamp) } },
      data: {
        stateInstance: event.status,
        stateTimestamp: BigInt(event.timestamp),
      },
    });
    if (changed.count && event.status !== "authorized")
      await pauseSender(tx, `Состояние WhatsApp: ${event.status}`);
  } else if (
    event.type === "incomingMessageReceived" &&
    event.stop &&
    !event.chatId.endsWith("@g.us")
  ) {
    if (!event.chatId) throw new Error("Отписка без идентификатора чата");
    const identity = await tx.chatIdentity.findUnique({
      where: { chatId: event.chatId },
    });
    const phone = event.phone || identity?.phone;
    await tx.chatIdentity.upsert({
      where: { chatId: event.chatId },
      create: {
        chatId: event.chatId,
        phone,
        optedOutAt: new Date(event.timestamp * 1000),
      },
      update: {
        ...(phone ? { phone } : {}),
        optedOutAt: new Date(event.timestamp * 1000),
      },
    });
    if (phone) {
      await tx.contactPreference.upsert({
        where: { phone },
        create: { phone, optedOutAt: new Date() },
        update: { optedOutAt: new Date() },
      });
      await tx.recipient.updateMany({
        where: { phone, status: "PENDING" },
        data: { status: "SKIPPED", error: "Отказ от рассылок" },
      });
    } else
      await pauseSender(
        tx,
        "Получен СТОП от неизвестного @lid; укажите телефон в настройках",
      );
  } else if (event.type === "outgoingMessageStatus") {
    if (
      ![
        "sent",
        "delivered",
        "read",
        "failed",
        "noAccount",
        "suspended",
        "yellowCard",
        "notInGroup",
      ].includes(event.status)
    ) {
      await pauseSender(
        tx,
        "Неизвестный статус GreenAPI; проверьте журнал событий",
      );
    } else {
      const attempt = event.idMessage
        ? await tx.sendAttempt.findUnique({
            where: {
              instanceId_idMessage: {
                instanceId: id,
                idMessage: event.idMessage,
              },
            },
          })
        : null;
      if (!attempt) {
        // Missing IDs cannot safely be matched by phone: an older send may fail late.
        if (
          ["failed", "noAccount", "suspended", "yellowCard"].includes(
            event.status,
          )
        )
          await pauseSender(
            tx,
            `GreenAPI: ${event.status}; требуется проверка`,
          );
        return;
      }
      const deliveryStatus = mergeDelivery(
        attempt.deliveryStatus,
        event.status,
      );
      await tx.sendAttempt.update({
        where: { id: attempt.id },
        data: { deliveryStatus },
      });
      await tx.recipient.updateMany({
        where: { id: attempt.recipientId, idMessage: attempt.idMessage },
        data: { deliveryStatus },
      });
      if (
        [
          "failed",
          "noAccount",
          "suspended",
          "yellowCard",
          "notInGroup",
        ].includes(deliveryStatus)
      )
        await pauseSender(
          tx,
          `GreenAPI: ${deliveryStatus}; требуется проверка`,
        );
    }
  } else if (event.type === "quotaExceeded") {
    await pauseSender(tx, "Превышено ограничение тарифа GreenAPI");
  }
  // Do not persist message contents, files or names in the event inbox.
  await tx.greenWebhookEvent.update({
    where: { id: key },
    data: { applied: true },
  });
}

export async function reconcileMessageEvents(tx: SenderTx, idMessage: string) {
  const events = await tx.greenWebhookEvent.findMany({
    where: { instanceId: instanceId(), idMessage, applied: false },
    orderBy: { createdAt: "asc" },
  });
  for (const event of events)
    await applyEvent(tx, event.id, event.payload as unknown as GreenEvent);
}

export async function receiveGreenEvent(event: GreenEvent) {
  return senderTransaction(async (tx) => {
    const id = eventKey(instanceId(), event);
    const existing = await tx.greenWebhookEvent.findUnique({ where: { id } });
    if (existing?.applied) return;
    if (!existing)
      await tx.greenWebhookEvent.create({
        data: {
          id,
          instanceId: instanceId(),
          idMessage: event.idMessage || null,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
    if (event.phone && event.chatId && !event.chatId.endsWith("@g.us")) {
      const identity = await tx.chatIdentity.upsert({
        where: { chatId: event.chatId },
        create: { chatId: event.chatId, phone: event.phone },
        update: { phone: event.phone },
      });
      if (identity.optedOutAt)
        await tx.contactPreference.upsert({
          where: { phone: event.phone },
          create: { phone: event.phone, optedOutAt: identity.optedOutAt },
          update: { optedOutAt: identity.optedOutAt },
        });
    }
    await applyEvent(tx, id, event);
  });
}
