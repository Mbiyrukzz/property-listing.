import { Model } from "@tylix/orm";


export class SyncLog extends Model {
    static table = "sync_logs";
    static fillable: string[] = [
        "trigger", "event", "external_id", "status", "message", "upserted", "removed", "duration_ms",
    ];
}
