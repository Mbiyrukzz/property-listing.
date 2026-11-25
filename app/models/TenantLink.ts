import { Model } from "@tylix/orm";

// A Barani Better Homes account verified as a Properman tenant (by SMS code).
export class TenantLink extends Model {
    static table = "tenant_links";
    static fillable: string[] = [
        "user_id", "properman_tenant_id", "tenant_name", "account_number", "phone", "verified_at",
    ];
}
