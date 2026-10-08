"use client";
import { useEffect, useRef, useState } from "react";
import { sb } from "@/lib/supabase";
import { WebRTCService, type CallKind, type CallState } from "@/lib/webrtc/webrtc-service";
import "./calls.css";
import "./calls-mini.css";

type Peer = { id: string; name: string; conversationId: string };
type SigType = "call-start" | "call-accept" | "call-reject" | "call-end" | "offer" | "answer" | "ice-candidate";
type Sig = {
  type: SigType; from: string; callId: string; kind?: CallKind; name?: string; conv?: string;
  sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit;
};
type SigRow = { call_id: string; from_id: string; type: SigType; payload: Partial<Sig>; created_at: string };
type Call = { phase: "outgoing" | "incoming" | "connecting" | "connected"; kind: CallKind; peerId: string; peerName: string; conv: string; callId: string; outgoing: boolean; startedAt: number | null };
type Outcome = "ENDED" | "REJECTED" | "MISSED";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const reason = (e: unknown) =>
  e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "NotFoundError") ? "Allow microphone/camera access to make calls."
    : e instanceof Error ? e.message : "Call failed";

/** Signaling is stored in `call_signals` and delivered via Postgres Changes (reliable, RLS-protected). */
export function CallLayer({ meId, myName, peer }: { meId: string; myName: string; peer: Peer | null }) {
  const [call, setCall] = useState<Call | null>(null);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [mini, setMini] = useState(false);
  const [secs, setSecs] = useState(0);
  const [note, setNote] = useState("");
  const [tick, setTick] = useState(0);
  const cur = useRef<Call | null>(null);
  const svc = useRef<WebRTCService | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const localRef = useRef<HTMLVideoElement>(null);
  const ovRef = useRef<HTMLDivElement>(null);
  const handlerRef = useRef<(m: Sig) => void>(() => {});

  function update(c: Call | null) { cur.current = c; setCall(c); }

  async function send(to: string, m: Omit<Sig, "from">) {
    const { type, callId, ...payload } = m;
    const { error } = await sb().from("call_signals").insert({ call_id: callId, from_id: meId, to_id: to, type, payload });
    if (error) throw new Error(error.message.includes("row-level") ? "You can't call this person (blocked?)" : "Could not reach the other person");
  }

  function cleanup() {
    const c = cur.current;
    if (timer.current) clearTimeout(timer.current);
    svc.current?.close(); svc.current = null;
    if (c) void sb().from("call_signals").delete().eq("call_id", c.callId).then(() => {});
    update(null); setMuted(false); setCamOff(false); setMini(false); setSecs(0);
  }

  async function log(c: Call, status: Outcome, dur: number) {
    await sb().from("call_history").insert({
      caller_id: meId, receiver_id: c.peerId, conversation_id: c.conv || null, call_type: c.kind, status,
      started_at: c.startedAt ? new Date(c.startedAt).toISOString() : null, ended_at: new Date().toISOString(), duration: dur,
    });
    const icon = c.kind === "VIDEO" ? "📹" : "📞";
    const label = c.kind === "VIDEO" ? "Video call" : "Voice call";
    const content = status === "ENDED" ? `${icon} ${label} · ${fmt(dur)}` : status === "REJECTED" ? `${icon} ${label} declined` : `${icon} Missed ${label.toLowerCase()}`;
    if (c.conv) await sb().from("messages").insert({ conversation_id: c.conv, sender_id: meId, content });
  }

  function finish(status: Outcome, notify: boolean) {
    const c = cur.current;
    if (!c) return;
    const dur = c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0;
    const done = notify ? send(c.peerId, { type: "call-end", callId: c.callId }).catch(() => {}) : Promise.resolve();
    if (c.outgoing) void log(c, status, dur).catch(() => {});
    // Let the end signal go out before clearing this call's signal rows
    void done.then(() => cleanup());
    svc.current?.close(); svc.current = null; update(null);
  }

  function onState(st: CallState) {
    const c = cur.current;
    if (!c) return;
    if (st === "connected" && !c.startedAt) update({ ...c, phase: "connected", startedAt: Date.now() });
    else if (st === "failed") { setNote("Connection failed. A TURN server may be needed on this network."); finish(c.startedAt ? "ENDED" : "MISSED", true); }
  }

  function makeService(peerId: string, callId: string) {
    const s = new WebRTCService((cand) => void send(peerId, { type: "ice-candidate", callId, candidate: cand }).catch(() => {}), onState);
    svc.current = s;
    return s;
  }

  async function startCall(kind: CallKind) {
    if (!peer || cur.current) return;
    const callId = crypto.randomUUID();
    try {
      const s = makeService(peer.id, callId);
      update({ phase: "outgoing", kind, peerId: peer.id, peerName: peer.name, conv: peer.conversationId, callId, outgoing: true, startedAt: null });
      await s.startMedia(kind);
      setTick((t) => t + 1);
      await send(peer.id, { type: "call-start", callId, kind, name: myName, conv: peer.conversationId });
      timer.current = setTimeout(() => {
        if (cur.current?.callId === callId && !cur.current.startedAt && cur.current.phase === "outgoing") { setNote("No answer"); finish("MISSED", true); }
      }, 40000);
    } catch (e) { setNote(reason(e)); cleanup(); }
  }

  async function accept() {
    const c = cur.current;
    if (!c || c.phase !== "incoming") return;
    try {
      const s = makeService(c.peerId, c.callId);
      update({ ...c, phase: "connecting" });
      await s.startMedia(c.kind);
      setTick((t) => t + 1);
      await send(c.peerId, { type: "call-accept", callId: c.callId });
    } catch (e) {
      void send(c.peerId, { type: "call-reject", callId: c.callId }).catch(() => {});
      setNote(reason(e)); cleanup();
    }
  }

  function reject() {
    const c = cur.current;
    if (!c) return;
    void send(c.peerId, { type: "call-reject", callId: c.callId }).catch(() => {}).then(() => cleanup());
    svc.current?.close(); svc.current = null; update(null);
  }

  async function handle(m: Sig) {
    const c = cur.current;
    if (m.type === "call-start") {
      if (c) { void send(m.from, { type: "call-reject", callId: m.callId }).catch(() => {}); return; }
      update({ phase: "incoming", kind: m.kind ?? "VOICE", peerId: m.from, peerName: m.name ?? "Someone", conv: m.conv ?? "", callId: m.callId, outgoing: false, startedAt: null });
      if (document.hidden && "Notification" in window && Notification.permission === "granted") new Notification(`${m.name ?? "Someone"} is calling`, { body: "Open Talkie to answer" });
      return;
    }
    if (!c || c.callId !== m.callId) return;
    try {
      switch (m.type) {
        case "call-accept": {
          if (timer.current) clearTimeout(timer.current);
          update({ ...c, phase: "connecting" });
          const offer = await svc.current!.createOffer();
          await send(c.peerId, { type: "offer", callId: c.callId, sdp: offer });
          break;
        }
        case "offer": {
          const answer = await svc.current!.acceptOffer(m.sdp!);
          await send(c.peerId, { type: "answer", callId: c.callId, sdp: answer });
          break;
        }
        case "answer": await svc.current!.acceptAnswer(m.sdp!); break;
        case "ice-candidate": await svc.current!.addCandidate(m.candidate!); break;
        case "call-reject": setNote("Call declined"); finish("REJECTED", false); break;
        case "call-end": setNote(c.phase === "incoming" ? "Missed call" : "Call ended"); finish(c.startedAt ? "ENDED" : "MISSED", false); break;
        default: break;
      }
    } catch (e) { setNote(reason(e)); finish("ENDED", true); }
  }
  handlerRef.current = (m) => void handle(m);

  // Incoming signals (rows addressed to me)
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
    const ch = sb().channel(`signals:${meId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "call_signals", filter: `to_id=eq.${meId}` }, (p) => {
        const r = p.new as SigRow;
        if (Date.now() - new Date(r.created_at).getTime() > 90000) return; // ignore stale
        handlerRef.current({ ...r.payload, type: r.type, from: r.from_id, callId: r.call_id });
      }).subscribe();
    return () => { void sb().removeChannel(ch); svc.current?.close(); svc.current = null; };
  }, [meId]);

  // Ringtone while a call is incoming
  useEffect(() => {
    if (call?.phase !== "incoming") return;
    let ctx: AudioContext | null = null;
    try { ctx = new AudioContext(); } catch { ctx = null; }
    const beep = () => {
      if (!ctx) return;
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 480; g.gain.value = 0.15; o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.5);
    };
    beep();
    const id = setInterval(beep, 1600);
    return () => { clearInterval(id); void ctx?.close(); };
  }, [call?.phase]);

  // Attach media streams
  useEffect(() => {
    if (!svc.current) return;
    if (remoteRef.current) remoteRef.current.srcObject = svc.current.remoteStream;
    if (localRef.current) localRef.current.srcObject = svc.current.localStream;
  }, [call?.phase, tick]);

  useEffect(() => {
    const start = call?.startedAt;
    if (!start) return;
    const id = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [call?.startedAt]);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(""), 4000);
    return () => clearTimeout(id);
  }, [note]);

  const status = !call ? "" : call.phase === "incoming" ? `Incoming ${call.kind === "VIDEO" ? "video" : "voice"} call` : call.phase === "outgoing" ? "Calling…" : call.phase === "connecting" ? "Connecting…" : fmt(secs);

  return (
    <>
      {peer && !call && (
        <div className="callbtns">
          <button className="ghost" onClick={() => startCall("VOICE")} aria-label="Voice call">📞</button>
          <button className="ghost" onClick={() => startCall("VIDEO")} aria-label="Video call">📹</button>
        </div>
      )}
      {call && (
        <div className={`callov${mini && call.phase !== "incoming" ? " mini" : ""}`} ref={ovRef} role="dialog" aria-label="Call">
          <video ref={remoteRef} autoPlay playsInline className={call.kind === "VIDEO" ? "remote" : "remote off"} />
          <div className="calltop"><strong>{call.peerName}</strong><span>{status}</span></div>
          {!(call.kind === "VIDEO" && call.phase === "connected") && (
            <div className="callmid"><span className="avatar">{(call.peerName[0] ?? "?").toUpperCase()}</span><h2>{call.peerName}</h2><p>{status}</p></div>
          )}
          {call.kind === "VIDEO" && call.phase !== "incoming" && <video ref={localRef} autoPlay playsInline muted className="local" />}
          <div className="ctrls">
            {call.phase === "incoming" ? (
              <>
                <button className="acc" onClick={accept}>Accept</button>
                <button className="rej" onClick={reject}>Decline</button>
              </>
            ) : (
              <>
                <button onClick={() => setMini(!mini)}>{mini ? "Expand" : "Minimize"}</button>
                <button onClick={() => { svc.current?.setMuted(!muted); setMuted(!muted); }}>{muted ? "Unmute" : "Mute"}</button>
                {call.kind === "VIDEO" && <button onClick={() => { svc.current?.setCameraOn(camOff); setCamOff(!camOff); }}>{camOff ? "Camera on" : "Camera off"}</button>}
                {call.kind === "VIDEO" && !mini && <button onClick={() => void ovRef.current?.requestFullscreen()}>Fullscreen</button>}
                <button className="rej" onClick={() => finish(call.startedAt ? "ENDED" : "MISSED", true)}>End</button>
              </>
            )}
          </div>
        </div>
      )}
      {note && <div className="toast" role="status">{note}</div>}
    </>
  );
}
