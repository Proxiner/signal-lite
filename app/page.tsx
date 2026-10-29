"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

type Profile = { id: string; username: string; display_name: string; bio: string; avatar_url: string | null; mood: string };
type Conversation = { id: string; user_a: string; user_b: string; theme: string; updated_at: string; other?: Profile; last?: Message };
type Message = { id: string; conversation_id: string; sender_id: string; kind: string; body: string; reply_to: string | null; edited_at: string | null; deleted_at: string | null; created_at: string };
type Reaction = { message_id: string; user_id: string; reaction: string };

const moods = ["available", "busy", "working", "gaming", "sleeping", "offline"];
const themes = ["default", "midnight", "ocean", "sunset"];
const emojis = ["❤️", "😂", "👍", "🔥", "😮", "😢"];

export default function Home() {
  const [session, setSession] = useState<any>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [draft, setDraft] = useState("");
  const [replying, setReplying] = useState<Message | null>(null);
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<Profile[]>([]);
  const [typing, setTyping] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState({ readReceipts: true, typingIndicators: true, linkPreviews: true, messagePreviews: true, notificationSound: true, muted: false, textSize: 16, appearance: "dark" });
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [online, setOnline] = useState<Record<string, boolean>>({});
  const channelRef = useRef<any>(null);
  const typingTimer = useRef<any>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const recordTimer = useRef<any>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => { if (mounted) setSession(data.session); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => { mounted = false; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!session?.user) return;
    loadProfile(session.user.id);
    loadConversations(session.user.id);
    const presence = supabase.channel("presence:messagner", { config: { presence: { key: session.user.id } } });
    presence.on("presence", { event: "sync" }, () => {
      const state = presence.presenceState();
      const next: Record<string, boolean> = {};
      Object.keys(state).forEach(id => { next[id] = true; });
      setOnline(next);
    }).subscribe(async status => { if (status === "SUBSCRIBED") await presence.track({ online_at: new Date().toISOString() }); });
    return () => { supabase.removeChannel(presence); };
  }, [session?.user?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, typing]);

  async function loadProfile(id: string) {
    const { data } = await supabase.from("profiles").select("*").eq("id", id).single();
    if (data) setProfile(data);
  }

  async function loadConversations(id: string) {
    const { data } = await supabase.from("conversations").select("*").or(`user_a.eq.${id},user_b.eq.${id}`).order("updated_at", { ascending: false });
    const rows = data || [];
    const hydrated = await Promise.all(rows.map(async row => {
      const otherId = row.user_a === id ? row.user_b : row.user_a;
      const [{ data: other }, { data: lastRows }] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", otherId).single(),
        supabase.from("messages").select("*").eq("conversation_id", row.id).order("created_at", { ascending: false }).limit(1)
      ]);
      return { ...row, other, last: lastRows?.[0] };
    }));
    setConversations(hydrated);
  }

  async function openConversation(conversation: Conversation) {
    setActive(conversation);
    const [{ data }, { data: rx }] = await Promise.all([
      supabase.from("messages").select("*").eq("conversation_id", conversation.id).order("created_at", { ascending: true }),
      supabase.from("message_reactions").select("message_id,user_id,reaction").in("message_id", [])
    ]);
    setMessages(data || []);
    setReactions(rx || []);
    if (channelRef.current) supabase.removeChannel(channelRef.current);
    const channel = supabase.channel(`conversation:${conversation.id}`);
    channel.on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversation.id}` }, payload => {
      const message = payload.new as Message;
      setMessages(prev => prev.some(item => item.id === message.id) ? prev : [...prev, message]);
      setConversations(prev => prev.map(item => item.id === conversation.id ? { ...item, last: message, updated_at: message.created_at } : item));
    });
    channel.on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages", filter: `conversation_id=eq.${conversation.id}` }, payload => {
      setMessages(prev => prev.map(item => item.id === payload.new.id ? payload.new as Message : item));
    });
    channel.on("postgres_changes", { event: "INSERT", schema: "public", table: "message_reactions" }, payload => setReactions(prev => [...prev.filter(item => !(item.message_id === payload.new.message_id && item.user_id === payload.new.user_id)), payload.new as Reaction]));
    channel.on("postgres_changes", { event: "DELETE", schema: "public", table: "message_reactions" }, payload => setReactions(prev => prev.filter(item => item.message_id !== payload.old.message_id || item.user_id !== payload.old.user_id)));
    channel.on("broadcast", { event: "typing" }, ({ payload }) => { if (payload.userId !== session?.user?.id) { setTyping(payload.active); if (payload.active) { clearTimeout(typingTimer.current); typingTimer.current = setTimeout(() => setTyping(false), 2500); } } });
    channel.on("broadcast", { event: "theme" }, ({ payload }) => { setActive(prev => prev ? { ...prev, theme: payload.theme } : prev); });
    await channel.subscribe();
    channelRef.current = channel;
  }

  async function createAnonymousAccount() {
    const clean = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (clean.length < 3) return setError("Username must be at least 3 characters.");
    setLoginBusy(true); setError("");
    const { data, error: authError } = await supabase.auth.signInAnonymously({ options: { data: { username: clean, display_name: displayName.trim() || clean } } });
    if (authError) { setError(authError.message); setLoginBusy(false); return; }
    if (data.user) {
      const { error: profileError } = await supabase.from("profiles").update({ username: clean, display_name: displayName.trim() || clean }).eq("id", data.user.id);
      if (profileError) setError(profileError.message);
    }
    setLoginBusy(false);
  }

  async function searchUsers(value: string) {
    setSearch(value);
    if (!value.trim() || !session?.user) { setUsers([]); return; }
    const { data } = await supabase.from("profiles").select("*").ilike("username", `%${value.trim()}%`).neq("id", session.user.id).limit(12);
    setUsers(data || []);
  }

  async function startChat(other: Profile) {
    if (!session?.user) return;
    const id = session.user.id;
    const { data: existing } = await supabase.from("conversations").select("*").or(`and(user_a.eq.${id},user_b.eq.${other.id}),and(user_a.eq.${other.id},user_b.eq.${id})`).limit(1).maybeSingle();
    let conversation = existing;
    if (!conversation) {
      const { data, error: createError } = await supabase.from("conversations").insert({ user_a: id, user_b: other.id }).select().single();
      if (createError) { setError(createError.message); return; }
      conversation = data;
    }
    setSearch(""); setUsers([]);
    const hydrated = { ...conversation, other } as Conversation;
    setConversations(prev => [hydrated, ...prev.filter(item => item.id !== hydrated.id)]);
    openConversation(hydrated);
  }

  async function sendMessage(kind = "text", body = draft) {
    const text = body.trim();
    if (!text || !active || !session?.user) return;
    const optimistic: Message = { id: crypto.randomUUID(), conversation_id: active.id, sender_id: session.user.id, kind, body: text, reply_to: replying?.id || null, edited_at: null, deleted_at: null, created_at: new Date().toISOString() };
    setMessages(prev => [...prev, optimistic]); setDraft(""); setReplying(null);
    const { data, error: sendError } = await supabase.from("messages").insert({ conversation_id: active.id, sender_id: session.user.id, kind, body: text, reply_to: optimistic.reply_to }).select().single();
    if (sendError) { setMessages(prev => prev.filter(item => item.id !== optimistic.id)); setError(sendError.message); return; }
    setMessages(prev => prev.map(item => item.id === optimistic.id ? data : item));
    await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", active.id);
    if (channelRef.current) channelRef.current.send({ type: "broadcast", event: "typing", payload: { userId: session.user.id, active: false } });
  }

  async function toggleReaction(message: Message, reaction: string) {
    if (!session?.user) return;
    const existing = reactions.find(item => item.message_id === message.id && item.user_id === session.user.id && item.reaction === reaction);
    if (existing) {
      setReactions(prev => prev.filter(item => item !== existing));
      await supabase.from("message_reactions").delete().eq("message_id", message.id).eq("user_id", session.user.id).eq("reaction", reaction);
    } else {
      const optimistic = { message_id: message.id, user_id: session.user.id, reaction };
      setReactions(prev => [...prev, optimistic]);
      const { error: reactionError } = await supabase.from("message_reactions").insert(optimistic);
      if (reactionError) setReactions(prev => prev.filter(item => item !== optimistic));
    }
  }

  async function editMessage(message: Message) {
    const next = window.prompt("Edit message", message.body);
    if (next === null || !next.trim()) return;
    const value = next.trim();
    setMessages(prev => prev.map(item => item.id === message.id ? { ...item, body: value, edited_at: new Date().toISOString() } : item));
    await supabase.from("messages").update({ body: value, edited_at: new Date().toISOString() }).eq("id", message.id).eq("sender_id", session.user.id);
  }

  async function deleteMessage(message: Message) {
    setMessages(prev => prev.map(item => item.id === message.id ? { ...item, deleted_at: new Date().toISOString(), body: "Message deleted" } : item));
    await supabase.from("messages").update({ deleted_at: new Date().toISOString(), body: "Message deleted" }).eq("id", message.id).eq("sender_id", session.user.id);
  }

  function notifyTyping(activeTyping: boolean) {
    if (!channelRef.current || !session?.user || !settings.typingIndicators) return;
    channelRef.current.send({ type: "broadcast", event: "typing", payload: { userId: session.user.id, active: activeTyping } });
  }

  function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) return setError("Voice recording is not supported by this browser.");
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      recorder.onstop = () => { stream.getTracks().forEach(track => track.stop()); const seconds = recordSeconds; setRecordSeconds(0); if (seconds > 0) setDraft(`Voice message · ${seconds}s`); };
      recorder.start(); mediaRecorder.current = recorder; setRecording(true); setRecordSeconds(0); recordTimer.current = setInterval(() => setRecordSeconds(value => value + 1), 1000);
    }).catch(() => setError("Microphone permission was denied."));
  }

  function stopRecording() {
    mediaRecorder.current?.stop(); mediaRecorder.current = null; clearInterval(recordTimer.current); setRecording(false);
  }

  async function changeTheme(theme: string) {
    if (!active) return;
    setActive(prev => prev ? { ...prev, theme } : prev);
    if (channelRef.current) channelRef.current.send({ type: "broadcast", event: "theme", payload: { theme } });
    await supabase.from("conversations").update({ theme }).eq("id", active.id);
  }

  const themeClass = active?.theme || "default";
  const visibleMessages = useMemo(() => messages.filter(message => !message.deleted_at || message.body === "Message deleted"), [messages]);

  if (!session) return <main className="auth"><div className="auth-card"><div className="brand"><span>✦</span><div><strong>Messagner</strong><small>private realtime messaging</small></div></div><h1>Talk privately.</h1><p>Create a username and jump straight into your private messenger.</p><label>Username<input value={username} onChange={event => setUsername(event.target.value)} placeholder="your_username" autoCapitalize="none" /></label><label>Display name<input value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Optional" /></label>{error && <div className="error">{error}</div>}<button className="primary" onClick={createAnonymousAccount} disabled={loginBusy}>{loginBusy ? "Creating…" : "Enter Messagner"}</button><small className="hint">No phone number required. Your session stays on this device.</small></div></main>;

  return <main className={`app theme-${themeClass} text-${settings.textSize}`}>
    <aside className={`sidebar ${active ? "mobile-hidden" : ""}`}>
      <header className="side-header"><div className="brand compact"><span>✦</span><strong>Messagner</strong></div><button className="icon" onClick={() => setShowSettings(true)}>⚙</button></header>
      <div className="me"><div className="avatar">{profile?.display_name?.slice(0, 1).toUpperCase() || "M"}</div><div className="me-copy"><strong>{profile?.display_name || profile?.username}</strong><span>@{profile?.username} · {profile?.mood || "available"}</span></div><span className="online-dot" /></div>
      <div className="search-wrap"><span>⌕</span><input value={search} onChange={event => searchUsers(event.target.value)} placeholder="Search people" /></div>
      {users.length > 0 && <div className="search-results">{users.map(user => <button key={user.id} onClick={() => startChat(user)}><div className="avatar small">{user.display_name?.slice(0, 1).toUpperCase() || user.username.slice(0, 1).toUpperCase()}</div><div><strong>{user.display_name || user.username}</strong><span>@{user.username}</span></div></button>)}</div>}
      <div className="section-title">Messages</div>
      <div className="conversation-list">{conversations.map(conversation => <button key={conversation.id} className={`conversation ${active?.id === conversation.id ? "selected" : ""}`} onClick={() => openConversation(conversation)}><div className="avatar small">{conversation.other?.display_name?.slice(0, 1).toUpperCase() || "?"}</div><div className="conversation-copy"><strong>{conversation.other?.display_name || conversation.other?.username || "User"}</strong><span>{conversation.last?.body || "Start a conversation"}</span></div>{online[conversation.other?.id || ""] && <span className="online-dot" />}</button>)}{conversations.length === 0 && <div className="empty-list">Search for a username to start your first chat.</div>}</div>
      <button className="profile-button" onClick={() => setShowSettings(true)}><div className="avatar small">{profile?.display_name?.slice(0, 1).toUpperCase() || "M"}</div><div><strong>{profile?.display_name}</strong><span>Profile & settings</span></div></button>
    </aside>
    <section className={`chat ${!active ? "no-chat" : ""}`}>
      {!active ? <div className="welcome"><div className="welcome-icon">✦</div><h2>Messagner</h2><p>Choose a conversation or search for someone above.</p><div className="feature-row"><span>⚡ Instant</span><span>🔒 Private</span><span>📱 Cross-device</span></div></div> : <>
        <header className="chat-header"><button className="back" onClick={() => setActive(null)}>‹</button><div className="avatar">{active.other?.display_name?.slice(0, 1).toUpperCase() || "?"}</div><div className="chat-title"><strong>{active.other?.display_name || active.other?.username}</strong><span>{online[active.other?.id || ""] ? "online" : "offline"}</span></div><div className="header-actions"><button className="icon" onClick={() => setShowSettings(true)}>⋯</button></div></header>
        <div className="message-area">{visibleMessages.length === 0 && <div className="chat-empty">Say hello 👋</div>}{visibleMessages.map(message => { const mine = message.sender_id === session.user.id; const rx = reactions.filter(item => item.message_id === message.id); return <div key={message.id} className={`message-row ${mine ? "mine" : "theirs"}`}><div className={`bubble ${message.deleted_at ? "deleted" : ""}`} onDoubleClick={() => !message.deleted_at && toggleReaction(message, "❤️")}><div>{message.body}</div>{message.edited_at && !message.deleted_at && <small>edited</small>}{rx.length > 0 && <div className="reactions">{rx.map(item => <span key={`${item.user_id}-${item.reaction}`}>{item.reaction}</span>)}</div>}</div><div className="message-meta"><span>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>{mine && settings.readReceipts && <span>✓✓</span>}<button onClick={() => setReplying(message)}>↩</button>{mine && !message.deleted_at && <><button onClick={() => editMessage(message)}>✎</button><button onClick={() => deleteMessage(message)}>⌫</button></>}</div>{rx.length > 0 && <div className="reaction-tools">{emojis.map(emoji => <button key={emoji} onClick={() => toggleReaction(message, emoji)}>{emoji}</button>)}</div>}</div>})}{typing && <div className="typing"><span /><span /><span /> typing…</div>}<div ref={bottomRef} /></div>
        {replying && <div className="reply-bar"><div><small>Replying to</small><strong>{replying.body}</strong></div><button onClick={() => setReplying(null)}>×</button></div>}
        <div className="composer"><button className="icon" onClick={() => setDraft(draft + "😊")}>☺</button><input value={draft} onChange={event => { setDraft(event.target.value); notifyTyping(true); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} placeholder="Write a message…" />{recording ? <button className="record active" onClick={stopRecording}>● {recordSeconds}s</button> : <button className="icon" onClick={startRecording}>🎙</button>}<button className="send" onClick={() => sendMessage()} disabled={!draft.trim()}>➤</button></div>
        <div className="theme-strip">{themes.map(theme => <button key={theme} className={themeClass === theme ? "active" : ""} onClick={() => changeTheme(theme)}>{theme}</button>)}</div>
      </>}
    </section>
    {showSettings && <div className="overlay" onClick={() => setShowSettings(false)}><aside className="settings" onClick={event => event.stopPropagation()}><div className="settings-head"><h2>Settings</h2><button className="icon" onClick={() => setShowSettings(false)}>×</button></div><section><h3>Appearance</h3><div className="segmented">{["dark", "light"].map(value => <button key={value} className={settings.appearance === value ? "active" : ""} onClick={() => setSettings(prev => ({ ...prev, appearance: value }))}>{value}</button>)}</div><label>Text size<input type="range" min="14" max="20" value={settings.textSize} onChange={event => setSettings(prev => ({ ...prev, textSize: Number(event.target.value) }))} /></label></section><section><h3>Privacy</h3>{[["readReceipts", "Read receipts"], ["typingIndicators", "Typing indicators"], ["linkPreviews", "Link previews"]].map(([key, label]) => <label className="switch" key={key}><span>{label}</span><input type="checkbox" checked={(settings as any)[key]} onChange={event => setSettings(prev => ({ ...prev, [key]: event.target.checked }))} /></label>)}</section><section><h3>Notifications</h3>{[["messagePreviews", "Message previews"], ["notificationSound", "Notification sound"], ["muted", "Mute this chat"]].map(([key, label]) => <label className="switch" key={key}><span>{label}</span><input type="checkbox" checked={(settings as any)[key]} onChange={event => setSettings(prev => ({ ...prev, [key]: event.target.checked }))} /></label>)}</section><section><h3>Your status</h3><div className="moods">{moods.map(mood => <button key={mood} className={profile?.mood === mood ? "active" : ""} onClick={async () => { await supabase.from("profiles").update({ mood }).eq("id", session.user.id); setProfile(prev => prev ? { ...prev, mood } : prev); }}>{mood}</button>)}</div></section><button className="danger" onClick={() => supabase.auth.signOut()}>Sign out</button></aside></div>}
  </main>;
}
