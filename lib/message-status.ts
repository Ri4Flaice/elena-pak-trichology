export const RECIPIENT_STATUS_LABEL = {
  PENDING: "Ожидает",
  SENDING: "Отправляется",
  ACCEPTED: "Принято GreenAPI",
  ERROR: "Ошибка",
  UNKNOWN: "Результат неизвестен",
  SKIPPED: "Пропущено",
} as const;

const DELIVERY_STATUS_LABEL: Record<string, string> = {
  sent: "Отправлено",
  delivered: "Доставлено",
  read: "Прочитано",
  failed: "Ошибка доставки",
  noAccount: "Нет аккаунта WhatsApp",
  suspended: "Временное ограничение WhatsApp",
  yellowCard: "Ограничение WhatsApp",
  notInGroup: "Нет доступа к группе",
};

export function deliveryLabel(status: string | null) {
  return status
    ? DELIVERY_STATUS_LABEL[status] || "Неизвестный статус"
    : "Нет подтверждения";
}
