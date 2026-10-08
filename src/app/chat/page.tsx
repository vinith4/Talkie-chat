"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { sb } from "@/lib/supabase";

type Msg = { id: string; conversation_id: string; sender_id: string; content: string; is_deleted: boolean; created_at: string };
type Prof = { id: string; display_name: string; username: string };
type Conv = { id: string; title: string };
type MemberRow = { conversation_id: string; conversations: { type: string; name: string | null } | null; profiles: { display_name: string } | null };

const initial = (s: string) => (s.trim()[0] ?? "?").toUpperCase();

export default function ChatPage() {
  const router = useRouter();
  const [meId, setMeId] = useState<string | null>(null);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [active, setActive] = useState<Conv | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Prof[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);

  const loadConvs = useCallback(async (uid: string) => {
    const mine = await sb().from("conversation_members").select("conversation_id").eq("user_id", uid);
    if (mine.error) return setError(mine.error.message);
    const ids = (mine.data ?? []).map((r) => r.conversation_id as string);
    if (!ids.length) { setConvs([]); return; }
    const { data, error: err } = await sb()
      .from("conversation_members")
      .select("conversation_id, conversations(type,name), profiles(display_name)")
      .in("conversation_id", ids)
      .neq("user_id", uid);
    if (err) return setError(err.message);
    const seen = new Map<string, Conv>();
    for (const r of (data ?? []) as unknown as MemberRow[]) {
      const title = r.conversations?.type === "GROUP" ? (r.conversations.name ?? "Group") : (r.profiles?.display_name ?? "Unknown");
      if (!seen.has(r.conversation_id)) seen.set(r.conversation_id, { id: r.conversation_id, title });
    }
    setConvs([...seen.values()]);
  }, []);

  useEffect(() => {
    sb().auth.getSession().then(async ({ data }) => {
      if (!data.session) return router.replace("/");
      setMeId(data.session.user.id);
      await loadConvs(data.session.user.id);
      setLoading(false);
    });
    const { data: sub } = sb().auth.onAuthStateChange((_e, s) => { if (!s) router.replace("/"); });
    return () => sub.subscription.unsubscribe();
  }, [router, loadConvs]);

  // Load history + subscribe to realtime inserts for the active conversation
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setMsgs([]);
    sb().from("messages").select("*").eq("conversation_id", active.id).order("created_at", { ascending: false }).limit(50)
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) setError(err.message); else setMsgs(((data ?? []) as Msg[]).reverse());
      });
    const ch = sb().channel(`msgs:${active.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `conversation_id=eq.${active.id}` }, (p) => {
        const row = p.new as Msg;
        setMsgs((cur) => cur.some((m) => m.id === row.id) ? cur.map((m) => (m.id === row.id ? row : m)) : [...cur, row]);
      }).subscribe();
    return () => { cancelled = true; void sb().removeChannel(ch); };
  }, [active]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [msgs]);

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

  async function startChat(p: Prof) {
    setError("");
    const { data, error: err } = await sb().rpc("start_direct_conversation", { other: p.id });
    if (err || !meId) return setError(err?.message ?? "Could not start chat");
    await loadConvs(meId);
    setActive({ id: data as string, title: p.display_name });
    setQuery(""); setResults([]);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const content = text.trim();
    if (!content || !active || !meId) return;
    setText("");
    const { data, error: err } = await sb().from("messages").insert({ conversation_id: active.id, sender_id: meId, content }).select().single();
    if (err) { setError(err.message); setText(content); return; }
    const row = data as Msg;
    setMsgs((cur) => (cur.some((m) => m.id === row.id) ? cur : [...cur, row]));
  }

  async function remove(m: Msg) {
    const { error: err } = await sb().from("messages").update({ is_deleted: true }).eq("id", m.id);
    if (err) setError(err.message);
  }

  return (
    <div className={`app${active ? " open" : ""}`}>
      <aside className="side">
        <header>
          <div className="row"><strong>Talkie</strong><button className="ghost" onClick={() => sb().auth.signOut()}>Sign out</button></div>
          <input aria-label="Search people" placeholder="Find people to chat with" value={query} onChange={(e) => setQuery(e.target.value)} />
        </header>
        <div className="list">
          {results.map((p) => (
            <button key={p.id} className="item" onClick={() => startChat(p)}>
              <span className="avatar">{initial(p.display_name)}</span>
              <span><div>{p.display_name}</div><div className="muted">@{p.username} · start chat</div></span>
            </button>
          ))}
          {loading && <p className="muted" style={{ padding: 14 }}>Loading…</p>}
          {!loading && !convs.length && !results.length && <p className="empty" style={{ padding: 24 }}>No conversations yet.<br />Search for someone to start one.</p>}
          {convs.map((c) => (
            <button key={c.id} className="item" aria-current={active?.id === c.id} onClick={() => setActive(c)}>
              <span className="avatar">{initial(c.title)}</span><span>{c.title}</span>
            </button>
          ))}
        </div>
      </aside>
      <main className="chat">
        {!active ? <p className="empty">Select a conversation</p> : (
          <>
            <header>
              <button className="ghost back" onClick={() => setActive(null)} aria-label="Back">←</button>
              <span className="avatar">{initial(active.title)}</span><strong>{active.title}</strong>
            </header>
            <div className="msgs">
              {msgs.map((m) => (
                <div key={m.id} className={`bubble${m.sender_id === meId ? " me" : ""}`}>
                  {m.is_deleted ? <em>This message was deleted</em> : m.content}
                  <small>
                    {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {m.sender_id === meId && !m.is_deleted && <> · <button className="ghost" style={{ padding: "0 6px", fontSize: 11, color: "inherit", border: 0 }} onClick={() => remove(m)} aria-label="Delete message">delete</button></>}
                  </small>
                </div>
              ))}
              <div ref={bottom} />
            </div>
            <form className="composer" onSubmit={send}>
              <input aria-label="Message" placeholder="Type a message" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
              <button>Send</button>
            </form>
          </>
        )}
        {error && <div className="err" role="alert" style={{ padding: 8 }} onClick={() => setError("")}>{error}</div>}
      </main>
    </div>
  );
}
