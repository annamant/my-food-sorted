/**
 * Look up a plated-dish photo that actually matches the recipe.
 * Hallucinated Unsplash URLs and leftover mood photos are never used.
 * If nothing relevant is found, the recipe is left without an image.
 */

const USER_AGENT = 'MyFoodSorted/1.0 (recipe photos; https://github.com/)';

const ALLOWED_IMAGE_HOSTS = new Set([
  'upload.wikimedia.org',
  'www.themealdb.com',
  'themealdb.com',
  'images.unsplash.com',
]);

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'with', 'without', 'of', 'for', 'in', 'on', 'to',
  'from', 'my', 'our', 'con', 'alla', 'al', 'la', 'le', 'di',
  'weeknight', 'easy', 'simple', 'classic', 'homemade', 'quick', 'best', 'loaded',
  'ultimate', 'perfect', 'special', 'tonight', 'style', 'inspired', 'recipe',
  'dinner', 'lunch', 'breakfast', 'brunch', 'supper', 'meal', 'dish', 'plate',
  'bowl', 'tray', 'bake', 'baked', 'roasted', 'grilled', 'fried',
  'creamy', 'crispy', 'one', 'pot', 'pan', 'skillet', 'sheet',
]);

const GENERIC = new Set([
  'rice', 'bowl', 'sauce', 'bread', 'toast', 'wrap', 'bun', 'roll',
]);

const PROTEINS = new Set([
  'chicken', 'beef', 'pork', 'lamb', 'fish', 'salmon', 'cod', 'haddock',
  'prawn', 'prawns', 'shrimp', 'tofu', 'turkey', 'duck', 'venison',
  'halloumi', 'paneer', 'chickpea', 'chickpeas', 'mushroom', 'mushrooms',
  'lentil', 'lentils', 'bean', 'beans', 'bacon', 'chorizo', 'sausage',
  'mince', 'steak', 'tuna', 'mackerel', 'trout', 'bass', 'seabass',
]);

const SYNONYMS: Record<string, string> = {
  chilli: 'chili',
  chili: 'chili',
  yoghurt: 'yogurt',
  yogurt: 'yogurt',
  aubergine: 'eggplant',
  eggplant: 'eggplant',
  mince: 'mince',
  minced: 'mince',
  chickpeas: 'chickpea',
  chickpea: 'chickpea',
  mushrooms: 'mushroom',
  mushroom: 'mushroom',
  prawns: 'prawn',
  prawn: 'prawn',
  noodles: 'noodle',
  noodle: 'noodle',
};

export function isAllowedImageUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length < 12 || url.length > 2000) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_IMAGE_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeToken(raw: string): string {
  const n = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!n) return '';
  if (SYNONYMS[n]) return SYNONYMS[n];
  if (n.endsWith('ies') && n.length > 5) return n.slice(0, -3) + 'y';
  if (n.endsWith('es') && n.length > 5) return n.slice(0, -2);
  if (n.endsWith('s') && n.length > 4) return n.slice(0, -1);
  return n;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normalizeToken)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** True when `label` (filename, meal name, wiki title) is actually this dish. */
export function isRelevantImageLabel(query: string, label: string): boolean {
  const qTokens = tokens(query);
  const lTokens = new Set(tokens(label));
  if (!qTokens.length || !lTokens.size) return false;

  const qProteins = qTokens.filter((t) => PROTEINS.has(t));
  const lProteins = [...lTokens].filter((t) => PROTEINS.has(t));
  if (qProteins.length && lProteins.length && !qProteins.some((p) => lTokens.has(p))) {
    return false;
  }

  const distinctive = qTokens
    .filter((t) => !GENERIC.has(t) && !PROTEINS.has(t) && t.length >= 4)
    .sort((a, b) => b.length - a.length);

  if (distinctive.length) {
    if (!lTokens.has(distinctive[0])) return false;
    const long = distinctive.filter((t) => t.length >= 6);
    if (long.length >= 2) {
      const hits = long.filter((t) => lTokens.has(t)).length;
      if (hits < 2) return false;
    }
  } else if (qProteins.length && !qProteins.some((p) => lTokens.has(p))) {
    return false;
  }

  return true;
}

function imageSearchQuery(title?: string, imageQuery?: string): string {
  const raw = (imageQuery || title || '').trim();
  return raw.slice(0, 80);
}

async function fetchJson(url: string, extraHeaders: Record<string, string> = {}, timeoutMs = 2800): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...extraHeaders,
      },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function pickHttpsImage(url: unknown): string | null {
  return isAllowedImageUrl(url) ? url : null;
}

