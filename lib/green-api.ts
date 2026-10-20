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

// Some mutating GreenAPI methods also use GET (e.g. clearMessagesQueue).
// Retry only this explicit set of read-only checks, never sending/clearing.
const RETRYABLE_READS = new Set([
  "getSettings",
  "getStateInstance",
  "showMessagesQueue",
]);

function retryDelay(response: Response) {
  const value = response.headers.get("retry-after");
  const seconds = value ? Number(value) : NaN;
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : value
      ? Date.parse(value) - Date.now()
      : 1200;
  return Math.max(1200, Number.isFinite(delay) ? delay : 1200);
}

function httpError(method: string, status: number) {
  const explanation =
    status === 404
      ? ". Метод или инстанс недоступен: проверьте apiUrl и idInstance в кабинете GreenAPI; возможен сбой провайдера"
      : status === 429
        ? ". Превышена частота запросов API. Подождите перед продолжением"
        : "";
  // Do not include the request URL: it contains apiTokenInstance.
  return `GreenAPI: ${method} вернул HTTP ${status}${explanation}`;
}

export async function greenRequest<T>(
  method: string,
  body?: unknown,
): Promise<T> {
  const url = endpoint(method);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25_000),
      cache: "no-store",
    }).catch(() => {
      throw new Error(`GreenAPI: ${method} недоступен; отправка остановлена`);
    });
    if (
      response.status === 429 &&
      attempt === 0 &&
      body === undefined &&
      RETRYABLE_READS.has(method)
    ) {
      const delay = retryDelay(response);
      if (delay <= 10000) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
    }
    if (!response.ok) throw new Error(httpError(method, response.status));
    return response.json();
  }
  throw new Error(`GreenAPI: ${method} не выполнен`);
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
        error: httpError("sendMessage", response.status),
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
