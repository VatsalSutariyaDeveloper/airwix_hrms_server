const {
  StockTransaction,
  ReserveStock,
  InvoiceTransaction,
  SalesOrderTransaction,
  SalesOrder,
  TaxTransaction,
  ChargesTransaction,
} = require("../../models");
const commonQuery = require("../commonQuery");
const { fixDecimals } = require("./commonFunctions");
const { sequelize } = require("../../models"); // Ensure Sequelize is imported
const { Op, fn, col } = require("sequelize");
const { convertStock } = require("./helperFunction");
const constants = require("../constants");
const { addReserveStock } = require("./inventoryFunctions");
const salesOrderTransaction = require("../../models/sales/sales-order/salesOrderTransaction");

exports.removeInvoiceStockEffect = async (
  invoiceTransactionId,
  commonData,
  transaction
) => {
  if (!invoiceTransactionId) return;

  // ==> PART 1: Reverse stock effects for items deducted directly on the invoice.
  // This process created a `ReserveStock` record (flag 1) against the invoice line
  // and updated the `used_qty` on the parent `StockTransaction`.

  const directReservations = await commonQuery.findAllRecords(
    ReserveStock,
    {
      ref_entity_id: commonData.entity_id,
      ref_id: invoiceTransactionId,
      stock_flag: 1,
      status: 0,
      company_id:commonData.company_id,
      branch_id:commonData.branch_id,
      user_id:commonData.user_id,
    },
    {},
    transaction
  );

  for (const reservation of directReservations) {
    if (reservation.stock_id) {
      const parentStock = await commonQuery.findOneRecord(
        StockTransaction,
        reservation.stock_id,
        {},
        transaction
      );

      if (parentStock) {
        // Decrease the used quantity on the parent stock lot.
        const newUsedQty =
          (parseFloat(parentStock.used_qty) || 0) -
          (parseFloat(reservation.item_qty) || 0);

        await commonQuery.updateRecordById(
          StockTransaction,
          parentStock.id,
          {
            // Ensure used quantity doesn't go below zero.
            used_qty: newUsedQty < 0 ? 0 : newUsedQty,
          },
          transaction
        );
      }
    }
    // After restoring the parent stock, soft-delete the reservation record.
    await commonQuery.softDeleteById(
      ReserveStock,
      reservation.id,
      null,
      transaction
    );
  }

  // 1. Find all active stock issuance records created for this invoice transaction.
  const stockIssuances = await commonQuery.findAllRecords(
    StockTransaction,
    {
      ref_entity_id: commonData.entity_id,
      ref_id: invoiceTransactionId,
      stock_flag: 2, // Represents stock out/issuance
      status: 0,
      company_id:commonData.company_id,
      branch_id:commonData.branch_id,
      user_id:commonData.user_id,
    },
    {},
    transaction
  );

  // 2. Iterate over each issuance record and reverse its effect.
  for (const issuance of stockIssuances) {
    // 3. Check if the stock was issued from a Sales Order reservation.
    if (issuance.reserve_id && issuance.reserve_id !== 0) {
      await commonQuery.softDeleteById(
        ReserveStock,
        {
          ref_entity_id: commonData.entity_id,
          ref_id: invoiceTransactionId,
          stock_flag: 2,
          perent_id: issuance.reserve_id, // The 'perent_id' of the usage record is the ID of the original reservation record.
        },
        null,
        transaction
      );
    }

    if (issuance.perent_id) {
      const parentStock = await commonQuery.findOneRecord(
        StockTransaction,
        issuance.perent_id,
        {},
        transaction
      );

      if (parentStock) {
        // Decrement the used quantity on the parent stock record.
        const newUsedBaseQty =
          (parseFloat(parentStock.used_qty) || 0) -
          (parseFloat(issuance.item_qty) || 0);

        await commonQuery.updateRecordById(
          StockTransaction,
          parentStock.id,
          {
            item_qty: newUsedBaseQty < 0 ? 0 : newUsedBaseQty,
          },
          transaction
        );
      }
    }

    // 4. Finally, soft-delete the stock issuance record itself.
    await commonQuery.softDeleteById(
      StockTransaction,
      issuance.id,
      null,
      transaction
    );
  }
};


