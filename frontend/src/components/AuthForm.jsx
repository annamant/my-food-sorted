import { useState } from 'react'
import './AuthForm.css'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function AuthForm({ loading, handleAuth, loggedInUserId, email, handleLogout }) {
  const [mode,     setMode]     = useState('login')   // 'login' | 'register'
  const [formEmail, setFormEmail] = useState(email ?? '')
  const [password, setPassword] = useState('')
  const [emailErr, setEmailErr] = useState('')

  if (loggedInUserId) {
    return (
      <div className="auth-form auth-form--loggedIn">
        <p className="auth-form__user-info">
          Signed in as{' '}
          <span className="auth-form__user-infoHighlight">{formEmail || `#${loggedInUserId}`}</span>
        </p>
        <button
          type="button"
          onClick={handleLogout}
          className="btn btn--danger"
        >
          Log out
        </button>
      </div>
    )
  }

  function onSubmit(e) {
    e.preventDefault()
    if (!EMAIL_REGEX.test(formEmail.trim())) {
      setEmailErr('Please enter a valid email address.')
      return
    }
    setEmailErr('')
    handleAuth(mode, formEmail.trim(), password)
  }

  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate>
      <h2 className="auth-form__title">
        {mode === 'login' ? 'Welcome back' : 'Create account'}
      </h2>

      <div className="auth-form__field">
        <label className="auth-form__label" htmlFor="auth-email">Email</label>
        <input
          id="auth-email"
          type="email"
          autoComplete={mode === 'login' ? 'email' : 'email'}
          value={formEmail}
          onChange={e => { setFormEmail(e.target.value); setEmailErr('') }}
          placeholder="you@example.com"
          required
        />
        {emailErr && <p className="auth-form__error">{emailErr}</p>}
      </div>

      <div className="auth-form__field">
        <label className="auth-form__label" htmlFor="auth-password">Password</label>
        <input
          id="auth-password"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="••••••••"
          required
        />
      </div>

      <button type="submit" disabled={loading} className="btn btn--primary auth-form__submit">
        {loading ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
      </button>

      <button
        type="button"
        className="btn btn--ghost auth-form__toggle"
        onClick={() => { setMode(m => m === 'login' ? 'register' : 'login'); setEmailErr('') }}
      >
        {mode === 'login' ? 'Create account' : 'Back to login'}
      </button>
    </form>
  )
}
