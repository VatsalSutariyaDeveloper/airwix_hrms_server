const {
  ReserveStock,
  StockGeneralTransaction,
  BatchStockIn,
  StockTransaction,
  ItemMaster,
  BatchData,
  User,
} = require("../../models");
const commonQuery = require("../commonQuery");
const moment = require("moment");
const { convertStock, getExpDateByItem } = require("./helperFunction");
const { getItemDetail, fixDecimals, createOrUpdateNotification } = require("./commonFunctions");
const { Op, literal } = require("sequelize");
const { sequelize } = require("../../models");
// const { session } = require("../middleware/authMiddleware");

exports.addStock = async ({
  transaction = null,
  item_id,
  item_unit,
  item_amount,
  item_convert_amount,
  ref_entity_id,
  ref_id,
  godown_id,
  item_qty,
  stock_flag,
  commonData,
  parent_id,
  reserve_id,
  party_id = "",
  batch_id = "",
  batch_no = "",
  workorder_id = 0,
}) => {
  let infoGen = {};
  let resStock = null;
  const { fixNum, fixQty } = await fixDecimals(commonData.company_id);

  if (parent_id) {
    resStock = await commonQuery.findAllRecords(
      StockTransaction,
      { id: parent_id, ...commonData },
      transaction
    );

    if (resStock && resStock.length) {
      resStock = resStock[0];
      if (!party_id) party_id = resStock.party_id;
      if (!batch_id) batch_id = resStock.batch_id;
      if (!batch_no) batch_no = resStock.batch_no;
    }
  }

  if (stock_flag === 1) {
    if (batch_id) {
      const batch = await commonQuery.findOneRecord(BatchData, batch_id, transaction);
      
      if (batch) {
        infoGen.mfg_date = batch.mfg_date;
        infoGen.exp_date = batch.exp_date;
      }
    } else {
      infoGen.mfg_date = moment().format("YYYY-MM-DD");
      const dt = await getExpDateByItem(
        item_id,
        moment().format("DD-MM-YYYY")
      );
      // infoGen.exp_date = moment(dt, "DD-MM-YYYY").format("YYYY-MM-DD");
    }
  }

  // get base unit via convertStock
  const {baseUnit, baseQty, convertedUnit, convertedQty} = await convertStock(fixQty(item_qty), item_id, item_unit, commonData.company_id, transaction);

  infoGen = {
    ...infoGen,
    item_id,
    item_unit: baseUnit,
    item_qty: baseQty,
    item_amount: item_amount,
    item_convert_amount: item_convert_amount,
    stock_flag: stock_flag,
    godown_id,
    ref_id,
    ref_entity_id,
    parent_id,
    reserve_id,
    party_id: party_id || 0,
    batch_id : batch_id || 0,
    batch_no,
    workorder_id,
    user_id: commonData.user_id,
    company_id: commonData.company_id,
    branch_id: commonData.branch_id || 1,
  };

  if (stock_flag === 2 && resStock) {
    infoGen.item_amount = fixNum(resStock.item_amount);
    infoGen.item_convert_amount = fixNum(resStock.item_convert_amount);
  }
  const inserted = await commonQuery.createRecord(
    StockTransaction,
    infoGen,
    transaction
  );

  if(stock_flag === 2){

    const reserveStocks = await commonQuery.findOneRecord(
      ReserveStock,
      {
        id: reserve_id,
      },
      transaction
    );

    const reserveData = {
      item_id: reserveStocks.item_id,
      item_unit: baseUnit,
      item_qty: baseQty,
      stock_flag: 2,
      ref_id: reserveStocks.ref_id,
      ref_entity_id:reserveStocks.ref_entity_id,
      item_amount: reserveStocks.item_amount,
      item_convert_amount: reserveStocks.item_convert_amount,
      stock_id: inserted.id,
      parent_id: reserveStocks.id,
      godown_id: reserveStocks.godown_id,
      branch_id: commonData.branch_id,
      user_id: commonData.user_id,
      company_id: commonData.company_id,
    };
  
    await commonQuery.createRecord(ReserveStock, reserveData, transaction);

    const approve_qty = parseFloat(reserveStocks.approve_qty) + parseFloat(baseQty);
    await commonQuery.updateRecordById(
      ReserveStock,
      { id: reserve_id },
      {
        approve_qty,
        used_status: approve_qty == reserveStocks.item_qty ? 1 : 0
      },
      transaction,
      true
    );
  }

  // Update Item Current Stock
  const stockChange = (stock_flag === 1) ? parseFloat(baseQty) : -parseFloat(baseQty);

  const updateStock = await commonQuery.updateRecordById(ItemMaster, { id: item_id }, 
      {
        current_stock: sequelize.literal(`current_stock + ${stockChange}`) 
      },
      transaction,
      true
  );

  if(updateStock.parent_item_id && updateStock.parent_item_id > 0){
    await commonQuery.updateRecordById(ItemMaster, { id: updateStock.parent_item_id }, 
        {
          current_stock: sequelize.literal(`current_stock + ${stockChange}`) 
        },
        transaction,
        true
    );
  }

  return inserted;
};

