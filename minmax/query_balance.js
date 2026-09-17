#!/usr/bin/env node
// ============================================================================
// 「模拟浏览器登录」通用单次查询脚本
// ----------------------------------------------------------------------------
// 用途：被 Rust 命令 browser_login_query（src-tauri/src/network.rs）按需 spawn，
//       用系统 Edge 无头浏览器完成一次「登录 → 跳余额页 → 抓余额接口」查询。
//       进程查完即退出，结果以 JSON 输出到 stdout（与 Rust BrowserLoginResult 契约一致）。
//
// 用法：node query_balance.js '<参数JSON>'
// 参数 JSON（camelCase，与 Rust BrowserLoginParams 一致）：
//   {
//     "loginUrl":      "https://platform.minimaxi.com/login",        // 必填
//     "balanceUrl":    "https://platform.minimaxi.com/console/recharge-records", // 必填
//     "balanceKeyword":"query_balance",                              // 可选，余额接口关键字
//     "username":      "15227230829",                                // 可选（已有登录态可空）
//     "password":      "***"                                         // 可选
//   }
//
// stdout JSON（BrowserLoginResult）：
//   { "success": true, "message": "ok", "extra": "现金 12.34 · 赠金 0.00",
//     "balance": { "available": 12.34, "cash": 12.34, "voucher": 0, "credit": null, "owed": null } }
// 失败也输出 JSON（success:false），stderr 只放调试日志（Rust 侧失败时截取展示）。
//
// 登录态持久化：web_state/browser_<域名>.json（Playwright storageState）；
//   host 为 platform.minimaxi.com 时兼容复用旧 minimax_web.json（server.js 时代的文件）。
//   ⚠️ 状态目录默认在脚本同级 web_state/（独立运行脚本时仍然可用），
//   但 App 调用时会通过 AQM_WEB_STATE_DIR 指到应用配置目录（%APPDATA%\com.apibalance.monitor[.dev]\web_state\）——
//   那里是真实账号会话 cookie，**绝不能放在项目目录里**（2026-09/15 迁移）。
// ============================================================================

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// 登录态目录：AQM_WEB_STATE_DIR 优先（App 注入）；独立运行时回退脚本同级 web_state/
const STATE_DIR = (process.env.AQM_WEB_STATE_DIR && String(process.env.AQM_WEB_STATE_DIR).trim())
  ? path.resolve(String(process.env.AQM_WEB_STATE_DIR).trim())
  : path.join(__dirname, 'web_state');
const LOGIN_POLL_MS = 60 * 1000; // 登录等待上限（与 server.js 一致）
const RESPONSE_WAIT_MS = 20 * 1000; // 跳余额页后等接口响应上限

// ---------- 日志：调试信息只走 stderr，stdout 只留给结果 JSON ----------
function log(...args) {
  console.error('[query_balance]', ...args);
}

function statePathFor(host) {
  const safe = String(host).replace(/[^a-zA-Z0-9.-]/g, '_');
  return path.join(STATE_DIR, `browser_${safe}.json`);
}

// 兼容旧文件：platform.minimaxi.com 的登录态曾存为 minimax_web.json
function legacyStateCandidates(host) {
  const list = [];
  const b = statePathFor(host);
  if (fs.existsSync(b)) list.push(b);
  if (host === 'platform.minimaxi.com') {
    const legacy = path.join(STATE_DIR, 'minimax_web.json');
    if (fs.existsSync(legacy)) list.push(legacy);
  }
  return list;
}

function pickStateFile(host) {
  const cands = legacyStateCandidates(host);
  return cands.length ? cands[0] : null;
}

// ---------- 金额字段解析（递归，兼容多级嵌套如 data.balance.available） ----------
const KEY_ALIASES = {
  available: ['available_amount', 'available_balance', 'remain_balance', 'remaining_balance',
              'usable_balance', 'usable', 'account_balance', 'balance'],
  cash: ['cash_balance', 'cash_amount', 'cash'],
  voucher: ['voucher_balance', 'voucher', 'gift_balance', 'gift', 'bonus_balance', 'bonus'],
  credit: ['credit_balance', 'credit_limit', 'credit'],
  owed: ['owed_amount', 'owed', 'arrears_balance', 'arrears', 'debt_amount', 'debt'],
};

