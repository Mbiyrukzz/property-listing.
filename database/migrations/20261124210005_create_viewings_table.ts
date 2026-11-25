import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("viewings", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("property_id").notNullable().index();
        table.integer("unit_id");
        table.integer("user_id").index();
        table.integer("agent_id").index();
        table.string("name", 120).notNullable();
        table.string("email", 190);
        table.string("phone", 40);
        table.date("preferred_date");
        table.string("preferred_time", 20);
        table.datetime("scheduled_for");
        table.text("notes");
        table.string("status", 20).notNullable().default("requested").index();
        table.text("admin_notes");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("viewings");
};
