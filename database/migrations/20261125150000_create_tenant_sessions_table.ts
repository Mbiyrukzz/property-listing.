import type { Schema, CreateTableBuilder } from "@tylix/shared";

// Tenants sign in to /tenant with their account number and an SMS code,
// without a website account. One row per signed-in browser; only a hash of
// the cookie's token is stored.
//
// The old way (link a website account to a tenancy) is gone: tenant_links
// is dropped, and rent_payments no longer needs a user.
export const up = async (schema: Schema) => {
    await schema.createTable("tenant_sessions", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("token_hash", 64).notNullable().unique();
        table.integer("properman_tenant_id").notNullable().index();
        table.string("tenant_name", 160);
        table.string("account_number", 60);
        table.string("phone", 40);
        table.string("ip", 64);
        table.string("user_agent", 255);
        table.datetime("last_used_at");
        table.datetime("expires_at").notNullable().index();
        table.timestamps();
    });

    if (await schema.hasColumn("rent_payments", "user_id")) {
        await schema.alterTable("rent_payments", (table) => {
            table.integer("user_id").nullable().change();
        });
    }

    if (await schema.hasTable("tenant_links")) {
        await schema.dropTable("tenant_links");
    }
};

export const down = async (schema: Schema) => {
    await schema.dropTable("tenant_sessions");

    if (!(await schema.hasTable("tenant_links"))) {
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
    }
    // rent_payments.user_id stays nullable: rows made by tenant sessions
    // have no user to put back.
};