function pickFirstNum(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
}

// 返回 { available, cash, voucher, credit, owed }，各字段为 number|null 或 undefined（未发现）
function extractBalance(obj, out = {}) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [field, aliases] of Object.entries(KEY_ALIASES)) {
    if (out[field] !== undefined) continue; // 已取到，优先保留更早（更浅/更靠前）的值
    for (const alias of aliases) {
      if (out[field] !== undefined) break;
      // 精确 key 匹配（忽略大小写与下划线差异）
      const direct = obj[alias] ?? obj[alias.replace(/_/g, '')];
      if (direct !== undefined && direct !== null) {
        const n = pickFirstNum(direct);
        if (n !== null) out[field] = n;
      }
      // 大小写不敏感兜底
      if (out[field] === undefined && typeof obj === 'object') {
        const k = Object.keys(obj).find(
          (key) => key.toLowerCase().replace(/[^a-z0-9]/g, '') === alias.toLowerCase().replace(/[^a-z0-9]/g, '')
        );
        if (k !== undefined) {
          const n = pickFirstNum(obj[k]);
          if (n !== null) out[field] = n;
        }
      }
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') extractBalance(v, out);
  }
  return out;
}

function buildExtra(bal) {
  const parts = [];
  if (bal.cash !== undefined && bal.cash !== null) parts.push(`现金 ${bal.cash}`);
  if (bal.voucher !== undefined && bal.voucher !== null) parts.push(`赠金 ${bal.voucher}`);
  if (bal.credit !== undefined && bal.credit !== null) parts.push(`信用 ${bal.credit}`);
  if (bal.owed !== undefined && bal.owed !== null && bal.owed > 0) parts.push(`欠费 ${bal.owed}`);
  return parts.join(' · ');
}

// ---------- 余额接口监听与捕获 ----------
function defaultKeywordRe() {
  // 常见余额接口关键字（宽松匹配：query_balance / get_balance / account_balance / wallet / quota / balance）
  return /(query_balance|get_balance|account_balance|available_amount|balance_info|wallet|quota|\/balance)/i;
}

function keywordMatcher(keyword) {
  if (keyword && keyword.trim()) {
    const k = keyword.trim();
    return (url) => url.toLowerCase().includes(k.toLowerCase());
  }
  const re = defaultKeywordRe();
  return (url) => re.test(url);
}

// 监听页面响应，抓到匹配关键字的 JSON 即返回解析结果（只取第一个匹配）
function attachBalanceListener(page, matcher) {
  let captured = null;
  const onResp = async (resp) => {
    if (captured) return;
    if (!matcher(resp.url())) return;
    const ct = (resp.headers()['content-type'] || '');
    if (!ct.includes('json') && !resp.url().toLowerCase().includes('.json')) return;
    try {
      const body = await resp.json();
      if (body !== null && typeof body === 'object') {
        const bal = extractBalance(body);
        if (Object.keys(bal).length > 0) captured = { body, bal };
      }
    } catch (_e) { /* 非 JSON 响应，忽略 */ }
  };
  page.on('response', onResp);
  return {
    waitFor(pred = () => captured) {
      return new Promise((resolve) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
          if (captured || Date.now() - t0 > RESPONSE_WAIT_MS) {
            clearInterval(timer);
            resolve(captured);
          }
        }, 150);
      });
    },
    detach() { page.removeListener('response', onResp); },
  };
}

// ---------- 登录 ----------
function isLoginUrl(url) {
  return /login|signin|sign-in|auth/i.test(url);
}