exports.invoiceStockDeduct = async (
  InvoiceTransactionId,
  commonData,
  transaction = null
) => {
  // This makes the function idempotent: first remove any previous stock effect
  // for this transaction ID, then apply the new one. This correctly handles updates.
  await exports.removeInvoiceStockEffect(InvoiceTransactionId, commonData, transaction);

  const item = await commonQuery.findOneRecord(
    InvoiceTransaction,
    InvoiceTransactionId,
    {},
    transaction,
    true
  );
  if (!item) return; // Exit if the transaction doesn't exist anymore

  const format = await fixDecimals(commonData.company_id);

  if (item.ref_entity_id === ENTITIES.SALES.ID && item.ref_id) {
    let inv_qty = parseFloat(item.item_qty);

    const reservedStocks = await commonQuery.findAllRecords(
      ReserveStock,
      {
        item_id: item.item_id,
        ref_entity_id: item.ref_entity_id,
        ref_id: item.ref_id,
        stock_flag: 1,
        status: 0,
        company_id: item.company_id,
        branch_id: item.branch_id,
        user_id: item.user_id,
      },
      {},
      transaction
    );

    for (const rstock of reservedStocks) {
      if (inv_qty <= 0) break;

      const used = await commonQuery.findOneRecord(
        ReserveStock,
        {
          stock_flag: 2,
          status: 0,
          parent_id: rstock.id,
        },
        {
          attributes: [
            [fn("IFNULL", fn("SUM", col("item_qty")), 0), "total_used_qty"],
          ],
          raw: true,
        },
        transaction
      );

      const totalUsedBase = parseFloat(used?.total_used_qty || 0);
      const pending_base = parseFloat(rstock.item_qty) - totalUsedBase;

      if (pending_base > 0) {
        const qty_rd = Math.min(inv_qty, pending_base);
        inv_qty -= qty_rd;

        const reserveDeduct = {
          item_id: rstock.item_id,
          godown_id: rstock.godown_id,
          item_unit: rstock.item_unit,
          item_qty: format(qty_rd, item.company_id, "qty"),
          stock_flag: 2,
          ref_entity_id: item.ref_entity_id,
          ref_id: item.ref_id,
          parent_id: rstock.id,
          user_id: item.user_id,
          company_id: item.company_id,
          branch_id: item.branch_id,
           parent_id: rstock.id,
        };
        await commonQuery.createRecord(ReserveStock, reserveDeduct, transaction);

        const stockEntry = {
          item_id: rstock.item_id,
          item_unit: rstock.item_unit,
          item_qty: format(qty_rd, item.company_id, "qty"),
          item_amount: format(item.item_rate, item.company_id, "rate"),
          item_conv_amount: format(item.item_convert_rate, item.company_id, "rate"),
          stock_flag: 2,
          ref_entity_id: item.ref_entity_id,
          ref_id: item.ref_id,
          parent_id: rstock.stock_id,
          godown_id: rstock.godown_id,
          reserve_id: rstock.id, // This is the link to the original SO reservation
          user_id: item.user_id,
          company_id: item.company_id,
          branch_id: item.branch_id,
        };
        await commonQuery.createRecord(StockTransaction, stockEntry, transaction);
      }
    }
  } else {
    // Stock deduction for items added directly to the invoice
    await addReserveStock(
      0,
      item,
      commonData.entity_id,
      item.id, // ref_id is the invoice transaction id
      item.user_id,
      item.branch_id,
      item.company_id,
      transaction
    );
  }
};

exports.getSalesOrderReserveStock = async (
  item_id,
  entityId,
  salesOrderTransactionId,
  company_id,
  transaction = null
) => {
  if (!item_id || !entityId || !salesOrderTransactionId || !company_id) {
    throw new Error("Missing required parameters.");
  }
  const format = await fixDecimals(company_id);
  const filters = {
    item_id,
    ref_entity_id: entityId,
    ref_id: salesOrderTransactionId,
    stock_flag: 1,
    status: 0,
    company_id,
  };

  const reservedStocks = await commonQuery.findAllRecords(
   ReserveStock,
    filters,
    {},
    transaction,
    false
  );

  let total_remaining_qty = 0;

  for (const rstock of reservedStocks) {
    const used = await commonQuery.findOneRecord(ReserveStock, 
      {
        status: 0,
        stock_flag: 2,
        parent_id: rstock.id,
      },
      {
        attributes: [
          [
            fn("IFNULL", fn("SUM", col("item_qty")), 0),
            "total_used_qty",
          ],
        ],
        raw: true,
      }, 
      transaction
    );
    const remaining_qty = format(
      parseFloat(rstock.item_qty) -
        parseFloat(used?.total_used_qty || 0)
    );

    if (remaining_qty > 0) {
      total_remaining_qty += remaining_qty;
    }
  }

  return {
    remaining_qty: format(total_remaining_qty, company_id, "qty"),
  };
};

