import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("agents", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("name", 120).notNullable();
        table.string("title", 120);
        table.string("email", 190);
        table.string("phone", 40);
        table.string("whatsapp", 40);
        table.string("photo");
        table.text("bio");
        table.integer("user_id").index();
        table.boolean("is_active").default(true).index();
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("agents");
};