// MiniMax 特判：复用 server.js 验证过的流程（2026-08 实测通过）
async function loginMinimax(page, username, password) {
  const cur = page.url().toLowerCase();
  const alreadyIn =
    (cur.includes('platform.minimaxi.com') || cur.includes('www.minimaxi.com')) &&
    !cur.includes('login') && !cur.includes('account.minimaxi');
  if (alreadyIn) return { ok: true };
  if (!username || !password) return { ok: false, message: '需要账号密码（或登录态已过期）' };

  // 切换到「账号密码登录」tab（若存在）
  try {
    await page.getByText('账号密码登录', { exact: false }).first().click({ timeout: 5000 });
  } catch (_e) { /* 无该 tab 则跳过 */ }
  await page.waitForTimeout(1200);

  try {
    await page.locator("input[type='text']").first().fill(username, { timeout: 8000 });
    await page.locator("input[type='password']").first().fill(password, { timeout: 8000 });
  } catch (e) {
    return { ok: false, message: '找不到账号/密码输入框: ' + (e.message || e) };
  }
  // 勾选协议（新版 unified-login：自定义勾选框 + 「我已阅读并同意 服务条款 和 隐私政策」文案行；
  // 不勾选则点「立即登录」无任何反应——诊断实测）。
  // 注意：文案 <p> 内含 <a> 子元素（服务条款/隐私政策链接），不能用 children.length===0 匹配；
  // 勾选框是协议行容器内第一个 <button>（圆形 border-gray_200）。
  try {
    const agreed = await page.evaluate(() => {
      const p = [...document.querySelectorAll('p')].find(
        (e) => /我已阅读并同意/.test(e.textContent || '') && (e.textContent || '').length < 60
      );
      if (!p || !p.parentElement) return false;
      const row = p.parentElement;
      const box = row.querySelector('button') || row.firstElementChild;
      (box || row).click();
      return true;
    });
    if (agreed) {
      await page.waitForTimeout(500); // 等 React 状态更新勾选样式
    } else {
      // 老页面（platform.minimaxi.com/login）兜底：原 server.js 选择器
      try { await page.locator("div[class*='border-gray_200']").first().click({ timeout: 2000 }); } catch (_e) {}
    }
  } catch (_e) {}
  try {
    await page.locator("button:has-text('立即登录')").first().click({ timeout: 5000 });
  } catch (e) {
    return { ok: false, message: '找不到登录按钮: ' + (e.message || e) };
  }
  // —— 登录成功判定：监听登录 API 响应 code===0（无头环境下 SPA 前端跳转不可靠，
  //    实测 oauth2/login 返回 code:0 即登录成功，但页面 URL 不会离开 unified-login；
  //    响应后前端 JS 写入会话 cookie，可直接手动跳余额页）——
  let loginResult = null;
  const onLoginResp = async (resp) => {
    if (loginResult) return;
    if (resp.request().method() !== 'POST') return;
    if (!/oauth2\/login|auth\/login|\/login/i.test(resp.url())) return;
    try {
      const body = await resp.json();
      if (body && typeof body === 'object' && 'code' in body) {
        loginResult = body.code === 0
          ? { ok: true }
          : { ok: false, message: '登录失败: ' + (body.msg || body.message || `错误码 ${body.code}`) };
      }
    } catch (_e) { /* 非 JSON 响应，忽略 */ }
  };
  page.on('response', onLoginResp);
  // 轮询：响应判定 + URL 跳转兜底 + 错误文本探测
  const t0 = Date.now();
  while (Date.now() - t0 < LOGIN_POLL_MS) {
    if (loginResult) {
      page.removeListener('response', onLoginResp);
      if (loginResult.ok) await page.waitForTimeout(1500); // 等前端写完会话 cookie
      return loginResult;
    }
    await page.waitForTimeout(800);
    const c = page.url().toLowerCase();
    if ((c.includes('platform.minimaxi.com') || c.includes('www.minimaxi.com')) &&
        !c.includes('login') && !c.includes('account.minimaxi')) {
      page.removeListener('response', onLoginResp);
      return { ok: true };
    }
    // 登录失败常出现错误提示（注意：不能用裸「验证码」匹配——页面常有
    // 「邮箱验证码登录」「获取验证码」等 tab/按钮文本，会误判为登录失败）
    const errText = await page.locator('text=/账号或密码错误|密码错误|密码不正确|验证码错误|验证码不正确|验证码已失效|登录过于频繁|操作频繁|账号被锁定|次数过多|手机号或密码/').first().textContent({ timeout: 500 }).catch(() => null);
    if (errText) {
      page.removeListener('response', onLoginResp);
      return { ok: false, message: '登录失败: ' + errText.trim().slice(0, 120) };
    }
  }
  page.removeListener('response', onLoginResp);
  return { ok: false, message: '登录超时（60 秒），可能需要验证码' };
}

