import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("tenant_links", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id").notNullable().unique();
        table.integer("properman_tenant_id").notNullable().index();
        table.string("tenant_name", 160);
        table.string("account_number", 60);
        table.string("phone", 40);
        table.datetime("verified_at");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("tenant_links");
};
