import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("enquiries", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("kind", 20).notNullable().default("general").index();
        table.integer("property_id").index();
        table.integer("unit_id");
        table.integer("user_id").index();
        table.integer("agent_id").index();
        table.string("name", 120).notNullable();
        table.string("email", 190);
        table.string("phone", 40);
        table.text("message");
        table.string("status", 20).notNullable().default("new").index();
        table.text("admin_notes");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("enquiries");
};