// 通用启发式登录：常见账号密码框 + 常见登录按钮，轮询 URL 离开 login 页
async function loginGeneric(page, username, password) {
  if (!username || !password) return { ok: false, message: '需要账号密码（或登录态已过期）' };
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
  } catch (_e) {}

  const isLoginNow = () => isLoginUrl(page.url());
  if (!isLoginNow()) return { ok: true }; // 已在站内

  const userSel = [
    "input[type='text']", "input[type='email']", "input[type='tel']",
    "input[name*='user' i]", "input[name*='account' i]", "input[name*='email' i]",
    "input[name*='phone' i]", "input[name*='mobile' i]",
    "input[placeholder*='账号' i]", "input[placeholder*='邮箱' i]", "input[placeholder*='手机' i]",
  ].join(', ');
  const userInput = page.locator(userSel).first();
  const passInput = page.locator("input[type='password']").first();
  try {
    await userInput.fill(username, { timeout: 8000 });
  } catch (e) {
    return { ok: false, message: '找不到账号输入框: ' + (e.message || e) };
  }
  try {
    await passInput.fill(password, { timeout: 8000 });
  } catch (e) {
    return { ok: false, message: '找不到密码输入框: ' + (e.message || e) };
  }

  const btnSel = [
    "button[type='submit']", "input[type='submit']",
    "button:has-text('立即登录')", "button:has-text('登 录')", "button:has-text('登录')",
    "button:has-text('Sign in')", "button:has-text('Log in')", "button:has-text('Sign In')",
  ].join(', ');
  const btn = page.locator(btnSel).first();
  try {
    await btn.click({ timeout: 5000 });
  } catch (e) {
    // 按钮兜底：回车提交
    await passInput.press('Enter').catch(() => {});
  }

  const t0 = Date.now();
  while (Date.now() - t0 < LOGIN_POLL_MS) {
    await page.waitForTimeout(1000);
    if (!isLoginUrl(page.url())) return { ok: true };
    const errText = await page.locator('text=/账号或密码错误|密码错误|密码不正确|验证码错误|验证码不正确|验证码已失效|登录过于频繁|操作频繁|账号被锁定|次数过多|手机号或密码/').first().textContent({ timeout: 500 }).catch(() => null);
    if (errText) return { ok: false, message: '登录失败: ' + errText.trim().slice(0, 120) };
  }
  return { ok: false, message: '登录超时（60 秒），可能需要验证码' };
}

