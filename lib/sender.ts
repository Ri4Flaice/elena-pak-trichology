import { db } from "./db";
import {
  inspectInstance,
  greenRequest,
  sendMessage,
  type SendOutcome,
} from "./green-api";
import {
  confirmationExpired,
  isWorkingTime,
  localTime,
} from "./sending-policy";
import { reconcileMessageEvents } from "./green-webhooks";
import {
  pauseSender,
  senderTransaction,
  outstandingAttempt,
} from "./sender-store";
export {
  pauseSender,
  senderTransaction,
  outstandingAttempt,
} from "./sender-store";

export function webhookConfiguration() {
  const url = process.env.GREEN_API_WEBHOOK_URL;
  const token = process.env.GREEN_API_WEBHOOK_SECRET;
  if (!url || !token || token.length < 32)
    throw new Error(
      "Задайте HTTPS GREEN_API_WEBHOOK_URL и GREEN_API_WEBHOOK_SECRET длиной от 32 символов",
    );
  if (new URL(url).protocol !== "https:")
    throw new Error("Webhook URL должен использовать HTTPS");
  return { url, token };
}

export async function verifyInstanceSettings() {
  const { url, token } = webhookConfiguration();
  const settings = await greenRequest<Record<string, unknown>>("getSettings");
  if (
    settings.webhookUrl !== url ||
    settings.webhookUrlToken !== `Bearer ${token}` ||
    !Number.isFinite(Number(settings.delaySendMessagesMilliseconds)) ||
    Number(settings.delaySendMessagesMilliseconds) < 15000 ||
    [
      "incomingWebhook",
      "outgoingWebhook",
      "outgoingAPIMessageWebhook",
      "stateWebhook",
    ].some((key) => settings[key] !== "yes")
  ) {
    throw new Error(
      "Проверьте настройки GreenAPI: URL, секрет, задержка от 15000 мс и четыре типа вебхуков",
    );
  }
}

export async function resumeCampaign(id: string) {
  await verifyInstanceSettings();
  await inspectInstance();
  return senderTransaction(async (tx, state) => {
    const campaign = await tx.campaign.findUnique({ where: { id } });
    if (!campaign) throw new Error("Рассылка не найдена");
    if (state.maintenanceUntil && state.maintenanceUntil > new Date())
      throw new Error(
        `Обслуживание инстанса до ${state.maintenanceUntil.toISOString()}`,
      );
    if (await outstandingAttempt(tx))
      throw new Error(
        "Сначала проверьте неподтверждённую отправку в настройках",
      );
    const unresolved = await tx.chatIdentity.count({
      where: { phone: null, optedOutAt: { not: null } },
    });
    if (unresolved)
      throw new Error(
        "Есть отписка с неизвестным @lid. Укажите телефон в настройках",
      );
    if (state.activeCampaignId && state.activeCampaignId !== id)
      throw new Error("Сначала приостановите другую активную рассылку");
    if (state.nextAllowedAt && state.nextAllowedAt > new Date())
      throw new Error(
        `Продолжение доступно после ${state.nextAllowedAt.toISOString()}`,
      );
    const today = localTime(new Date(), state.timeZone).day;
    if (
      (await tx.sendAttempt.count({
        where: { instanceId: state.id, quotaDay: today },
      })) >= state.dailyLimit
    )
      throw new Error("Дневной лимит исчерпан");
    if (!isWorkingTime(new Date(), state))
      throw new Error(
        `Время отправки: ${state.startHour}:00–${state.endHour}:00 (${state.timeZone})`,
      );
    await tx.senderState.update({
      where: { id: state.id },
      data: {
        pauseReason: null,
        activeCampaignId: id,
        stateInstance: "authorized",
      },
    });
    await tx.campaign.update({
      where: { id },
      data: { status: "RUNNING", pauseReason: null },
    });
  });
}

