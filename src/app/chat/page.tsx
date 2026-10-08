"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { sb } from "@/lib/supabase";
import { CallLayer } from "@/components/calls/CallLayer";
import { CallsList } from "@/components/calls/CallsList";
import { Avatar } from "@/components/Avatar";
import "./chat.css";
import "./tabs.css";

type Msg = { id: string; conversation_id: string; sender_id: string; content: string; reply_to_message_id: string | null; is_edited: boolean; is_deleted: boolean; created_at: string };
type Prof = { id: string; display_name: string; username: string };
type Conv = { id: string; title: string; isGroup: boolean; otherId: string | null };
type Reaction = { message_id: string; user_id: string; emoji: string };
type Member = { user_id: string; last_read_at: string; name: string };
type MemberRow = { conversation_id: string; user_id: string; conversations: { type: string; name: string | null } | null; profiles: { display_name: string } | null };
type PresenceMeta = { typing?: boolean; name?: string };

const EMOJIS = ["👍", "❤️", "😂", "😮", "🙏"];

export default function ChatPage() {
  const router = useRouter();
  const [tab, setTab] = useState<"chats" | "calls">("chats");
  const [meId, setMeId] = useState<string | null>(null);
  const [myName, setMyName] = useState("Someone");
  const [convs, setConvs] = useState<Conv[]>([]);
  const [active, setActive] = useState<Conv | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [pins, setPins] = useState<string[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [typers, setTypers] = useState<string[]>([]);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [editing, setEditing] = useState<Msg | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Prof[]>([]);
  const [grpMode, setGrpMode] = useState(false);
  const [grpName, setGrpName] = useState("");
  const [grpMembers, setGrpMembers] = useState<Prof[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const room = useRef<RealtimeChannel | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readMark = useRef("");

  const loadConvs = useCallback(async (uid: string) => {
    const mine = await sb().from("conversation_members").select("conversation_id").eq("user_id", uid);
    if (mine.error) return setError(mine.error.message);
    const ids = (mine.data ?? []).map((r) => r.conversation_id as string);
    if (!ids.length) { setConvs([]); return; }
    const { data, error: err } = await sb().from("conversation_members")
      .select("conversation_id, user_id, conversations(type,name), profiles(display_name)")
      .in("conversation_id", ids).neq("user_id", uid);
    if (err) return setError(err.message);
    const seen = new Map<string, Conv>();
    for (const r of (data ?? []) as unknown as MemberRow[]) {
      if (seen.has(r.conversation_id)) continue;
      const isGroup = r.conversations?.type === "GROUP";
      seen.set(r.conversation_id, { id: r.conversation_id, isGroup, otherId: isGroup ? null : r.user_id, title: isGroup ? (r.conversations?.name ?? "Group") : (r.profiles?.display_name ?? "Unknown") });
    }
    setConvs([...seen.values()]);
  }, []);

  // Session + profile
  useEffect(() => {
    sb().auth.getSession().then(async ({ data }) => {
      if (!data.session) return router.replace("/");
      const uid = data.session.user.id;
      setMeId(uid);
      const p = await sb().from("profiles").select("display_name").eq("id", uid).single();
      if (p.data) setMyName((p.data as { display_name: string }).display_name);
      await loadConvs(uid);
      setLoading(false);
    });
    const { data: sub } = sb().auth.onAuthStateChange((_e, s) => { if (!s) router.replace("/"); });
    return () => sub.subscription.unsubscribe();
  }, [router, loadConvs]);

  // Global presence (who is online) + new-conversation notifications
  useEffect(() => {
    if (!meId) return;
    const pres = sb().channel("online", { config: { presence: { key: meId } } });
    pres.on("presence", { event: "sync" }, () => setOnline(new Set(Object.keys(pres.presenceState()))))
      .subscribe((s) => { if (s === "SUBSCRIBED") void pres.track({ at: Date.now() }); });
    const mine = sb().channel(`mine:${meId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "conversation_members", filter: `user_id=eq.${meId}` }, () => void loadConvs(meId))
      .subscribe();
    return () => { void sb().removeChannel(pres); void sb().removeChannel(mine); };
  }, [meId, loadConvs]);

  // Active conversation: history, reactions, pins, members + realtime
  useEffect(() => {
    if (!active || !meId) return;
    const cid = active.id;
    let cancelled = false;
    setMsgs([]); setReactions([]); setPins([]); setMembers([]); setTypers([]); setReplyTo(null); setEditing(null); setSel(null);
    (async () => {
      const m = await sb().from("messages").select("*").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(50);
      if (cancelled) return;
      if (m.error) return setError(m.error.message);
      const list = ((m.data ?? []) as Msg[]).reverse();
      setMsgs(list);
      const [r, p, mem] = await Promise.all([
        sb().from("message_reactions").select("message_id,user_id,emoji").in("message_id", list.map((x) => x.id)),
        sb().from("pinned_messages").select("message_id").eq("conversation_id", cid),
        sb().from("conversation_members").select("user_id,last_read_at,profiles(display_name)").eq("conversation_id", cid),
      ]);
      if (cancelled) return;
      setReactions((r.data ?? []) as Reaction[]);
      setPins(((p.data ?? []) as { message_id: string }[]).map((x) => x.message_id));
      setMembers(((mem.data ?? []) as unknown as { user_id: string; last_read_at: string; profiles: { display_name: string } | null }[])
        .map((x) => ({ user_id: x.user_id, last_read_at: x.last_read_at, name: x.profiles?.display_name ?? "Unknown" })));
    })();

    const ch = sb().channel(`room:${cid}`, { config: { presence: { key: meId } } })
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `conversation_id=eq.${cid}` }, (p) => {
        const row = p.new as Msg;
        setMsgs((cur) => cur.some((x) => x.id === row.id) ? cur.map((x) => (x.id === row.id ? row : x)) : [...cur, row]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "message_reactions" }, (p) => {
        if (p.eventType === "INSERT") {
          const r = p.new as Reaction;
          setReactions((cur) => cur.some((x) => x.message_id === r.message_id && x.user_id === r.user_id && x.emoji === r.emoji) ? cur : [...cur, r]);
        } else if (p.eventType === "DELETE") {
          const r = p.old as Partial<Reaction>;
          setReactions((cur) => cur.filter((x) => !(x.message_id === r.message_id && x.user_id === r.user_id && x.emoji === r.emoji)));
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "pinned_messages", filter: `conversation_id=eq.${cid}` }, (p) => {
        if (p.eventType === "INSERT") { const id = (p.new as { message_id: string }).message_id; setPins((c) => (c.includes(id) ? c : [...c, id])); }
        else if (p.eventType === "DELETE") { const id = (p.old as { message_id: string }).message_id; setPins((c) => c.filter((x) => x !== id)); }
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversation_members", filter: `conversation_id=eq.${cid}` }, (p) => {
        const row = p.new as { user_id: string; last_read_at: string };
        setMembers((cur) => cur.map((x) => (x.user_id === row.user_id ? { ...x, last_read_at: row.last_read_at } : x)));
      })
      .on("presence", { event: "sync" }, () => {
        const st = ch.presenceState<PresenceMeta>();
        setTypers(Object.entries(st).filter(([k, v]) => k !== meId && v.some((x) => x.typing)).map(([, v]) => v.find((x) => x.name)?.name ?? "Someone"));
      })
      .subscribe((s) => { if (s === "SUBSCRIBED") void ch.track({ typing: false, name: myName }); });
    room.current = ch;
    return () => { cancelled = true; room.current = null; void sb().removeChannel(ch); };
  }, [active, meId, myName]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [msgs.length, typers.length]);

  // Read receipts: mark conversation read up to newest message (one write per new message)
  useEffect(() => {
    if (!active || !meId || !msgs.length) return;
    const newest = msgs[msgs.length - 1].created_at;
    const key = `${active.id}:${newest}`;
    if (readMark.current === key) return;
    readMark.current = key;
    void sb().from("conversation_members").update({ last_read_at: newest }).eq("conversation_id", active.id).eq("user_id", meId);
  }, [msgs, active, meId]);

  // Debounced user search
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !meId) { setResults([]); return; }
    const t = setTimeout(async () => {
      const safe = q.replace(/[%,()]/g, "");
      const { data } = await sb().from("profiles").select("id,display_name,username")
        .or(`username.ilike.%${safe}%,display_name.ilike.%${safe}%`).neq("id", meId).limit(8);
      setResults((data ?? []) as Prof[]);
    }, 300);
    return () => clearTimeout(t);
  }, [query, meId]);

  const nameOf = (uid: string) => (uid === meId ? "You" : members.find((m) => m.user_id === uid)?.name ?? "Unknown");

  async function startChat(p: Prof) {
    setError("");
    const { data, error: err } = await sb().rpc("start_direct_conversation", { other: p.id });
    if (err || !meId) return setError(err?.message ?? "Could not start chat");
    await loadConvs(meId);
    setActive({ id: data as string, title: p.display_name, isGroup: false, otherId: p.id });
    setQuery(""); setResults([]);
  }

  async function createGroup() {
    if (!meId) return;
    if (!grpName.trim() || !grpMembers.length) return setError("Enter a group name and add at least one person.");
    const { data, error: err } = await sb().rpc("create_group", { p_name: grpName.trim(), p_members: grpMembers.map((m) => m.id) });
    if (err) return setError(err.message);
    await loadConvs(meId);
    setActive({ id: data as string, title: grpName.trim(), isGroup: true, otherId: null });
    setGrpMode(false); setGrpName(""); setGrpMembers([]); setQuery(""); setResults([]);
  }

  async function leaveGroup() {
    if (!active || !meId) return;
    const { error: err } = await sb().from("conversation_members").delete().eq("conversation_id", active.id).eq("user_id", meId);
    if (err) return setError(err.message);
    setActive(null); await loadConvs(meId);
  }

  function onType(v: string) {
    setText(v);
    const ch = room.current;
    if (!ch) return;
    void ch.track({ typing: true, name: myName });
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => void ch.track({ typing: false, name: myName }), 2000);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const content = text.trim();
    if (!content || !active || !meId) return;
    setText("");
    if (typingTimer.current) clearTimeout(typingTimer.current);
    void room.current?.track({ typing: false, name: myName });
    if (editing) {
      const { error: err } = await sb().from("messages").update({ content }).eq("id", editing.id);
      if (err) { setError(err.message); setText(content); return; }
      setMsgs((c) => c.map((m) => (m.id === editing.id ? { ...m, content, is_edited: true } : m)));
      setEditing(null);
      return;
    }
    const { data, error: err } = await sb().from("messages")
      .insert({ conversation_id: active.id, sender_id: meId, content, reply_to_message_id: replyTo?.id ?? null }).select().single();
    if (err) { setError(err.message); setText(content); return; }
    const row = data as Msg;
    setMsgs((c) => (c.some((m) => m.id === row.id) ? c : [...c, row]));
    setReplyTo(null);
  }

  async function remove(m: Msg) {
    const { error: err } = await sb().from("messages").update({ is_deleted: true, content: "" }).eq("id", m.id);
    if (err) return setError(err.message);
    setMsgs((c) => c.map((x) => (x.id === m.id ? { ...x, is_deleted: true, content: "" } : x)));
  }

  async function toggleReaction(m: Msg, emoji: string) {
    if (!meId) return;
    const has = reactions.some((r) => r.message_id === m.id && r.user_id === meId && r.emoji === emoji);
    const res = has
      ? await sb().from("message_reactions").delete().eq("message_id", m.id).eq("user_id", meId).eq("emoji", emoji)
      : await sb().from("message_reactions").insert({ message_id: m.id, user_id: meId, emoji });
    if (res.error) return setError(res.error.message);
    setReactions((c) => has ? c.filter((r) => !(r.message_id === m.id && r.user_id === meId && r.emoji === emoji))
      : c.some((r) => r.message_id === m.id && r.user_id === meId && r.emoji === emoji) ? c : [...c, { message_id: m.id, user_id: meId, emoji }]);
  }

  async function togglePin(m: Msg) {
    if (!active || !meId) return;
    const pinned = pins.includes(m.id);
    const res = pinned
      ? await sb().from("pinned_messages").delete().eq("conversation_id", active.id).eq("message_id", m.id)
      : await sb().from("pinned_messages").insert({ conversation_id: active.id, message_id: m.id, pinned_by: meId });
    if (res.error) return setError(res.error.message);
    setPins((c) => (pinned ? c.filter((x) => x !== m.id) : c.includes(m.id) ? c : [...c, m.id]));
  }

  const jump = (id: string) => document.getElementById(`m-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const others = members.filter((m) => m.user_id !== meId);
  const isRead = (m: Msg) => others.length > 0 && others.every((o) => new Date(o.last_read_at) >= new Date(m.created_at));
  const lastPinned = msgs.find((m) => m.id === pins[pins.length - 1]);
  const typingText = typers.length === 0 ? "" : typers.length === 1 ? `${typers[0]} is typing…` : `${typers.slice(0, 2).join(" and ")} are typing…`;

  return (
    <div className={`app${active ? " open" : ""}`}>
      <aside className="side">
        <header>
          <div className="row"><strong>{tab === "chats" ? "Talkie" : "Calls"}</strong><span>{tab === "chats" && <button className="ghost" onClick={() => setGrpMode(!grpMode)}>{grpMode ? "Cancel" : "New group"}</button>} <button className="ghost" onClick={() => sb().auth.signOut()}>Sign out</button></span></div>
          {tab === "chats" && grpMode && (
            <>
              <input aria-label="Group name" placeholder="Group name" value={grpName} onChange={(e) => setGrpName(e.target.value)} />
              <div className="chips">{grpMembers.map((g) => <span key={g.id} className="chip">{g.display_name}</span>)}</div>
              <button onClick={createGroup}>Create group</button>
            </>
          )}
          {tab === "chats" && <input aria-label="Search people" placeholder={grpMode ? "Search people to add" : "Find people to chat with"} value={query} onChange={(e) => setQuery(e.target.value)} />}
        </header>
        {tab === "calls" ? (
          <div className="list">{meId && <CallsList meId={meId} />}</div>
        ) : (
          <div className="list">
            {results.map((p) => (
              <button key={p.id} className="item" onClick={() => (grpMode ? setGrpMembers((c) => (c.some((x) => x.id === p.id) ? c : [...c, p])) : startChat(p))}>
                <Avatar userId={p.id} name={p.display_name} />
                <span><div>{p.display_name}</div><div className="muted">@{p.username} · {grpMode ? "add to group" : "start chat"}</div></span>
              </button>
            ))}
            {loading && <p className="muted" style={{ padding: 14 }}>Loading…</p>}
            {!loading && !convs.length && !results.length && <p className="empty" style={{ padding: 24 }}>No conversations yet.<br />Search for someone to start one.</p>}
            {convs.map((c) => (
              <button key={c.id} className="item" aria-current={active?.id === c.id} onClick={() => setActive(c)}>
                {c.isGroup ? <span className="avatar">#</span> : <Avatar userId={c.otherId} name={c.title} />}
                <span>{c.title}{c.otherId && online.has(c.otherId) && <span className="dot" aria-label="online" />}</span>
              </button>
            ))}
          </div>
        )}
        <nav className="tabs" aria-label="Sections">
          <button aria-current={tab === "chats"} onClick={() => setTab("chats")}><span aria-hidden="true">💬</span>Chats</button>
          <button aria-current={tab === "calls"} onClick={() => setTab("calls")}><span aria-hidden="true">📞</span>Calls</button>
        </nav>
      </aside>
      <main className="chat">
        {!active ? <p className="empty">Select a conversation</p> : (
          <>
            <header>
              <button className="ghost back" onClick={() => setActive(null)} aria-label="Back">←</button>
              {active.isGroup ? <span className="avatar">#</span> : <Avatar userId={active.otherId} name={active.title} />}
              <span className="top"><span><strong>{active.title}</strong><small>{active.isGroup ? `${members.length} members` : active.otherId && online.has(active.otherId) ? "Online" : "Offline"}</small></span></span>
              {active.isGroup && <button className="ghost" onClick={leaveGroup}>Leave</button>}
            </header>
            {lastPinned && <div className="pinbar">📌 <button onClick={() => jump(lastPinned.id)}>{lastPinned.content}</button><span className="muted">{pins.length} pinned</span></div>}
            <div className="msgs">
              {msgs.map((m) => {
                const mine = m.sender_id === meId;
                const parent = m.reply_to_message_id ? msgs.find((x) => x.id === m.reply_to_message_id) : undefined;
                const groups = EMOJIS.map((e) => ({ e, n: reactions.filter((r) => r.message_id === m.id && r.emoji === e).length, me: reactions.some((r) => r.message_id === m.id && r.emoji === e && r.user_id === meId) })).filter((g) => g.n > 0);
                return (
                  <div key={m.id} id={`m-${m.id}`} className={`bubble${mine ? " me" : ""}`}>
                    {active.isGroup && !mine && <div className="sender">{nameOf(m.sender_id)}</div>}
                    {parent && <button className="quote" onClick={() => jump(parent.id)}><strong>{nameOf(parent.sender_id)}</strong><br />{parent.is_deleted ? "Deleted message" : parent.content.slice(0, 80)}</button>}
                    {m.is_deleted ? <em>This message was deleted</em> : m.content}
                    {!m.is_deleted && groups.length > 0 && (
                      <div className="reacts">{groups.map((g) => <button key={g.e} className={`react${g.me ? " mine" : ""}`} onClick={() => toggleReaction(m, g.e)} aria-label={`React ${g.e}`}>{g.e} {g.n}</button>)}</div>
                    )}
                    <small>
                      {pins.includes(m.id) && "📌 "}{m.is_edited && !m.is_deleted && "edited · "}
                      {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {mine && !m.is_deleted && <span className={`ticks${isRead(m) ? " read" : ""}`} aria-label={isRead(m) ? "Read" : "Sent"}>{isRead(m) ? "✓✓" : "✓"}</span>}
                      {!m.is_deleted && <button className="mini" onClick={() => setSel(sel === m.id ? null : m.id)} aria-label="Message actions">⋯</button>}
                    </small>
                    {sel === m.id && !m.is_deleted && (
                      <div className="acts">
                        {EMOJIS.map((e) => <button key={e} onClick={() => { void toggleReaction(m, e); setSel(null); }} aria-label={`React ${e}`}>{e}</button>)}
                        <button onClick={() => { setReplyTo(m); setEditing(null); setSel(null); }}>Reply</button>
                        <button onClick={() => { void togglePin(m); setSel(null); }}>{pins.includes(m.id) ? "Unpin" : "Pin"}</button>
                        {mine && <button onClick={() => { setEditing(m); setReplyTo(null); setText(m.content); setSel(null); }}>Edit</button>}
                        {mine && <button onClick={() => { void remove(m); setSel(null); }}>Delete</button>}
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={bottom} />
            </div>
            <div className="typing" aria-live="polite">{typingText}</div>
            {(replyTo || editing) && (
              <div className="banner">
                <span>{editing ? "Editing message" : `Replying to ${nameOf(replyTo!.sender_id)}: ${replyTo!.content.slice(0, 60)}`}</span>
                <button className="ghost" onClick={() => { setReplyTo(null); setEditing(null); setText(""); }}>Cancel</button>
              </div>
            )}
            <form className="composer" onSubmit={send}>
              <input aria-label="Message" placeholder="Type a message" value={text} onChange={(e) => onType(e.target.value)} maxLength={4000} />
              <button>{editing ? "Save" : "Send"}</button>
            </form>
          </>
        )}
        {error && <div className="err" role="alert" style={{ padding: 8 }} onClick={() => setError("")}>{error}</div>}
      </main>
      {meId && <CallLayer meId={meId} myName={myName} peer={active && !active.isGroup && active.otherId ? { id: active.otherId, name: active.title, conversationId: active.id } : null} />}
    </div>
  );
}
