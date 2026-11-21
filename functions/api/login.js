/**
 * /api/login —— 账号密码登录，签发 HttpOnly 会话 Cookie
 *
 * 环境变量（Cloudflare → Pages → 设置 → 变量和机密）：
 *   ARVEA_USER     账号
 *   ARVEA_PASS     密码
 *   SESSION_SECRET 可选，会话签名密钥；不填则用 ARVEA_PASS 派生
 *
 * 安全要点：
 *  - 账号密码只存在于服务端，前端拿不到，仓库里也没有
 *  - 常量时间比较，抗时序侧信道
 *  - 失败按 IP 限流（每分钟 8 次），抵抗爆破
 *  - 会话是 HMAC 签名的 Cookie，HttpOnly + Secure + SameSite=Lax，前端 JS 读不到
 */
const RATE = { windowMs: 60_000, max: 8 };
const hits = new Map();
const TTL = 60 * 60 * 12;      // 12 小时

export async function onRequestGet({ env }) {
  return json({ ok: true, endpoint: "/api/login", configured: !!(env && env.ARVEA_USER && env.ARVEA_PASS) });
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "forbidden" }, 403);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!rateOk(ip)) return json({ ok: false, error: "尝试太频繁，请稍后再试" }, 429);

  const user = env.ARVEA_USER, pass = env.ARVEA_PASS;
  if (!user || !pass) return json({ ok: false, error: "服务器未配置账号" }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
  const u = String((body && body.user) || "").slice(0, 64);
  const p = String((body && body.pass) || "").slice(0, 128);

  const okUser = await safeEqual(u, user);
  const okPass = await safeEqual(p, pass);
  if (!okUser || !okPass) {
    await new Promise(r => setTimeout(r, 320));      // 失败统一延时，弱化时序差异
    return json({ ok: false, error: "账号或密码不正确" }, 401);
  }

  const token = await sign({ role: "owner", u, exp: Date.now() + TTL * 1000 }, secretOf(env));
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `tyc_sess=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL}`
    }
  });
}

export async function onRequestDelete({ request }) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "tyc_sess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    }
  });
}

/* ---------- 辅助 ---------- */
export function secretOf(env) {
  return String(env.SESSION_SECRET || (env.ARVEA_PASS || "") + "|arvea-session-v1");
}

export async function sign(payload, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return body + "." + b64urlBytes(new Uint8Array(sig));
}

export async function verifyToken(token, secret) {
  if (!token || token.indexOf(".") < 0) return null;
  const [body, sig] = token.split(".");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, u8FromB64url(sig), enc.encode(body));
  } catch { return null; }
  if (!ok) return null;
  try {
    const data = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    if (!data || !data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

export async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a)), bb = enc.encode(String(b));
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

export function b64url(str) {
  return b64urlBytes(new TextEncoder().encode(str));
}
export function b64urlBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function u8FromB64url(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export function sameOrigin(request) {
  const origin = request.headers.get("Origin") || request.headers.get("Referer") || "";
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

export function rateOk(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE.windowMs) { hits.set(ip, { start: now, n: 1 }); return true; }
  rec.n++;
  return rec.n <= RATE.max;
}

export function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra }
  });
}