exports.addGeneralBookEntry = async (
  ref_name,
  ref_id,
  entry_type,
  party_id,
  amount,
  ref_date,
  currency_array,
  branch_id,
  user_id,
  company_id,
  general_book_id = null,
  transaction = null
) => {
  try {
    const info_gen = {
      ref_name,
      ref_id,
      entry_type,
      party_id,
      amount,
      ref_date: ref_date ? new Date(ref_date) : new Date(),
      branch_id,
      user_id,
      company_id,
      ...currency_array,
    };

    let result;
    if (!general_book_id) {
      // Insert new record
      result = await commonQuery.createRecord(
        GeneralBook,
        info_gen,
        transaction
      );
    } else {
      // Update existing record
      result = await commonQuery.updateRecordById(
        GeneralBook,
        { id: general_book_id },
        info_gen,
        transaction
      );
    }

    return result;
  } catch (err) {
    console.error("Error in addGeneralBookEntry:", err);
    throw err;
  }
};

exports.getSalesOrderInvoiceDone = async (ref_entity_id, sales_ordertrn_id, invoice_id, commonData, transaction) => {
  // 1. Get the sales order transaction row (switched to findOneRecord for clarity)
  const soTrn = await commonQuery.findOneRecord(
    SalesOrderTransaction,
    { 
      id: sales_ordertrn_id,
      company_id: commonData.company_id,
      branch_id: commonData.branch_id,
      user_id: commonData.user_id,
    },
    { attributes: ['item_quantity', 'id', 'sales_order_id'] },
    transaction
  );

  if (!soTrn) {
    throw new Error('Sales order transaction not found.');
  }

  // 2. Get the total invoiced qty for this sales order line
  // Note: Removed 'invoice_id' from the filter to correctly sum up ALL invoices for this line.
  const invQtyResult = await commonQuery.findOneRecord(
    InvoiceTransaction,
    {
      status: 0,
      ref_entity_id,
      ref_id: soTrn.id,
      company_id: commonData.company_id,
      branch_id: commonData.branch_id,
      user_id: commonData.user_id,
    },
    {
      attributes: [
        [sequelize.fn('SUM', sequelize.col('item_qty')), 'total_invoiced_qty']
      ],
      raw: true
    },
    transaction
  );

  const total_invoiced_qty = parseFloat(invQtyResult?.total_invoiced_qty || 0);
  const item_qty = parseFloat(soTrn.item_quantity || 0);
  const remaining_qty = item_qty - total_invoiced_qty;

  // 3. Update the sales order transaction line
  await commonQuery.updateRecordById(
    SalesOrderTransaction,
    { id: sales_ordertrn_id },
    {
      // BUG FIX: Set the invoice_qty directly, don't add to it.
      invoice_qty: total_invoiced_qty, 
      invoice_status: remaining_qty <= 0 ? 1 : 0
    },
    transaction
  );

  // 4. OPTIMIZED: Get counts for both total and completed lines in a single query
  const counts = await commonQuery.findOneRecord(
    SalesOrderTransaction,
    {
      status: 0,
      sales_order_id: soTrn.sales_order_id,
      company_id: commonData.company_id,
      branch_id: commonData.branch_id,
      user_id: commonData.user_id
    },
    {
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'total_trn'],
        // Use a conditional SUM to count only the completed lines
        [sequelize.literal("SUM(CASE WHEN `invoice_status` = 1 THEN 1 ELSE 0 END)"), 'done_inv']
      ],
      raw: true
    },
    transaction
  );
  
  const done_inv = parseInt(counts?.done_inv || 0, 10);
  const total_trn = parseInt(counts?.total_trn || 0, 10);

  // 5. Update the sales order header status
  if (total_trn > 0) { // Avoid division by zero or updating if no lines exist
    await commonQuery.updateRecordById(
      SalesOrder,
      { id: soTrn.sales_order_id },
      {
        invoice_status: done_inv >= total_trn ? 1 : 0
      },
      transaction
    );
  }
};

exports.addTaxTransactionRecord = async (
  taxesList,
  entity_id,
  entity_transaction_id,
  ref_id,
  ref_type, // 1=Item, 2=Charges
  currency_id,
  currency_rate,
  taxable_value,
  taxable_value_converted,
  commonData,
  transaction
) => {
  if (!Array.isArray(taxesList)) return;
  const { fixNum } = await fixDecimals(commonData.company_id);

  const existingTaxes = await commonQuery.findAllRecords(
    TaxTransaction,
    {
      entity_id,
      entity_transaction_id,
      ref_id,
      ref_type,
      status: 0,
      company_id:commonData.company_id,
      branch_id:commonData.branch_id,
      user_id:commonData.user_id,
    },
    {},
    transaction,
    true
  );

  const incomingTaxIds = taxesList.map((t) => t.id).filter(Boolean);
  // 1️⃣ Soft delete taxes that are not in incoming array
  for (const tax of existingTaxes) { 
    if (!incomingTaxIds.includes(tax.id)) {
      await commonQuery.updateRecordById(
        TaxTransaction,
        tax.id,
        { status: 2 },
        transaction
      );
    }
  }

  // 2️⃣ Insert or update incoming taxes
  for (const tax of taxesList) {
    const data = {
      tax_id: tax.tax_id,
      tax_value: tax.tax_value,
      tax_amount:fixNum(tax.tax_amount),
      tax_amount_converted:fixNum(tax.tax_amount_converted),
      entity_id,
      entity_transaction_id,
      ref_id,
      ref_type,
      currency_id,
      currency_rate,
      taxable_value,
      taxable_value_converted,
      ...commonData,
    };
    if (tax.id) {
      await commonQuery.updateRecordById(
        TaxTransaction,
        tax.id,
        data,
        transaction
      );
    } else {
      await commonQuery.createRecord(TaxTransaction, data, transaction);
    }
  }
};

