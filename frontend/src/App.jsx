import { useState, useCallback } from 'react'
import ChatInterface from './components/ChatInterface'
import MealPlanDisplay from './components/MealPlanDisplay'
import ShoppingListDisplay from './components/ShoppingListDisplay'
import LandingPage from './components/LandingPage'
import './App.css'

const API = import.meta.env.VITE_API_URL ?? ''

export default function App() {
  /* ── Auth ── */
  const [token,          setToken]          = useState(() => localStorage.getItem('token') ?? '')
  const [loggedInUserId, setLoggedInUserId] = useState(() => localStorage.getItem('userId') ?? '')
  const [authEmail,      setAuthEmail]      = useState('')
  const [authPassword,   setAuthPassword]   = useState('')

  /* ── Chat ── */
  const [messages,    setMessages]    = useState([])
  const [input,       setInput]       = useState('')
  const [chatLoading, setChatLoading] = useState(false)

  /* ── Meal plan ── */
  const [mealPlan,    setMealPlan]    = useState(null)
  const [savedPlanId, setSavedPlanId] = useState(null)
  const [planLoading, setPlanLoading] = useState(false)

  /* ── Shopping list ── */
  const [shoppingList, setShoppingList] = useState(null)
  const [retailer,     setRetailer]     = useState('tesco')
  const [shopLoading,  setShopLoading]  = useState(false)

  const loading = chatLoading || planLoading || shopLoading

  /* ── Auth ── */
  const handleAuth = useCallback(async (endpoint, email, password) => {
    try {
      const res = await fetch(`${API}/auth/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Authentication failed')

      localStorage.setItem('token',  data.access_token)
      localStorage.setItem('userId', String(data.user_id))
      setToken(data.access_token)
      setLoggedInUserId(String(data.user_id))
      setAuthEmail('')
      setAuthPassword('')
    } catch (err) {
      alert(err.message)
    }
  }, [])

  const handleLogout = useCallback(() => {
    localStorage.removeItem('token')
    localStorage.removeItem('userId')
    setToken('')
    setLoggedInUserId('')
    setMessages([])
    setMealPlan(null)
    setSavedPlanId(null)
    setShoppingList(null)
  }, [])

  /* ── Chat ── */
  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || chatLoading) return

    const userMsg = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setChatLoading(true)

    try {
      const res = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: text, conversation_history: messages }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Chat error')

      setMessages(prev => [...prev, { role: 'assistant', content: data.response }])
      if (data.meal_plan) setMealPlan(data.meal_plan)
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
    } finally {
      setChatLoading(false)
    }
  }, [input, chatLoading, token, messages])

  /* ── Save plan ── */
  const savePlan = useCallback(async () => {
    if (!mealPlan || planLoading) return
    setPlanLoading(true)
    try {
      const res = await fetch(`${API}/meal-plans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(mealPlan),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Save failed')
      setSavedPlanId(data.id)
      alert(`Plan saved! ID: ${data.id}`)
    } catch (err) {
      alert(err.message)
    } finally {
      setPlanLoading(false)
    }
  }, [mealPlan, planLoading, token])

  /* ── Shopping list ── */
  const generateShoppingList = useCallback(async () => {
    if (!savedPlanId || shopLoading) return
    setShopLoading(true)
    try {
      const res = await fetch(`${API}/shopping-lists/generate/${savedPlanId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Generate failed')
      setShoppingList(data)
    } catch (err) {
      alert(err.message)
    } finally {
      setShopLoading(false)
    }
  }, [savedPlanId, shopLoading, token])

  const shopNow = useCallback(async () => {
    if (!shoppingList || shopLoading) return
    setShopLoading(true)
    try {
      const res = await fetch(`${API}/shopping-lists/${shoppingList.id}/shop?retailer=${retailer}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Shop failed')
      if (data.shopping_url) window.open(data.shopping_url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      alert(err.message)
    } finally {
      setShopLoading(false)
    }
  }, [shoppingList, shopLoading, retailer, token])

  /* ── Render ── */
  if (!token) {
    return (
      <LandingPage
        loading={loading}
        handleAuth={handleAuth}
      />
    )
  }

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__headerInner">
          <div className="app__logo">
            <span className="app__logoTop">my food.</span>
            <span className="app__logoBottom">SORTED.</span>
          </div>
          <div className="app__headerRight">
            <span className="app__userId">#{loggedInUserId}</span>
            <button
              type="button"
              onClick={handleLogout}
              className="btn btn--ghost app__logoutBtn"
            >
              Log out
            </button>
          </div>
        </div>
      </header>

      <main className="app__main">
        <section className="app__chat">
          <ChatInterface
            messages={messages}
            input={input}
            setInput={setInput}
            sendMessage={sendMessage}
            loading={chatLoading}
          />
        </section>

        {mealPlan && (
          <section className="app__panel">
            <MealPlanDisplay
              mealPlan={mealPlan}
              savePlan={savePlan}
              loading={planLoading}
            />
          </section>
        )}

        {savedPlanId && (
          <section className="app__panel">
            <ShoppingListDisplay
              shoppingList={shoppingList}
              savedPlanId={savedPlanId}
              generateShoppingList={generateShoppingList}
              shopNow={shopNow}
              retailer={retailer}
              setRetailer={setRetailer}
              loading={shopLoading}
            />
          </section>
        )}
      </main>
    </div>
  )
}
