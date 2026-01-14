import fetch from 'node-fetch';
import fs from 'fs';

const API_URL = 'https://www.sheinindia.in/api/category/sverse-5939-37961';
const DATA_FILE = './product-data.json';
const CHECK_INTERVAL = 60000; // Check every 60 seconds

// ⚠️ CONFIGURE THESE - Get from @BotFather and @userinfobot on Telegram
const TELEGRAM_BOT_TOKEN = '8437563456:AAGZrNRQz60ttxEQNLWgswvAoG5CA-aPSps';
const TELEGRAM_CHAT_ID = '6085597629';

// Browser-like headers
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.sheinindia.in/',
  'Origin': 'https://www.sheinindia.in'
};

// Send message via Telegram
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
    console.log('📤 Telegram notification sent');
  } catch (error) {
    console.error('Failed to send Telegram message:', error.message);
  }
}

// Load previous product data
function loadPreviousData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (error) {
    console.log('No previous data found, starting fresh.');
  }
  return { products: [], count: 0 };
}

// Save current product data
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Extract product info from API response
function extractProducts(apiResponse) {
  const products = apiResponse?.products || [];
  return products.map(p => ({
    id: p.code,
    name: p.name || 'Unknown',
    brand: p.fnlColorVariantData?.brandName || 'Shein',
    price: p.price?.displayformattedValue || p.price?.formattedValue || 'N/A',
    offerPrice: p.offerPrice?.displayformattedValue || null,
    discount: p.offerPrice?.value && p.price?.value 
      ? Math.round((1 - p.offerPrice.value / p.price.value) * 100) + '%' 
      : null,
    category: p.brickNameText || 'N/A',
    segment: p.segmentNameText || 'N/A',
    vertical: p.verticalNameText || 'N/A',
    coupon: p.couponStatus || null,
    url: p.url ? `https://www.sheinindia.in${p.url}` : null,
    image: p.images?.[0]?.url || p.fnlColorVariantData?.outfitPictureURL
  }));
}

// Compare products and find changes
function compareProducts(oldProducts, newProducts) {
  const oldIds = new Set(oldProducts.map(p => p.id));
  const newIds = new Set(newProducts.map(p => p.id));
  return {
    added: newProducts.filter(p => !oldIds.has(p.id)),
    removed: oldProducts.filter(p => !newIds.has(p.id))
  };
}

// Fetch product stock details
async function fetchProductStock(productCode) {
  try {
    const url = `https://www.sheinindia.in/api/p/${productCode}`;
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    const data = await response.json();
    
    // Get stock from all size variants
    const variants = data?.baseOptions?.[0]?.options?.[0]?.variantOptions || 
                     data?.variantOptions || [];
    const baseStock = data?.baseOptions?.[0]?.options?.[0]?.stock;
    
    // Check if any variant is in stock
    let totalStock = 0;
    let inStockSizes = [];
    
    if (variants.length > 0) {
      for (const v of variants) {
        if (v.stock?.stockLevel > 0) {
          totalStock += v.stock.stockLevel;
          inStockSizes.push(`${v.size || v.code}: ${v.stock.stockLevel}`);
        }
      }
    } else if (baseStock) {
      totalStock = baseStock.stockLevel || 0;
    }
    
    return {
      inStock: totalStock > 0,
      totalStock,
      sizes: inStockSizes
    };
  } catch (error) {
    console.error(`Error fetching stock for ${productCode}:`, error.message);
    return null;
  }
}

// Check stock for new products and filter (parallel batching)
async function filterInStockProducts(products) {
  const inStockProducts = [];
  const batchSize = 10; // Check 10 products at a time in parallel
  
  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, i + batchSize);
    console.log(`  Checking stock: ${i + 1}-${Math.min(i + batchSize, products.length)} of ${products.length}...`);
    
    const results = await Promise.all(
      batch.map(async (p) => {
        const stockInfo = await fetchProductStock(p.id);
        if (stockInfo && stockInfo.inStock) {
          p.stock = stockInfo.totalStock;
          p.stockSizes = stockInfo.sizes;
          return p;
        }
        return null;
      })
    );
    
    inStockProducts.push(...results.filter(p => p !== null));
    
    // Small delay between batches to avoid rate limiting
    if (i + batchSize < products.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  return inStockProducts;
}


