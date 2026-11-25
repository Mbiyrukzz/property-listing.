import { Model } from "@tylix/orm";

// A browser signed in to the landlord portal (account number + SMS code).
// See app/services/LandlordAuth.ts.
export class LandlordSession extends Model {
    static table = "landlord_sessions";
    static fillable: string[] = [
        "token_hash", "properman_landlord_id", "landlord_name", "account_number", "phone",
        "ip", "user_agent", "last_used_at", "expires_at",
    ];
}
