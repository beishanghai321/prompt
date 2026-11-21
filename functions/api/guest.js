/**
 * /api/guest —— 访客入口：发一张 30 天的访客会话（无需密码）
 *
 * 访客权限：
 *  - 基础功能全部可用（导入、解析、分块、计时、编辑、历史）
 *  - AI 智能整理：全生命周期只能用 1 次（标记在签名 Cookie 里，刷新无效）
 *  - 语音跟读：不开放（前端禁入）
 */
import { sign, secretOf, json, sameOrigin, readCookie, verifyToken } from "./login.js";

const TTL = 60 * 60 * 24 * 30;   // 30 天

export async function onRequestGet({ env }) {
  return json({ ok: true, endpoint: "/api/guest", open: !!(env && env.ARVEA_PASS), kv: !!(env && env.GUEST_KV) });
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "forbidden" }, 403);
  if (!env || !env.ARVEA_PASS) return json({ ok: false, error: "服务器未配置账号" }, 503);

  // 已有访客身份就沿用（保留 AI 已用次数，避免刷新重置）
  const old = readCookie(request, "tyc_sess");
  if (old) {
    const data = await verifyToken(old, secretOf(env));
    if (data && data.role === "guest" && data.exp > Date.now()) {
      return json({ ok: true, role: "guest", aiLeft: data.aiUsed ? 0 : 1 });
    }
  }

  const payload = {
    role: "guest",
    gid: crypto.randomUUID(),
    aiUsed: false,
    exp: Date.now() + TTL * 1000
  };
  const token = await sign(payload, secretOf(env));
  return new Response(JSON.stringify({ ok: true, role: "guest", aiLeft: 1 }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `tyc_sess=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL}`
    }
  });
}
