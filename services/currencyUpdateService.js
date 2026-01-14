const axios = require('axios');
const { CurrencyMaster } = require('../models'); // Adjust the path as needed
const { Op } = require('sequelize');

const API_KEY = process.env.EXCHANGE_RATE_API_KEY;
const BASE_URL = `https://v6.exchangerate-api.com/v6/${API_KEY}/latest/INR`;

const updateCurrencyRates = async () => {
  console.log('🚀 Starting currency rate update...');
  try {
    // 1. Fetch the latest rates from the API (with USD as the base)
    const response = await axios.get(BASE_URL);
    const rates = response.data.conversion_rates;

    if (!rates) {
      console.error('❌ Failed to fetch currency rates.');
      return;
    }

    // 2. Get all currencies from your database
    const currencies = await CurrencyMaster.findAll({
      where: {
        status: { [Op.ne]: 2 } // Exclude deleted currencies
      }
    });

    // 3. Update each currency with the new rate
    for (const currency of currencies) {
      const rate = rates[currency.currency_code];
      if (rate) {
        await currency.update({ currency_rate: rate });
        console.log(`✅ Updated ${currency.currency_code} to ${rate}`);
      } else {
        console.warn(`⚠️ No rate found for ${currency.currency_code}`);
      }
    }

    console.log('🎉 Currency rate update complete.');
  } catch (error) {
    console.error('❌ Error updating currency rates:', error.message);
  }
};

module.exports = { updateCurrencyRates };