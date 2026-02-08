export interface Env {
  OTTO_JIDELNICEK: KVNamespace;
}

interface StoredMeal {
  name: string;
  date: string;
  order: number;
  priority: number;
}

interface MealData {
  date: string;
  generatedAt: string;
  meals: StoredMeal[];
}

const KEY = "daily:meals:v2";
const MENU_URL = "http://ejdl.knyt.tl/ejidelnicek/menu/";
const IGNORED_WORDS = ["prázdniny", "oběd"];

/* ---------------------------------- */
/* JSON extraction from script block  */
/* ---------------------------------- */

function extractJidelnicekJson(html: string): any {
  const match = html.match(
    /ejidelnicek\.setJidelnicek\((\{[\s\S]*?\})\);/
  );

  if (!match) {
    throw new Error("Jídelníček JSON nebyl nalezen v HTML");
  }

  return JSON.parse(match[1]);
}

/* ---------------------------------- */
/* Meal parsing                       */
/* ---------------------------------- */

function extractMealsFromJson(
  data: any,
  ignored: Set<string>
): StoredMeal[] {
  const meals: StoredMeal[] = [];

  const stravaMap = data?.stravaMap;
  if (!stravaMap) return meals;

  for (const strava of Object.values<any>(stravaMap)) {
    const denMap = strava.denMap;
    if (!denMap) continue;

    for (const [date, day] of Object.entries<any>(denMap)) {
      const menuMap = day.menuMap;
      if (!menuMap) continue;

      for (const [orderKey, item] of Object.entries<any>(menuMap)) {
        const name = item.nazev?.trim();
        if (!name) continue;

        const lower = name.toLowerCase();
        if ([...ignored].some(w => lower.includes(w))) continue;

        meals.push({
          name,
          date,
          order: Number(orderKey),
          priority: item.isFirst ? 1 : 2
        });
      }
    }
  }

  return meals;
}

/* ---------------------------------- */
/* Merge logic                        */
/* ---------------------------------- */

function mergeMeals(
  oldMeals: StoredMeal[],
  newMeals: StoredMeal[]
): StoredMeal[] {
  const map = new Map<string, StoredMeal>();

  for (const m of oldMeals) {
    map.set(`${m.date}|${m.order}|${m.name}`, m);
  }

  for (const m of newMeals) {
    map.set(`${m.date}|${m.order}|${m.name}`, m);
  }

  return Array.from(map.values()).sort(
    (a, b) => a.date.localeCompare(b.date) || a.order - b.order
  );
}

/* ---------------------------------- */
/* Fetch + store                      */
/* ---------------------------------- */

async function readMeals(env: Env): Promise<MealData> {
  const ignored = new Set(IGNORED_WORDS);

  const existing = await env.OTTO_JIDELNICEK.get(KEY, "json") as MealData | null;

  const response = await fetch(MENU_URL);
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }

  const html = await response.text();

  const json = extractJidelnicekJson(html);
  const extracted = extractMealsFromJson(json, ignored);

  const merged = mergeMeals(
    existing?.meals ?? [],
    extracted
  );

  const payload: MealData = {
    date: new Date().toISOString().split("T")[0],
    generatedAt: new Date().toISOString(),
    meals: merged
  };

  await env.OTTO_JIDELNICEK.put(KEY, JSON.stringify(payload));

  return payload;
}

/* ---------------------------------- */
/* Worker handlers                    */
/* ---------------------------------- */

export default {

  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/") {
        const stored = await env.OTTO_JIDELNICEK.get(KEY, "json") as MealData | null;
        const payload = stored ?? await readMeals(env);

        const html = `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8"/>
<title>Jídelníček</title>
<style>
body { font-family: Arial, sans-serif; padding:20px; }
.meal { margin:4px 0; }
.date { margin-top:14px; font-weight:bold; }
</style>
</head>
<body>
<h1>Uložená jídla</h1>

${payload.meals.map(m => `
  <div class="meal">
    <strong>${m.date}</strong> [${m.order}] – ${m.name}
  </div>
`).join("")}

<small>Generováno: ${payload.generatedAt}</small>
</body>
</html>`;

        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store"
          }
        });
      }

      if (url.pathname === "/json") {
        const stored = await env.OTTO_JIDELNICEK.get(KEY, "json") as MealData | null;
        const payload = stored ?? await readMeals(env);

        return new Response(JSON.stringify(payload, null, 2), {
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }

      return new Response("Not found", { status: 404 });

    } catch (err) {
      return new Response(
        String(err),
        { status: 500 }
      );
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    await readMeals(env);
  }
};
