import type { Pool } from 'pg'

const COHORT_DEFAULT_DAYS = 30
const PEOPLE_LIMIT = 50
const FOOD_LOG_LIMIT = 40

function parseCohortDays(daysInput: unknown): number {
  const n = Number(daysInput)
  if (!Number.isFinite(n) || n < 1 || n > 365) return COHORT_DEFAULT_DAYS
  return Math.round(n)
}

function toCount(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export async function loadCohortSummary(db: Pool, daysInput?: unknown, now = new Date()) {
  const days = parseCohortDays(daysInput ?? COHORT_DEFAULT_DAYS)
  const to = now
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  const fromIso = from.toISOString()
  const toIso = to.toISOString()

  const [feedbackResult, repeatResult, recipeResult, logsResult, usersResult, peopleResult, recentLogsResult] =
    await Promise.all([
      db.query<{ feedback: string; n: string }>(
        `SELECT feedback, COUNT(*)::int AS n
         FROM meal_feedback
         WHERE recorded_at >= $1 AND recorded_at <= $2 AND feedback IS NOT NULL
         GROUP BY feedback`,
        [fromIso, toIso]
      ),
      db.query<{ repeat: string; n: string }>(
        `SELECT repeat, COUNT(*)::int AS n
         FROM meal_feedback
         WHERE recorded_at >= $1 AND recorded_at <= $2 AND repeat IS NOT NULL
         GROUP BY repeat`,
        [fromIso, toIso]
      ),
      db.query<{ recipe_title: string; would_repeat: string; no_repeat: string; liked: string; disliked: string }>(
        `SELECT
           COALESCE(NULLIF(TRIM(recipe_title), ''), 'Untitled') AS recipe_title,
           COUNT(*) FILTER (WHERE repeat = 'would_repeat')::int AS would_repeat,
           COUNT(*) FILTER (WHERE repeat = 'no_repeat')::int AS no_repeat,
           COUNT(*) FILTER (WHERE feedback = 'liked')::int AS liked,
           COUNT(*) FILTER (WHERE feedback = 'disliked')::int AS disliked
         FROM meal_feedback
         WHERE recorded_at >= $1 AND recorded_at <= $2
         GROUP BY 1`,
        [fromIso, toIso]
      ),
      db.query<{ logs: string }>(
        `SELECT COUNT(*)::int AS logs FROM food_logs
         WHERE logged_at >= $1 AND logged_at <= $2`,
        [fromIso, toIso]
      ),
      db.query<{
        registered_in_window: string
        with_feedback: string
        with_food_logs: string
        with_both: string
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM users WHERE created_at >= $1 AND created_at <= $2) AS registered_in_window,
           (SELECT COUNT(DISTINCT user_id)::int FROM meal_feedback
             WHERE recorded_at >= $1 AND recorded_at <= $2) AS with_feedback,
           (SELECT COUNT(DISTINCT user_id)::int FROM food_logs
             WHERE logged_at >= $1 AND logged_at <= $2) AS with_food_logs,
           (SELECT COUNT(*)::int FROM (
              SELECT user_id FROM meal_feedback
                WHERE recorded_at >= $1 AND recorded_at <= $2
              INTERSECT
              SELECT user_id FROM food_logs
                WHERE logged_at >= $1 AND logged_at <= $2
            ) both_users) AS with_both`,
        [fromIso, toIso]
      ),
      db.query<{
        id: string
        email: string
        created_at: Date
        food_logs: string
        food_log_days: string
        liked: string
        disliked: string
        would_repeat: string
        no_repeat: string
      }>(
        `SELECT
           u.id,
           u.email,
           u.created_at,
           COALESCE(fl.logs, 0)::int AS food_logs,
           COALESCE(fl.days, 0)::int AS food_log_days,
           COALESCE(fb.liked, 0)::int AS liked,
           COALESCE(fb.disliked, 0)::int AS disliked,
           COALESCE(fb.would_repeat, 0)::int AS would_repeat,
           COALESCE(fb.no_repeat, 0)::int AS no_repeat
         FROM users u
         LEFT JOIN (
           SELECT
             user_id,
             COUNT(*)::int AS logs,
             COUNT(DISTINCT (logged_at AT TIME ZONE 'UTC')::date)::int AS days
           FROM food_logs
           WHERE logged_at >= $1 AND logged_at <= $2
           GROUP BY user_id
         ) fl ON fl.user_id = u.id
         LEFT JOIN (
           SELECT
             user_id,
             COUNT(*) FILTER (WHERE feedback = 'liked')::int AS liked,
             COUNT(*) FILTER (WHERE feedback = 'disliked')::int AS disliked,
             COUNT(*) FILTER (WHERE repeat = 'would_repeat')::int AS would_repeat,
             COUNT(*) FILTER (WHERE repeat = 'no_repeat')::int AS no_repeat
           FROM meal_feedback
           WHERE recorded_at >= $1 AND recorded_at <= $2
           GROUP BY user_id
         ) fb ON fb.user_id = u.id
         WHERE (u.created_at >= $1 AND u.created_at <= $2)
          OR fl.user_id IS NOT NULL
          OR fb.user_id IS NOT NULL
         ORDER BY u.created_at DESC
         LIMIT ${PEOPLE_LIMIT}`,
        [fromIso, toIso]
      ),
      db.query<{
        id: string
        email: string
        logged_at: Date
        description: string
        recipe_title: string | null
      }>(
        `SELECT
           fl.id,
           u.email,
           fl.logged_at,
           fl.description,
           fl.recipe_title
         FROM food_logs fl
         JOIN users u ON u.id = fl.user_id
         WHERE fl.logged_at >= $1 AND fl.logged_at <= $2
         ORDER BY fl.logged_at DESC
         LIMIT ${FOOD_LOG_LIMIT}`,
        [fromIso, toIso]
      ),
    ])

  const feedback: Record<string, number> = {}
  for (const row of feedbackResult.rows) {
    feedback[row.feedback] = toCount(row.n)
  }
  const repeat: Record<string, number> = {}
  for (const row of repeatResult.rows) {
    repeat[row.repeat] = toCount(row.n)
  }

  const users = usersResult.rows[0]

  const recipesByRepeat = recipeResult.rows
    .map((row) => ({
      recipe_title: String(row.recipe_title),
      would_repeat: toCount(row.would_repeat),
      no_repeat: toCount(row.no_repeat),
      liked: toCount(row.liked),
      disliked: toCount(row.disliked),
      repeat_rate:
        toCount(row.would_repeat) + toCount(row.no_repeat) > 0
          ? toCount(row.would_repeat) / (toCount(row.would_repeat) + toCount(row.no_repeat))
          : null,
    }))
    .filter((r) => r.would_repeat + r.no_repeat > 0)
    .sort((a, b) => (b.repeat_rate ?? -1) - (a.repeat_rate ?? -1))
    .slice(0, 20)

  return {
    window_days: days,
    from: fromIso,
    to: toIso,
    users: {
      registered_in_window: toCount(users?.registered_in_window),
      with_feedback: toCount(users?.with_feedback),
      with_food_logs: toCount(users?.with_food_logs),
      with_both: toCount(users?.with_both),
    },
    feedback,
    repeat,
    food_logs: toCount(logsResult.rows[0]?.logs),
    recipes_by_repeat: recipesByRepeat,
    people: peopleResult.rows.map((row) => ({
      id: toCount(row.id),
      email: String(row.email || ''),
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
      food_logs: toCount(row.food_logs),
      food_log_days: toCount(row.food_log_days),
      liked: toCount(row.liked),
      disliked: toCount(row.disliked),
      would_repeat: toCount(row.would_repeat),
      no_repeat: toCount(row.no_repeat),
    })),
    recent_logs: recentLogsResult.rows.map((row) => ({
      id: toCount(row.id),
      email: String(row.email || ''),
      logged_at: row.logged_at instanceof Date ? row.logged_at.toISOString() : String(row.logged_at || ''),
      description: String(row.description || '').slice(0, 240),
      recipe_title: row.recipe_title ? String(row.recipe_title).slice(0, 200) : '',
    })),
  }
}
