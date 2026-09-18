import type { Recipient } from "@prisma/client";

export type SendOutcome = {
  status: "ACCEPTED" | "ERROR" | "UNKNOWN";
  idMessage?: string;
  error?: string;
};

export function batchSize() {
  const configured = Number(process.env.SEND_BATCH_SIZE ?? 5);
  return Number.isInteger(configured)
    ? Math.min(5, Math.max(1, configured))
    : 5;
}

export function sendDelay() {
  const configured = Number(process.env.SEND_DELAY_MS ?? 700);
  return Number.isInteger(configured)
    ? Math.min(10_000, Math.max(0, configured))
    : 700;
}

export async function sendMessage(
  recipient: Pick<Recipient, "phone" | "message">,
): Promise<SendOutcome> {
  const base = process.env.GREEN_API_URL?.replace(/\/+$/, "");
  const id = process.env.GREEN_API_ID_INSTANCE;
  const token = process.env.GREEN_API_TOKEN;
  if (!base || !id || !token)
    throw new Error("GreenAPI не настроен на сервере");
  const url = `${base}/waInstance${id}/sendMessage/${token}`;
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
