const { ENTITIES } = require("../constants");

const ENTITYCONFIG_MAP = {
    // === Settings Masters (Core) ===
    [ENTITIES.ITEM_MASTER.NAME]: { primary: 'item_name', series: 'series_code' },
    [ENTITIES.PARTIES_MASTER.NAME]: { primary: 'party_name', series: 'series_code' },
    [ENTITIES.COMPANY_MASTER.NAME]: { primary: 'company_name', series: 'company_code' },
    [ENTITIES.BRANCH_MASTER.NAME]: { primary: 'branch_name', secondary: 'city' },
    [ENTITIES.USER.NAME]: { primary: 'user_name', secondary: 'email' },
    [ENTITIES.DRAWING_MASTER.NAME]: { primary: 'title', series: 'series_code' },
    [ENTITIES.PROCESS_LIST_MASTER.NAME]: { primary: 'process_name' },
    [ENTITIES.RESOURCE_MASTER.NAME]: { primary: 'resource_name' },
    [ENTITIES.GODOWN.NAME]: { primary: 'name' },
    [ENTITIES.SIGNATURE.NAME]: { primary: 'name' },

    // === Item & Specification ===
    [ENTITIES.ITEM_TYPE_MASTER.NAME]: { primary: 'item_type_name' },
    [ENTITIES.ITEM_CATEGORY.NAME]: { primary: 'category_name', secondary: 'item_type_id' },
    [ENTITIES.ITEM_UNIT_MASTER.NAME]: { primary: 'unit_name', secondary: 'gst_code' },
    [ENTITIES.ITEM_NAME_PARAMETER.NAME]: { primary: 'item_field_name' },
    [ENTITIES.ITEM_SPEC_MASTER.NAME]: { primary: 'master_field_name' },
    [ENTITIES.ITEM_SPEC_VALUE.NAME]: { primary: 'master_field_value', secondary: 'master_field_name_id' },
    [ENTITIES.HSN_MASTER.NAME]: { primary: 'hsn_code', secondary: 'description' },
    [ENTITIES.QC_PARAMETER.NAME]: { primary: 'parameter_name' },

    // Parties
    [ENTITIES.PARTIES_GROUP.NAME]: { primary: 'group_name', secondary: 'parent_group_id' },
    [ENTITIES.PARTIES_ADDRESS.NAME]: { primary: 'party_id', secondary: 'address_type' },
    [ENTITIES.PARTIES_CONTACT.NAME]: { primary: 'first_name' },
    [ENTITIES.PARTIES_CONSIGNEE.NAME]: { primary: 'contact_person_name' },
    [ENTITIES.PARTIES_BANK.NAME]: { primary: 'party_id', secondary: 'account_number' },

    // General Masters
    [ENTITIES.SERIES_TYPE.NAME]: { primary: 'series_type_name', secondary: 'series_entity_id' },
    [ENTITIES.DOCUMENT_MASTER.NAME]: { primary: 'document_name' },
    [ENTITIES.BUSINESS_TYPE.NAME]: { primary: 'business_type_name' },
    [ENTITIES.COMMON_CATEGORY.NAME]: { primary: 'category_name' },
    [ENTITIES.PAYMENT_TERMS.NAME]: { primary: 'terms_title', secondary: 'payment_day' },
    [ENTITIES.TRANSPORT_MASTER.NAME]: { primary: 'transpotation_name' },
    [ENTITIES.BANK_MASTER.NAME]: { primary: 'bank_name', secondary: 'account_number' },
    [ENTITIES.COUNTRY_MASTER.NAME]: { primary: 'country_name', secondary: 'country_code' },
    [ENTITIES.STATE_MASTER.NAME]: { primary: 'state_name', secondary: 'code' },
    [ENTITIES.CITY_MASTER.NAME]: { primary: 'city_name', secondary: 'state_id' },
    [ENTITIES.ZONE_MASTER.NAME]: { primary: 'zone_name' },
    [ENTITIES.CURRENCY_MASTER.NAME]: { primary: 'currency_name', secondary: 'currency_code' },
    [ENTITIES.ROLE_PERMISSION.NAME]: { primary: 'role_name' },

    // Tax & Charges
    [ENTITIES.TAX_TYPE.NAME]: { primary: 'tax_type', secondary: 'tax_type_name' },
    [ENTITIES.TAX.NAME]: { primary: 'tax_name', secondary: 'tax_value' },
    [ENTITIES.TAX_GROUP.NAME]: { primary: 'tax_group_name', secondary: 'group_value' },
    [ENTITIES.CHARGES.NAME]: { primary: 'charge_name', secondary: 'value' },
    [ENTITIES.TERMS_MASTER.NAME]: { primary: 'role_name' },

    // SALES
    [ENTITIES.SALES.NAME]: { primary: 'series_code' },
    [ENTITIES.LEADS.NAME]: { primary: 'series_code' },
    [ENTITIES.PROFORMA.NAME]: { primary: 'series_code' },
    [ENTITIES.QUOTATION.NAME]: { primary: 'series_code' },
    [ENTITIES.TASK.NAME]: { primary: 'task_name', secondary: 'task_date' },

    // Inventory
    [ENTITIES.STOCK_GENERAL.NAME]: { primary: 'series_code', secondary: 'stock_general_date' },
    [ENTITIES.BATCH_STOCK.NAME]: { primary: 'batch_stock_no', secondary: 'item_id' },

    // Finance
    [ENTITIES.INVOICE.NAME]: { primary: 'series_code' },
    [ENTITIES.GENERAL_BOOK.NAME]: { primary: 'ref_name', secondary: 'ref_id' },

    // Purchase
    [ENTITIES.INDENT.NAME]: { primary: 'indent_no' },
    [ENTITIES.PURCHASE_ORDER.NAME]: { primary: 'series_code' },
    [ENTITIES.QUOTATION_COMPARISON.NAME]: { primary: 'req_quotation_no', secondary: 'req_quotation_date' },

    // Production
    [ENTITIES.BOM.NAME]: { primary: 'bom_no' },
    [ENTITIES.ITEM_BOM_VERSION.NAME]: { primary: 'bom_version_no', secondary: 'item_id' },
    [ENTITIES.PRODUCT_BOM_VERSION.NAME]: { primary: 'bom_version_no', secondary: 'product_id' },

    // DeliveryChallan
    [ENTITIES.DISPATCH.NAME]: { primary: 'series_code' },

    // Logs
    [ENTITIES.ACTIVITY_LOG.NAME]: { primary: 'record_id', secondary: 'entity_name' },
    [ENTITIES.LOGIN_HISTORY.NAME]: { primary: 'user_id', secondary: 'in_time' },
};

