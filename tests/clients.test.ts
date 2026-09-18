import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import readExcelFile from "read-excel-file/node";
import {
  extractClientRows,
  normalizePhone,
  prepareClients,
  validateTemplate,
} from "../lib/clients";

describe("подготовка клиентов", () => {
  it("читает нужные заголовки, игнорирует пустые строки и нормализует телефон", () => {
    const rows = extractClientRows([
      ["№", "Фамилия", "Имя", "Телефон", "Комментарий"],
      [2, "Пак", "Елена", "+7(777)123-45-67", "не отправлять на сервер"],
      [null, null, null, null, null],
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      rowNumber: 2,
      lastName: "Пак",
      firstName: "Елена",
      rawPhone: "+7(777)123-45-67",
    });
    expect(normalizePhone("8 777 123 45 67")).toBe("77771234567");
    expect(normalizePhone("123")).toBeNull();
  });

  it("пропускает некорректные строки и повтор номера, подставляет обе переменные", () => {
    const rows = [
      {
        rowNumber: 2,
        lastName: "Пак",
        firstName: "Елена",
        rawPhone: "+7(777)123-45-67",
      },
      {
        rowNumber: 3,
        lastName: "Другая",
        firstName: "Анна",
        rawPhone: "8 777 123 45 67",
      },
      { rowNumber: 4, lastName: "Без", firstName: "Телефона", rawPhone: "" },
    ];
    const result = prepareClients(rows, "Здравствуйте, {{Имя}} {{Фамилия}}!");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].message).toBe("Здравствуйте, Елена Пак!");
    expect(result.skipped.map((row) => row.reason)).toEqual([
      "Повтор номера",
      "Некорректный телефон",
    ]);
  });

  it("отклоняет отсутствующие столбцы и неизвестные переменные", () => {
    expect(() => extractClientRows([["Имя", "Телефон"]])).toThrow(/Фамилия/);
    expect(validateTemplate("Привет, {{Баланс}}!")).toMatch(/Неизвестная/);
    expect(validateTemplate("  ")).toMatch(/Введите/);
  });
});

const workbook = resolve(process.cwd(), "Клиенты-2.xlsx");
describe.skipIf(!existsSync(workbook))("реальный Excel из проекта", () => {
  it("находит лист и восемь заполненных клиентов", async () => {
    const sheets = await readExcelFile(workbook);
    const sheet = sheets.find((item) => item.sheet === "Клиенты");
    expect(sheet).toBeDefined();
    const rows = extractClientRows(sheet!.data);
    expect(rows).toHaveLength(8);
    expect(prepareClients(rows, "Здравствуйте, {{Имя}}!").valid).toHaveLength(
      8,
    );
  });
});
