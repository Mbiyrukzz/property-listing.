// POST /api/integrations/hq/webhook
//
// Properman (app/Jobs/Bbhomes/NotifyBbhomes) calls this when a published
// property, unit or image changes. The body carries only the property id; we
// verify the signature and queue SyncPropermanProperty, which reads the
// current state from Properman's API. Answers fast so Properman's job
// doesn't time out.

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { dispatch } from "@tylix/core";
import { verifyWebhookSignature, webhookSecret } from "../services/Properman.js";
import { SyncLog } from "../models/SyncLog.js";

const EVENTS = [
    "property.updated",
    "property.unpublished",
    "property.deleted",
    "unit.updated",
    "unit.moved",
    "unit.deleted",
    "media.updated",
];

export class WebhookController {
    async properman(req: TylixRequest, res: TylixResponse) {
        if (!webhookSecret()) {
            res.status(503);
            return res.json({ error: "Webhooks are not configured." });
        }

        const raw = String((req as unknown as { rawBody?: string }).rawBody ?? "");
        const ok = verifyWebhookSignature(raw, req.headers["x-properman-timestamp"], req.headers["x-properman-signature"]);
        if (!ok) {
            await SyncLog.create({ trigger: "webhook", event: "rejected", status: "error", message: "Bad or expired signature." }).catch(() => {});
            res.status(401);
            return res.json({ error: "Invalid signature." });
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        const propertyId = Number(body.property_id);
        const event = EVENTS.includes(String(body.event)) ? String(body.event) : "property.updated";
        if (!Number.isInteger(propertyId) || propertyId <= 0) {
            res.status(422);
            return res.json({ error: "property_id is required." });
        }

        await dispatch("SyncPropermanProperty", { propertyId, event });
        res.status(202);
        return res.json({ accepted: true });
    }
}
