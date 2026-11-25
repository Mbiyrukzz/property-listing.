import { loadConfig } from "@tylix/shared";
import type { MailConfig } from "@tylix/mail";
import { StaffNoticeMail } from "../mail/StaffNoticeMail.js";
import { getSettings } from "../services/site.js";
import { Agent } from "../models/Agent.js";

// Emails the office (Site settings → email) and the listing's agent about a
// new enquiry, viewing request or application. Queued so the visitor's form
// answers at once; does nothing if no address is set.
export const NotifyStaff = {
    tries: 3,
    backoff: "exponential",
    async handle(payload: { subject: string; heading: string; lines: string[]; path: string; agentId?: number | null }) {
        const settings = await getSettings();
        const to = new Set<string>();
        if (settings.email) to.add(settings.email);
        if (payload.agentId) {
            const agent = (await Agent.find(payload.agentId)) as { email?: string | null } | null;
            if (agent?.email) to.add(agent.email);
        }
        if (to.size === 0) return;

        const config = await loadConfig(process.cwd(), "typescript");
        const appUrl = String(process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
        const mail = new StaffNoticeMail({
            subject: payload.subject,
            heading: payload.heading,
            lines: payload.lines,
            url: `${appUrl}${payload.path}`,
        });
        for (const address of to) {
            await mail.send(address, config.mail as unknown as MailConfig);
        }
    },
};
