import { readFileSync, writeFileSync } from "node:fs";

const path = "app/page.tsx";
const text = readFileSync(path, "utf8");
if (text.includes("__MESSAGNER_RENDERER_REPAIRED__")) process.exit(0);

const replacement = `        <div className="message-area">
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

const pattern = /        <div className="message-area">.*?\n        \{replying &&/s;
if (!pattern.test(text)) throw new Error("message renderer block not found");
writeFileSync(path, text.replace(pattern, replacement));