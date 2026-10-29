import { readFileSync, writeFileSync } from "node:fs";

const path = "app/page.tsx";
let text = readFileSync(path, "utf8");

const startChatReplacement = `  async function startChat(other: Profile) {
    if (!other?.id) return;
    setError("");
    let { data: authData } = await supabase.auth.getUser();
    if (!authData.user) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      authData = { user: refreshed.session?.user ?? null };
    }
    const currentId = authData.user?.id;
    if (!currentId || currentId === other.id) {
      setError("Your session expired. Please reload and sign in again.");
      return;
    }
    const [userA, userB] = [currentId, other.id].sort();
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

  async function createGroup()`;

const startChatPattern = /  async function startChat\(other: Profile\) \{.*?\n  async function createGroup\(\)/s;
if (!startChatPattern.test(text)) throw new Error("startChat block not found");
text = text.replace(startChatPattern, startChatReplacement);

const createGroupReplacement = `  async function createGroup() {
    if (!groupName.trim() || groupUsers.length === 0) return;
    setError("");
    let { data: authData } = await supabase.auth.getUser();
    if (!authData.user) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      authData = { user: refreshed.session?.user ?? null };
    }
    const currentId = authData.user?.id;
    if (!currentId) {
      setError("Your session expired. Please reload and sign in again.");
      return;
    }
    const { data: conversation, error: createError } = await supabase
      .from("conversations")
      .insert({ user_a: currentId, user_b: null, kind: "group", name: groupName.trim(), created_by: currentId })
      .select("*")
      .single();
    if (createError || !conversation) { setError(createError?.message || "Could not create group."); return; }
    const members = [{ conversation_id: conversation.id, user_id: currentId, role: "admin" }, ...groupUsers.map(user => ({ conversation_id: conversation.id, user_id: user.id, role: "member" }))];
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