exports.generateLogMessage = (entityName, actionType, recordData = {}) => {
    const config = ENTITYCONFIG_MAP[entityName] || { primary: 'id' };
    
    const primaryValue = recordData[config.primary];
    const secondaryValue = config.secondary ? (recordData[config.secondary] ? ` (${recordData[config.secondary]})` : '') : '';
    const seriesValue = config.series ? (recordData[config.series] ? ` [${recordData[config.series]}]` : '') : '';

    let identifier = `${primaryValue || ''}${secondaryValue}${seriesValue}`;
    
    if (!primaryValue) {
        identifier = recordData.id ? `Record ID: ${recordData.id}` : 'an unknown record';
    } else {
         identifier = identifier.trim().replace(/\s{2,}/g, ' '); 
    }

    const actionTextMap = {
        "CREATE": "Created new",
        "BULK CREATE": "Bulk Data Create",
        "UPDATE": "Updated",
        "DELETE": "Soft deleted",
        "STATUS_CHANGE": "Changed status for",
        "ERROR": "Encountered a server error in",
    };

    const actionText = actionTextMap[actionType] || actionType;
    const cleanEntityName = entityName.replace(/([A-Z])/g, ' $1').trim();

    return `${actionText} ${cleanEntityName}: ${identifier}`;
};