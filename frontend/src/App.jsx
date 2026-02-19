import { useState, useCallback } from 'react'
import ChatInterface from './components/ChatInterface'
import MealPlanDisplay from './components/MealPlanDisplay'
import ShoppingListDisplay from './components/ShoppingListDisplay'
import LandingPage from './components/LandingPage'
import './App.css'

const API = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

export default function App() {
  /* ── Auth ── */
  const [token,          setToken]          = useState(() => localStorage.getItem('token') ?? '')
  const [loggedInUserId, setLoggedInUserId] = useState(() => localStorage.getItem('userId') ?? '')
  const [authEmail,      setAuthEmail]      = useState('')
  const [authPassword,   setAuthPassword]   = useState('')

  /* ── Chat ── */
  const [messages,       setMessages]       = useState([])
  const [input,          setInput]          = useState('')
  const [chatLoading,    setChatLoading]    = useState(false)
  const [conversationId]                    = useState(() => crypto.randomUUID())

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
      const res = await fetch(`${API}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Authentication failed')

      localStorage.setItem('token',  data.token)
      localStorage.setItem('userId', String(data.userId))
      setToken(data.token)
      setLoggedInUserId(String(data.userId))
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
        body: JSON.stringify({ user_message: text, conversation_id: conversationId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Chat error')

      setMessages(prev => [...prev, { role: 'assistant', content: data.message }])
      if (data.meal_plan) setMealPlan(data.meal_plan)
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
    } finally {
      setChatLoading(false)
    }
  }, [input, chatLoading, token, messages, conversationId])

  /* ── Save plan ── */
  const savePlan = useCallback(async () => {
    if (!mealPlan || planLoading) return
    setPlanLoading(true)
    try {
      const res = await fetch(`${API}/meal-plan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(mealPlan),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      setSavedPlanId(data.meal_plan_id)
      alert(`Plan saved! ID: ${data.meal_plan_id}`)
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
      const res = await fetch(`${API}/shopping-list/${savedPlanId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Generate failed')
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
      const res = await fetch(`${API}/affiliate-link`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ retailer, search_query: 'weekly grocery shopping' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Shop failed')
      if (data.url) window.open(data.url, '_blank', 'noopener,noreferrer')
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
