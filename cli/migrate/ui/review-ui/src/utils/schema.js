export function prolibuEntitySchema(entityName, prolibuSpec) {
    if (!entityName || !prolibuSpec) return null;
    const sc = prolibuSpec?.components?.schemas || {};
    const low = entityName.toLowerCase();
    return (
        sc[entityName] ||
        sc[entityName.charAt(0).toUpperCase() + entityName.slice(1)] ||
        Object.entries(sc).find(([k]) => k.toLowerCase() === low)?.[1] ||
        null
    );
}

export function matchField(sfName, prolibuProps) {
    if (!prolibuProps) return null;
    const clean = sfName.toLowerCase().replace(/__c$/, "").replace(/_/g, "");
    return (
        Object.keys(prolibuProps).find((k) => {
            const kc = k.toLowerCase().replace(/_/g, "");
            return kc === clean || kc.includes(clean) || clean.includes(kc);
        }) || null
    );
}

export function mapType(sfType) {
    const m = {
        string: "text",
        textarea: "textarea",
        double: "number",
        integer: "integer",
        currency: "currency",
        boolean: "boolean",
        date: "date",
        datetime: "datetime",
        id: "id",
        reference: "relation",
        picklist: "select",
        multipicklist: "multiselect",
        email: "email",
        phone: "phone",
        url: "url",
    };
    return m[sfType] || "text";
}

/** Map a Salesforce field type to a Prolibu COB schema type. */
export function sfTypeToCobType(sfType) {
    const m = {
        string: "string",
        textarea: "string",
        double: "number",
        integer: "number",
        currency: "number",
        percent: "number",
        boolean: "boolean",
        date: "date",
        datetime: "date",
        id: "string",
        reference: "objectid",
        picklist: "string",
        multipicklist: "string",
        email: "string",
        phone: "string",
        url: "string",
    };
    return m[sfType] || "string";
}

/**
 * Build COB + CustomField bodies from SF field details.
 * @param {string} modelName - e.g. "Vehicle"
 * @param {{ name: string, type: string, label?: string, custom?: boolean, referenceTo?: string, picklistValues?: string[] }[]} sfFields
 * @returns {{ cob: object, customField: object }}
 */
export function buildCobFromSFFields(modelName, sfFields) {
    const SKIP = new Set(["Id", "IsDeleted", "CreatedDate", "CreatedById", "LastModifiedDate", "LastModifiedById", "SystemModstamp", "LastActivityDate", "LastViewedDate", "LastReferencedDate", "OwnerId"]);
    const cob = { modelName, active: true };
    const overrides = {};
    for (const f of sfFields) {
        if (SKIP.has(f.name)) continue;
        const cobType = sfTypeToCobType(f.type);
        const def = { type: cobType };
        if (f.referenceTo && cobType === "objectid") def.ref = f.referenceTo;
        if (f.picklistValues?.length && cobType === "string") def.enum = f.picklistValues.slice(0, 100);
        cob[f.name] = def;
        overrides[f.name] = {
            isCustomField: true,
            type: cobType,
            label: f.label || f.name,
        };
    }
    return {
        cob,
        customField: { objectAssigned: modelName, active: true, overrides },
    };
}
