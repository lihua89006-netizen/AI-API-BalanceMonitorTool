// MiniMax 余额查询服务（Node.js，无 python）
// 由「启动.bat」自动拉起，HTML 页面只需输入账号密码
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 18080;
const STATE_FILE = path.join(__dirname, 'web_state', 'minimax_web.json');
const playwright = require('playwright');

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } });
  });
}

async function queryBalance(username, password) {
  const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  const hasState = fs.existsSync(STATE_FILE);
  const context = await browser.newContext(hasState ? { storageState: STATE_FILE } : {});
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(20000);
    await page.goto('https://platform.minimaxi.com/login', { timeout: 25000 });
    await page.waitForTimeout(3500);
    const cur = page.url().toLowerCase();
    const alreadyIn = (cur.includes('platform.minimaxi.com') || cur.includes('www.minimaxi.com')) && !cur.includes('login');
    if (!alreadyIn) {
      if (!username || !password) return { success: false, message: '需要账号密码（或登录态已过期）' };
      await page.getByText('账号密码登录', { exact: false }).first().click();
      await page.waitForTimeout(1500);
      await page.locator("input[type='text']").first().fill(username);
      await page.locator("input[type='password']").first().fill(password);
      try { await page.locator("div[class*='border-gray_200']").first().click({ timeout: 3000 }); } catch (e) {}
      await page.locator("button:has-text('立即登录')").first().click();
      let ok = false;
      for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(1000);
        const c = page.url().toLowerCase();
        if ((c.includes('platform.minimaxi.com') || c.includes('www.minimaxi.com')) && !c.includes('login') && !c.includes('account.minimaxi')) { ok = true; break; }
      }
      if (!ok) return { success: false, message: '登录失败（可能需要验证码或账号密码错误）' };
      await context.storageState({ path: STATE_FILE });
    }
    let balanceData = null;
    const onResp = async (resp) => {
      if (resp.url().includes('query_balance')) {
        try { balanceData = await resp.json(); } catch (e) {}
      }
    };
    page.on('response', onResp);
    await page.goto('https://platform.minimaxi.com/console/recharge-records', { timeout: 25000 });
    await page.waitForTimeout(7000);
    page.removeListener('response', onResp);
    if (!balanceData) return { success: false, message: '未能获取余额数据' };
    const br = balanceData.base_resp || {};
    if (br.status_code !== 0) return { success: false, message: br.status_msg || '查询失败' };
    return {
      success: true,
      balance: {
        available: balanceData.available_amount,
        cash: balanceData.cash_balance,
        voucher: balanceData.voucher_balance,
        credit: balanceData.credit_balance,
        owed: balanceData.owed_amount,
      }
    };
  } catch (e) {
    return { success: false, message: '查询异常: ' + (e.message || e) };
  } finally {
    await browser.close();
  }
}

const HTML = fs.readFileSync(path.join(__dirname, 'mm_balance.html'), 'utf-8');

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
    } else if (req.method === 'POST' && req.url === '/api/balance') {
      const body = await readBody(req);
      console.log('[查询]', body.username || '(使用登录态)');
      const result = await queryBalance((body.username || '').trim(), body.password || '');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, message: String(e) }));
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('MiniMax 余额查询服务已启动: http://127.0.0.1:' + PORT);
});
