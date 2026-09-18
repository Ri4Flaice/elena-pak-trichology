export type ClientRow = {
  rowNumber: number;
  firstName: string;
  lastName: string;
  rawPhone: string;
};

export type PreparedClient = ClientRow & { phone: string; message: string };
export type SkippedClient = ClientRow & { reason: string };

export const DEFAULT_TEMPLATE = [
  "Добрый день, {{Имя}}!",
  "Приглашаем вас на Клиентский день — 18 сентября!",
  "",
  "В Центре восстановления волос трихолога Елены Пак мы проведём день, посвящённый здоровью кожи головы и волос.",
  "",
  "Вас ждёт БЕСПЛАТНАЯ диагностика, которая включает:",
  "• осмотр кожи головы",
  "• трихоскопию",
  "• оценку состояния кожи головы и волос",
  "• анализ домашнего ухода",
  "• индивидуальные рекомендации.",
  "",
  "Также в этот день можно воспользоваться специальным предложением на комплекс процедур восстановления кожи головы и волос — 17 500 ₸ вместо 32 000 ₸.",
  "",
  "Количество мест ограничено 💚",
  "",
  "Если хотите прийти — напишите нам «Хочу на Клиентский день», и мы подберём для вас удобное время.",
].join("\n");
const ALLOWED_TOKENS = new Set(["Имя", "Фамилия"]);

export function normalizePhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8"))
    return `7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("7")) return digits;
  return null;
}

export function extractClientRows(sheet: unknown[][]): ClientRow[] {
  const header = sheet[0];
  if (!header) throw new Error("Лист «Клиенты» пуст.");
  const labels = header.map((cell) =>
    String(cell ?? "")
      .trim()
      .toLowerCase(),
  );
  const index = (name: string) => labels.indexOf(name.toLowerCase());
  const surname = index("Фамилия");
  const name = index("Имя");
  const phone = index("Телефон");
  if (surname < 0 || name < 0 || phone < 0) {
    throw new Error(
      "В листе «Клиенты» нужны столбцы «Фамилия», «Имя» и «Телефон».",
    );
  }
  return sheet
    .slice(1)
    .map((row, offset) => ({
      rowNumber: offset + 2,
      lastName: String(row[surname] ?? "").trim(),
      firstName: String(row[name] ?? "").trim(),
      rawPhone: String(row[phone] ?? "").trim(),
    }))
    .filter((row) => row.lastName || row.firstName || row.rawPhone);
}

export function validateTemplate(template: string): string | null {
  if (!template.trim()) return "Введите текст сообщения.";
  if (template.length > 20_000) return "Шаблон длиннее 20 000 символов.";
  const tokens = [...template.matchAll(/\{\{([^{}]*)\}\}/g)];
  for (const match of tokens) {
    if (!ALLOWED_TOKENS.has(match[1].trim()))
      return `Неизвестная переменная: ${match[0]}`;
  }
  const withoutTokens = template.replace(/\{\{[^{}]*\}\}/g, "");
  if (withoutTokens.includes("{{") || withoutTokens.includes("}}"))
    return "Проверьте скобки переменных.";
  return null;
}

export function renderMessage(template: string, row: ClientRow): string {
  return template.replace(/\{\{\s*(Имя|Фамилия)\s*\}\}/g, (_, token: string) =>
    token === "Имя" ? row.firstName : row.lastName,
  );
}

export function prepareClients(
  rows: ClientRow[],
  template: string,
): {
  valid: PreparedClient[];
  skipped: SkippedClient[];
} {
  const templateError = validateTemplate(template);
  if (templateError) throw new Error(templateError);
  const valid: PreparedClient[] = [];
  const skipped: SkippedClient[] = [];
  const phones = new Set<string>();
  for (const row of rows) {
    const phone = normalizePhone(row.rawPhone);
    let reason = "";
    if (!row.firstName || !row.lastName) reason = "Нет имени или фамилии";
    else if (!phone) reason = "Некорректный телефон";
    else if (phones.has(phone)) reason = "Повтор номера";
    if (reason) {
      skipped.push({ ...row, reason });
      continue;
    }
    const message = renderMessage(template, row);
    if (!message.trim() || message.length > 20_000) {
      skipped.push({
        ...row,
        reason: "Сообщение пустое или длиннее 20 000 символов",
      });
      continue;
    }
    phones.add(phone!);
    valid.push({ ...row, phone: phone!, message });
  }
  return { valid, skipped };
}

export function isClientRow(value: unknown): value is ClientRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(row.rowNumber) &&
    Number(row.rowNumber) > 1 &&
    typeof row.firstName === "string" &&
    row.firstName.length <= 200 &&
    typeof row.lastName === "string" &&
    row.lastName.length <= 200 &&
    typeof row.rawPhone === "string" &&
    row.rawPhone.length <= 100
  );
}