exports.enterProductionStockEffect = async (
  stock_general_id,
  entity_id,
  commonData,
  transaction = null
) => {
  const format = await fixDecimals(commonData.company_id);
  const transactions = await commonQuery.findAllRecords(
    StockGeneralTransaction,
    { stock_general_id, status: 0, ...commonData },
    transaction
  );
  for (const trn of transactions) {  
    if(trn.stock_flag === 2){

    const reserveStocks = await commonQuery.findAllRecords(
      ReserveStock,
      {
        ref_entity_id:entity_id,
        ref_id: trn.id,
        stock_flag: 1,
        ...commonData
      },
      transaction
    );

    for (const stock of reserveStocks) {
      
        await exports.addStock({
          transaction,
          item_id: stock.item_id,
          item_unit: stock.item_unit,
          ref_id: stock.ref_id,
          ref_entity_id: stock.ref_entity_id,
          reserve_id: stock.id,
          godown_id: stock.godown_id,
          item_qty: format(stock.item_qty, commonData.company_id, "qty"),
          stock_flag: 2,
          commonData,
          parent_id: stock.stock_id,
        }

      );
    } 
  }else {
    const batches = await commonQuery.findAllRecords(
      BatchStockIn,
      { status: 0,ref_id:trn.id, ...commonData }, 
      {
        include: [
          {
            model: StockGeneralTransaction,
            as: "transaction",
           
          },
        ],
      },
      transaction
    );
  
    for (const batch of batches) {
      await exports.addStock({
        transaction,
        item_id: batch.item_id,
        item_unit: batch.item_unit,
        item_amount: format(batch.transaction.item_amount, commonData.company_id, "rate"),
        item_convert_amount: format(batch.transaction.item_convert_amount, commonData.company_id, "rate"),
        ref_id: batch.ref_id,
        ref_entity_id: batch.ref_entity_id,
        godown_id: batch.godown_id,
        item_qty: format(batch.item_qty, commonData.company_id, "qty"),
        stock_flag: 1,
        commonData,
        batch_id: batch.batch_id,
        batch_no: batch.batch_stock_no,
      });
    }
  }
}
};

exports.deleteItemStockEffect = async (
  stock_general_id,
  entity_id,
  commonData,
  transaction = null
) => {
  const transactions = await commonQuery.findAllRecords(
    StockGeneralTransaction,
    { stock_general_id, ...commonData },
    transaction
  );

  for (const trn of transactions) {
    if(trn.stock_flag == 2){
      const reserveStocks = await commonQuery.findAllRecords(
        ReserveStock,
        {
          ref_id: trn.id,
          ref_entity_id: entity_id,
          status: 0,
          ...commonData
        },
        transaction
      );

      for (const stock of reserveStocks) {
        const stockTrn = await commonQuery.findOneRecord(
          StockTransaction,
          {id: stock.stock_id},
          transaction
        );

        if (stockTrn) {
          await commonQuery.updateRecordById(
            StockTransaction,
            { id: stockTrn.id },
            {
              used_qty: parseFloat(stockTrn.used_qty) - parseFloat(stock.item_qty),
            },
            transaction
          );
        }
        
        await commonQuery.softDeleteById(
          ReserveStock,
          { id: stock.id },
          {},
          transaction
        );
      }
    } else {
      await commonQuery.softDeleteById(
        BatchStockIn,
        { ref_id: trn.id, ref_entity_id: entity_id },
        {},
        transaction
      );

      await commonQuery.softDeleteById(
        StockTransaction,
        { ref_id: trn.id, ref_entity_id: entity_id },
        {},
        transaction
      );
    }
  }
};

