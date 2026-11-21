/**
 * /api/session —— 查询当前浏览器是否已登录，并给出身份与访客剩余 AI 次数
 * 返回：{ ok:true, authed:boolean, role:"owner"|"guest"|null, aiLeft:number }
 *
 * 同时导出：
 *  - currentSession(request, env)
 *  - requireAuth(request, env)        未登录 → 401
 *  - aiGuard(request, env)            AI 接口守卫：访客只能成功调用一次（服务端记账，刷新无效）
 */
import { verifyToken, readCookie, secretOf, json, sameOrigin, sign } from "./login.js";

const GUEST_COOKIE_TTL = 60 * 60 * 24 * 30;

export async function onRequestGet({ request, env }) {
  const data = await currentSession(request, env);
  if (!data) return json({ ok: true, authed: false, role: null, aiLeft: 0, kv: !!(env && env.GUEST_KV) });
  return json({
    ok: true,
    authed: true,
    role: data.role || "owner",
    aiLeft: (data.role === "guest") ? ((data.aiUsed || await kvUsed(env, request, data)) ? 0 : 1) : 999,
    kv: !!(env && env.GUEST_KV)
  });
}

async function kvUsed(env, request, data){
  const kv = env && env.GUEST_KV;
  if (!kv) return false;
  try{
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const byIp = await kv.get("ai:ip:" + ip);
    const byGid = data && data.gid ? await kv.get("ai:gid:" + data.gid) : null;
    return !!(byIp || byGid);
  }catch(_){ return false; }
}

/** 校验会话；有效返回 payload，否则 null */
export async function currentSession(request, env) {
  if (!env || !env.ARVEA_PASS) return null;
  const token = readCookie(request, "tyc_sess");
  if (!token) return null;
  return await verifyToken(token, secretOf(env));
}

/** 基础守卫：未登录返回 401 响应，已登录返回 null */
export async function requireAuth(request, env) {
  if (!sameOrigin(request)) return json({ ok: false, error: "forbidden" }, 403);
  const data = await currentSession(request, env);
  if (!data) return json({ ok: false, error: "请先登录" }, 401);
  return null;
}

/**
 * AI 守卫：
 *  - 未登录 → { deny: 401 }
 *  - 房主   → {}                  不限次数
 *  - 访客   → 第一次放行并立刻把 aiUsed=true 写回签名 Cookie（{ cookie } 需要附到响应里）
 *             之后一律 { deny: 403 }
 */
export async function aiGuard(request, env) {
  if (!sameOrigin(request)) return { deny: json({ ok: false, error: "forbidden" }, 403) };
  const data = await currentSession(request, env);
  if (!data) return { deny: json({ ok: false, error: "请先登录" }, 401) };

  if (data.role !== "guest") return {};

  const now = Date.now();
  const LEASE = 120 * 1000;          // 一次「AI 智能整理」包含多次后端调用，2 分钟租期
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const kv = env.GUEST_KV;

  let kvTs = 0;
  if (kv) {
    try { kvTs = Number(await kv.get("ai:ip:" + ip)) || 0; } catch (_) { kvTs = 0; }
  }

  // 已经用过：租期内（同一次整理的多步调用）放行，租期外一律拒绝
  if (data.aiUsed) {
    if ((data.leaseUntil && now < data.leaseUntil) || (kvTs && now - kvTs < LEASE)) return {};
    return { deny: json({ ok: false, error: "访客的 AI 智能整理已用完，登录后可不限次数" }, 403) };
  }

  // 首次使用：IP 已被别人用过且在租期外 → 拒绝（清 Cookie 也绕不过）
  if (kvTs && now - kvTs >= LEASE) {
    return { deny: json({ ok: false, error: "这台设备/网络的访客体验次数已用完，登录后可不限次数" }, 403) };
  }
  if (kv && !kvTs) {
    try { await kv.put("ai:ip:" + ip, String(now), { expirationTtl: 86400 }); } catch (_) { /* KV 异常则退回 Cookie 记账 */ }
  }

  const next = { ...data, aiUsed: true, leaseUntil: now + LEASE, exp: data.exp };
  const token = await sign(next, secretOf(env));
  return {
    cookie: `tyc_sess=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${GUEST_COOKIE_TTL}`
  };
}
