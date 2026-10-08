"use client";
import { useCallback, useEffect, useState } from "react";
import { sb } from "@/lib/supabase";

type Row = {
  id: string; caller_id: string; receiver_id: string; call_type: "VOICE" | "VIDEO"; status: string;
  duration: number | null; created_at: string;
  caller: { display_name: string } | null; receiver: { display_name: string } | null;
};

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function CallsList({ meId }: { meId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await sb().from("call_history")
      .select("id,caller_id,receiver_id,call_type,status,duration,created_at,caller:profiles!call_history_caller_id_fkey(display_name),receiver:profiles!call_history_receiver_id_fkey(display_name)")
      .order("created_at", { ascending: false }).limit(60);
    if (error) setErr(error.message); else setRows((data ?? []) as unknown as Row[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const h = () => void load();
    window.addEventListener("talkie:call-logged", h);
    return () => window.removeEventListener("talkie:call-logged", h);
  }, [load]);

  async function callBack(r: Row, kind: "VOICE" | "VIDEO") {
    const outgoing = r.caller_id === meId;
    const other = outgoing ? r.receiver_id : r.caller_id;
    const name = (outgoing ? r.receiver : r.caller)?.display_name ?? "Unknown";
    const { data, error } = await sb().rpc("start_direct_conversation", { other });
    if (error) return setErr(error.message);
    window.dispatchEvent(new CustomEvent("talkie:call", { detail: { id: other, name, conversationId: data as string, kind } }));
  }

  if (loading) return <p className="muted" style={{ padding: 14 }}>Loading…</p>;
  if (!rows.length) return <p className="empty" style={{ padding: 24 }}>No calls yet.<br />Start one from a chat.</p>;

  return (
    <>
      {err && <div className="err" role="alert" style={{ padding: 8 }}>{err}</div>}
      {rows.map((r) => {
        const outgoing = r.caller_id === meId;
        const name = (outgoing ? r.receiver : r.caller)?.display_name ?? "Unknown";
        const missed = !outgoing && r.status === "MISSED";
        const label = missed ? "Missed" : r.status === "REJECTED" ? (outgoing ? "Declined" : "Declined") : r.status === "MISSED" ? "No answer" : r.duration ? fmt(r.duration) : "Call";
        return (
          <div key={r.id} className="crow">
            <span className="avatar">{(name[0] ?? "?").toUpperCase()}</span>
            <div className="grow">
              <div className={missed ? "miss" : undefined}>{name}</div>
              <div className={`muted${missed ? " miss" : ""}`}>
                {outgoing ? "↗" : "↙"} {r.call_type === "VIDEO" ? "Video" : "Voice"} · {label} · {new Date(r.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
            <button onClick={() => callBack(r, "VOICE")} aria-label={`Voice call ${name}`}>📞</button>
            <button onClick={() => callBack(r, "VIDEO")} aria-label={`Video call ${name}`}>📹</button>
          </div>
        );
      })}
    </>
  );
}
