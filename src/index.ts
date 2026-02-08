export interface Env {
  OTTO_JIDELNICEK: KVNamespace;
}

interface MealData {
  date: string;
  generatedAt: string;
  meals: string[];
}

const KEY = "daily:meals:v1";
const MENU_URL = "http://ejdl.knyt.tl/ejidelnicek/menu/";
const IGNORED_WORDS = ["prázdniny", "oběd"];

/**
 * Extracts meal names from HTML content using regex
 */
function extractMealsFromHtml(html: string, ignoredWords: Set<string>): Set<string> {
    const meals = new Set<string>();

    // Regex to extract content from ejidelnicek.setJidelnicek({...});
    const jsonRegex = /ejidelnicek\.setJidelnicek\((\{.*?})\);/s;
    const match = html.match(jsonRegex);

    if (match) {
        const jsonText = match[1];

        // Simple regex for meal names "nazev":"..."
        const mealRegex = /"nazev"\s*:\s*"([^"]+)"/g;
        let mealMatch;

        while ((mealMatch = mealRegex.exec(jsonText)) !== null) {
            const name = mealMatch[1].trim();

            if (!name) continue;

            const nameLower = name.toLowerCase();
            // Check if name doesn't contain any ignored words
            const hasIgnoredWord = Array.from(ignoredWords).some(word => nameLower.includes(word));

            if (!hasIgnoredWord) {
                meals.add(name);
            }
        }
    }

    return meals;
}

/**
 * Fetches meals from the menu website and stores them in KV
 */
async function readMeals(env: Env): Promise<MealData> {
    const ignoredWords = new Set(IGNORED_WORDS);

    // Read existing meals from KV
    const existingData = await env.OTTO_JIDELNICEK.get(KEY, "json") as MealData | null;
    const existingMeals = new Set<string>(existingData?.meals || []);

    // Fetch the HTML page with browser-like headers to avoid 403 errors
    const response = await fetch(MENU_URL);
    console.log(response);
    if (!response.ok) {
        throw new Error(`Failed to fetch menu: ${response.status} ${response.statusText}`);
    }
    const html = await response.text();

    // Extract new meals and merge with existing ones
    const newMeals = extractMealsFromHtml(html, ignoredWords);
    newMeals.forEach(meal => existingMeals.add(meal));

    // Prepare payload with sorted meals
    const sortedMeals = Array.from(existingMeals).sort();
    const payload: MealData = {
        date: new Date().toISOString().split('T')[0],
        generatedAt: new Date().toISOString(),
        meals: sortedMeals,
    };

    // Write to KV namespace (no expiration - data persists indefinitely)
    await env.OTTO_JIDELNICEK.put(KEY, JSON.stringify(payload));

    return payload;
}

export default {
  // HTTP endpoint
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      // GET / -> return latest stored meal list
      if (url.pathname === "/") {
        const stored = await env.OTTO_JIDELNICEK.get(KEY, "json") as MealData | null;

        if (!stored) {
          // First run fallback: generate on-demand so endpoint works immediately
          const payload = await readMeals(env);
          return Response.json(payload, {
            headers: {
              "Cache-Control": "no-store",
              "Content-Type": "application/json"
            }
          });
        }

        return Response.json(stored, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json"
          }
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Error in fetch handler:", error);
      return new Response(
        JSON.stringify({
          error: "Internal Server Error",
          message: error instanceof Error ? error.message : "Unknown error"
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
  },

  // Daily cron trigger
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      await readMeals(env);
      console.log("Successfully updated meals from scheduled trigger");
    } catch (error) {
      console.error("Error in scheduled handler:", error);
      // Re-throw to mark the cron execution as failed
      throw error;
    }
  },
};
