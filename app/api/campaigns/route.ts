import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, errorResponse } from "@/lib/api";
import { isClientRow, prepareClients, type ClientRow } from "@/lib/clients";
import { senderTransaction } from "@/lib/sender";

export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;
  try {
    const campaigns = await db.campaign.findMany({
      take: 30,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        fileName: true,
        status: true,
        createdAt: true,
      },
    });
    const totals = campaigns.length
      ? await db.recipient.groupBy({
          by: ["campaignId", "status"],
          where: {
            campaignId: { in: campaigns.map((campaign) => campaign.id) },
          },
          _count: { _all: true },
        })
      : [];
    return NextResponse.json({
      campaigns: campaigns.map((campaign) => ({
        ...campaign,
        counts: Object.fromEntries(
          totals
            .filter((total) => total.campaignId === campaign.id)
            .map((total) => [total.status, total._count._all]),
        ),
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const denied = await requireAuth(request, true);
  if (denied) return denied;
  try {
    const body = await request.json().catch(() => ({}));
    const fileName =
      typeof body.fileName === "string"
        ? body.fileName.trim().slice(0, 255)
        : "";
    const template = typeof body.template === "string" ? body.template : "";
    const rows: unknown = body.rows;
    const selected: unknown = body.selectedRowNumbers;
    const consentRows: unknown = body.consentRowNumbers ?? [];
    const consentSource =
      typeof body.consentSource === "string"
        ? body.consentSource.trim().slice(0, 500)
        : "";
    if (
      !fileName ||
      !Array.isArray(rows) ||
      rows.length > 20_000 ||
      !rows.every(isClientRow) ||
      !Array.isArray(selected) ||
      selected.length > rows.length ||
      !selected.every((value) => Number.isSafeInteger(value)) ||
      !Array.isArray(consentRows) ||
      consentRows.length > rows.length ||
      !consentRows.every((value) => Number.isSafeInteger(value)) ||
      (consentRows.length > 0 && !consentSource)
    ) {
      return NextResponse.json(
        { error: "Некорректные данные файла" },
        { status: 400 },
      );
    }
    const rowNumbers = rows.map((row: ClientRow) => row.rowNumber);
    if (new Set(rowNumbers).size !== rows.length)
      return NextResponse.json(
        { error: "Повторяются номера строк" },
        { status: 400 },
      );
    const normalizedRows = (rows as ClientRow[]).map((row) => ({
      ...row,
      firstName: row.firstName.trim(),
      lastName: row.lastName.trim(),
      rawPhone: row.rawPhone.trim(),
    }));
    const { valid, skipped } = prepareClients(normalizedRows, template);
    const selectedSet = new Set<number>(selected);
    const sendCount = valid.filter((row) =>
      selectedSet.has(row.rowNumber),
    ).length;
    if (!sendCount)
      return NextResponse.json(
        { error: "Не выбраны получатели для отправки" },
        { status: 400 },
      );
    const campaign = await senderTransaction(async (tx) => {
      const confirmed = new Set<number>(consentRows as number[]);
      const confirmedPhones = valid
        .filter((row) => confirmed.has(row.rowNumber))
        .map((row) => row.phone);
      if (confirmedPhones.length) {
        await tx.contactPreference.createMany({
          data: confirmedPhones.map((phone) => ({
            phone,
            consentAt: new Date(),
            consentSource,
          })),
          skipDuplicates: true,
        });
        await tx.contactPreference.updateMany({
          where: {
            phone: { in: confirmedPhones },
            consentAt: null,
            optedOutAt: null,
          },
          data: { consentAt: new Date(), consentSource },
        });
      }
      const preferences = await tx.contactPreference.findMany({
        where: { phone: { in: valid.map((row) => row.phone) } },
      });
      const preferenceByPhone = new Map(
        preferences.map((preference) => [preference.phone, preference]),
      );
      const eligible = new Set(
        preferences
          .filter((p) => p.consentAt && !p.optedOutAt)
          .map((p) => p.phone),
      );
      if (
        !valid.some(
          (row) => selectedSet.has(row.rowNumber) && eligible.has(row.phone),
        )
      )
        throw new Error(
          "Не выбраны клиенты с подтверждённым согласием на сообщения",
        );
      return tx.campaign.create({
        data: {
          fileName,
          template,
          recipients: {
            create: [
              ...valid.map((row) => ({
                rowNumber: row.rowNumber,
                firstName: row.firstName,
                lastName: row.lastName,
                phone: row.phone,
                message: row.message,
                status:
                  selectedSet.has(row.rowNumber) && eligible.has(row.phone)
                    ? ("PENDING" as const)
                    : ("SKIPPED" as const),
                error: !eligible.has(row.phone)
                  ? preferenceByPhone.get(row.phone)?.optedOutAt
                    ? "Отказ от рассылок"
                    : "Нет подтверждённого согласия"
                  : selectedSet.has(row.rowNumber)
                    ? null
                    : "Исключён вручную",
              })),
              ...skipped.map((row) => ({
                rowNumber: row.rowNumber,
                firstName: row.firstName,
                lastName: row.lastName,
                phone: row.rawPhone,
                message: "",
                status: "SKIPPED" as const,
                error: row.reason,
              })),
            ],
          },
        },
        select: { id: true },
      });
    });
    return NextResponse.json({ id: campaign.id }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Error &&
      /шаблон|переменная|скобки|сообщени|согласи/i.test(error.message)
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return errorResponse(error);
  }
}
