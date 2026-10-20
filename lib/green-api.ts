import type { Recipient } from "@prisma/client";

export type SendOutcome = {
  status: "ACCEPTED" | "ERROR" | "UNKNOWN";
  idMessage?: string;
  error?: string;
  retryable?: boolean;
};

export function instanceId() {
  const id = process.env.GREEN_API_ID_INSTANCE;
  if (!id) throw new Error("GreenAPI не настроен на сервере");
  return id;
}

function endpoint(method: string) {
  const base = process.env.GREEN_API_URL?.replace(/\/+$/, "");
  const token = process.env.GREEN_API_TOKEN;
  if (!base || !token) throw new Error("GreenAPI не настроен на сервере");
  return `${base}/waInstance${instanceId()}/${method}/${token}`;
}

export async function greenRequest<T>(
  method: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(endpoint(method), {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25_000),
    cache: "no-store",
  }).catch(() => {
    throw new Error("GreenAPI недоступен; отправка остановлена");
  });
  if (!response.ok) throw new Error(`GreenAPI вернул HTTP ${response.status}`);
  return response.json();
}

export async function inspectInstance() {
  const state = await greenRequest<{ stateInstance: string }>(
    "getStateInstance",
  );
  if (state.stateInstance !== "authorized")
    throw new Error(`Инстанс: ${state.stateInstance || "неизвестно"}`);
  const queue = await greenRequest<unknown>("showMessagesQueue");
  if (!Array.isArray(queue))
    throw new Error("Не удалось проверить очередь GreenAPI");
  if (queue.length)
    throw new Error("В GreenAPI есть очередь. Проверьте её перед продолжением");
  return state;
}

export async function sendMessage(
  recipient: Pick<Recipient, "phone" | "message">,
): Promise<SendOutcome> {
  const url = endpoint("sendMessage");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: `${recipient.phone}@c.us`,
        message: recipient.message,
      }),
      signal: AbortSignal.timeout(25_000),
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        status:
          response.status >= 400 && response.status < 500 ? "ERROR" : "UNKNOWN",
        error: `GreenAPI вернул HTTP ${response.status}`,
        retryable: response.status === 429,
      };
    }
    const data = (await response.json().catch(() => ({}))) as {
      idMessage?: unknown;
    };
    if (typeof data.idMessage !== "string" || !data.idMessage) {
      return {
        status: "UNKNOWN",
        error: "GreenAPI не вернул idMessage; проверьте отправку вручную",
      };
    }
    return { status: "ACCEPTED", idMessage: data.idMessage };
  } catch {
    return {
      status: "UNKNOWN",
      error: "Нет достоверного ответа GreenAPI; проверьте отправку вручную",
    };
  }
}
