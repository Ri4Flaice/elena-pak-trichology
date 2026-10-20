import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/api";
import { greenRequest, instanceId, inspectInstance } from "@/lib/green-api";
import { localTime } from "@/lib/sending-policy";
import { unconfirmedAttemptWhere } from "@/lib/sender-store";
import {
  pauseSender,
  senderTransaction,
  webhookConfiguration,
  outstandingAttempt,
  verifyInstanceSettings,
} from "@/lib/sender";

export const maxDuration = 120;

export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;
  try {
    const result = await senderTransaction(async (tx, state) => {
      const {
        stateTimestamp: _timestamp,
        maintenanceToken: _token,
        ...safeState
      } = state;
      void _timestamp;
      void _token;
      const used = await tx.sendAttempt.count({
        where: {
          instanceId: state.id,
          quotaDay: localTime(new Date(), state.timeZone).day,
        },
      });
      const unresolved = await tx.chatIdentity.findMany({
        where: { phone: null, optedOutAt: { not: null } },
        take: 50,
      });
      const waiting = await tx.sendAttempt.findMany({
        where: {
          instanceId: state.id,
          ...unconfirmedAttemptWhere,
        },
        orderBy: { reservedAt: "asc" },
        take: 20,
      });
      const recent = await tx.sendAttempt.findMany({
        where: { instanceId: state.id },
        orderBy: { reservedAt: "desc" },
        take: 20,
      });
      return {
        state: {
          ...safeState,
          maintenanceActive:
            !!state.maintenanceUntil && state.maintenanceUntil > new Date(),
        },
        used,
        remaining: Math.max(0, state.dailyLimit - used),
        unresolved,
        attempts: [
          ...new Map(
            [...waiting, ...recent].map((attempt) => [attempt.id, attempt]),
          ).values(),
        ],
      };
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "Проверьте подключение к БД, миграцию и GREEN_API_ID_INSTANCE" },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  const denied = await requireAuth(request, true);
  if (denied) return denied;
  try {
    const body = await request.json();
    const maintenanceToken = randomUUID();
    const startMaintenance = async (reason: string, durationMs: number) =>
      senderTransaction(async (tx, state) => {
        if (state.maintenanceUntil && state.maintenanceUntil > new Date())
          throw new Error(
            "Дождитесь завершения текущего обслуживания инстанса",
          );
        if (body.action === "configure" && (await outstandingAttempt(tx)))
          throw new Error(
            "Проверьте неподтверждённые отправки перед изменением настроек",
          );
        if (
          body.action === "clear-queue" &&
          (await tx.sendAttempt.count({
            where: { instanceId: state.id, outcome: "SENDING" },
          }))
        )
          throw new Error(
            "Дождитесь завершения текущего запроса или проверьте его результат через пять минут",
          );
        await pauseSender(tx, reason);
        await tx.senderState.update({
          where: { id: state.id },
          data: {
            maintenanceToken,
            maintenanceUntil: new Date(Date.now() + durationMs),
          },
        });
      });
    const finishMaintenance = () =>
      senderTransaction((tx) =>
        tx.senderState.updateMany({
          where: { id: instanceId(), maintenanceToken },
          data: { maintenanceToken: null, maintenanceUntil: null },
        }),
      );
    if (body.action === "configure") {
      const { url, token } = webhookConfiguration();
      await startMaintenance(
        "Применяются настройки GreenAPI. Дождитесь авторизации и продолжите вручную",
        5 * 60_000,
      );
      // Explicit administrator action only. SetSettings restarts the instance.
      const result = await greenRequest<{ saveSettings: boolean }>(
        "setSettings",
        {
          webhookUrl: url,
          webhookUrlToken: `Bearer ${token}`,
          delaySendMessagesMilliseconds: 15000,
          autoTyping: 2,
          incomingWebhook: "yes",
          outgoingWebhook: "yes",
          outgoingAPIMessageWebhook: "yes",
          outgoingMessageWebhook: "yes",
          stateWebhook: "yes",
          markIncomingMessagesReaded: "no",
          markIncomingMessagesReadedOnReply: "no",
          keepOnlineStatus: "no",
        },
      );
      if (!result.saveSettings)
        throw new Error("GreenAPI не подтвердил сохранение настроек");
      await senderTransaction((tx) =>
        tx.senderState.update({
          where: { id: instanceId() },
          data: { settingsAppliedAt: new Date() },
        }),
      );
    } else if (body.action === "check") {
      await verifyInstanceSettings();
      await inspectInstance();
    } else if (body.action === "resolve-attempt") {
      if (
        typeof body.attemptId !== "string" ||
        typeof body.note !== "string" ||
        body.note.trim().length < 10 ||
        body.note.length > 1000 ||
        !["sent", "not-sent"].includes(body.result)
      )
        throw new Error(
          "Укажите результат проверки и пояснение от 10 до 1000 символов",
        );
      await startMaintenance(
        "Ручная проверка отправки. Продолжите кампанию после проверки",
        90_000,
      );
      if (body.result === "not-sent") {
        const queue = await greenRequest<unknown>("showMessagesQueue");
        if (!Array.isArray(queue) || queue.length)
          throw new Error(
            "Сначала проверьте и очистите очередь GreenAPI: сообщение ещё может уйти",
          );
      }
      await senderTransaction(async (tx) => {
        const attempt = await tx.sendAttempt.findUnique({
          where: { id: body.attemptId },
        });
        if (!attempt || attempt.instanceId !== instanceId())
          throw new Error("Попытка не найдена");
        if (
          attempt.outcome === "SENDING" &&
          Date.now() - attempt.reservedAt.getTime() < 5 * 60_000
        )
          throw new Error("Запрос ещё может выполняться. Подождите пять минут");
        if (
          ["sent", "delivered", "read"].includes(attempt.deliveryStatus ?? "")
        )
          throw new Error("Отправка уже подтверждена");
        const sent = body.result === "sent";
        await tx.sendAttempt.update({
          where: { id: attempt.id },
          data: {
            outcome: sent ? "ACCEPTED" : "ERROR",
            deliveryStatus: sent ? "sent" : attempt.deliveryStatus,
            retryable: !sent,
            reviewNote: body.note.trim(),
            finishedAt: new Date(),
          },
        });
        // Do not overwrite a newer attempt for the same recipient.
        const newest = await tx.sendAttempt.findFirst({
          where: { recipientId: attempt.recipientId },
          orderBy: { reservedAt: "desc" },
        });
        if (newest?.id === attempt.id)
          await tx.recipient.updateMany({
            where: { id: attempt.recipientId },
            data: {
              status: sent ? "ACCEPTED" : "ERROR",
              deliveryStatus: sent ? "sent" : attempt.deliveryStatus,
              error: sent
                ? null
                : "Администратор подтвердил отсутствие отправки",
            },
          });
      });
      await finishMaintenance();
    } else if (body.action === "clear-queue") {
      if (body.confirm !== "CLEAR INSTANCE QUEUE")
        throw new Error("Подтвердите очистку всей очереди инстанса");
      await startMaintenance(
        "Очередь очищается администратором. Проверьте принятые сообщения перед продолжением",
        90_000,
      );
      const result = await greenRequest<{ isCleared: boolean }>(
        "clearMessagesQueue",
      );
      if (!result.isCleared)
        throw new Error("GreenAPI не подтвердил очистку очереди");
      await finishMaintenance();
    } else
      return NextResponse.json(
        { error: "Неизвестное действие" },
        { status: 400 },
      );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Не удалось выполнить действие",
      },
      { status: 409 },
    );
  }
}