/**
 * 🔹 Sync Charges with Taxes (create & update)
 *
 * @param {Array} chargesList - Incoming charges_transaction array
 * @param {Number} entityId - Entity (quotation, sales order, invoice, etc.)
 * @param {Number} entityTransactionId - Parent record id (quotation.id, invoice.id, etc.)
 * @param {Object} extraFields - { company_id, branch_id, user_id }
 * @param {Object} transaction - Sequelize transaction
 */
exports.syncChargesWithTaxes = async (
  chargesList,
  currencyId,
  currencyRate,
  entityId,
  entityTransactionId,
  extraFields,
  transaction
) => {
  if (!Array.isArray(chargesList)) return;
  const { fixNum } = await fixDecimals(extraFields.company_id);
  const incomingIds = chargesList.map((c) => c.id).filter(Boolean);

  // Soft delete removed charges
  if (incomingIds.length > 0) {
    await commonQuery.softDeleteById(
      ChargesTransaction,
      {
        entity_id: entityId,
        entity_transaction_id: entityTransactionId,
        id: { [Op.notIn]: incomingIds },
        ...extraFields
      },
      null,
      transaction
    );
  } else {
    // No IDs passed → delete all charges for this transaction
    await commonQuery.softDeleteById(
      ChargesTransaction,
      {
        entity_id: entityId,
        entity_transaction_id: entityTransactionId,
        ...extraFields
      },
      null,
      transaction
    );
  }

  for (const charge of chargesList) {
    charge.charges_amount = fixNum(charge.charges_amount);
    charge.charges_convert_amount = fixNum(charge.charges_convert_amount);
    charge.taxable_amount = fixNum(charge.taxable_amount);
    charge.taxable_convert_amount = fixNum(charge.taxable_convert_amount);
    charge.tax_amount = fixNum(charge.tax_amount);
    charge.tax_convert_amount = fixNum(charge.tax_convert_amount);
    charge.total_amount = fixNum(charge.total_amount);
    charge.total_convert_amount = fixNum(charge.total_convert_amount);
    
    let chargesTrnId;

    if (charge.id) {
      await commonQuery.updateRecordById(
        ChargesTransaction,
        charge.id,
        {
          charges_id: charge.charges_id,
          tax_group_id: charge.tax_group_id || null,
          currency_id: currencyId,
          currency_rate: currencyRate,
          charges_percentage: charge.charges_percentage,
          taxable_amount: charge.taxable_amount,
          taxable_convert_amount: charge.taxable_convert_amount,
          tax_amount: charge.tax_amount,
          tax_convert_amount: charge.tax_convert_amount,
          total_amount: charge.total_amount,
          total_convert_amount: charge.total_convert_amount,
          status: 0,
          entity_id: entityId,
          entity_transaction_id: entityTransactionId,
          ...extraFields,
        },
        transaction
      );
      chargesTrnId = charge.id;
    } else {
      const newCharge = await commonQuery.createRecord(
        ChargesTransaction,
        {
          charges_id: charge.charges_id,
          entity_id: entityId,
          entity_transaction_id: entityTransactionId,
          tax_group_id: charge.tax_group_id || null,
          currency_id: currencyId,
          currency_rate: currencyRate,
          charges_percentage: charge.charges_percentage,
          taxable_amount: charge.taxable_amount,
          taxable_convert_amount: charge.taxable_convert_amount,
          tax_amount: charge.tax_amount,
          tax_convert_amount: charge.tax_convert_amount,
          total_amount: charge.total_amount,
          total_convert_amount: charge.total_convert_amount,
          status: 0,
          ...extraFields,
        },
        transaction
      );
      chargesTrnId = newCharge.id;
    }

    // Handle taxTransactions for this charge
    if (Array.isArray(charge.taxTransactions)) {
      await exports.addTaxTransactionRecord(
        charge.taxTransactions,
        entityId,
        entityTransactionId,
        chargesTrnId,
        2, // ref_type = 2 for charges
        currencyId,
        currencyRate,
        charge.taxable_amount,
        charge.taxable_convert_amount,
        extraFields,
        transaction
      );
    }
  }
};