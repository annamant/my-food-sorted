import { useMemo } from 'react'
import './ShoppingListDisplay.css'

function fmtPrice(p) {
  return (Number(p) || 0).toFixed(2)
}

function ShoppingListDisplay({
  shoppingList,
  savedPlanId,
  generateShoppingList,
  shopNow,
  retailer,
  setRetailer,
  loading,
}) {
  const grouped = useMemo(() => {
    if (!shoppingList?.items?.length) return null
    return shoppingList.items.reduce((acc, item) => {
      const cat = item.category || 'Other'
      if (!acc[cat]) acc[cat] = []
      acc[cat].push(item)
      return acc
    }, {})
  }, [shoppingList])

  return (
    <div className="shopping-list-display">
      <h2 className="shopping-list-display__title">
        Shopping List {savedPlanId ? `(Plan #${savedPlanId})` : ''}
      </h2>

      <button
        type="button"
        onClick={generateShoppingList}
        disabled={loading}
        className="btn btn--primary shopping-list-display__generateBtn"
      >
        {shoppingList ? 'Regenerate List' : 'Generate Shopping List'}
      </button>

      {grouped && Object.entries(grouped).map(([cat, items]) => (
        <div key={cat} className="shopping-list-display__category">
          <h3 className="shopping-list-display__categoryTitle">{cat}</h3>
          <ul className="shopping-list-display__list">
            {items.map((item, i) => (
              <li key={item.id ?? i} className="shopping-list-display__item">
                {item.ingredient_name} — {item.quantity} {item.unit}
                {item.estimated_price != null && (
                  <span className="shopping-list-display__price">
                    {' '}(£{fmtPrice(item.estimated_price)})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {shoppingList && (
        <div className="shopping-list-display__retailer">
          <h3 className="shopping-list-display__retailerTitle">Shop at</h3>
          <div className="shopping-list-display__retailerButtons">
            {['tesco', 'sainsburys'].map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRetailer(r)}
                className={`btn ${retailer === r ? 'btn--retailerActive' : 'btn--retailer'}`}
              >
                {r === 'tesco' ? 'Tesco' : "Sainsbury's"}
              </button>
            ))}
            <button
              type="button"
              onClick={shopNow}
              disabled={loading}
              className="btn btn--success"
            >
              Shop now →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default ShoppingListDisplay
