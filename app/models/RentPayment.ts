import { Model } from "@tylix/orm";

// An M-Pesa request started from the tenant portal. Properman records
// and applies the money; this row is only so the tenant can follow it.
export class RentPayment extends Model {
    static table = "rent_payments";
    static fillable: string[] = [
        "user_id", "properman_tenant_id", "properman_payment_id", "amount", "phone", "status",
        "mpesa_receipt", "message",
    ];
}
