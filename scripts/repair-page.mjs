import { readFileSync, writeFileSync } from "node:fs";

const path = "app/page.tsx";
let text = readFileSync(path, "utf8");

const rendererReplacement = `        <div className="message-area">
          {visibleMessages.length === 0 && <div className="chat-empty">Say hello 👋</div>}
          {visibleMessages.map(message => {
            const mine = message.sender_id === session.user.id;
            const rx = reactions.filter(item => item.message_id === message.id);
            const receipt = receipts.find(item => item.message_id === message.id && item.user_id !== session.user.id);
            return (
              <div key={message.id} className={\`message-row \${mine ? "mine" : "theirs"}\`}>
                <div className={\`bubble \${message.deleted_at ? "deleted" : ""}\`} onContextMenu={event => { event.preventDefault(); setReplying(message); }}>
                  {message.reply_to && <div className="reply-preview">Reply</div>}
                  {message.body}
                  {message.edited_at && <small>edited</small>}
                  {rx.length > 0 && <div className="reactions">{Array.from(new Set(rx.map(item => item.reaction))).map(reaction => <button key={reaction} onClick={() => toggleReaction(message, reaction)}>{reaction} {rx.filter(item => item.reaction === reaction).length}</button>)}</div>}
                </div>
                <div className="message-meta">
                  <span>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  {mine && <span>{message.status === "failed" ? <button onClick={() => retryMessage(message)}>Retry</button> : receipt?.status === "read" ? "✓✓" : receipt?.status === "delivered" ? "✓✓" : "✓"}</span>}
                  <button onClick={() => setReplying(message)}>Reply</button>
                  {mine && <button onClick={() => editMessage(message)}>Edit</button>}
                  <button onClick={() => deleteForMe(message)}>Delete</button>
                  {mine && <button onClick={() => deleteMessage(message)}>×</button>}
                </div>
                <div className="reaction-tools">{emojis.map(reaction => <button key={reaction} onClick={() => toggleReaction(message, reaction)}>{reaction}</button>)}</div>
              </div>
            );
          })}
          {typing && <div className="typing"><span /><span /><span /> typing</div>}
          <div ref={bottomRef} />
        </div>
        <span className="__MESSAGNER_RENDERER_REPAIRED__" hidden />
        {replying &&`;

const rendererPattern = /        <div className="message-area">.*?\n        \{replying &&/s;
if (rendererPattern.test(text)) text = text.replace(rendererPattern, rendererReplacement);

const startChatReplacement = `  async function startChat(other: Profile) {
    if (!session?.user || !other?.id || other.id === session.user.id) return;
    const currentId = session.user.id;
    const [userA, userB] = [currentId, other.id].sort();
    setError("");
    const { data: existing, error: lookupError } = await supabase
      .from("conversations")
      .select("*")
      .eq("kind", "direct")
      .or(\`and(user_a.eq.\${userA},user_b.eq.\${userB}),and(user_a.eq.\${userB},user_b.eq.\${userA})\`)
      .limit(1)
      .maybeSingle();
    if (lookupError) { setError(lookupError.message); return; }
    let conversation = existing;
    if (!conversation) {
      const { data, error: createError } = await supabase
        .from("conversations")
        .insert({ user_a: userA, user_b: userB, kind: "direct", created_by: currentId })
        .select("*")
        .single();
      if (createError || !data) { setError(createError?.message || "Could not create conversation."); return; }
      conversation = data;
    }
    setSearch("");
    setUsers([]);
    const hydrated = { ...conversation, other } as Conversation;
    setConversations(prev => [hydrated, ...prev.filter(item => item.id !== hydrated.id)]);
    await openConversation(hydrated);
  }

  async function createGroup() {`;

const startChatPattern = /  async function startChat\(other: Profile\) \{.*?\n  async function createGroup\(\) \{/s;
if (!startChatPattern.test(text)) throw new Error("startChat block not found");
text = text.replace(startChatPattern, startChatReplacement);

const createGroupReplacement = `  async function createGroup() {
    if (!session?.user || !groupName.trim() || groupUsers.length === 0) return;
    setError("");
    const { data: conversation, error: createError } = await supabase
      .from("conversations")
      .insert({ user_a: session.user.id, user_b: null, kind: "group", name: groupName.trim(), created_by: session.user.id })
      .select("*")
      .single();
    if (createError || !conversation) { setError(createError?.message || "Could not create group."); return; }
    const members = [{ conversation_id: conversation.id, user_id: session.user.id, role: "admin" }, ...groupUsers.map(user => ({ conversation_id: conversation.id, user_id: user.id, role: "member" }))];
    const { error: memberError } = await supabase.from("group_members").insert(members);
    if (memberError) {
      await supabase.from("conversations").delete().eq("id", conversation.id);
      setError(memberError.message);
      return;
    }
    const hydrated = { ...conversation } as Conversation;
    setConversations(prev => [hydrated, ...prev.filter(item => item.id !== hydrated.id)]);
    setNewGroup(false);
    setGroupName("");
    setGroupUsers([]);
    setGroupCandidates([]);
    setGroupSearch("");
    await openConversation(hydrated);
  }

  async function sendMessage`;

const createGroupPattern = /  async function createGroup\(\) \{.*?\n  async function sendMessage/s;
if (!createGroupPattern.test(text)) throw new Error("createGroup block not found");
text = text.replace(createGroupPattern, createGroupReplacement);

writeFileSync(path, text);