exports.itemReserveStockEntry = async (
  transaction,
  itemData,
  item_unit,
  item_stock,
  ref_entity_id,
  ref_id,
  stock_id,
  godown_id,
  commonData
) => {
  try {
    const format = await fixDecimals(commonData.company_id);
    // 1. Check existing reserve stock
    const existingStockArr = await commonQuery.findAllRecords(
      ReserveStock,
      {
        status: 0,
        stock_flag: 1,
        ref_entity_id,
        ref_id: ref_id,
        item_id: itemData.item_id,
        stock_id,
        ...commonData
      },
      {},
      transaction
    );

    // Validate item_id
    if (!itemData.item_id || isNaN(parseInt(itemData.item_id)) || parseInt(itemData.item_id) <= 0) {
      throw new Error(`Invalid item_id: ${itemData.item_id}`);
    }

    const info_stock = {
      item_id: parseInt(itemData.item_id), 
      item_unit: item_unit,
      item_qty: format(item_stock, commonData.company_id, "qty"),
      item_amount: itemData.item_amount,
      item_convert_amount: itemData.item_convert_amount,
      stock_flag: 1,
      ref_entity_id,
      ref_id,
      stock_id,
      godown_id,
      ...commonData
    };

    let prev_stock = 0;

    const existingStock = existingStockArr[0];

    if (existingStock) {
      prev_stock = format(existingStock.item_qty, commonData.company_id, "qty");

      await commonQuery.updateRecordById(
        ReserveStock,
        { id: existingStock.id },
        info_stock,
        transaction
      );
    } else {
      await commonQuery.createRecord(ReserveStock, info_stock, transaction);
    }

    // 2. Fetch the original stock transaction
    const stockTrn = await commonQuery.findOneRecord(
      StockTransaction,
      { id: stock_id },
      {},
      transaction,
      true    
    );

    const used_stock = parseFloat(format(stockTrn.used_qty, commonData.company_id, "qty")) + parseFloat(format(item_stock, commonData.company_id, "qty"));
    await commonQuery.updateRecordById(
      StockTransaction,
      { id: stockTrn.id },
      { used_qty: format(used_stock - prev_stock, commonData.company_id, "qty") },
      transaction,
      true
    );

    return true;
  } catch (err) {
    throw err;
  }
};

exports.getCurrentStock = async (itemId, godownId, company_id) => {
  const format = await fixDecimals(company_id);
  const filters = {
    stock_flag: 1,
    status: 0,
    [Op.and]: [
      literal(
        "CAST(item_qty AS DECIMAL(15,5)) > CAST(used_base_qty AS DECIMAL(15,5))"
      ),
    ],
  };

  if (itemId) filters.item_id = itemId;
  if (godownId) filters.godown_id = godownId;

  const stockList = await commonQuery.findAllRecords(
    StockTransaction,
    filters,
    {
      company_id:company_id
    },
  );

  let availableBaseQty = 0;

  for (const stock of stockList) {
    availableBaseQty += format(stock.item_qty, company_id, "qty") - format(stock.used_qty, company_id, "qty");
  }

  return format(availableBaseQty, company_id, "qty");
};

exports.getReserveStock = async (itemId, godownId, company_id, transaction = null) => {
  const format = await fixDecimals(company_id);
  const filters = {
    status: 0,
  };

  if (itemId) filters.item_id = itemId;
  if (godownId) filters.godown_id = godownId;

  // Get approved stock
  const approvedStock = await commonQuery.findAllRecords(
    ReserveStock,
    {
      ...filters,
      stock_flag: 1,
      company_id
    },
    {
      attributes: [
        "item_id",
        [
          sequelize.fn("SUM", sequelize.col("item_qty")),
          "total_item",
        ],
      ],
      group: ["item_id"],
    },
    transaction,
  );

  // Get used stock
  const usedStock = await commonQuery.findAllRecords(
    ReserveStock,
    {
      ...filters,
      stock_flag: 2,
      company_id
    },
    {
      attributes: [
        "item_id",
        [
          sequelize.fn("SUM", sequelize.col("item_qty")),
          "total_used_item",
        ],
      ],
      group: ["item_id"],
    },
    transaction,
  );

  // Calculate available stock
  const appr = approvedStock[0];
  const used = usedStock[0];

  const approveBase = format(appr?.get("total_item") || 0);
  const usedBase = format(used?.get("total_used_item") || 0);

  return format(approveBase - usedBase, company_id, "qty");
};

