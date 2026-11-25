// Ashmif SMS gateway (POST /api/v3/sms/send). Server-only.
//
// Env:
//   ASHMIF_API_URL    send endpoint, defaults to https://sms.ashmif.com/api/v3/sms/send
//   ASHMIF_API_KEY    API key, sent as a Bearer token
//   ASHMIF_SENDER_ID  approved sender ID (alphanumeric, max 11 chars)

const DEFAULT_URL = "https://sms.ashmif.com/api/v3/sms/send";
const TIMEOUT_MS = 10_000;

export function smsConfigured(): boolean {
    return Boolean(String(process.env.ASHMIF_API_KEY ?? "").trim() && String(process.env.ASHMIF_SENDER_ID ?? "").trim());
}

// Kenyan numbers in the 2547XXXXXXXX / 2541XXXXXXXX form the gateway expects.
export function msisdn(phone: string): string | null {
    let digits = String(phone ?? "").replace(/\D/g, "");
    if (digits.startsWith("0")) digits = "254" + digits.slice(1);
    if (digits.length === 9) digits = "254" + digits;
    return /^254\d{9}$/.test(digits) ? digits : null;
}

export async function sendSms(phone: string, message: string): Promise<boolean> {
    if (!smsConfigured()) return false;
    const recipient = msisdn(phone);
    if (!recipient) {
        console.error("[sms] not sent: phone on file is not a Kenyan mobile number");
        return false;
    }

    try {
        const response = await fetch(String(process.env.ASHMIF_API_URL ?? "").trim() || DEFAULT_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${String(process.env.ASHMIF_API_KEY).trim()}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                recipient,
                sender_id: String(process.env.ASHMIF_SENDER_ID).trim(),
                type: "plain",
                message,
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const body = (await response.json().catch(() => null)) as { status?: string; message?: string } | null;
        if (!response.ok || body?.status !== "success") {
            // Never log the message itself: it can hold a verification code.
            console.error("[sms] send failed:", response.status, body?.message ?? "no message");
            return false;
        }
        return true;
    } catch (err) {
        console.error("[sms] send error:", err instanceof Error ? err.message : err);
        return false;
    }
}
