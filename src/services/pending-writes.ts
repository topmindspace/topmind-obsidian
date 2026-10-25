/** Host-neutral review queue, vendored from the canonical Kernel. No global workspace/cache. */
export { stashPendingWrite, listPendingWrites, takePendingWrite, rejectPendingWrite, restorePendingWrite } from "#kernel/pending-writes.mjs";
export type { PendingWrite } from "#kernel/pending-writes.mjs";
