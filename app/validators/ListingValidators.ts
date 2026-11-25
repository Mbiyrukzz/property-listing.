// Rules for the Barani Better Homes forms. Imports nothing server-only, so pages use the
// same rules before sending (see docs: Validation).

import {
    validate,
    required,
    isString,
    isEmail,
    isNumber,
    isInteger,
    maxLength,
    minLength,
    min,
    max,
    oneOf,
    matches,
    withMessage,
} from "@tylix/shared/validation";

// Kenyan numbers in any common form: 07XX…, 01XX…, +2547XX…, 2547XX…
export const PHONE_RE = /^(?:\+?254|0)[17]\d{8}$/;

const phone = matches(PHONE_RE, "Enter a phone number like 0712 345 678.");
const name = [withMessage(required, "Enter your name."), isString, maxLength(120)];

function compactPhone(value: unknown): unknown {
    return typeof value === "string" ? value.replace(/[\s-]/g, "") : value;
}

export function normaliseContact(data: Record<string, unknown>) {
    return {
        ...data,
        name: typeof data.name === "string" ? data.name.trim() : data.name,
        email: typeof data.email === "string" ? data.email.trim().toLowerCase() : data.email,
        phone: compactPhone(data.phone),
    };
}

export function validateEnquiry(data: Record<string, unknown>) {
    const result = validate(normaliseContact(data), {
        kind: [oneOf(["general", "rental", "purchase"])],
        name,
        email: [isEmail, maxLength(190)],
        phone: [withMessage(required, "Enter a phone number so we can call you back."), phone],
        message: [withMessage(required, "Tell us what you'd like to know."), isString, minLength(5), maxLength(3000)],
        property_id: [isInteger],
        unit_id: [isInteger],
    });
    return result;
}

export function validateViewing(data: Record<string, unknown>) {
    return validate(normaliseContact(data), {
        property_id: [withMessage(required, "Pick a property."), isInteger],
        unit_id: [isInteger],
        name,
        email: [isEmail, maxLength(190)],
        phone: [withMessage(required, "Enter a phone number to confirm the visit."), phone],
        preferred_date: [
            withMessage(required, "Pick a day for the viewing."),
            matches(/^\d{4}-\d{2}-\d{2}$/, "Pick a day for the viewing."),
        ],
        preferred_time: [oneOf(["morning", "afternoon", "evening"])],
        notes: [isString, maxLength(1000)],
    });
}

export function validateApplication(data: Record<string, unknown>) {
    const kind = data.kind === "purchase" ? "purchase" : "rental";
    return validate(normaliseContact({ ...data, name: data.full_name }), {
        kind: [required, oneOf(["rental", "purchase"])],
        property_id: [required, isInteger],
        unit_id: [isInteger],
        name: [withMessage(required, "Enter your full name."), isString, maxLength(160)],
        email: [withMessage(required, "Enter your email."), isEmail, maxLength(190)],
        phone: [withMessage(required, "Enter your phone number."), phone],
        id_number: [withMessage(required, "Enter your ID or passport number."), isString, maxLength(40)],
        occupation: [isString, maxLength(120)],
        employer: [isString, maxLength(160)],
        monthly_income: [isNumber, min(0)],
        offer_amount: kind === "purchase" ? [withMessage(required, "Enter your offer."), isNumber, min(1)] : [isNumber, min(0)],
        financing: kind === "purchase" ? [oneOf(["cash", "mortgage", "sacco", "other"])] : [],
        move_in_date: kind === "rental"
            ? [withMessage(required, "When would you like to move in?"), matches(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.")]
            : [matches(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.")],
        occupants: [isInteger, min(1), max(30)],
        notes: [isString, maxLength(2000)],
    });
}

export function validateListing(data: Record<string, unknown>) {
    return validate(data, {
        title: [withMessage(required, "Give the listing a title."), isString, maxLength(200)],
        purpose: [required, oneOf(["rent", "sale"])],
        category: [
            required,
            oneOf(["apartment", "house", "maisonette", "furnished", "commercial", "office", "shop", "land"]),
        ],
        location: [withMessage(required, "Where is it?"), isString, maxLength(190)],
        address: [isString, maxLength(255)],
        description: [withMessage(required, "Describe the property."), isString, maxLength(10000)],
        price: [withMessage(required, "Enter the price."), isNumber, min(0), max(100_000_000_000)],
        bedrooms: [isInteger, min(0), max(50)],
        bathrooms: [isInteger, min(0), max(50)],
        size_sqm: [isNumber, min(0)],
        land_size: [isString, maxLength(60)],
        status: [oneOf(["available", "under_offer", "let", "sold"])],
    });
}

export function validateAgent(data: Record<string, unknown>) {
    return validate(normaliseContact(data), {
        name,
        title: [isString, maxLength(120)],
        email: [isEmail, maxLength(190)],
        phone: [phone],
        whatsapp: [phone],
        bio: [isString, maxLength(2000)],
    });
}

export function validateTenantLink(data: Record<string, unknown>) {
    return validate({ ...data, phone: compactPhone(data.phone) }, {
        account_number: [withMessage(required, "Enter your tenant account number (it is on your rent invoices and receipts)."), isString, maxLength(60)],
        phone: [withMessage(required, "Enter the phone number your landlord has on file."), phone],
    });
}

export function validatePayment(data: Record<string, unknown>) {
    return validate({ ...data, phone: compactPhone(data.phone) }, {
        phone: [
            withMessage(required, "Enter the M-Pesa number to charge."),
            matches(/^(?:\+?254|0)7\d{8}$/, "Enter a Safaricom number like 0712 345 678."),
        ],
        amount: [withMessage(required, "Enter an amount."), isNumber, min(1), max(250000)],
    });
}
