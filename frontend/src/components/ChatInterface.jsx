import './ChatInterface.css'

export default function ChatInterface({ messages, input, setInput, sendMessage, loading }) {
  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="chat-interface">
      <div className="chat-interface__messages">
        {messages.length === 0 && !loading && (
          <p className="chat-interface__empty">
            Ask me to plan your meals, suggest recipes, or build a shopping list!
          </p>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`chat-interface__message chat-interface__message--${msg.role === 'user' ? 'user' : 'assistant'}`}
          >
            {msg.content}
          </div>
        ))}

        {loading && (
          <div className="chat-interface__message chat-interface__message--assistant">
            <span className="chat-interface__loading">•••</span>
          </div>
        )}
      </div>

      <div className="chat-interface__input">
        <textarea
          className="chat-interface__textarea"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Tell me what you'd like to eat…"
          rows={3}
          disabled={loading}
        />
        <button
          type="button"
          onClick={sendMessage}
          disabled={loading || !input.trim()}
          className="btn btn--primary chat-interface__send"
        >
          Send
        </button>
      </div>
    </div>
  )
}
