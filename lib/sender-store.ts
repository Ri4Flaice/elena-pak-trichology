import { Prisma, type SenderState } from "@prisma/client";
import { db } from "./db";
import { instanceId } from "./green-api";

export type SenderTx = Prisma.TransactionClient;

export const unconfirmedAttemptWhere: Prisma.SendAttemptWhereInput = {
  OR: [
    { outcome: { in: ["SENDING", "UNKNOWN"] } },
    {
      outcome: "ACCEPTED",
      deliveryStatus: null,
      // The migration marked old records with this prefix. They predate the
      // webhook receiver and cannot be treated as currently in-flight sends.
      // Keep their unknown delivery status and quota history unchanged.
      NOT: { id: { startsWith: "legacy-" } },
    },
  ],
};

// Serialize all decisions to send, including STOP and campaign deletion.
export async function senderTransaction<T>(
  fn: (tx: SenderTx, state: SenderState) => Promise<T>,
) {
  return db.$transaction(
    async (tx) => {
      const id = instanceId();
      await tx.$executeRaw`INSERT INTO "SenderState" ("id", "updatedAt") VALUES (${id}, CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING`;
      const rows = await tx.$queryRaw<
        SenderState[]
      >`SELECT * FROM "SenderState" WHERE "id" = ${id} FOR UPDATE`;
      await tx.sendAttempt.updateMany({
        where: { instanceId: "__legacy__" },
        data: { instanceId: id },
      });
      return fn(tx, rows[0]);
    },
    { timeout: 10_000 },
  );
}

export async function pauseSender(tx: SenderTx, reason: string) {
  await tx.senderState.update({
    where: { id: instanceId() },
    data: { pauseReason: reason, activeCampaignId: null },
  });
  await tx.campaign.updateMany({
    where: { status: "RUNNING" },
    data: { status: "PAUSED", pauseReason: reason },
  });
}

export async function outstandingAttempt(tx: SenderTx) {
  return tx.sendAttempt.findFirst({
    where: {
      instanceId: instanceId(),
      ...unconfirmedAttemptWhere,
    },
    orderBy: { reservedAt: "asc" },
  });
}
