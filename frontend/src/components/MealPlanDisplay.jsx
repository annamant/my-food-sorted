import './MealPlanDisplay.css'

function fmtPrice(p) {
  return (Number(p) || 0).toFixed(2)
}

function recipeKey(r, i) {
  return r.id ?? `${r.day_of_week}-${r.meal_slot}-${String(r.title).slice(0, 30)}-${i}`
}

function MealPlanDisplay({ mealPlan, savePlan, loading }) {
  if (!mealPlan?.recipes?.length) return null

  return (
    <div className="meal-plan-display">
      <h2 className="meal-plan-display__title">
        Meal Plan: {mealPlan.plan_name || 'Untitled'}
      </h2>
      <div className="meal-plan-display__list">
        {mealPlan.recipes.map((r, i) => (
          <div key={recipeKey(r, i)} className="meal-plan-display__card">
            <strong className="meal-plan-display__cardTitle">
              {r.day_of_week} – {r.meal_slot}: {r.title}
            </strong>
            <div className="meal-plan-display__cardMeta">
              £{fmtPrice(r.estimated_cost)} | {r.prep_time}min prep, {r.cook_time}min cook
            </div>
            <p className="meal-plan-display__cardInstructions">{r.instructions}</p>
            <div className="meal-plan-display__cardIngredients">
              <span className="meal-plan-display__cardIngredientsLabel">Ingredients:</span>{' '}
              {(r.ingredients || [])
                .map((ing) => `${ing.ingredient_name} (${ing.quantity} ${ing.unit})`)
                .join(', ')}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={savePlan}
        disabled={loading}
        className="btn btn--primary meal-plan-display__saveBtn"
      >
        Save Plan
      </button>
    </div>
  )
}

export default MealPlanDisplay
