export interface Env {
  OTTO_JIDELNICEK: KVNamespace;
}

const KEY = "daily:lines:v1";

function mulberry32(seed: number) {
  // Small deterministic PRNG
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function todayUtcKeyDate(d = new Date()) {
  // YYYY-MM-DD in UTC
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function generate30Lines(dateKey: string) {
  // Seed based on date so it’s stable for that day (still “random”)
  let seed = 0;
  for (let i = 0; i < dateKey.length; i++) seed = (seed * 31 + dateKey.charCodeAt(i)) >>> 0;

  const rand = mulberry32(seed);
  const lines: string[] = [];

  for (let i = 0; i < 30; i++) {
    const n = Math.floor(rand() * 1_000_000_000);
    const token = n.toString(16).padStart(8, "0");
    lines.push(`line ${String(i + 1).padStart(2, "0")}: ${dateKey} :: ${token}`);
  }

  return lines;
}

async function storeDailyLines(env: Env, dateKey: string) {
  const lines = generate30Lines(dateKey);
  const payload = {
    date: dateKey,
    generatedAt: new Date().toISOString(),
    lines,
  };

  // Store JSON + keep it for e.g. 14 days (optional)
  await env.OTTO_JIDELNICEK.put(KEY, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 14 });
  return payload;
}

export default {
  // HTTP endpoint
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /lines -> return latest stored list
    if (url.pathname === "/lines") {
      const stored = await env.OTTO_JIDELNICEK.get(KEY, "json") as
        | { date: string; generatedAt: string; lines: string[] }
        | null;

      if (!stored) {
        // First run fallback: generate on-demand so endpoint works immediately
        const dateKey = todayUtcKeyDate();
        const payload = await storeDailyLines(env, dateKey);
        return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
      }

      return Response.json(stored, { headers: { "Cache-Control": "no-store" } });
    }

    return new Response("Not Found", { status: 404 });
  },

  // Daily cron trigger
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const dateKey = todayUtcKeyDate();
    await storeDailyLines(env, dateKey);
  },
};
