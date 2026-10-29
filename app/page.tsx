"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

type Profile = { id: string; username: string; display_name: string; bio: string; avatar_url: string | null; mood: string };
type Conversation = { id: string; user_a: string; user_b: string | null; kind: string; name: string | null; avatar_url: string | null; theme: string; updated_at: string; other?: Profile; last?: Message };
type Message = { id: string; conversation_id: string; sender_id: string; kind: string; body: string; reply_to: string | null; edited_at: string | null; deleted_at: string | null; created_at: string; status: string; delivered_at?: string | null; read_at?: string | null; metadata?: Record<string, any> };
type Reaction = { message_id: string; user_id: string; reaction: string };
type Receipt = { message_id: string; user_id: string; status: string; delivered_at?: string | null; read_at?: string | null };
type ChatSettings = { muted: boolean; archived: boolean; pinned: boolean; read_receipts: boolean; typing_indicators: boolean; notifications: boolean; notification_previews: boolean; notification_sound: boolean; theme: string; text_size: number; disappearing_seconds: number };

const emojis = ["❤️", "😂", "👍", "🔥", "😮", "😢"];
const themes = ["default", "midnight", "ocean", "sunset"];
const defaultSettings: ChatSettings = { muted: false, archived: false, pinned: false, read_receipts: true, typing_indicators: true, notifications: true, notification_previews: true, notification_sound: true, theme: "default", text_size: 16, disappearing_seconds: 0 };

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
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [draft, setDraft] = useState("");
  const [replying, setReplying] = useState<Message | null>(null);
  const [search, setSearch] = useState("");
  const [messageSearch, setMessageSearch] = useState("");
  const [users, setUsers] = useState<Profile[]>([]);
  const [typing, setTyping] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState({ appearance: "dark", textSize: 16, notificationSound: true });
  const [chatSettings, setChatSettings] = useState<ChatSettings>(defaultSettings);
  const [online, setOnline] = useState<Record<string, boolean>>({});
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [showEmoji, setShowEmoji] = useState(false);
  const [editing, setEditing] = useState<Message | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [showChatMenu, setShowChatMenu] = useState(false);
  const [newGroup, setNewGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupUsers, setGroupUsers] = useState<Profile[]>([]);
  const [groupSearch, setGroupSearch] = useState("");
  const [groupCandidates, setGroupCandidates] = useState<Profile[]>([]);
  const channelRef = useRef<any>(null);
  const typingTimer = useRef<any>(null);
  const recordTimer = useRef<any>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
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

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, typing]);

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
        otherId ? supabase.from("profiles").select("*").eq("id", otherId).single() : Promise.resolve({ data: null }),
        supabase.from("messages").select("*").eq("conversation_id", row.id).order("created_at", { ascending: false }).limit(1)
      ]);
      return { ...row, other, last: lastRows?.[0] } as Conversation;
    }));
    setConversations(hydrated);
  }

  async function loadChatSettings(conversationId: string) {
    if (!session?.user) return;
    const { data } = await supabase.from("chat_settings").select("*").eq("conversation_id", conversationId).eq("user_id", session.user.id).maybeSingle();
    if (data) setChatSettings(data);
    else {
      const { data: created } = await supabase.from("chat_settings").insert({ conversation_id: conversationId, user_id: session.user.id }).select().single();
      setChatSettings(created || defaultSettings);
    }
  }

  async function openConversation(conversation: Conversation) {
    setActive(conversation); setMessageSearch(""); setShowChatMenu(false); setShowEmoji(false);
    await loadChatSettings(conversation.id);
    const [{ data }, { data: rx }, { data: rc }] = await Promise.all([
      supabase.from("messages").select("*").eq("conversation_id", conversation.id).order("created_at", { ascending: true }),
      supabase.from("message_reactions").select("message_id,user_id,reaction"),
      supabase.from("message_receipts").select("message_id,user_id,status,delivered_at,read_at")
    ]);
    setMessages(data || []); setReactions(rx || []); setReceipts(rc || []);
    if (channelRef.current) supabase.removeChannel(channelRef.current);
    const channel = supabase.channel(`conversation:${conversation.id}`);
    channel.on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversation.id}` }, async payload => {
      const message = payload.new as Message;
      setMessages(prev => prev.some(item => item.id === message.id) ? prev : [...prev, message]);
      setConversations(prev => prev.map(item => item.id === conversation.id ? { ...item, last: message, updated_at: message.created_at } : item));
      if (message.sender_id !== session?.user?.id) {
        await supabase.from("message_receipts").upsert({ message_id: message.id, user_id: session?.user?.id, status: "delivered", delivered_at: new Date().toISOString() });
        if (chatSettings.read_receipts) await supabase.from("message_receipts").upsert({ message_id: message.id, user_id: session?.user?.id, status: "read", delivered_at: new Date().toISOString(), read_at: new Date().toISOString() });
      }
    });
    channel.on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages", filter: `conversation_id=eq.${conversation.id}` }, payload => setMessages(prev => prev.map(item => item.id === payload.new.id ? payload.new as Message : item)));
    channel.on("postgres_changes", { event: "INSERT", schema: "public", table: "message_reactions" }, payload => setReactions(prev => [...prev.filter(item => !(item.message_id === payload.new.message_id && item.user_id === payload.new.user_id)), payload.new as Reaction]));
    channel.on("postgres_changes", { event: "DELETE", schema: "public", table: "message_reactions" }, payload => setReactions(prev => prev.filter(item => item.message_id !== payload.old.message_id || item.user_id !== payload.old.user_id)));
    channel.on("postgres_changes", { event: "INSERT", schema: "public", table: "message_receipts" }, payload => setReceipts(prev => [...prev.filter(item => !(item.message_id === payload.new.message_id && item.user_id === payload.new.user_id)), payload.new as Receipt]));
    channel.on("postgres_changes", { event: "UPDATE", schema: "public", table: "message_receipts" }, payload => setReceipts(prev => prev.map(item => item.message_id === payload.new.message_id && item.user_id === payload.new.user_id ? payload.new as Receipt : item)));
    channel.on("broadcast", { event: "typing" }, ({ payload }) => { if (payload.userId !== session?.user?.id) { setTyping(Boolean(payload.active)); clearTimeout(typingTimer.current); if (payload.active) typingTimer.current = setTimeout(() => setTyping(false), 3200); } });
    channel.on("broadcast", { event: "theme" }, ({ payload }) => setChatSettings(prev => ({ ...prev, theme: payload.theme })));
    await channel.subscribe(); channelRef.current = channel;
    const incoming = (data || []).filter((message: Message) => message.sender_id !== session.user.id);
    if (incoming.length) {
      const now = new Date().toISOString();
      await Promise.all(incoming.map(message => supabase.from("message_receipts").upsert({ message_id: message.id, user_id: session.user.id, status: "read", delivered_at: now, read_at: now })));
    }
  }

  async function createAnonymousAccount() {
    const clean = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (clean.length < 3) return setError("Username must be at least 3 characters.");
    setLoginBusy(true); setError("");
    const { data, error: authError } = await supabase.auth.signInAnonymously({ options: { data: { username: clean, display_name: displayName.trim() || clean } } });
    if (authError) { setError(authError.message); setLoginBusy(false); return; }
    if (data.user) await supabase.from("profiles").update({ username: clean, display_name: displayName.trim() || clean }).eq("id", data.user.id);
    setLoginBusy(false);
  }

  async function searchUsers(value: string) {
    setSearch(value);
    if (!value.trim() || !session?.user) { setUsers([]); return; }
    const { data } = await supabase.from("profiles").select("*").ilike("username", `%${value.trim()}%`).neq("id", session.user.id).limit(12);
    setUsers(data || []);
  }

  async function searchGroupUsers(value: string) {
    setGroupSearch(value);
    if (!value.trim() || !session?.user) { setGroupCandidates([]); return; }
    const { data } = await supabase.from("profiles").select("*").ilike("username", `%${value.trim()}%`).neq("id", session.user.id).limit(12);
    setGroupCandidates(data || []);
  }

  async function startChat(other: Profile) {
    if (!session?.user) return;
    const id = session.user.id;
    const { data: existing } = await supabase.from("conversations").select("*").or(`and(user_a.eq.${id},user_b.eq.${other.id}),and(user_a.eq.${other.id},user_b.eq.${id})`).limit(1).maybeSingle();
    let conversation = existing;
    if (!conversation) {
      const { data, error: createError } = await supabase.from("conversations").insert({ user_a: id, user_b: other.id, kind: "direct", created_by: id }).select().single();
      if (createError) { setError(createError.message); return; }
      conversation = data;
    }
    setSearch(""); setUsers([]);
    const hydrated = { ...conversation, other } as Conversation;
    setConversations(prev => [hydrated, ...prev.filter(item => item.id !== hydrated.id)]);
    openConversation(hydrated);
  }

  async function createGroup() {
    if (!session?.user || !groupName.trim() || groupUsers.length === 0) return;
    const { data: conversation, error: createError } = await supabase.from("conversations").insert({ user_a: session.user.id, user_b: null, kind: "group", name: groupName.trim(), created_by: session.user.id }).select().single();
    if (createError || !conversation) { setError(createError?.message || "Could not create group."); return; }
    const members = [{ conversation_id: conversation.id, user_id: session.user.id, role: "admin" }, ...groupUsers.map(user => ({ conversation_id: conversation.id, user_id: user.id, role: "member" }))];
    const { error: memberError } = await supabase.from("group_members").insert(members);
    if (memberError) { setError(memberError.message); return; }
    const hydrated = { ...conversation, other: undefined } as Conversation;
    setConversations(prev => [hydrated, ...prev]); setNewGroup(false); setGroupName(""); setGroupUsers([]); setGroupCandidates([]); setGroupSearch(""); openConversation(hydrated);
  }

  async function sendMessage(kind = "text", body = draft) {
    const text = body.trim();
    if (!text || !active || !session?.user) return;
    if (editing) { await saveEdit(); return; }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const optimistic: Message = { id, conversation_id: active.id, sender_id: session.user.id, kind, body: text, reply_to: replying?.id || null, edited_at: null, deleted_at: null, created_at: now, status: "sent", metadata: {} };
    setMessages(prev => [...prev, optimistic]); setDraft(""); setReplying(null);
    const { data, error: sendError } = await supabase.from("messages").insert({ id, conversation_id: active.id, sender_id: session.user.id, kind, body: text, reply_to: optimistic.reply_to, status: "sent", metadata: {} }).select().single();
    if (sendError) { setMessages(prev => prev.map(item => item.id === id ? { ...item, status: "failed" } : item)); setError(sendError.message); return; }
    setMessages(prev => prev.map(item => item.id === id ? data : item));
    await supabase.from("conversations").update({ updated_at: now }).eq("id", active.id);
    if (channelRef.current) channelRef.current.send({ type: "broadcast", event: "typing", payload: { userId: session.user.id, active: false } });
  }

  async function retryMessage(message: Message) {
    if (!session?.user) return;
    const { data, error: retryError } = await supabase.from("messages").insert({ ...message, status: "sent" }).select().single();
    if (!retryError && data) setMessages(prev => prev.map(item => item.id === message.id ? data : item));
  }

  async function toggleReaction(message: Message, reaction: string) {
    if (!session?.user) return;
    const existing = reactions.find(item => item.message_id === message.id && item.user_id === session.user.id && item.reaction === reaction);
    const optimistic = { message_id: message.id, user_id: session.user.id, reaction };
    if (existing) {
      setReactions(prev => prev.filter(item => item !== existing));
      const { error } = await supabase.from("message_reactions").delete().eq("message_id", message.id).eq("user_id", session.user.id).eq("reaction", reaction);
      if (error) setReactions(prev => [...prev, existing]);
    } else {
      setReactions(prev => [...prev, optimistic]);
      const { error } = await supabase.from("message_reactions").insert(optimistic);
      if (error) setReactions(prev => prev.filter(item => item !== optimistic));
    }
  }

  async function editMessage(message: Message) { setEditing(message); setEditDraft(message.body); setDraft(""); }

  async function saveEdit() {
    if (!editing || !session?.user || !editDraft.trim()) return;
    const editedAt = new Date().toISOString();
    const value = editDraft.trim();
    setMessages(prev => prev.map(item => item.id === editing.id ? { ...item, body: value, edited_at: editedAt } : item));
    const { error: editError } = await supabase.from("messages").update({ body: value, edited_at: editedAt }).eq("id", editing.id).eq("sender_id", session.user.id);
    if (editError) setError(editError.message);
    setEditing(null); setEditDraft("");
  }

  async function deleteMessage(message: Message) {
    if (!session?.user) return;
    const deletedAt = new Date().toISOString();
    setMessages(prev => prev.map(item => item.id === message.id ? { ...item, deleted_at: deletedAt, body: "Message deleted" } : item));
    await supabase.from("messages").update({ deleted_at: deletedAt, body: "Message deleted" }).eq("id", message.id).eq("sender_id", session.user.id);
  }

  async function deleteForMe(message: Message) {
    if (!session?.user) return;
    setMessages(prev => prev.filter(item => item.id !== message.id));
    await supabase.from("message_deletions").upsert({ message_id: message.id, user_id: session.user.id });
  }

  function notifyTyping(activeTyping: boolean) {
    if (!channelRef.current || !session?.user || !chatSettings.typing_indicators) return;
    channelRef.current.send({ type: "broadcast", event: "typing", payload: { userId: session.user.id, active: activeTyping } });
  }

  async function changeChatSetting(patch: Partial<ChatSettings>) {
    if (!active || !session?.user) return;
    const next = { ...chatSettings, ...patch };
    setChatSettings(next);
    const { error: settingError } = await supabase.from("chat_settings").upsert({ conversation_id: active.id, user_id: session.user.id, ...patch, updated_at: new Date().toISOString() });
    if (settingError) setError(settingError.message);
    if (patch.theme && channelRef.current) channelRef.current.send({ type: "broadcast", event: "theme", payload: { theme: patch.theme } });
  }

  async function toggleBlock() {
    if (!active?.other || !session?.user) return;
    const { data: existing } = await supabase.from("blocked_users").select("blocked_id").eq("blocker_id", session.user.id).eq("blocked_id", active.other.id).maybeSingle();
    if (existing) await supabase.from("blocked_users").delete().eq("blocker_id", session.user.id).eq("blocked_id", active.other.id);
    else await supabase.from("blocked_users").insert({ blocker_id: session.user.id, blocked_id: active.other.id });
    setShowChatMenu(false);
  }

  function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) return setError("Voice recording is not supported by this browser.");
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const recorder = new MediaRecorder(stream);
      recorder.onstop = () => { stream.getTracks().forEach(track => track.stop()); clearInterval(recordTimer.current); const seconds = recordSeconds; setRecordSeconds(0); if (seconds > 0) sendMessage("voice", `Voice message · ${seconds}s`); };
      recorder.start(); mediaRecorder.current = recorder; setRecording(true); setRecordSeconds(0); recordTimer.current = setInterval(() => setRecordSeconds(value => value + 1), 1000);
    }).catch(() => setError("Microphone permission was denied."));
  }

  function stopRecording() { mediaRecorder.current?.stop(); mediaRecorder.current = null; setRecording(false); }

  const visibleMessages = useMemo(() => {
    const query = messageSearch.trim().toLowerCase();
    return messages.filter(message => !query || message.body.toLowerCase().includes(query));
  }, [messages, messageSearch]);

  const themeClass = chatSettings.theme || "default";

  if (!session) return <main className="auth"><div className="auth-card"><div className="brand"><span>✦</span><div><strong>Messagner</strong><small>private realtime messaging</small></div></div><h1>Talk privately.</h1><p>A fast, private messenger inspired by the best modern messaging apps.</p><label>Username<input value={username} onChange={event => setUsername(event.target.value)} placeholder="your_username" autoCapitalize="none" /></label><label>Display name<input value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Optional" /></label>{error && <div className="error">{error}</div>}<button className="primary" onClick={createAnonymousAccount} disabled={loginBusy}>{loginBusy ? "Creating…" : "Enter Messagner"}</button><small className="hint">No phone number required. Your session stays on this device.</small></div></main>;

  return <main className={`app theme-${themeClass} text-${settings.textSize}`}>
    <aside className={`sidebar ${active ? "mobile-hidden" : ""}`}>
      <header className="side-header"><div className="brand compact"><span>✦</span><strong>Messagner</strong></div><div className="side-actions"><button className="icon" onClick={() => setNewGroup(true)}>＋</button><button className="icon" onClick={() => setShowSettings(true)}>⚙</button></div></header>
      <div className="me"><div className="avatar">{profile?.display_name?.slice(0, 1).toUpperCase() || "M"}</div><div className="me-copy"><strong>{profile?.display_name || profile?.username}</strong><span>@{profile?.username} · {profile?.mood || "available"}</span></div><span className="online-dot" /></div>
      <div className="search-wrap"><span>⌕</span><input value={search} onChange={event => searchUsers(event.target.value)} placeholder="Search people" /></div>
      {users.length > 0 && <div className="search-results">{users.map(user => <button key={user.id} onClick={() => startChat(user)}><div className="avatar small">{user.display_name?.slice(0, 1).toUpperCase() || "?"}</div><div><strong>{user.display_name || user.username}</strong><span>@{user.username}</span></div></button>)}</div>}
      <div className="section-title">Chats</div>
      <div className="conversation-list">{conversations.length === 0 ? <div className="empty-list">No conversations yet.<br />Search a username to start one.</div> : conversations.map(conversation => <button className={`conversation ${active?.id === conversation.id ? "selected" : ""}`} key={conversation.id} onClick={() => openConversation(conversation)}><div className="avatar small">{conversation.kind === "group" ? "G" : conversation.other?.display_name?.slice(0, 1).toUpperCase() || "?"}</div><div className="conversation-copy"><strong>{conversation.kind === "group" ? conversation.name : conversation.other?.display_name || conversation.other?.username}</strong><span>{conversation.last?.body || "No messages yet"}</span></div><span className="conversation-status">{conversation.other && online[conversation.other.id] ? "●" : ""}</span></button>)}</div>
      <button className="profile-button" onClick={() => setShowSettings(true)}><div className="avatar small">{profile?.display_name?.slice(0, 1).toUpperCase() || "M"}</div><div><strong>{profile?.display_name || profile?.username}</strong><span>Settings & privacy</span></div><span>›</span></button>
    </aside>

    <section className={`chat ${active ? "" : "no-chat"}`}>
      {!active ? <div className="welcome"><div className="welcome-icon">✦</div><h2>Private conversations.</h2><p>Fast, realtime messaging with a clean Signal-inspired experience.</p><div className="feature-row"><span>Realtime</span><span>Reactions</span><span>Replies</span><span>Privacy</span></div></div> : <>
        <header className="chat-header"><button className="back" onClick={() => setActive(null)}>‹</button><div className="avatar small">{active.kind === "group" ? "G" : active.other?.display_name?.slice(0, 1).toUpperCase() || "?"}</div><div className="chat-title"><strong>{active.kind === "group" ? active.name : active.other?.display_name || active.other?.username}</strong><span>{active.kind === "group" ? "Group" : active.other && online[active.other.id] ? "online" : "offline"}{typing ? " · typing…" : ""}</span></div><div className="header-actions"><button className="icon" onClick={() => setMessageSearch(value => value ? "" : " ")}>⌕</button><button className="icon" onClick={() => setShowChatMenu(value => !value)}>⋯</button></div></header>
        {showChatMenu && <div className="chat-menu"><button onClick={() => changeChatSetting({ muted: !chatSettings.muted })}>{chatSettings.muted ? "Unmute chat" : "Mute chat"}</button><button onClick={() => changeChatSetting({ archived: true })}>Archive chat</button><button onClick={toggleBlock}>{active.kind === "direct" ? "Block / unblock user" : "Group settings"}</button></div>}
        {messageSearch !== "" && <div className="message-search"><input autoFocus value={messageSearch.trim() === "" ? "" : messageSearch} onChange={event => setMessageSearch(event.target.value)} placeholder="Search messages" /></div>}
        <div className="message-area">{visibleMessages.length === 0 && <div className="chat-empty">Say hello 👋</div>}{visibleMessages.map(message => { const mine = message.sender_id === session.user.id; const rx = reactions.filter(item => item.message_id === message.id); const receipt = receipts.find(item => item.message_id === message.id && item.user_id !== session.user.id); return <div key={message.id} className={`message-row ${mine ? "mine" : "theirs"}`}><div className={`bubble ${message.deleted_at ? "deleted" : ""}`} onContextMenu={event => { event.preventDefault(); setReplying(message); }}>{message.reply_to && <div className="reply-preview">Reply</div>}{message.body}{message.edited_at && <small>edited</small>}{rx.length > 0 && <div className="reactions">{Array.from(new Set(rx.map(item => item.reaction))).map(reaction => <button key={reaction} onClick={() => toggleReaction(message, reaction)}>{reaction} {rx.filter(item => item.reaction === reaction).length}</button>)}</div>}</div><div className="message-meta"><span>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>{mine && <span>{message.status === "failed" ? <button onClick={() => retryMessage(message)}>Retry</button> : receipt?.status === "read" ? "✓✓" : receipt?.status === "delivered" ? "✓✓" : "✓"}</span>}<button onClick={() => setReplying(message)}>Reply</button>{mine && <button onClick={() => editMessage(message)}>Edit</button>}<button onClick={() => deleteForMe(message)}>Delete</button>{mine && <button onClick={() => deleteMessage(message)}>×</button></div><div className="reaction-tools">{emojis.map(reaction => <button key={reaction} onClick={() => toggleReaction(message, reaction)}>{reaction}</button>)}</div></div> })}{typing && <div className="typing"><span /><span /><span /> typing</div>}<div ref={bottomRef} /></div>
        {replying && <div className="reply-bar"><div><small>Replying to</small><strong>{replying.body.slice(0, 100)}</strong></div><button onClick={() => setReplying(null)}>×</button></div>}
        {editing && <div className="edit-bar"><input value={editDraft} onChange={event => setEditDraft(event.target.value)} autoFocus /><button onClick={saveEdit}>Save</button><button onClick={() => { setEditing(null); setEditDraft(""); }}>Cancel</button></div>}
        <div className="theme-strip">{themes.map(theme => <button key={theme} className={chatSettings.theme === theme ? "active" : ""} onClick={() => changeChatSetting({ theme })}>{theme}</button>)}</div>
        <div className="composer">{showEmoji && <div className="emoji-popover">{["😀","😂","❤️","🔥","👍","🎉","😮","😢","🙏","✨","💯","🤝"].map(emoji => <button key={emoji} onClick={() => { setDraft(value => value + emoji); setShowEmoji(false); }}>{emoji}</button>)}</div>}<button className="icon" onClick={() => setShowEmoji(value => !value)}>☺</button><button className="icon" onClick={() => setError("Media uploads are being wired into the new media pipeline.")}>＋</button><input value={editing ? editDraft : draft} onChange={event => { editing ? setEditDraft(event.target.value) : setDraft(event.target.value); if (!editing) notifyTyping(Boolean(event.target.value)); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} placeholder={recording ? `Recording ${recordSeconds}s…` : "Message"} disabled={recording} /><button className={`record ${recording ? "active" : ""}`} onClick={recording ? stopRecording : startRecording}>{recording ? `${recordSeconds}s` : "🎙"}</button><button className="send" onClick={() => sendMessage()} disabled={!draft.trim() && !editing}>➤</button></div>
      </>}
    </section>

    {newGroup && <div className="overlay"><div className="settings"><div className="settings-head"><h2>New group</h2><button className="icon" onClick={() => setNewGroup(false)}>×</button></div><section><label>Group name<input value={groupName} onChange={event => setGroupName(event.target.value)} placeholder="My group" /></label><label>Find people<input value={groupSearch} onChange={event => searchGroupUsers(event.target.value)} placeholder="username" /></label><div className="member-list">{groupCandidates.map(user => <button key={user.id} className={groupUsers.some(item => item.id === user.id) ? "selected-member" : ""} onClick={() => setGroupUsers(prev => prev.some(item => item.id === user.id) ? prev.filter(item => item.id !== user.id) : [...prev, user])}><div className="avatar small">{user.display_name?.slice(0, 1).toUpperCase() || "?"}</div><span>{user.display_name || user.username}</span><b>{groupUsers.some(item => item.id === user.id) ? "✓" : "+"}</b></button>)}</div><button className="primary" onClick={createGroup} disabled={!groupName.trim() || groupUsers.length === 0}>Create group</button></section></div></div>}

    {showSettings && <div className="overlay"><div className="settings"><div className="settings-head"><h2>Settings</h2><button className="icon" onClick={() => setShowSettings(false)}>×</button></div><section><h3>Appearance</h3><div className="segmented">{["dark","light"].map(value => <button key={value} className={settings.appearance === value ? "active" : ""} onClick={() => setSettings(prev => ({ ...prev, appearance: value }))}>{value}</button>)}</div><label>Text size<input type="range" min="14" max="20" value={settings.textSize} onChange={event => setSettings(prev => ({ ...prev, textSize: Number(event.target.value) }))} /></label></section><section><h3>Notifications</h3><label className="switch">Notifications<input type="checkbox" checked={chatSettings.notifications} onChange={event => changeChatSetting({ notifications: event.target.checked })} /></label><label className="switch">Message previews<input type="checkbox" checked={chatSettings.notification_previews} onChange={event => changeChatSetting({ notification_previews: event.target.checked })} /></label><label className="switch">Notification sound<input type="checkbox" checked={chatSettings.notification_sound} onChange={event => changeChatSetting({ notification_sound: event.target.checked })} /></label></section><section><h3>Privacy</h3><label className="switch">Read receipts<input type="checkbox" checked={chatSettings.read_receipts} onChange={event => changeChatSetting({ read_receipts: event.target.checked })} /></label><label className="switch">Typing indicators<input type="checkbox" checked={chatSettings.typing_indicators} onChange={event => changeChatSetting({ typing_indicators: event.target.checked })} /></label></section><section><h3>Disappearing messages</h3><div className="segmented">{[[0,"Off"],[30,"30s"],[300,"5m"],[86400,"24h"]].map(([value,label]) => <button key={value} className={chatSettings.disappearing_seconds === value ? "active" : ""} onClick={() => changeChatSetting({ disappearing_seconds: value as number })}>{label}</button>)}</div></section><section><h3>Your profile</h3><label>Display name<input value={displayName || profile?.display_name || ""} onChange={event => setDisplayName(event.target.value)} /></label><button className="primary" onClick={async () => { if (!session?.user) return; await supabase.from("profiles").update({ display_name: displayName.trim() }).eq("id", session.user.id); await loadProfile(session.user.id); }}>Save profile</button></section><section><button className="danger" onClick={async () => { await supabase.auth.signOut(); setShowSettings(false); }}>Sign out</button></section></div></div>}
    {error && <button className="toast" onClick={() => setError("")}>{error} ×</button>}
  </main>;
}
