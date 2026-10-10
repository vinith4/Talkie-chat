"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import { Avatar } from "@/components/Avatar";
import "./info.css";

type P = { display_name: string; username: string; bio: string | null; avatar_url: string | null };
type Target =
  | { kind: "user"; id: string; name: string }
  | { kind: "group"; name: string; members: { id: string; name: string }[] };

/** WhatsApp-style contact / group info: tap a chat header to open it. */
export function InfoSheet({ meId, target, online, onClose }: { meId: string; target: Target; online: Set<string>; onClose: () => void }) {
  const [uid, setUid] = useState<string | null>(target.kind === "user" ? target.id : null);
  const [p, setP] = useState<P | null>(null);
  const [zoom, setZoom] = useState(false);
  const [err, setErr] = useState("");
  const fromGroup = target.kind === "group";

  useEffect(() => {
    setP(null);
    if (!uid) return;
    let live = true;
    void Promise.resolve(sb().from("profiles").select("display_name,username,bio,avatar_url").eq("id", uid).single()).then(({ data }) => { if (live) setP(data as P | null); });
    return () => { live = false; };
  }, [uid]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { if (zoom) setZoom(false); else onClose(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [zoom, onClose]);

  async function call(kind: "VOICE" | "VIDEO") {
    if (!uid) return;
    const { data, error } = await sb().rpc("start_direct_conversation", { other: uid });
    if (error) return setErr(error.message);
    window.dispatchEvent(new CustomEvent("talkie:call", { detail: { id: uid, name: p?.display_name ?? "Contact", conversationId: data as string, kind } }));
    onClose();
  }

  const name = p?.display_name ?? (target.kind === "user" ? target.name : "");

  return (
    <div className="infoov" onClick={onClose} role="presentation">
      <div className="infocard" role="dialog" aria-label={uid ? "Contact info" : "Group info"} onClick={(e) => e.stopPropagation()}>
        {uid ? (
          <>
            {fromGroup && <div className="irow" style={{ justifyContent: "flex-start" }}><button className="ghost" onClick={() => setUid(null)}>← Group</button></div>}
            <button className="iavbtn" onClick={() => p?.avatar_url && setZoom(true)} aria-label="View profile photo">
              <Avatar userId={uid} name={name} className="iavatar" />
            </button>
            <h2>{name}</h2>
            {p && <div className="sub">@{p.username} · {online.has(uid) ? "Online" : "Offline"}</div>}
            <div className="about"><small>About</small>{p ? (p.bio?.trim() || "Hey there! I am using Talkie") : "…"}</div>
            {uid !== meId && (
              <div className="irow">
                <button onClick={() => call("VOICE")}>📞 Voice call</button>
                <button onClick={() => call("VIDEO")}>📹 Video call</button>
              </div>
            )}
            {err && <div className="err" role="alert">{err}</div>}
          </>
        ) : target.kind === "group" ? (
          <>
            <div className="iavatar">#</div>
            <h2>{target.name}</h2>
            <div className="sub">Group · {target.members.length} members</div>
            <div className="mlist">
              {target.members.map((m) => (
                <button key={m.id} className="mrow" onClick={() => setUid(m.id)}>
                  <Avatar userId={m.id} name={m.name} />
                  <span>{m.id === meId ? `${m.name} (You)` : m.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
      {zoom && p?.avatar_url && (
        <div className="lightbox" onClick={(e) => { e.stopPropagation(); setZoom(false); }} role="dialog" aria-label="Profile photo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.avatar_url} alt={`${name}'s profile photo`} />
        </div>
      )}
    </div>
  );
}