export async function sendNext(id: string) {
  // Fast local check before provider calls; reserve repeats it under the same lock.
  const ready = await senderTransaction(async (tx, state) => {
    const campaign = await tx.campaign.findUnique({ where: { id } });
    if (!campaign) throw new Error("Рассылка не найдена");
    const waiting = (reason: string, manual = true) => ({
      processed: 0,
      done: campaign.status === "COMPLETED",
      pauseReason: reason,
      manual,
      nextAllowedAt: state.nextAllowedAt,
    });
    if (campaign.status !== "RUNNING" || state.pauseReason)
      return waiting(
        state.pauseReason || campaign.pauseReason || "Нажмите «Продолжить»",
      );
    if (state.activeCampaignId !== id)
      return waiting("Отправка занята другой кампанией");
    const pending = await outstandingAttempt(tx);
    if (pending) {
      if (
        pending.outcome === "UNKNOWN" ||
        confirmationExpired(pending.reservedAt, new Date())
      ) {
        if (pending.outcome === "SENDING") {
          await tx.sendAttempt.update({
            where: { id: pending.id },
            data: {
              outcome: "UNKNOWN",
              error: "Отправка прервалась; требуется проверка",
            },
          });
          await tx.recipient.updateMany({
            where: { id: pending.recipientId },
            data: {
              status: "UNKNOWN",
              error: "Отправка прервалась; требуется проверка",
            },
          });
        }
        await pauseSender(
          tx,
          "Нет подтверждения отправки; проверьте журнал попыток",
        );
        return waiting("Нет подтверждения отправки; проверьте журнал попыток");
      }
      return waiting("Ожидаем подтверждение отправки GreenAPI", false);
    }
    if (!isWorkingTime(new Date(), state)) {
      await tx.campaign.update({
        where: { id },
        data: { status: "PAUSED", pauseReason: "Вне рабочего времени" },
      });
      await tx.senderState.update({
        where: { id: state.id },
        data: { activeCampaignId: null },
      });
      return waiting("Вне рабочего времени");
    }
    if (state.nextAllowedAt && state.nextAllowedAt > new Date())
      return waiting("Интервал между сообщениями", false);
    return null;
  });
  if (ready) return ready;
  try {
    await verifyInstanceSettings();
    await inspectInstance();
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Не удалось проверить GreenAPI";
    await senderTransaction((tx) => pauseSender(tx, reason));
    return { processed: 0, done: false, manual: true, pauseReason: reason };
  }
  const reserved = await senderTransaction(async (tx, state) => {
    const now = new Date();
    const campaign = await tx.campaign.findUnique({ where: { id } });
    if (
      !campaign ||
      campaign.status !== "RUNNING" ||
      state.pauseReason ||
      state.activeCampaignId !== id ||
      (state.nextAllowedAt && state.nextAllowedAt > now) ||
      !isWorkingTime(now, state) ||
      (await outstandingAttempt(tx))
    )
      return null;
    const quotaDay = localTime(now, state.timeZone).day;
    if (
      (await tx.sendAttempt.count({
        where: { instanceId: state.id, quotaDay },
      })) >= state.dailyLimit
    ) {
      await tx.campaign.update({
        where: { id },
        data: { status: "PAUSED", pauseReason: "Дневной лимит исчерпан" },
      });
      await tx.senderState.update({
        where: { id: state.id },
        data: { activeCampaignId: null },
      });
      return null;
    }
    // Skip ineligible rows inside the transaction, including opt-outs since import.
    const candidates = await tx.recipient.findMany({
      where: { campaignId: id, status: "PENDING" },
      orderBy: { rowNumber: "asc" },
      select: { id: true, phone: true },
    });
    const preferences = await tx.contactPreference.findMany({
      where: { phone: { in: candidates.map((row) => row.phone) } },
    });
    const allowed = new Set(
      preferences
        .filter((preference) => preference.consentAt && !preference.optedOutAt)
        .map((preference) => preference.phone),
    );
    const optedOut = new Set(
      preferences
        .filter((preference) => preference.optedOutAt)
        .map((preference) => preference.phone),
    );
    for (const [ids, error] of [
      [
        candidates
          .filter((row) => optedOut.has(row.phone))
          .map((row) => row.id),
        "Отказ от рассылок",
      ],
      [
        candidates
          .filter((row) => !allowed.has(row.phone) && !optedOut.has(row.phone))
          .map((row) => row.id),
        "Нет подтверждённого согласия",
      ],
    ] as const) {
      if (ids.length)
        await tx.recipient.updateMany({
          where: { id: { in: [...ids] } },
          data: { status: "SKIPPED", error },
        });
    }
    const candidate = candidates.find((row) => allowed.has(row.phone));
    if (candidate) {
      const recipient = await tx.recipient.findUniqueOrThrow({
        where: { id: candidate.id },
      });
      const attempt = await tx.sendAttempt.create({
        data: {
          instanceId: state.id,
          campaignId: id,
          recipientId: recipient.id,
          phone: recipient.phone,
          quotaDay,
          reservedAt: now,
        },
      });
      await tx.recipient.update({
        where: { id: recipient.id },
        data: { status: "SENDING", error: null },
      });
      const seriesComplete = state.seriesCount + 1 >= state.seriesLimit;
      await tx.senderState.update({
        where: { id: state.id },
        data: {
          nextAllowedAt: new Date(
            now.getTime() +
              (seriesComplete
                ? Math.max(state.intervalMs, state.seriesPauseMs)
                : state.intervalMs),
          ),
          seriesCount: seriesComplete ? 0 : { increment: 1 },
          ...(seriesComplete ? { activeCampaignId: null } : {}),
        },
      });
      if (seriesComplete)
        await tx.campaign.update({
          where: { id },
          data: {
            status: "PAUSED",
            pauseReason: "Серия завершена. После паузы продолжите вручную",
          },
        });
      return { attempt, recipient };
    }
    await tx.campaign.update({
      where: { id },
      data: { status: "COMPLETED", pauseReason: null },
    });
    await tx.senderState.update({
      where: { id: state.id },
      data: { activeCampaignId: null },
    });
    return null;
  });
  if (!reserved) {
    const campaign = await db.campaign.findUnique({ where: { id } });
    return {
      processed: 0,
      done: campaign?.status === "COMPLETED",
      manual: true,
      pauseReason:
        campaign?.pauseReason || "Обновите журнал и проверьте ограничения",
    };
  }

  // The durable reservation precedes the external side effect. Never retry UNKNOWN.
  const outcome: SendOutcome = await sendMessage(reserved.recipient).catch(
    () => ({
      status: "UNKNOWN" as const,
      error: "Запрос прервался; проверьте отправку вручную",
    }),
  );
  return senderTransaction(async (tx, state) => {
    await tx.sendAttempt.update({
      where: { id: reserved.attempt.id },
      data: {
        outcome: outcome.status,
        idMessage: outcome.idMessage,
        error: outcome.error,
        retryable: "retryable" in outcome && outcome.retryable === true,
        finishedAt: new Date(),
      },
    });
    await tx.recipient.updateMany({
      where: { id: reserved.recipient.id },
      data: {
        status: outcome.status,
        idMessage: outcome.idMessage,
        error: outcome.error,
      },
    });
    if (outcome.idMessage) await reconcileMessageEvents(tx, outcome.idMessage);
    if (outcome.status !== "ACCEPTED")
      await pauseSender(tx, outcome.error || "Требуется проверка отправки");
    const pending = await tx.recipient.count({
      where: { campaignId: id, status: "PENDING" },
    });
    const manual = outcome.status !== "ACCEPTED";
    if (!pending) {
      await tx.campaign.updateMany({
        where: { id, status: "RUNNING" },
        data: { status: "COMPLETED" },
      });
      await tx.senderState.update({
        where: { id: state.id },
        data: { activeCampaignId: null },
      });
    }
    const updated = await tx.senderState.findUniqueOrThrow({
      where: { id: state.id },
    });
    const updatedCampaign = await tx.campaign.findUniqueOrThrow({
      where: { id },
    });
    return {
      processed: 1,
      done: !pending,
      manual: manual || updatedCampaign.status === "PAUSED",
      nextAllowedAt: updated.nextAllowedAt,
      pauseReason: updated.pauseReason || updatedCampaign.pauseReason,
    };
  });
}