// ---------- 主流程 ----------
async function main() {
  let raw = process.argv[2];
  // 兼容传文件路径（文件内容为参数 JSON；命令行直接拼 JSON 时引号转义麻烦）
  if (raw && !raw.startsWith('{') && fs.existsSync(raw) && fs.statSync(raw).isFile()) {
    raw = fs.readFileSync(raw, 'utf8');
  }
  if (!raw) {
    console.log(JSON.stringify({ success: false, message: '缺少参数（需传入 JSON 或参数文件路径）' }));
    return;
  }
  let p;
  try {
    p = JSON.parse(raw);
  } catch (e) {
    console.log(JSON.stringify({ success: false, message: '参数不是合法 JSON: ' + e.message }));
    return;
  }
  const loginUrl = String(p.loginUrl || '').trim();
  const balanceUrl = String(p.balanceUrl || '').trim();
  const username = String(p.username || '').trim();
  const password = String(p.password || '');
  const keyword = String(p.balanceKeyword || '').trim();

  if (!loginUrl || !balanceUrl) {
    console.log(JSON.stringify({ success: false, message: '缺少 loginUrl 或 balanceUrl 参数' }));
    return;
  }
  let host = '';
  try { host = new URL(loginUrl).host; } catch (_e) { /* 下面统一报错 */ }
  if (!host) {
    console.log(JSON.stringify({ success: false, message: 'loginUrl 不是合法 URL: ' + loginUrl }));
    return;
  }
  log('站点', host, '| 登录态文件', pickStateFile(host) || '(无，将全新登录)');

  let browser = null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const stateFile = pickStateFile(host);
    const context = await browser.newContext(stateFile ? { storageState: stateFile } : {});
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const matcher = keywordMatcher(keyword);

    // 1) 有登录态时先试直接抓余额（若成功则无需登录）
    if (stateFile) {
      log('尝试复用登录态直连余额页');
      const l1 = attachBalanceListener(page, matcher);
      let navErr = null;
      try {
        await page.goto(balanceUrl, { timeout: 25000, waitUntil: 'domcontentloaded' });
      } catch (e) {
        // goto 超时/失败不等于登录态失效（可能是网络慢），继续等接口，稍后按页面状态判定
        navErr = e;
        log('直连加载异常（继续等待接口）:', (e.message || e).toString().split('\n')[0]);
      }
      const got = await l1.waitFor();
      l1.detach();
      if (got) {
        const bal = got.bal;
        log('复用登录态成功', JSON.stringify(bal));
        console.log(JSON.stringify({
          success: true,
          message: 'ok',
          extra: buildExtra(bal),
          balance: bal,
        }));
        return;
      }
      // 没抓到接口：按当前页面状态区分「登录态失效」与「页面无接口」
      const curUrl = page.url();
      if (isLoginUrl(curUrl)) {
        log('登录态失效（当前在登录页），重新登录');
      } else if (navErr && !curUrl) {
        log('登录态失效（导航失败且无页面地址），重新登录');
      } else {
        log('页面已加载但未捕获到余额接口，当前地址:', curUrl);
        console.log(JSON.stringify({
          success: false,
          message: `未能获取余额数据（页面已加载但未捕获到含「${keyword || '自动'}」的接口；余额页: ${balanceUrl}）`,
        }));
        return;
      }
    }

    // 2) 打开登录页登录
    await page.goto(loginUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500); // 等 SPA 首屏/重定向

    const isMiniMax = host.includes('minimaxi.com');
    const loginRes = isMiniMax
      ? await loginMinimax(page, username, password)
      : await loginGeneric(page, username, password);
    if (!loginRes.ok) {
      console.log(JSON.stringify({ success: false, message: loginRes.message || '登录失败' }));
      return;
    }
    log('登录成功，持久化登录态');
    fs.mkdirSync(STATE_DIR, { recursive: true });
    await context.storageState({ path: statePathFor(host) });

    // 3) 跳余额页抓接口
    const l2 = attachBalanceListener(page, matcher);
    try {
      await page.goto(balanceUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
    } catch (e) {
      log('余额页加载异常（继续等待接口）:', e.message || e);
    }
    const got2 = await l2.waitFor();
    l2.detach();

    if (!got2) {
      console.log(JSON.stringify({
        success: false,
        message: `未能获取余额数据（余额页: ${balanceUrl}，接口关键字: ${keyword || '自动'}）`,
      }));
      return;
    }
    const bal = got2.bal;
    const available = bal.available !== undefined ? bal.available : (bal.cash !== undefined ? bal.cash : null);
    log('查询成功', JSON.stringify(bal));
    console.log(JSON.stringify({
      success: true,
      message: 'ok',
      extra: buildExtra(bal),
      balance: {
        available: available !== undefined ? available : null,
        cash: bal.cash !== undefined ? bal.cash : null,
        voucher: bal.voucher !== undefined ? bal.voucher : null,
        credit: bal.credit !== undefined ? bal.credit : null,
        owed: bal.owed !== undefined ? bal.owed : null,
      },
    }));
  } catch (e) {
    log('异常:', e.message || e);
    console.log(JSON.stringify({ success: false, message: '查询异常: ' + (e.message || e) }));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main();
