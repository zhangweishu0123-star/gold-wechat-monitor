import { DurableObject } from "cloudflare:workers";

const JD_PRODUCT_SKU = "1961543816";
const JD_URL =
  `https://api.jdjygold.com/gw2/generic/jrm/h5/m/stdLatestPrice?productSku=${JD_PRODUCT_SKU}`;
const PUSHPLUS_URL = "https://www.pushplus.plus/send";

const BUY_TARGETS = [
  { zone: "buy_10", test: (p) => p > 920 && p < 940, target: 10 },
  { zone: "buy_30", test: (p) => p > 900 && p <= 920, target: 30 },
  { zone: "buy_60", test: (p) => p <= 900, target: 60 },
];

const SELL_TARGETS = [
  { zone: "sell_20", test: (p) => p >= 955 && p < 965, target: 20 },
  { zone: "sell_50", test: (p) => p >= 965 && p < 980, target: 50 },
  { zone: "sell_80", test: (p) => p >= 980 && p < 1000, target: 80 },
  { zone: "sell_100", test: (p) => p >= 1000, target: 100 },
];

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function fmt(n, digits = 2) {
  return Number(n).toFixed(digits);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function randomToken(bytes = 18) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function nowMs() {
  return Date.now();
}

function actionForPrice(price) {
  for (const rule of BUY_TARGETS) {
    if (rule.test(price)) return { side: "buy", ...rule };
  }
  if (price >= 940 && price < 955) {
    return { side: "neutral", zone: "neutral", target: 0 };
  }
  for (const rule of SELL_TARGETS) {
    if (rule.test(price)) return { side: "sell", ...rule };
  }
  return { side: "neutral", zone: "neutral", target: 0 };
}

async function fetchQuote(maxAgeMinutes) {
  const url = `${JD_URL}&_=${Date.now()}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 GoldWechatMonitor/2.0",
      Accept: "application/json,text/plain,*/*",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  if (!resp.ok) throw new Error(`京东接口HTTP ${resp.status}`);

  const payload = await resp.json();
  if (payload?.success !== true) throw new Error("京东接口 success != true");
  const result = payload?.resultData;
  if (result?.status !== "SUCCESS") throw new Error("京东接口状态异常");

  const data = result?.datas || {};
  const price = Number(data.price);
  const quoteMs = Number(data.time);
  if (!Number.isFinite(price) || !Number.isFinite(quoteMs)) {
    throw new Error("京东接口价格或时间字段异常");
  }

  const ageMin = (Date.now() - quoteMs) / 60000;
  const fresh = ageMin >= -2 && ageMin <= maxAgeMinutes;
  return { price, quoteMs, ageMin, fresh };
}

async function pushPlus(token, title, content) {
  const resp = await fetch(PUSHPLUS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      token,
      title,
      content,
      template: "html",
      channel: "wechat",
      timestamp: Date.now() + 5 * 60 * 1000,
    }),
  });
  const result = await resp.json();
  if (result?.code !== 200) {
    throw new Error(`PushPlus 未接受请求: ${JSON.stringify(result)}`);
  }
  return result;
}

function defaultState(env) {
  return {
    version: 2,
    holdingsG: num(env.START_HOLDINGS_G, 675.5714),
    cashYuan: num(env.START_CASH_YUAN, 80000),
    coreFloorG: num(env.CORE_FLOOR_G, 575),
    cashFloorYuan: num(env.CASH_FLOOR_YUAN, 25000),
    sellFeeRate: num(env.SELL_FEE_RATE, 0.004),
    maxQuoteAgeMin: num(env.MAX_QUOTE_AGE_MINUTES, 15),
    retryMinutes: num(env.RETRY_MINUTES, 30),

    buyCycleConfirmedG: 0,
    sellCycleConfirmedG: 0,
    activeDirection: "neutral",

    pending: null,
    lastDeclined: null,
    baseUrl: null,
    lastQuote: null,
    lastAction: null,
    createdAt: nowMs(),
    updatedAt: nowMs(),
  };
}

export class GoldState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async getState() {
    let state = await this.ctx.storage.get("state");
    if (!state) {
      state = defaultState(this.env);
      await this.ctx.storage.put("state", state);
    }
    return state;
  }

  async saveState(state) {
    state.updatedAt = nowMs();
    await this.ctx.storage.put("state", state);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const state = await this.getState();

    // 每次用户打开 Worker 地址，都自动记住自己的 workers.dev 域名。
    if (!state.baseUrl) {
      state.baseUrl = url.origin;
      await this.saveState(state);
    }

    if (url.pathname === "/") {
      return new Response(
        `<!doctype html>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>黄金微信盯盘</title>
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:40px auto;padding:0 20px;line-height:1.7">
          <h2>✅ 黄金微信盯盘 V2 已启动</h2>
          <p>交互确认已启用。收到微信操作提醒后，打开消息即可选择：</p>
          <p><b>✅ 已完成</b> 或 <b>❌ 未完成</b></p>
          <p>只有点击“已完成”，系统才会改变仓位，并据此计算下一笔买卖数量。</p>
          <p style="color:#666">这个页面不展示你的账户明细。</p>
        </body>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    if (url.pathname === "/action") {
      return await this.handleAction(url, state);
    }

    return new Response("Not found", { status: 404 });
  }

  async handleAction(url, state) {
    const id = url.searchParams.get("id");
    const token = url.searchParams.get("token");
    const result = url.searchParams.get("result");

    const pending = state.pending;
    if (
      !pending ||
      pending.id !== id ||
      pending.token !== token ||
      pending.status !== "pending"
    ) {
      return this.actionPage(
        "这条提醒已经过期",
        "请以最新一条微信黄金提醒为准。你的仓位没有因此改变。",
      );
    }

    if (result === "done") {
      const qty = pending.grams;

      if (pending.side === "buy") {
        const cost = qty * pending.signalPrice;
        if (state.cashYuan - cost < state.cashFloorYuan - 0.01) {
          pending.status = "rejected";
          pending.respondedAt = nowMs();
          state.pending = null;
          await this.saveState(state);
          return this.actionPage(
            "未记录这笔买入",
            "按当前现金底仓规则，完成后会低于最低现金保留额。系统没有修改仓位。",
          );
        }

        state.holdingsG = round4(state.holdingsG + qty);
        state.cashYuan = round2(state.cashYuan - cost);
        state.buyCycleConfirmedG = round4(state.buyCycleConfirmedG + qty);
      } else if (pending.side === "sell") {
        if (state.holdingsG - qty < state.coreFloorG - 0.0001) {
          pending.status = "rejected";
          pending.respondedAt = nowMs();
          state.pending = null;
          await this.saveState(state);
          return this.actionPage(
            "未记录这笔卖出",
            "这笔卖出会低于核心仓底线，系统没有修改仓位。",
          );
        }

        const net = qty * pending.signalPrice * (1 - state.sellFeeRate);
        state.holdingsG = round4(state.holdingsG - qty);
        state.cashYuan = round2(state.cashYuan + net);
        state.sellCycleConfirmedG = round4(state.sellCycleConfirmedG + qty);
      }

      pending.status = "done";
      pending.respondedAt = nowMs();
      state.lastAction = pending;
      state.pending = null;
      await this.saveState(state);

      return this.actionPage(
        "✅ 已记录完成",
        `仓位已更新为约 ${fmt(state.holdingsG, 4)}g；现金估算约 ¥${fmt(state.cashYuan, 2)}。下一次提醒会按这个新仓位重新计算。`,
      );
    }

    if (result === "skip") {
      pending.status = "declined";
      pending.respondedAt = nowMs();
      state.lastDeclined = {
        zone: pending.zone,
        at: nowMs(),
      };
      state.lastAction = pending;
      state.pending = null;
      await this.saveState(state);

      return this.actionPage(
        "❌ 已记录：未完成",
        "仓位没有变化。之后如果价格进入新的档位，系统会按你尚未执行的真实仓位重新计算；若一直停在当前档位，约30分钟后才会再次提醒。",
      );
    }

    return this.actionPage("无法识别操作", "请返回微信重新点击“已完成”或“未完成”。");
  }

  actionPage(title, message) {
    return new Response(
      `<!doctype html>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${escapeHtml(title)}</title>
      <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:40px auto;padding:0 20px;line-height:1.7">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <p style="color:#666">可以直接关闭这个页面。</p>
      </body>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  async checkPrice() {
    const state = await this.getState();

    if (!this.env.PUSHPLUS_TOKEN) {
      console.log("PUSHPLUS_TOKEN 尚未设置，跳过本轮。");
      return;
    }
    if (!state.baseUrl) {
      console.log("尚未初始化 baseUrl。请先打开一次 Worker 地址。");
      return;
    }

    const quote = await fetchQuote(state.maxQuoteAgeMin);
    state.lastQuote = quote;
    await this.saveState(state);

    if (!quote.fresh) {
      console.log(`报价滞后 ${quote.ageMin.toFixed(1)} 分钟，暂不发交易指令。`);
      return;
    }

    const signal = actionForPrice(quote.price);

    // 只有真正从买区到卖区、或卖区到买区时，才重置另一侧的阶梯。
    if (signal.side === "buy" && state.activeDirection !== "buy") {
      state.activeDirection = "buy";
      state.buyCycleConfirmedG = 0;
      state.sellCycleConfirmedG = 0;
      state.pending = null;
    } else if (signal.side === "sell" && state.activeDirection !== "sell") {
      state.activeDirection = "sell";
      state.sellCycleConfirmedG = 0;
      state.buyCycleConfirmedG = 0;
      state.pending = null;
    }

    if (signal.side === "neutral") {
      await this.saveState(state);
      return;
    }

    // 如果旧提醒仍待确认，未超时则不重复发；如果价格已经跨到别的档位，则旧提醒立即失效。
    if (state.pending?.status === "pending") {
      if (state.pending.zone === signal.zone) {
        const ageMin = (nowMs() - state.pending.createdAt) / 60000;
        if (ageMin < state.retryMinutes) {
          await this.saveState(state);
          return;
        }
      }
      state.pending.status = "expired";
      state.pending.expiredAt = nowMs();
      state.pending = null;
    }

    // 用户点“未完成”以后，同档位先冷静一段时间；跨档位则立即重新计算。
    if (state.lastDeclined?.zone === signal.zone) {
      const ageMin = (nowMs() - state.lastDeclined.at) / 60000;
      if (ageMin < state.retryMinutes) {
        await this.saveState(state);
        return;
      }
    }

    let confirmed;
    let desiredTarget;
    let rawQty;

    if (signal.side === "buy") {
      confirmed = state.buyCycleConfirmedG;
      desiredTarget = signal.target;
      rawQty = Math.max(0, desiredTarget - confirmed);

      // 买入还要受“至少保留现金底仓”约束。
      const maxByCash = Math.max(
        0,
        Math.floor(((state.cashYuan - state.cashFloorYuan) / quote.price) * 10000) / 10000,
      );
      rawQty = Math.min(rawQty, maxByCash);
    } else {
      confirmed = state.sellCycleConfirmedG;
      desiredTarget = signal.target;
      rawQty = Math.max(0, desiredTarget - confirmed);

      // 卖出不得低于核心仓。
      const maxSellable = Math.max(0, state.holdingsG - state.coreFloorG);
      rawQty = Math.min(rawQty, maxSellable);
    }

    const qty = round4(rawQty);
    if (qty < 0.0001) {
      await this.saveState(state);
      return;
    }

    const id = crypto.randomUUID();
    const token = randomToken();
    const pending = {
      id,
      token,
      status: "pending",
      side: signal.side,
      zone: signal.zone,
      grams: qty,
      desiredTarget,
      confirmedBefore: confirmed,
      signalPrice: quote.price,
      quoteMs: quote.quoteMs,
      createdAt: nowMs(),
    };
    state.pending = pending;

    const doneUrl =
      `${state.baseUrl}/action?id=${encodeURIComponent(id)}` +
      `&token=${encodeURIComponent(token)}&result=done`;
    const skipUrl =
      `${state.baseUrl}/action?id=${encodeURIComponent(id)}` +
      `&token=${encodeURIComponent(token)}&result=skip`;

    let afterHoldings;
    let afterCash;
    if (signal.side === "buy") {
      afterHoldings = state.holdingsG + qty;
      afterCash = state.cashYuan - qty * quote.price;
    } else {
      afterHoldings = state.holdingsG - qty;
      afterCash = state.cashYuan + qty * quote.price * (1 - state.sellFeeRate);
    }

    const verb = signal.side === "buy" ? "买" : "卖";
    const title = `黄金提醒｜${verb}${fmt(qty, qty % 1 === 0 ? 0 : 4)}g`;
    const content = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.75">
        <p><b>当前价：${fmt(quote.price, 2)}元/g</b></p>
        <p style="font-size:20px"><b>操作：${verb}${fmt(qty, qty % 1 === 0 ? 0 : 4)}g</b></p>
        <p>当前仓位：约 ${fmt(state.holdingsG, 4)}g<br>
        当前现金估算：约 ¥${fmt(state.cashYuan, 2)}</p>
        <p>如果执行，预计变为：<br>
        仓位约 ${fmt(afterHoldings, 4)}g<br>
        现金约 ¥${fmt(afterCash, 2)}</p>
        <hr>
        <p>
          <a href="${doneUrl}" style="display:inline-block;padding:10px 16px;margin-right:10px;text-decoration:none;border:1px solid #333;border-radius:8px">✅ 已完成</a>
          <a href="${skipUrl}" style="display:inline-block;padding:10px 16px;text-decoration:none;border:1px solid #777;border-radius:8px">❌ 未完成</a>
        </p>
        <p style="color:#666">只有点击“已完成”，系统才会改变仓位。卖出现金按0.4%手续费做估算。</p>
      </div>
    `;

    await pushPlus(this.env.PUSHPLUS_TOKEN, title, content);
    await this.saveState(state);
  }
}

export default {
  async fetch(request, env) {
    const stub = env.GOLD_STATE.getByName("main");
    return stub.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    const stub = env.GOLD_STATE.getByName("main");
    ctx.waitUntil(stub.checkPrice());
  },
};
