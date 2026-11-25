import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("sync_logs", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("trigger", 20).notNullable().index();
        table.string("event", 60);
        table.integer("external_id");
        table.string("status", 20).notNullable().index();
        table.text("message");
        table.integer("upserted").default(0);
        table.integer("removed").default(0);
        table.integer("duration_ms").default(0);
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("sync_logs");
};