exports.addReserveStock = async (stock_id, itemData, item_qty, ref_entity_id, ref_id, stock_godown, commonData, transaction) => {
  const {baseUnit, baseQty, convertedUnit, convertedQty} = await convertStock(item_qty, itemData.item_id, itemData.item_unit, commonData.company_id, transaction);
  const format = await fixDecimals(commonData.company_id);
  if (stock_id === 0) {
    const stockTrnList = await commonQuery.findAllRecords(
      StockTransaction,
      {
        [Op.and]: [
          { status: 0 },
          { stock_flag: 1 },
          { stock_godown },
          { item_id: itemData.item_id },
          literal(
            "CAST(item_qty AS DECIMAL(15,5)) > CAST(used_qty AS DECIMAL(15,5))"
          ),
        ],
        ...commonData
      },
      {
        order: [["id", "ASC"]],
      },
      transaction
    );

    let totalAvailableStock = 0;

    for (const stockTrn of stockTrnList) {
      let pendingStock = format(stockTrn.item_qty, commonData.company_id, "qty") - format(stockTrn.used_qty, commonData.company_id, "qty");
      totalAvailableStock += format(pendingStock, commonData.company_id, "qty");
    }

    totalAvailableStock = format(totalAvailableStock, commonData.company_id, "qty");
    if (totalAvailableStock < parseFloat(baseQty)) {
      // Throw an error instead of returning a response
      throw new Error(
        `Insufficient stock for item ID ${itemData.item_id}. Required: ${baseQty}, Available: ${totalAvailableStock}`
      );
    }
    let remainingQty = baseQty;

    for (const stockTrn of stockTrnList) {
      let availableStock = format(stockTrn.item_qty, commonData.company_id, "qty") - format(stockTrn.used_qty, commonData.company_id, "qty");

      if (remainingQty <= 0) break;

      availableStock = format(availableStock, commonData.company_id, "qty");
      const deductQty = Math.min(availableStock, remainingQty);
      remainingQty -= format(deductQty, commonData.company_id, "qty");

      await exports.itemReserveStockEntry(
        transaction,
        itemData,
        baseUnit,
        deductQty,
        ref_entity_id,
        ref_id,
        stockTrn.id,
        stockTrn.godown_id,
        commonData
      );
    }
  } else {
    const stockTrn = await commonQuery.findOneRecord(StockTransaction, { id: stock_id }, transaction);
    if (stockTrn.id) {
      await exports.itemReserveStockEntry(
        transaction,
        itemData,
        baseUnit,
        baseQty,
        ref_entity_id,
        ref_id,
        stockTrn.id,
        stockTrn.godown_id,
        commonData
      );
    }
  }
}

exports.updateItemCurrentStock = async (itemId, baseQty, stockFlag, transaction) => {
    const stockChange = (stockFlag === 1) ? parseFloat(baseQty) : -parseFloat(baseQty);
    const item = await commonQuery.updateRecordById(
        ItemMaster, 
        { id: itemId }, 
        {
          current_stock: literal(`current_stock + ${stockChange}`) 
        },
        transaction 
    );

    if(item.parent_item_id && item.parent_item_id > 0){
      await commonQuery.updateRecordById(ItemMaster, { id: item.parent_item_id }, 
          {
            current_stock: sequelize.literal(`current_stock + ${stockChange}`) 
          },
          transaction 
      );
    }

    
    const current = parseFloat(item.current_stock || 0);
    const min = parseFloat(item.minimum_stock || 0);
    // const max = parseFloat(item.maximum_stock || 0);

    let alertMessage = null;

    if (current < min) {
      alertMessage = `Current stock (${current}) is below Minimum Stock (${min}).`;
    } 
    // else if (max > 0 && current > max) {
    //   alertMessage = `Current stock (${current}) is above Maximum Stock (${max}).`;
    // }

    if (!alertMessage) return;

    const adminUsers = await commonQuery.findAllRecords(
      User,
      {
        role_id: 1, 
        company_id: item.company_id,
        status: 0
      },
      {},
      transaction,
      false
    );

    for (const admin of adminUsers) {
      const notificationData = {
        receiver_id: admin.id,
        title: "Stock Alert",
        message: `Item: ${item.item_name}\n${alertMessage}`,
        type: "alert",
        is_read: false,
        user_id: item.user_id,
        branch_id: item.branch_id,
        company_id: item.company_id,
        link: `/inventory/item/${item.id}`,  // optional
        status: 0
      };

      await createOrUpdateNotification(notificationData, transaction);
    }
}