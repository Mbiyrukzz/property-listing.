import type { Schema } from "@tylix/shared";

// "trigger" is a reserved word in MySQL, and the ORM doesn't quote column
// names in INSERTs, so every sync log write failed there. Renamed to a
// name that needs no quoting. hasColumn keeps it safe to run twice.
export const up = async (schema: Schema) => {
    if (await schema.hasColumn("sync_logs", "trigger")) {
        await schema.alterTable("sync_logs", (table) => {
            table.renameColumn("trigger", "triggered_by");
        });
    }
};

export const down = async (schema: Schema) => {
    if (await schema.hasColumn("sync_logs", "triggered_by")) {
        await schema.alterTable("sync_logs", (table) => {
            table.renameColumn("triggered_by", "trigger");
        });
    }
};
