import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { utils, write } from "xlsx";
import { readClientFile } from "../lib/client-file";

// Exercise the browser reader in Node with the missing XML browser API supplied.
beforeAll(() => vi.stubGlobal("DOMParser", DOMParser));
afterAll(() => vi.unstubAllGlobals());

const headers = [null, "Фамилия", null, "Имя", "Телефон"];
const clients = [
  headers,
  [null, "Пак", null, "Елена", "+7 (777) 123-45-67"],
  [],
  [null, "Иванова", null, "Анна", 77771234568],
];

function makeFile(
  format: "xls" | "xlsx",
  data: unknown[][] = clients,
  sheetName = " Клиенты ",
) {
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet(data), sheetName);
  const buffer: ArrayBuffer = write(workbook, {
    type: "array",
    bookType: format === "xls" ? "biff8" : "xlsx",
  });
  return { name: `clients.${format}`, arrayBuffer: async () => buffer };
}

describe.each(["xls", "xlsx"] as const)("импорт .%s", (format) => {
  it("сохраняет кириллицу, телефоны и номера строк при пустых строках и столбцах", async () => {
    const file = makeFile(format);
    const rows = await readClientFile({ ...file, name: file.name.toUpperCase() });
    expect(rows).toEqual([
      { rowNumber: 2, lastName: "Пак", firstName: "Елена", rawPhone: "+7 (777) 123-45-67" },
      { rowNumber: 4, lastName: "Иванова", firstName: "Анна", rawPhone: "77771234568" },
    ]);
  });

  it("сообщает об отсутствии листа", async () => {
    await expect(readClientFile(makeFile(format, clients, "Другой"))).rejects.toThrow(
      "В файле не найден лист «Клиенты».",
    );
  });

  it("сообщает об отсутствии обязательных столбцов", async () => {
    await expect(readClientFile(makeFile(format, [["Имя", "Телефон"]]))).rejects.toThrow(
      "нужны столбцы",
    );
  });

  it("сообщает о пустом листе и отсутствии записей", async () => {
    await expect(readClientFile(makeFile(format, []))).rejects.toThrow("пуст");
    await expect(readClientFile(makeFile(format, [headers]))).rejects.toThrow("нет записей");
  });

  it("позволяет повторить импорт после ошибки чтения", async () => {
    const file = makeFile(format);
    const original = await file.arrayBuffer();
    let attempt = 0;
    const retryFile = {
      ...file,
      arrayBuffer: async () => (++attempt === 1 ? original.slice(0, 8) : original),
    };
    await expect(readClientFile(retryFile)).rejects.toThrow("Не удалось прочитать Excel-файл");
    await expect(readClientFile(retryFile)).resolves.toHaveLength(2);
  });
});

it("отклоняет неподдерживаемое расширение до чтения файла", async () => {
  await expect(readClientFile({
    name: "clients.csv",
    arrayBuffer: async () => { throw new Error("Файл не должен читаться"); },
  })).rejects.toThrow("Выберите файл Excel в формате .xls или .xlsx");
});

for (const format of ["xls", "xlsx"] as const) {
  const path = resolve(process.cwd(), `Клиенты-2.${format}`);
  it.skipIf(!existsSync(path))(`читает локальный файл .${format} без публикации данных`, async () => {
    const bytes = readFileSync(path);
    const rows = await readClientFile({
      name: `Клиенты-2.${format}`,
      arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.firstName && row.lastName && row.rawPhone)).toBe(true);
  });
}
