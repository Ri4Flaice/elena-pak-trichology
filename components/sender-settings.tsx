"use client";

import { useCallback, useEffect, useState } from "react";
import { deliveryLabel, RECIPIENT_STATUS_LABEL } from "@/lib/message-status";

type Attempt = {
  id: string;
  phone: string;
  outcome: string;
  deliveryStatus: string | null;
  error: string | null;
  reviewNote: string | null;
  reservedAt: string;
};
type Snapshot = {
  state: {
    dailyLimit: number;
    seriesLimit: number;
    seriesCount: number;
    intervalMs: number;
    seriesPauseMs: number;
    startHour: number;
    endHour: number;
    timeZone: string;
    nextAllowedAt: string | null;
    maintenanceUntil: string | null;
    maintenanceActive: boolean;
    pauseReason: string | null;
  };
  used: number;
  remaining: number;
  unresolved: { chatId: string }[];
  attempts: Attempt[];
};

async function request(url: string, body?: unknown) {
  const response = await fetch(url, {
    cache: "no-store",
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "Не удалось выполнить действие");
  return result;
}

export function SenderSettings() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setData(await request("/api/green-api/settings"));
      setError("");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Не удалось загрузить настройки",
      );
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    request("/api/green-api/settings")
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((error) => {
        if (!cancelled)
          setError(
            error instanceof Error
              ? error.message
              : "Не удалось загрузить настройки",
          );
      });
    const handler = () => {
      void refresh();
    };
    window.addEventListener("sender-updated", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("sender-updated", handler);
    };
  }, [refresh]);

  async function act(action: string, extra: Record<string, string> = {}) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request("/api/green-api/settings", { action, ...extra });
      await refresh();
      setNotice(
        action === "configure"
          ? "Настройки отправлены. Инстанс перезапускается; подождите до пяти минут, затем проверьте подключение."
          : "Действие выполнено. Для отправки продолжите кампанию вручную.",
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Не удалось выполнить действие",
      );
    } finally {
      setBusy(false);
    }
  }

  function review(attempt: Attempt, result: "sent" | "not-sent") {
    const note = window.prompt(
      result === "sent"
        ? "После проверки WhatsApp/GreenAPI: как вы подтвердили, что сообщение отправлено? (от 10 символов)"
        : "Сначала проверьте и при необходимости очистите очередь GreenAPI. Как вы подтвердили, что сообщение НЕ отправлено и больше не уйдёт? (от 10 символов)",
    );
    if (note)
      void act("resolve-attempt", { attemptId: attempt.id, result, note });
  }

  return (
    <section className="panel" aria-labelledby="sender-heading">
      <div className="section-heading">
        <div>
          <h2 id="sender-heading">Контроль отправки</h2>
          <p>
            Лимиты общие для всех рассылок этого номера. Они снижают
            интенсивность, но не гарантируют отсутствие блокировки.
          </p>
        </div>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {data && (
        <>
          <div className="metrics">
            <div>
              <strong>
                {data.used} / {data.state.dailyLimit}
              </strong>
              <span>Попыток сегодня</span>
            </div>
            <div>
              <strong>
                {data.state.seriesCount} / {data.state.seriesLimit}
              </strong>
              <span>В текущей серии</span>
            </div>
            <div>
              <strong>{data.state.intervalMs / 1000} сек</strong>
              <span>Между сообщениями</span>
            </div>
          </div>
          <p className="muted">
            Отправка: {data.state.startHour}:00–{data.state.endHour}:00 (
            {data.state.timeZone}). После серии — пауза{" "}
            {data.state.seriesPauseMs / 60000} минут и ручное продолжение.
          </p>
          {data.state.nextAllowedAt && (
            <p>
              Следующее сообщение не ранее:{" "}
              {new Date(data.state.nextAllowedAt).toLocaleString("ru-RU", {
                timeZone: data.state.timeZone,
              })}
            </p>
          )}
          {data.state.pauseReason && (
            <p role="status">Пауза: {data.state.pauseReason}</p>
          )}
          {data.state.maintenanceUntil && data.state.maintenanceActive && (
            <p>
              Обслуживание инстанса до:{" "}
              {new Date(data.state.maintenanceUntil).toLocaleString("ru-RU", {
                timeZone: data.state.timeZone,
              })}
            </p>
          )}
        </>
      )}
      <div className="report-actions">
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Обновить
        </button>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void act("check")}
        >
          Проверить GreenAPI
        </button>
      </div>
      <details className="skipped">
        <summary>Настройки инстанса и очередь</summary>
        <p>
          Применение настроек перезапустит инстанс: задержка 15 секунд,
          автопечать 10 символов/сек, уведомления о входящих, исходящих
          сообщениях, статусах и авторизации. Автопрочтение и постоянный статус
          «в сети» выключены.
        </p>
        <div className="report-actions">
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Приостановить отправку и применить настройки GreenAPI? Инстанс перезапустится, применение занимает до пяти минут.",
                )
              )
                void act("configure");
            }}
          >
            Применить настройки инстанса
          </button>
          <button
            className="danger-button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Удалить ВСЕ ожидающие сообщения из очереди инстанса, включая сообщения других приложений? Уже отправленные сообщения это не отменит.",
                )
              )
                void act("clear-queue", { confirm: "CLEAR INSTANCE QUEUE" });
            }}
          >
            Очистить всю очередь GreenAPI
          </button>
        </div>
      </details>
      {!!data?.unresolved.length && (
        <details open className="skipped">
          <summary>Отписки с неизвестным телефоном</summary>
          {data.unresolved.map((chat) => (
            <p key={chat.chatId}>
              {chat.chatId}{" "}
              <button
                disabled={busy}
                onClick={async () => {
                  const phone = window.prompt(
                    "Введите телефон клиента из этого чата. Номер будет исключён из рассылок.",
                  );
                  if (!phone) return;
                  setBusy(true);
                  try {
                    await request("/api/contacts", {
                      action: "resolve-chat",
                      chatId: chat.chatId,
                      phone,
                    });
                    await refresh();
                  } catch (error) {
                    setError(
                      error instanceof Error
                        ? error.message
                        : "Ошибка привязки",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Указать телефон
              </button>
            </p>
          ))}
        </details>
      )}
      {!!data?.attempts.length && (
        <details className="skipped">
          <summary>Журнал попыток и ручная проверка</summary>
          <p className="muted">
            Сначала показаны до 20 неподтверждённых попыток, затем последние 20.
            После проверки обновите список. Проверяйте WhatsApp и очередь перед
            разрешением повтора.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Телефон / время</th>
                  <th>Результат</th>
                  <th>Проверка</th>
                </tr>
              </thead>
              <tbody>
                {data.attempts.map((attempt) => (
                  <tr key={attempt.id}>
                    <td>
                      +{attempt.phone}
                      <small>
                        {new Date(attempt.reservedAt).toLocaleString("ru-RU")}
                      </small>
                    </td>
                    <td>
                      {attempt.deliveryStatus
                        ? deliveryLabel(attempt.deliveryStatus)
                        : RECIPIENT_STATUS_LABEL[
                            attempt.outcome as keyof typeof RECIPIENT_STATUS_LABEL
                          ] || attempt.outcome}
                      <small>
                        {[attempt.error, attempt.reviewNote]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </td>
                    <td>
                      {!["sent", "delivered", "read"].includes(
                        attempt.deliveryStatus ?? "",
                      ) && (
                        <div className="tool-actions">
                          <button
                            disabled={busy}
                            onClick={() => review(attempt, "sent")}
                          >
                            Отправлено
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => review(attempt, "not-sent")}
                          >
                            Не отправлено
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
