import readExcelFile from "read-excel-file/browser";
import { extractClientRows, type ClientRow } from "./clients";

type ClientFile = Pick<File, "name" | "arrayBuffer">;

export async function readClientFile(file: ClientFile): Promise<ClientRow[]> {
  if (!/\.xlsx?$/i.test(file.name)) {
    throw new Error("Выберите файл Excel в формате .xls или .xlsx");
  }

  let data: unknown[][] | undefined;
  try {
    const buffer = await file.arrayBuffer();
    if (/\.xlsx$/i.test(file.name)) {
      const sheets = await readExcelFile(buffer);
      data = sheets.find((item) => item.sheet.trim() === "Клиенты")?.data;
    } else {
      const { read, utils } = await import("xlsx");
      const workbook = read(buffer, { type: "array" });
      const name = workbook.SheetNames.find((name) => name.trim() === "Клиенты");
      if (name) {
        const sheet = workbook.Sheets[name];
        data = utils.sheet_to_json<unknown[]>(sheet, {
          header: 1,
          raw: true,
          defval: null,
          blankrows: true,
          range: {
            s: { r: 0, c: 0 },
            e: utils.decode_range(sheet["!ref"] ?? "A1").e,
          },
        });
      }
    }
  } catch {
    throw new Error(
      "Не удалось прочитать Excel-файл. Проверьте, что файл не повреждён, и снимите пароль на открытие, если он установлен.",
    );
  }

  if (!data) throw new Error("В файле не найден лист «Клиенты».");
  if (!data.some((row) => row.some((cell) => cell != null && cell !== ""))) {
    throw new Error("Лист «Клиенты» пуст.");
  }
  const rows = extractClientRows(data);
  if (!rows.length) throw new Error("На листе «Клиенты» нет записей.");
  return rows;
}
