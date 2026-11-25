import type { Schema, CreateTableBuilder } from "@tylix/shared";

// Landlords sign in to /landlord the same way tenants sign in to /tenant:
// their account number and an SMS code, without a website account. One row
// per signed-in browser; only a hash of the cookie's token is stored.
export const up = async (schema: Schema) => {
    await schema.createTable("landlord_sessions", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("token_hash", 64).notNullable().unique();
        table.integer("properman_landlord_id").notNullable().index();
        table.string("landlord_name", 160);
        table.string("account_number", 60);
        table.string("phone", 40);
        table.string("ip", 64);
        table.string("user_agent", 255);
        table.datetime("last_used_at");
        table.datetime("expires_at").notNullable().index();
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("landlord_sessions");
};
