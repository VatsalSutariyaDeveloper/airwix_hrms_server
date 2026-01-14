const {
  
  ItemMaster,
  TaxTemplate,
  TaxTemplateTransaction,
  TaxTypeMaster,
  HSNMaster,       // ➕ Import HSNMaster
  ItemCategory,     // ➕ Import ItemCategory
  CompanyConfigration
} = require("../../models");
const commonQuery = require("../commonQuery"); // Assuming your helper is in the same directory

/**
 * Calculates tax for a given item and amount based on company configuration.
 * @param {number} itemId - The ID of the item.
 * @param {number} taxableAmount - The base amount on which to calculate tax.
 * @param {number} companyId - The ID of the company to fetch configuration for.
 * @returns {object} - An object containing the detailed tax calculation.
 */
exports.calculateTax = async (itemId, taxableAmount, companyId, taxTemplateId = null) => {
  try {
    let tax_group_id = taxTemplateId;

    // If no template passed, decide from company config + item
    if (!tax_group_id) {
      // 1. Get Company Configuration for Tax Calculation
      const config = await commonQuery.findOneRecord(
        CompanyConfigration,
        { company_id: companyId, setting_key: "tax_calculation_from" }
      );

      const taxCalculationFrom = config ? config.setting_value : "Item";

      // 2. Fetch Item with associations
      const item = await commonQuery.findOneRecord(ItemMaster, itemId, {
        include: [
          { model: HSNMaster, as: "hsn" },
          { model: ItemCategory, as: "category" },
        ],
      });

      if (!item) throw new Error("Item not found.");

      // 3. Decide template source
      if (taxCalculationFrom === "Item" && item.tax_group_id) {
        tax_group_id = item.tax_group_id;
      } else if (taxCalculationFrom === "HSN" && item.hsn && item.hsn.tax_group_id) {
        tax_group_id = item.hsn.tax_group_id;
      } else if (taxCalculationFrom === "Category" && item.category && item.category.tax_group_id) {
        tax_group_id = item.category.tax_group_id;
      }
    }

    // 4. If still no template → return no tax
    if (!tax_group_id) {
      return {
        taxableAmount,
        totalTax: 0,
        totalAmount: taxableAmount,
        taxBreakdown: [],
        summary: "No Tax",
      };
    }

    // 5. Fetch template + transactions
    const taxTemplate = await commonQuery.findOneRecord(TaxTemplate, tax_group_id, {
      include: [{
        model: TaxTemplateTransaction,
        as: "transactions",
        include: [{
          model: TaxTypeMaster,
          as: "taxType",
          attributes: ["id", "tax_type_name"],
        }],
      }],
    });

    if (!taxTemplate || !taxTemplate.transactions) {
      throw new Error("Tax template or its transactions not found.");
    }

    // 6. Calculate
    const result = {
      taxableAmount: parseFloat(taxableAmount),
      totalTax: 0,
      totalAmount: parseFloat(taxableAmount),
      taxBreakdown: [],
    };

    for (const txn of taxTemplate.transactions) {
      const rate = parseFloat(txn.tax_value);
      const amount = (taxableAmount * rate) / 100;

      result.taxBreakdown.push({
        taxTypeId: txn.tax_type_id,
        rate: rate,
        amount: parseFloat(amount.toFixed(2)),
      });

      result.totalTax += amount;
    }

    result.totalAmount += result.totalTax;

    // Rounding
    result.totalTax = parseFloat(result.totalTax.toFixed(2));
    result.totalAmount = parseFloat(result.totalAmount.toFixed(2));

    return result;
  } catch (error) {
    console.error("Tax Calculation Error:", error);
    return {
      error: true,
      message: error.message,
      taxableAmount,
      totalTax: 0,
      totalAmount: taxableAmount,
      taxBreakdown: [],
    };
  }
};