async function fetchProducts(page = 0) {
  try {
    const response = await fetch(`${API_URL}?currentPage=${page}`, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('Error fetching products:', error.message);
    return null;
  }
}

// Fetch all products across all pages
async function fetchAllProducts() {
  const firstPage = await fetchProducts(0);
  if (!firstPage) return null;

  const totalPages = firstPage.pagination?.totalPages || 1;
  const totalCount = firstPage.pagination?.totalResults || 0;
  let allProducts = extractProducts(firstPage);

  for (let page = 1; page < totalPages; page++) {
    console.log(`  Fetching page ${page + 1}/${totalPages}...`);
    const pageData = await fetchProducts(page);
    if (pageData) allProducts = allProducts.concat(extractProducts(pageData));
    await new Promise(r => setTimeout(r, 500));
  }

  return { products: allProducts, totalCount };
}

// Main monitoring function
async function checkForChanges() {
  console.log(`\n[${new Date().toLocaleTimeString()}] Checking for product changes...`);
  
  const result = await fetchAllProducts();
  if (!result) {
    console.log('Failed to fetch data, will retry next interval.');
    return;
  }

  const { products: newProducts, totalCount: newCount } = result;
  const previousData = loadPreviousData();
  const { count: oldCount, products: oldProducts } = previousData;

  console.log(`Current: ${newCount} | Previous: ${oldCount}`);

  if (oldCount === 0) {
    console.log(`Initial scan complete. Tracking ${newCount} products.`);
    saveData({ products: newProducts, count: newCount, lastChecked: new Date().toISOString() });
    await sendTelegram(`🔍 <b>Product Monitor Started</b>\n\nTracking ${newCount} products from SHEINVERSE`);
    return;
  }

  if (newCount !== oldCount || newProducts.length !== oldProducts.length) {
    const { added } = compareProducts(oldProducts, newProducts);
    
    if (added.length === 0) {
      console.log('No new products added.');
      saveData({ products: newProducts, count: newCount, lastChecked: new Date().toISOString() });
      return;
    }

    // Filter only in-stock products
    console.log(`\nChecking stock for ${added.length} new products...`);
    const inStockAdded = await filterInStockProducts(added);
    
    if (inStockAdded.length === 0) {
      console.log('All new products are out of stock.');
      saveData({ products: newProducts, count: newCount, lastChecked: new Date().toISOString() });
      return;
    }

    let message = `🛍️ <b>New Products Added!</b>\n\n`;
    message += `📊 ${oldCount} → ${newCount} | In Stock: ${inStockAdded.length}/${added.length}\n\n`;
    message += `✅ <b>NEW IN-STOCK PRODUCTS (${inStockAdded.length}):</b>\n\n`;
    
    inStockAdded.forEach((p, i) => {
      message += `<b>${i + 1}. ${p.name}</b>\n`;
      message += `   💰 ${p.offerPrice || p.price}`;
      if (p.discount) message += ` (${p.discount} OFF)`;
      message += `\n`;
      message += `   📦 ${p.category} | ${p.segment}\n`;
      if (p.stock) message += `   🏷️ Stock: ${p.stock} units\n`;
      if (p.coupon) message += `   🎟️ ${p.coupon}\n`;
      if (p.url) message += `   🔗 <a href="${p.url}">View Product</a>\n`;
      message += `\n`;
    });

    console.log(message);

    // Split into multiple messages if too long (Telegram limit is 4096 chars)
    if (message.length > 4000) {
      const chunks = [];
      let current = `🛍️ <b>New Products Added!</b>\n📊 ${oldCount} → ${newCount} | In Stock: ${inStockAdded.length}\n\n`;
      
      for (let i = 0; i < inStockAdded.length; i++) {
        const p = inStockAdded[i];
        let productMsg = `<b>${i + 1}. ${p.name}</b>\n`;
        productMsg += `💰 ${p.offerPrice || p.price}`;
        if (p.discount) productMsg += ` (${p.discount} OFF)`;
        productMsg += `\n📦 ${p.category} | ${p.segment}\n`;
        if (p.stock) productMsg += `🏷️ Stock: ${p.stock}\n`;
        if (p.coupon) productMsg += `🎟️ ${p.coupon}\n`;
        if (p.url) productMsg += `🔗 <a href="${p.url}">View</a>\n`;
        productMsg += `\n`;
        
        if (current.length + productMsg.length > 4000) {
          chunks.push(current);
          current = productMsg;
        } else {
          current += productMsg;
        }
      }
      if (current) chunks.push(current);
      
      for (const chunk of chunks) {
        await sendTelegram(chunk);
        await new Promise(r => setTimeout(r, 500));
      }
    } else {
      await sendTelegram(message);
    }

    saveData({ 
      products: newProducts, 
      count: newCount, 
      lastChecked: new Date().toISOString(),
      lastChange: { added: inStockAdded, timestamp: new Date().toISOString() }
    });
  } else {
    console.log('No changes detected.');
  }
}

// Validate config
if (TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE' || TELEGRAM_CHAT_ID === 'YOUR_CHAT_ID_HERE') {
  console.log(`
⚠️  SETUP REQUIRED:

1. Create a bot: Message @BotFather on Telegram, send /newbot
2. Copy the token and replace TELEGRAM_BOT_TOKEN in index.js
3. Get your chat ID: Message @userinfobot on Telegram
4. Replace TELEGRAM_CHAT_ID in index.js
5. Start the bot by messaging it first!

Then run: npm start
`);
  process.exit(1);
}

// Start monitoring
console.log('🔍 Product Monitor Started (Telegram)');
console.log(`Check interval: ${CHECK_INTERVAL / 1000} seconds\n`);

await checkForChanges();
setInterval(checkForChanges, CHECK_INTERVAL);

console.log('\nPress Ctrl+C to stop monitoring.');
