import { useRef } from 'react'
import AuthForm from './AuthForm'
import './LandingPage.css'

function LogoMark({ size = 'md' }) {
  return (
    <div className={`logomark logomark--${size}`} aria-label="my food. SORTED.">
      <span className="logomark__top">my food.</span>
      <span className="logomark__bottom">SORTED.</span>
    </div>
  )
}

const FEATURES = [
  {
    emoji: '💬',
    title: 'Chat your cravings',
    body: 'Just tell us what you fancy — budget, servings, dietary needs. No forms, no filters.',
  },
  {
    emoji: '🗓',
    title: "Get a full week's plan",
    body: 'Recipes with prep times, cook times, and estimated costs. Proper planning, zero effort.',
  },
  {
    emoji: '🛒',
    title: 'Shop in one tap',
    body: "Your list auto-builds from your plan and links straight to Tesco or Sainsbury's.",
  },
]

export default function LandingPage({ loading, handleAuth }) {
  const authRef = useRef(null)

  function scrollToAuth() {
    authRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="landing">

      <nav className="landing__nav">
        <LogoMark size="sm" />
        <button type="button" className="btn landing__navCta" onClick={scrollToAuth}>
          Get started free
        </button>
      </nav>

      <section className="landing__hero">
        <div className="landing__heroText">
          <p className="landing__eyebrow">AI meal planning ✦ no stress</p>
          <h1 className="landing__headline">
            Your meals,<br />
            <em className="landing__headlineLime">actually sorted.</em>
          </h1>
          <p className="landing__sub">
            Describe what you want to eat. Get a full week of recipes,
            a shopping list, and a direct link to your supermarket — in seconds.
          </p>
          <div className="landing__heroCtas">
            <button type="button" className="btn landing__ctaPrimary" onClick={scrollToAuth}>
              Start for free →
            </button>
            <span className="landing__ctaNote">No card needed · takes 30 sec</span>
          </div>
        </div>

        <div className="landing__mockWrap" aria-hidden="true">
          <div className="landing__mock">
            <div className="landing__mockHeader">
              <LogoMark size="xs" />
              <span className="landing__mockHeaderLabel">my food. SORTED.</span>
            </div>
            <div className="landing__mockBubble landing__mockBubble--user">
              Plan 5 dinners for 2, budget £50, no fish 🙏
            </div>
            <div className="landing__mockBubble landing__mockBubble--ai">
              <span className="landing__mockAiLabel">✦ Sorted your week</span>
              <ul className="landing__mockMeals">
                <li>🍝 Mon — Pasta Primavera  <span className="landing__mockCost">£7.20</span></li>
                <li>🍗 Tue — Lemon Herb Chicken  <span className="landing__mockCost">£9.40</span></li>
                <li>🥗 Wed — Halloumi &amp; Veg  <span className="landing__mockCost">£8.10</span></li>
                <li>🍛 Thu — Veggie Curry  <span className="landing__mockCost">£6.80</span></li>
                <li>🍔 Fri — Smash Burgers  <span className="landing__mockCost">£11.50</span></li>
              </ul>
              <p className="landing__mockTotal">Total est. £43.00 · under budget 🎉</p>
            </div>
            <div className="landing__mockActions">
              <span className="landing__mockAction">Save plan</span>
              <span className="landing__mockAction landing__mockAction--lime">Build list + shop →</span>
            </div>
          </div>
        </div>
      </section>

      <section className="landing__features">
        <p className="landing__featuresSup">How it works</p>
        <h2 className="landing__featuresTitle">Three steps. Zero faff.</h2>
        <div className="landing__featureGrid">
          {FEATURES.map((f, i) => (
            <div key={f.title} className="landing__featureCard">
              <span className="landing__featureStep">0{i + 1}</span>
              <span className="landing__featureEmoji">{f.emoji}</span>
              <h3 className="landing__featureTitle">{f.title}</h3>
              <p className="landing__featureBody">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing__authSection" ref={authRef}>
        <div className="landing__authInner">
          <h2 className="landing__authTitle">Ready to sort your meals?</h2>
          <p className="landing__authSub">Free to use. Takes 30 seconds to sign up.</p>
          <AuthForm
            loading={loading}
            handleAuth={handleAuth}
            loggedInUserId={null}
            email=""
            handleLogout={() => {}}
          />
        </div>
      </section>

      <footer className="landing__footer">
        <LogoMark size="sm" />
        <p className="landing__footerNote">
          © {new Date().getFullYear()} my food. SORTED. — eat well, stress less.
        </p>
      </footer>

    </div>
  )
}