async function fromCommons(query: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6',
    gsrlimit: '8',
    prop: 'imageinfo',
    iiprop: 'url|mime',
    iiurlwidth: '1200',
    format: 'json',
  });
  const data = (await fetchJson(`https://commons.wikimedia.org/w/api.php?${params}`)) as {
    query?: { pages?: Record<string, {
      title?: string;
      index?: number;
      imageinfo?: Array<{ url?: string; thumburl?: string; mime?: string }>;
    }> };
  } | null;
  const pages = Object.values(data?.query?.pages || {}).sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    const mime = info?.mime || '';
    if (!mime.startsWith('image/') || mime.includes('svg') || mime.includes('gif')) continue;
    if (!isRelevantImageLabel(query, page.title || '')) continue;
    const url = pickHttpsImage(info?.thumburl) || pickHttpsImage(info?.url);
    if (url) return url;
  }
  return null;
}

async function fromWikipedia(query: string): Promise<string | null> {
  const titleGuess = query.replace(/\s+/g, '_');
  const summary = (await fetchJson(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titleGuess)}`
  )) as { title?: string; originalimage?: { source?: string }; thumbnail?: { source?: string } } | null;

  if (summary?.title && isRelevantImageLabel(query, summary.title)) {
    const url = pickHttpsImage(summary.originalimage?.source) || pickHttpsImage(summary.thumbnail?.source);
    if (url) return url;
  }

  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: '5',
    prop: 'pageimages',
    piprop: 'thumbnail|original',
    pithumbsize: '1200',
    format: 'json',
  });
  const data = (await fetchJson(`https://en.wikipedia.org/w/api.php?${params}`)) as {
    query?: { pages?: Record<string, {
      title?: string;
      index?: number;
      original?: { source?: string };
      thumbnail?: { source?: string };
    }> };
  } | null;
  const pages = Object.values(data?.query?.pages || {}).sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
  for (const page of pages) {
    if (!isRelevantImageLabel(query, page.title || '')) continue;
    const url = pickHttpsImage(page.original?.source) || pickHttpsImage(page.thumbnail?.source);
    if (url) return url;
  }
  return null;
}

async function fromMealDb(query: string): Promise<string | null> {
  const searches = [query, ...tokens(query).filter((t) => t.length >= 5).slice(0, 2)];
  const seen = new Set<string>();
  for (const term of searches) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const data = (await fetchJson(
      `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(term)}`
    )) as { meals?: Array<{ strMeal?: string; strMealThumb?: string }> | null } | null;
    for (const meal of data?.meals || []) {
      if (!isRelevantImageLabel(query, meal.strMeal || '')) continue;
      const url = pickHttpsImage(meal.strMealThumb);
      if (url) return url;
    }
  }
  return null;
}

async function fromUnsplash(query: string, accessKey: string): Promise<string | null> {
  if (!accessKey) return null;
  const params = new URLSearchParams({
    query: `${query} food dish`,
    per_page: '5',
    orientation: 'landscape',
    content_filter: 'high',
  });
  const data = (await fetchJson(
    `https://api.unsplash.com/search/photos?${params}`,
    { Authorization: `Client-ID ${accessKey}` }
  )) as {
    results?: Array<{
      alt_description?: string | null;
      description?: string | null;
      urls?: { regular?: string; small?: string };
    }>;
  } | null;
  for (const photo of data?.results || []) {
    const label = [photo.alt_description, photo.description].filter(Boolean).join(' ');
    if (!label || !isRelevantImageLabel(query, label)) continue;
    const url = pickHttpsImage(photo.urls?.regular) || pickHttpsImage(photo.urls?.small);
    if (url) return url;
  }
  return null;
}

export async function findRecipeImage(
  title?: string,
  imageQuery?: string,
  unsplashAccessKey = ''
): Promise<string | null> {
  const query = imageSearchQuery(title, imageQuery);
  if (query.length < 3) return null;

  const searches = [fromCommons(query), fromWikipedia(query), fromMealDb(query)];
  if (unsplashAccessKey) searches.push(fromUnsplash(query, unsplashAccessKey));

  const results = await Promise.all(searches);
  return results.find((url): url is string => Boolean(url)) || null;
}

type RecipeLike = {
  title?: string;
  image_query?: string;
  image?: string;
};

type PlanLike = {
  recipes?: RecipeLike[];
  image?: string;
};

function stripHallucinatedImages<T extends RecipeLike>(recipe: T): T {
  const next = { ...recipe } as T & { image_url?: string; photo?: string };
  delete next.image;
  delete next.image_query;
  delete next.image_url;
  delete next.photo;
  return next;
}

export async function attachRecipeImages<T extends PlanLike>(
  plan: T,
  unsplashAccessKey = ''
): Promise<T> {
  const recipes = Array.isArray(plan.recipes) ? plan.recipes : [];
  const planRest = { ...plan };
  delete planRest.image;

  const withPhotos = await Promise.all(
    recipes.map(async (recipe) => {
      const title = typeof recipe.title === 'string' ? recipe.title : '';
      const imageQuery = typeof recipe.image_query === 'string' ? recipe.image_query : '';
      const cleaned = stripHallucinatedImages(recipe);
      const image = await findRecipeImage(title, imageQuery, unsplashAccessKey);
      return image ? { ...cleaned, image } : cleaned;
    })
  );

  return { ...planRest, recipes: withPhotos } as T;
}
