'use client'

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

type Profile = {
  id: string
  username: string
  display_name: string
  bio: string
  avatar_url: string | null
}

type Conversation = {
  id: string
  kind: 'direct' | 'group'
  name: string | null
  avatar_url: string | null
  updated_at: string
  other?: Profile
}

type Message = {
  id: string
  conversation_id: string
  sender_id: string
  kind: string
  body: string
  created_at: string
  edited_at: string | null
  deleted_at: string | null
}

type Reaction = {
  message_id: string
  user_id: string
  reaction: string
}

const reactions = ['❤️', '👍', '😂', '😮', '😢', '🔥']

export default function Home() {
  const [sessionReady, setSessionReady] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Profile[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [active, setActive] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [reactionRows, setReactionRows] = useState<Reaction[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dark, setDark] = useState(true)
  const endRef = useRef<HTMLDivElement | null>(null)

  const reactionMap = useMemo(() => {
    const map = new Map<string, Reaction[]>()
    for (const row of reactionRows) {
      const list = map.get(row.message_id) || []
      list.push(row)
      map.set(row.message_id, list)
    }
    return map
  }, [reactionRows])

  useEffect(() => {
    let mounted = true
    const boot = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        const { data, error: authError } = await supabase.auth.signInAnonymously()
        if (authError) {
          if (mounted) setError(authError.message)
          return
        }
        if (mounted) setUserId(data.user?.id || null)
      } else if (mounted) {
        setUserId(session.user.id)
      }
      if (mounted) setSessionReady(true)
    }
    boot()
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      if (mounted) setUserId(next?.user.id || null)
    })
    return () => {
      mounted = false
      listener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!userId) return
    let mounted = true
    const load = async () => {
      setLoading(true)
      const { data, error: profileError } = await supabase.from('m2_profiles').select('*').eq('id', userId).maybeSingle()
      if (!mounted) return
      if (profileError) setError(profileError.message)
      setProfile(data)
      setLoading(false)
      if (data) loadConversations()
    }
    load()
    return () => { mounted = false }
  }, [userId])

  useEffect(() => {
    if (!active) return
    loadMessages(active.id)
    const channel = supabase
      .channel(`conversation:${active.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'm2_messages', filter: `conversation_id=eq.${active.id}` }, payload => {
        const message = payload.new as Message
        setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'm2_reactions' }, payload => {
        const next = payload.new as Reaction
        const old = payload.old as Reaction
        setReactionRows(current => {
          if (payload.eventType === 'INSERT') return current.some(item => item.message_id === next.message_id && item.user_id === next.user_id && item.reaction === next.reaction) ? current : [...current, next]
          if (payload.eventType === 'DELETE') return current.filter(item => !(item.message_id === old.message_id && item.user_id === old.user_id && item.reaction === old.reaction))
          return current
        })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [active])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  const loadConversations = async () => {
    if (!userId) return
    const { data: memberships, error: memberError } = await supabase.from('m2_conversation_members').select('conversation_id').eq('user_id', userId)
    if (memberError) {
      setError(memberError.message)
      return
    }
    const ids = (memberships || []).map(row => row.conversation_id)
    if (!ids.length) {
      setConversations([])
      return
    }
    const { data, error: conversationError } = await supabase.from('m2_conversations').select('*').in('id', ids).order('updated_at', { ascending: false })
    if (conversationError) {
      setError(conversationError.message)
      return
    }
    const directIds = (data || []).filter(row => row.kind === 'direct').map(row => row.user_a === userId ? row.user_b : row.user_a).filter(Boolean) as string[]
    let people: Profile[] = []
    if (directIds.length) {
      const { data: profiles } = await supabase.from('m2_profiles').select('*').in('id', directIds)
      people = profiles || []
    }
    setConversations((data || []).map(row => ({ ...row, other: people.find(person => person.id === (row.user_a === userId ? row.user_b : row.user_a)) })))
  }

  const loadMessages = async (conversationId: string) => {
    const [{ data: messageData, error: messageError }, { data: reactionData }] = await Promise.all([
      supabase.from('m2_messages').select('*').eq('conversation_id', conversationId).is('deleted_at', null).order('created_at', { ascending: true }),
      supabase.from('m2_reactions').select('*').in('message_id', (messages || []).map(message => message.id))
    ])
    if (messageError) {
      setError(messageError.message)
      return
    }
    const loadedMessages = messageData || []
    setMessages(loadedMessages)
    if (loadedMessages.length) {
      const { data } = await supabase.from('m2_reactions').select('*').in('message_id', loadedMessages.map(message => message.id))
      setReactionRows(data || [])
    } else {
      setReactionRows(reactionData || [])
    }
  }

  const createProfile = async (event: FormEvent) => {
    event.preventDefault()
    if (!userId) return
    const normalized = username.trim().toLowerCase()
    if (!/^[a-z0-9_]{3,32}$/.test(normalized)) {
      setError('Username must be 3-32 characters using letters, numbers, or underscores.')
      return
    }
    setBusy(true)
    setError('')
    const { data, error: profileError } = await supabase.from('m2_profiles').insert({ id: userId, username: normalized, display_name: displayName.trim() || normalized }).select().single()
    setBusy(false)
    if (profileError) {
      setError(profileError.code === '23505' ? 'That username is already taken.' : profileError.message)
      return
    }
    setProfile(data)
  }

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const term = search.trim().toLowerCase()
      if (!term || !profile) {
        setResults([])
        return
      }
      const { data, error: searchError } = await supabase.from('m2_profiles').select('*').ilike('username', `%${term}%`).neq('id', profile.id).limit(12)
      if (searchError) setError(searchError.message)
      setResults(data || [])
    }, 160)
    return () => window.clearTimeout(timer)
  }, [search, profile])

  const startConversation = async (person: Profile) => {
    setBusy(true)
    setError('')
    const { data, error: conversationError } = await supabase.rpc('m2_get_or_create_direct', { target_user: person.id })
    setBusy(false)
    if (conversationError || !data) {
      setError(conversationError?.message || 'Unable to start conversation.')
      return
    }
    const conversation: Conversation = { id: data, kind: 'direct', name: null, avatar_url: person.avatar_url, updated_at: new Date().toISOString(), other: person }
    setActive(conversation)
    setSearch('')
    setResults([])
    await loadConversations()
  }

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault()
    if (!active || !userId || !draft.trim()) return
    const body = draft.trim()
    const optimistic: Message = { id: `optimistic-${crypto.randomUUID()}`, conversation_id: active.id, sender_id: userId, kind: 'text', body, created_at: new Date().toISOString(), edited_at: null, deleted_at: null }
    setMessages(current => [...current, optimistic])
    setDraft('')
    const { data, error: sendError } = await supabase.from('m2_messages').insert({ conversation_id: active.id, sender_id: userId, kind: 'text', body }).select().single()
    if (sendError) {
      setMessages(current => current.filter(message => message.id !== optimistic.id))
      setError(sendError.message)
      setDraft(body)
      return
    }
    setMessages(current => current.map(message => message.id === optimistic.id ? data : message))
  }

  const toggleReaction = async (messageId: string, reaction: string) => {
    if (!userId) return
    const exists = reactionRows.some(row => row.message_id === messageId && row.user_id === userId && row.reaction === reaction)
    if (exists) {
      setReactionRows(current => current.filter(row => !(row.message_id === messageId && row.user_id === userId && row.reaction === reaction)))
      const { error: reactionError } = await supabase.from('m2_reactions').delete().eq('message_id', messageId).eq('user_id', userId).eq('reaction', reaction)
      if (reactionError) setError(reactionError.message)
      return
    }
    const optimistic = { message_id: messageId, user_id: userId, reaction }
    setReactionRows(current => [...current, optimistic])
    const { error: reactionError } = await supabase.from('m2_reactions').insert(optimistic)
    if (reactionError) {
      setReactionRows(current => current.filter(row => !(row.message_id === messageId && row.user_id === userId && row.reaction === reaction)))
      setError(reactionError.message)
    }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setUserId(null)
    setProfile(null)
    setActive(null)
    setConversations([])
  }

  if (!sessionReady || loading) return <main className="splash">Messagner</main>

  if (!profile) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="brand-mark">M</div>
          <h1>Welcome to Messagner</h1>
          <p>Your private messenger, rebuilt cleanly from the ground up.</p>
          <form onSubmit={createProfile} className="stack">
            <label>Username<input value={username} onChange={event => setUsername(event.target.value)} placeholder="your_username" autoCapitalize="none" autoCorrect="off" /></label>
            <label>Display name<input value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Your name" /></label>
            <button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
          </form>
          {error && <div className="error">{error}</div>}
        </section>
      </main>
    )
  }

  return (
    <main className={dark ? 'app dark' : 'app'}>
      <aside className="sidebar">
        <header className="sidebar-head">
          <div className="identity"><div className="avatar">{profile.display_name.slice(0, 1).toUpperCase()}</div><div><strong>{profile.display_name}</strong><span>@{profile.username}</span></div></div>
          <div className="head-actions"><button onClick={() => setDark(value => !value)} aria-label="Toggle theme">{dark ? '☀' : '☾'}</button><button onClick={signOut} aria-label="Sign out">↪</button></div>
        </header>
        <div className="search-wrap"><span>⌕</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search username" /></div>
        {results.length > 0 && <div className="search-results">{results.map(person => <button key={person.id} className="person" onClick={() => startConversation(person)} disabled={busy}><div className="avatar small">{person.display_name.slice(0, 1).toUpperCase()}</div><div><strong>{person.display_name || person.username}</strong><span>@{person.username}</span></div></button>)}</div>}
        <div className="section-title">Messages</div>
        <div className="conversation-list">
          {conversations.map(conversation => <button key={conversation.id} className={`conversation ${active?.id === conversation.id ? 'selected' : ''}`} onClick={() => setActive(conversation)}><div className="avatar">{(conversation.other?.display_name || conversation.name || '?').slice(0, 1).toUpperCase()}</div><div className="conversation-copy"><strong>{conversation.other?.display_name || conversation.name || 'Group'}</strong><span>{conversation.other ? `@${conversation.other.username}` : 'Group conversation'}</span></div></button>)}
          {!conversations.length && <div className="empty-list">Search for a username to start your first conversation.</div>}
        </div>
      </aside>

      <section className="chat">
        {!active ? (
          <div className="empty-chat"><div className="brand-mark large">M</div><h2>Messagner</h2><p>Search for someone and start a private conversation.</p></div>
        ) : (
          <>
            <header className="chat-head"><div className="identity"><div className="avatar">{(active.other?.display_name || active.name || '?').slice(0, 1).toUpperCase()}</div><div><strong>{active.other?.display_name || active.name || 'Group'}</strong><span>{active.other ? `@${active.other.username}` : 'Group conversation'}</span></div></div><button className="chat-more">•••</button></header>
            <div className="messages">
              {messages.map(message => {
                const mine = message.sender_id === userId
                const messageReactions = reactionMap.get(message.id) || []
                return <div key={message.id} className={`message-row ${mine ? 'mine' : ''}`}><div className="message"><div className="bubble">{message.body}</div><div className="message-meta"><time>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>{messageReactions.length > 0 && <div className="reaction-strip">{messageReactions.map((row, index) => <span key={`${row.user_id}-${row.reaction}-${index}`}>{row.reaction}</span>)}</div>}<div className="reaction-menu">{reactions.map(reaction => <button key={reaction} onClick={() => toggleReaction(message.id, reaction)}>{reaction}</button>)}</div></div></div>
              })}
              <div ref={endRef} />
            </div>
            <form className="composer" onSubmit={sendMessage}><button type="button" className="icon-button">＋</button><input value={draft} onChange={event => setDraft(event.target.value)} placeholder="Message" /><button type="submit" className="send" disabled={!draft.trim()}>➤</button></form>
          </>
        )}
      </section>
      {error && <button className="error-toast" onClick={() => setError('')}>{error} ×</button>}
    </main>
  )
}
