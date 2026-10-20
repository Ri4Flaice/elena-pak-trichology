export type SendingPolicy = {
  intervalMs: number;
  dailyLimit: number;
  seriesLimit: number;
  seriesPauseMs: number;
  timeZone: string;
  startHour: number;
  endHour: number;
};

export function localTime(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (key: string) => parts.find((part) => part.type === key)!.value;
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
  };
}

export function isWorkingTime(now: Date, policy: SendingPolicy) {
  const { hour } = localTime(now, policy.timeZone);
  return hour >= policy.startHour && hour < policy.endHour;
}

export function isStopCommand(text: string) {
  return ["STOP", "СТОП", "ОТПИСКА"].includes(text.trim().toUpperCase());
}

export function mergeDelivery(current: string | null, incoming: string) {
  const rank: Record<string, number> = { sent: 1, delivered: 2, read: 3 };
  if (rank[current ?? ""] && rank[incoming]) {
    return rank[incoming] > rank[current!] ? incoming : current!;
  }
  // A late success must not erase a provider failure requiring review.
  if (
    ["failed", "noAccount", "suspended", "yellowCard"].includes(current ?? "")
  )
    return current!;
  return incoming;
}

export function phoneFromChat(chatId: string) {
  return /^7\d{10}@c\.us$/.test(chatId) ? chatId.slice(0, -5) : null;
}

export function confirmationExpired(reservedAt: Date, now: Date) {
  return now.getTime() - reservedAt.getTime() >= 5 * 60_000;
}
