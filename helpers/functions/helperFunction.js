const dayjs = require('dayjs');
const commonQuery = require('../commonQuery');
const { ItemMaster, sequelize } = require('../../models');
const { fixDecimals } = require('./commonFunctions');
const fs = require("fs");
const path = require("path");
const { fail } = require('../Err');

exports.getExpDateByItem = async (item_id, mfgDate) => {
    try {
        const item = await commonQuery.findOneRecord(ItemMaster, item_id);

        if (item && item.self_life_days) {
            const expDate = dayjs(mfgDate).add(item.self_life_days, 'day').format('DD-MM-YYYY');
            return expDate;
        } else {
            return '';
        }
    } catch (err) {
        console.error("Error in getExpDateByItem:", err);
        return '';
    }
};

exports.convertStock = async (stock, itemId, itemUnit, company_id, transaction = null) => {
    try {
        const { fixQty } = await fixDecimals(company_id);

        const item = await commonQuery.findOneRecord(
            ItemMaster,
            itemId,
            {
                attributes: [
                    "id",
                    "alternate_unit",
                    "primary_unit",
                    "alternate_unit_quantity",
                    "purchase_quantity",
                ],
            },
            transaction,
            true
        );

        if (!item) {
            return {
                baseQty: fixQty(0),
                convertedQty: fixQty(0),
                baseUnit: null,
                convertedUnit: null,
            };
        }

        let baseQty, convertedQty, baseUnit, convertedUnit;

        if (String(itemUnit) === String(item.primary_unit)) {
            // Input given in Primary Unit → Keep stock as base
            baseQty = fixQty(stock);
            baseUnit = item.primary_unit;

            // Convert into Alternate Unit
           if (item.alternate_unit && parseFloat(item.alternate_unit_quantity) > 0) {
                convertedQty = fixQty((parseFloat(stock) * parseFloat(item.purchase_quantity)) / parseFloat(item.alternate_unit_quantity),);
                convertedUnit = item.alternate_unit;
            } else {
                convertedQty = baseQty;
                convertedUnit = baseUnit;
            }

        } else if (String(itemUnit) === String(item.alternate_unit)) {
            if (!item.alternate_unit_quantity || parseFloat(item.alternate_unit_quantity) <= 0) {
                fail("INVALID_PURCHASE_CONVERSION");
            }

            baseQty = fixQty((parseFloat(stock) / parseFloat(item.alternate_unit_quantity)) * parseFloat(item.purchase_quantity),);
            baseUnit = item.primary_unit;

            convertedQty = fixQty(stock);
            convertedUnit = item.alternate_unit;

        } else {            
            fail("UNIT_NOT_MATCHED");
        }
        return { baseUnit, baseQty, convertedUnit, convertedQty };

    } catch (err) {
        console.error("Error in convertStock:", err);
        fail(err);
    }
};

exports.updateItemStock = async (
    itemId,
    itemUnit,
    type,
    current = 0,
    reserve = 0,
    company_id,
    transaction = null
) => {
    const t = transaction || await sequelize.transaction();
    try {
        const format = await fixDecimals(company_id);
        const item = await commonQuery.findOneRecord(
            ItemMaster,
            itemId,{
                attributes: ["id", "current_stock", "reserve_stock"],
            },
            t,
            true
        );

        if (!item) throw new Error("ITEM_NOT_FOUND");

        const baseCurrent = await exports.convertStock(current, itemId, itemUnit, company_id, t);
        const baseReserve = await exports.convertStock(reserve, itemId, itemUnit, company_id, t);

        let newCurrentStock, newReserveStock;

        const currentStockNum = parseFloat(item.current_stock);
        const reserveStockNum = parseFloat(item.reserve_stock);
        const baseCurrentNum = parseFloat(baseCurrent);
        const baseReserveNum = parseFloat(baseReserve);

        if (type === "add") {
            newCurrentStock = currentStockNum + baseCurrentNum;
            newReserveStock = reserveStockNum + baseReserveNum;
        } else if (type === "deduct") {
            newCurrentStock = currentStockNum - baseCurrentNum;
            newReserveStock = reserveStockNum - baseReserveNum;
        } else {
            throw new Error("INVALID_TYPE");
        }

        if (newCurrentStock < 0 || newReserveStock < 0) {
            throw new Error("INSUFFICIENT_STOCK");
        }

        await commonQuery.updateRecordById(
            ItemMaster, { id: itemId }, {
                current_stock: format(newCurrentStock, company_id, "qty"),
                reserve_stock: format(newReserveStock, company_id, "qty"),
            },
            t
        );

        if (!transaction) await t.commit();
        return {
            ...item.toJSON(),
            current_stock: format(newCurrentStock, company_id, "qty"),
            reserve_stock: format(newReserveStock, company_id, "qty")
        };
    } catch (err) {
        if (!transaction) await t.rollback();
        throw err;
    }
};


