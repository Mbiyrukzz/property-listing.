import { Model } from "@tylix/orm";

// A browser signed in to the tenant portal (account number + SMS code).
// See app/services/TenantAuth.ts.
export class TenantSession extends Model {
    static table = "tenant_sessions";
    static fillable: string[] = [
        "token_hash", "properman_tenant_id", "tenant_name", "account_number", "phone",
        "ip", "user_agent", "last_used_at", "expires_at",
    ];
}
