import { syncOne } from "../services/ListingSync.js";

// Queued by the Properman webhook (app/controllers/WebhookController). Pulls
// the property's current state from Properman, so duplicate or out-of-order
// webhooks are harmless. Throwing (Properman unreachable) lets the queue retry;
// the scheduled full sync catches anything that still slips through.
export const SyncPropermanProperty = {
    tries: 5,
    backoff: [15, 60, 300, 900],
    timeout: 60,
    async handle(payload: { propertyId: number; event?: string }) {
        const id = Number(payload?.propertyId);
        if (!Number.isInteger(id) || id <= 0) return;
        await syncOne(id, "webhook", String(payload?.event ?? "property.updated"));
    },
};
