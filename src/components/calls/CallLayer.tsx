"use client";
import { useEffect, useRef, useState } from "react";
import { sb } from "@/lib/supabase";
import { WebRTCService, getIceServers, type CallKind, type CallState } from "@/lib/webrtc/webrtc-service";
import { audioRunning, chime, startRing, unlockAudio } from "@/lib/webrtc/sounds";
import { enablePush, pushSupported, registerWorker } from "@/lib/push";
import { Avatar } from "@/components/Avatar";
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
type Corner = "tl" | "tr" | "bl" | "br";
type SinkEl = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const BT = /bluetooth|buds|airpods/i;
const reason = (e: unknown) =>
  e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "NotFoundError") ? "Allow microphone/camera access to make calls."
    : e instanceof DOMException && e.name === "NotReadableError" ? "Camera or microphone is being used by another app or window."
    : e instanceof Error ? e.message : "Call failed";

function Ico({ children }: { children: React.ReactNode }) {
  return <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}
const Phone = ({ rot = 0 }: { rot?: number }) => (
  <Ico><path transform={`rotate(${rot} 12 12)`} d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" fill="currentColor" /></Ico>
);

/** Signaling is stored in `call_signals` and delivered via Postgres Changes (reliable, RLS-protected). */
export function CallLayer({ meId, myName, peer }: { meId: string; myName: string; peer: Peer | null }) {
  const [call, setCall] = useState<Call | null>(null);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [mini, setMini] = useState(false);
  const [sheet, setSheet] = useState<null | "audio" | "more">(null);
  const [devs, setDevs] = useState<{ outs: MediaDeviceInfo[]; ins: MediaDeviceInfo[] }>({ outs: [], ins: [] });
  const [outId, setOutId] = useState("");
  const [inId, setInId] = useState("");
  const [secs, setSecs] = useState(0);
  const [note, setNote] = useState("");
  const [tick, setTick] = useState(0);
  const [corner, setCorner] = useState<Corner>("tr");
  const [dragXY, setDragXY] = useState<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [front, setFront] = useState(true);
  const cur = useRef<Call | null>(null);
  const svc = useRef<WebRTCService | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const localRef = useRef<HTMLVideoElement>(null);
  const ovRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const handlerRef = useRef<(m: Sig) => void>(() => {});
  const actRef = useRef<(a: string) => void>(() => {});
  const startRef = useRef<(k: CallKind, p?: Peer | null) => void>(() => {});

  // Self-preview size and position adapt to the screen (portrait / landscape / desktop)
  const land = box.w > box.h;
  const sw = land ? Math.min(220, box.w * 0.22) : Math.min(150, Math.max(90, box.w * 0.28));
  const sh = land ? sw * 0.62 : sw * 1.4;
  const cx = corner.endsWith("l") ? 12 : Math.max(12, box.w - sw - 12);
  const cy = corner.startsWith("t") ? 76 : Math.max(76, box.h - sh - 140);
  const self = { x: dragXY?.x ?? cx, y: dragXY?.y ?? cy, w: sw, h: sh };

  function update(c: Call | null) { cur.current = c; setCall(c); }

  async function send(to: string, m: Omit<Sig, "from">) {
    const { type, callId, ...payload } = m;
    const { error } = await sb().from("call_signals").insert({ call_id: callId, from_id: meId, to_id: to, type, payload });
    if (error) throw new Error(error.message.includes("row-level") ? "You can't call this person (blocked?)" : "Could not reach the other person");
  }

  function cleanup(callId?: string) {
    if (timer.current) clearTimeout(timer.current);
    svc.current?.close(); svc.current = null;
    if (callId) void sb().from("call_signals").delete().eq("call_id", callId).then(() => {});
    update(null); setMuted(false); setCamOff(false); setMini(false); setSheet(null); setOutId(""); setInId(""); setSecs(0);
    setCorner("tr"); setDragXY(null); setFront(true);
  }

  async function log(c: Call, status: Outcome, dur: number) {
    await sb().from("call_history").insert({
      caller_id: meId, receiver_id: c.peerId, conversation_id: c.conv || null, call_type: c.kind, status,
      started_at: c.startedAt ? new Date(c.startedAt).toISOString() : null, ended_at: new Date().toISOString(), duration: dur,
    });
    window.dispatchEvent(new Event("talkie:call-logged"));
    const icon = c.kind === "VIDEO" ? "📹" : "📞";
    const label = c.kind === "VIDEO" ? "Video call" : "Voice call";
    const content = status === "ENDED" ? `${icon} ${label} · ${fmt(dur)}` : status === "REJECTED" ? `${icon} ${label} declined` : `${icon} Missed ${label.toLowerCase()}`;
    if (c.conv) await sb().from("messages").insert({ conversation_id: c.conv, sender_id: meId, content });
  }

  function finish(status: Outcome, notify: boolean) {
    const c = cur.current;
    if (!c) return;
    const dur = c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0;
    chime("end");
    const done = notify ? send(c.peerId, { type: "call-end", callId: c.callId }).catch(() => {}) : Promise.resolve();
    if (c.outgoing) void log(c, status, dur).catch(() => {});
    void done.then(() => { void sb().from("call_signals").delete().eq("call_id", c.callId).then(() => {}); });
    cleanup();
  }

  function onState(st: CallState) {
    const c = cur.current;
    if (!c) return;
    if (st === "connected" && !c.startedAt) { chime("connect"); void svc.current?.tuneSenders(); update({ ...c, phase: "connected", startedAt: Date.now() }); }
    else if (st === "failed") { setNote("Connection failed. A TURN server may be needed on this network."); finish(c.startedAt ? "ENDED" : "MISSED", true); }
  }

  function makeService(peerId: string, callId: string) {
    const s = new WebRTCService(
      (cand) => void send(peerId, { type: "ice-candidate", callId, candidate: cand }).catch(() => {}),
      onState, getIceServers(), () => setTick((t) => t + 1),
    );
    svc.current = s;
    return s;
  }

  async function startCall(kind: CallKind, p: Peer | null = peer) {
    if (!p || cur.current) return;
    unlockAudio();
    const callId = crypto.randomUUID();
    try {
      const s = makeService(p.id, callId);
      update({ phase: "outgoing", kind, peerId: p.id, peerName: p.name, conv: p.conversationId, callId, outgoing: true, startedAt: null });
      await s.startMedia(kind);
      setTick((t) => t + 1);
      await send(p.id, { type: "call-start", callId, kind, name: myName, conv: p.conversationId });
      timer.current = setTimeout(() => {
        if (cur.current?.callId === callId && !cur.current.startedAt && cur.current.phase === "outgoing") { setNote("No answer"); finish("MISSED", true); }
      }, 40000);
    } catch (e) { setNote(reason(e)); cleanup(callId); }
  }
  startRef.current = (k, p) => void startCall(k, p ?? peer);

  async function accept() {
    const c = cur.current;
    if (!c || c.phase !== "incoming") return;
    unlockAudio();
    try {
      const s = makeService(c.peerId, c.callId);
      update({ ...c, phase: "connecting" });
      await s.startMedia(c.kind);
      setTick((t) => t + 1);
      await send(c.peerId, { type: "call-accept", callId: c.callId });
    } catch (e) {
      void send(c.peerId, { type: "call-reject", callId: c.callId }).catch(() => {});
      setNote(reason(e)); cleanup(c.callId);
    }
  }

  function reject() {
    const c = cur.current;
    if (!c) return;
    void send(c.peerId, { type: "call-reject", callId: c.callId }).catch(() => {});
    cleanup();
  }

  function toggleMute() { svc.current?.setMuted(!muted); setMuted(!muted); }
  function toggleCam() { svc.current?.setCameraOn(camOff); setCamOff(!camOff); }
  function flip() { svc.current?.switchCamera().then(() => { setFront((f) => !f); setTick((t) => t + 1); }).catch((e) => setNote(reason(e))); }
  function endCall() { const c = cur.current; if (c) finish(c.startedAt ? "ENDED" : "MISSED", true); }

  // Draggable self-preview: drag anywhere, snaps to the nearest corner on release
  function onSelfDown(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onSelfMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    const ov = ovRef.current;
    if (!d || !ov) return;
    const b = ov.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - d.dx - b.left, 6), Math.max(6, b.width - self.w - 6));
    const y = Math.min(Math.max(e.clientY - d.dy - b.top, 6), Math.max(6, b.height - self.h - 6));
    setDragXY({ x, y });
  }
  function onSelfUp() {
    if (!dragRef.current) return;
    dragRef.current = null;
    const mx = self.x + self.w / 2;
    const my = self.y + self.h / 2;
    setCorner(`${my < box.h / 2 ? "t" : "b"}${mx < box.w / 2 ? "l" : "r"}` as Corner);
    setDragXY(null);
  }

  async function loadDevs() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const d = await navigator.mediaDevices.enumerateDevices();
    setDevs({ outs: d.filter((x) => x.kind === "audiooutput"), ins: d.filter((x) => x.kind === "audioinput") });
  }
  async function chooseOut(id: string) {
    const el = audioRef.current as SinkEl | null;
    if (!el?.setSinkId) { setNote("This browser can't switch speakers. Your system's selected output is used."); return; }
    try { await el.setSinkId(id); setOutId(id); } catch (e) { setNote(reason(e)); }
  }
  async function chooseIn(id: string) {
    try { await svc.current?.switchMic(id); setInId(id); } catch (e) { setNote(reason(e)); }
  }

  async function handle(m: Sig) {
    const c = cur.current;
    if (m.type === "call-start") {
      if (c) { void send(m.from, { type: "call-reject", callId: m.callId }).catch(() => {}); return; }
      update({ phase: "incoming", kind: m.kind ?? "VOICE", peerId: m.from, peerName: m.name ?? "Someone", conv: m.conv ?? "", callId: m.callId, outgoing: false, startedAt: null });
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
  actRef.current = (a) => {
    const c = cur.current;
    if (!c) return;
    if (a === "accept" && c.phase === "incoming") void accept();
    else if (a === "decline" && c.phase === "incoming") reject();
    else if (a === "mute" && c.phase !== "incoming") toggleMute();
    else if (a === "end" && c.phase !== "incoming") endCall();
  };

  // Incoming signals (rows addressed to me) + catch-up for a call that rang while the app was closed
  useEffect(() => {
    const ch = sb().channel(`signals:${meId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "call_signals", filter: `to_id=eq.${meId}` }, (p) => {
        const r = p.new as SigRow;
        if (Date.now() - new Date(r.created_at).getTime() > 90000) return; // ignore stale
        handlerRef.current({ ...r.payload, type: r.type, from: r.from_id, callId: r.call_id });
      }).subscribe((s) => {
        if (s !== "SUBSCRIBED") return;
        const since = new Date(Date.now() - 45000).toISOString();
        void sb().from("call_signals").select("call_id,from_id,type,payload,created_at").eq("to_id", meId).gte("created_at", since).order("created_at", { ascending: true })
          .then(({ data }) => {
            const rows = (data ?? []) as SigRow[];
            const ended = new Set(rows.filter((r) => r.type === "call-end").map((r) => r.call_id));
            const start = [...rows].reverse().find((r) => r.type === "call-start" && !ended.has(r.call_id));
            if (!start || cur.current) return;
            handlerRef.current({ ...start.payload, type: start.type, from: start.from_id, callId: start.call_id });
            if (new URLSearchParams(window.location.search).get("answer")) setTimeout(() => actRef.current("accept"), 400);
          });
      });
    return () => { void sb().removeChannel(ch); svc.current?.close(); svc.current = null; };
  }, [meId]);

  // Calls started from the Calls tab
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; name: string; conversationId: string; kind: CallKind }>).detail;
      startRef.current(d.kind, { id: d.id, name: d.name, conversationId: d.conversationId });
    };
    window.addEventListener("talkie:call", h);
    return () => window.removeEventListener("talkie:call", h);
  }, []);

  // Background alerts turn on automatically (the browser needs one tap/click to allow the permission prompt)
  useEffect(() => {
    if (!pushSupported()) return;
    void registerWorker().catch(() => {});
    if (Notification.permission === "granted") { void enablePush(false); return; }
    if (Notification.permission !== "default") return;
    const ask = () => { void enablePush(true); };
    window.addEventListener("pointerdown", ask, { once: true });
    return () => window.removeEventListener("pointerdown", ask);
  }, [meId]);

  // Notification buttons (Answer / Decline / Mute / End) arrive from the service worker
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const h = (e: MessageEvent) => {
      const m = e.data as { type?: string; action?: string } | null;
      if (m?.type === "notif-action" && m.action) actRef.current(m.action);
    };
    navigator.serviceWorker.addEventListener("message", h);
    return () => navigator.serviceWorker.removeEventListener("message", h);
  }, []);

  // Browsers only allow sound after a tap/click: unlock sounds and resume call audio on interaction
  useEffect(() => {
    const un = () => { unlockAudio(); void audioRef.current?.play().catch(() => {}); };
    window.addEventListener("pointerdown", un);
    window.addEventListener("keydown", un);
    return () => { window.removeEventListener("pointerdown", un); window.removeEventListener("keydown", un); };
  }, []);

  // Phone-style sounds: ringtone for the callee, ringback for the caller
  useEffect(() => {
    if (call?.phase === "incoming") {
      if (!audioRunning()) setNote("Tap anywhere on the screen to hear the ringtone");
      return startRing("ringtone");
    }
    if (call?.phase === "outgoing") return startRing("ringback");
    return undefined;
  }, [call?.phase]);

  // Track the call screen size so layout adapts to rotation / resizing
  const open = !!call;
  useEffect(() => {
    const el = ovRef.current;
    if (!open || !el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, mini]);

  // Audio devices list (only used by the speaker/microphone picker; the system default stays in charge)
  useEffect(() => {
    if (!call || call.phase === "incoming" || !navigator.mediaDevices) return;
    void loadDevs();
    const h = () => void loadDevs();
    navigator.mediaDevices.addEventListener("devicechange", h);
    return () => navigator.mediaDevices.removeEventListener("devicechange", h);
  }, [call?.phase]);

  // Ongoing-call notification with Mute / End buttons while the app is in the background
  useEffect(() => {
    if (!call || call.phase !== "connected" || !("serviceWorker" in navigator) || !("Notification" in window)) return;
    const title = `${call.kind === "VIDEO" ? "Video" : "Voice"} call · ${call.peerName}`;
    const show = async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg || Notification.permission !== "granted") return;
      await reg.showNotification(title, {
        tag: "talkie-ongoing", body: muted ? "Microphone muted · tap to return" : "Call in progress · tap to return",
        requireInteraction: true, silent: true, icon: "/icon.svg", badge: "/icon.svg",
        actions: [{ action: "mute", title: muted ? "Unmute" : "Mute" }, { action: "end", title: "End call" }],
      } as NotificationOptions);
    };
    const clear = async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      (await reg?.getNotifications({ tag: "talkie-ongoing" }))?.forEach((n) => n.close());
    };
    const onVis = () => { if (document.hidden) void show(); else void clear(); };
    document.addEventListener("visibilitychange", onVis);
    if (document.hidden) void show();
    return () => { document.removeEventListener("visibilitychange", onVis); void clear(); };
  }, [call?.phase, call?.peerName, call?.kind, muted]);

  // Attach media streams. Sound plays through a dedicated <audio> element (reliable on laptops);
  // the remote <video> only draws the picture.
  useEffect(() => {
    const s = svc.current;
    if (!s) return;
    const attach = (el: HTMLMediaElement | null, stream: MediaStream | null, loud: boolean) => {
      if (!el || !stream) return;
      if (el.srcObject !== stream) el.srcObject = stream;
      el.volume = 1;
      void el.play().catch(() => { if (loud) setNote("Click anywhere to turn on call audio"); });
    };
    attach(audioRef.current, s.remoteStream, true);
    attach(remoteRef.current, s.remoteStream, false);
    attach(localRef.current, s.localStream, false);
  }, [call?.phase, tick, mini]);

  useEffect(() => {
    const start = call?.startedAt;
    if (!start) return;
    const id = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [call?.startedAt]);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(""), 4500);
    return () => clearTimeout(id);
  }, [note]);

  const isVideo = call?.kind === "VIDEO";
  const noRemoteVideo = !!call && isVideo && call.phase === "connected" && !svc.current?.remoteStream.getVideoTracks().length;
  const showAvatar = !!call && (!isVideo || call.phase !== "connected" || noRemoteVideo);
  const btOut = devs.outs.find((d) => BT.test(d.label));
  const btActive = !!btOut && outId === btOut.deviceId;
  const status = !call ? "" : call.phase === "incoming" ? `Incoming ${isVideo ? "video" : "voice"} call` : call.phase === "outgoing" ? "Ringing…" : call.phase === "connecting" ? "Connecting…" : noRemoteVideo ? `${fmt(secs)} · waiting for their camera…` : fmt(secs);

  return (
    <>
      {peer && !call && (
        <div className="callbtns">
          <button className="ghost" onClick={() => startCall("VOICE")} aria-label="Voice call">📞</button>
          <button className="ghost" onClick={() => startCall("VIDEO")} aria-label="Video call">📹</button>
        </div>
      )}
      {call && (
        <div className={`callov${isVideo ? "" : " voice"}${mini && call.phase !== "incoming" ? " mini" : ""}`} ref={ovRef} role="dialog" aria-label="Call">
          <audio ref={audioRef} autoPlay />
          <video ref={remoteRef} autoPlay playsInline muted className={isVideo ? "remote" : "remote off"} />
          {isVideo && <div className="shade" />}
          {call.phase !== "incoming" && !mini && (
            <div className="ctop">
              <button className="circ" onClick={() => setMini(true)} aria-label="Minimize call"><Ico><path d="M6 9l6 6 6-6" /></Ico></button>
              {isVideo && <button className="circ" onClick={flip} aria-label="Flip camera"><Ico><path d="M20 12a8 8 0 0 0-14-5M4 4v4h4M4 12a8 8 0 0 0 14 5M20 20v-4h-4" /></Ico></button>}
            </div>
          )}
          <div className="cinfo">
            <h2>{call.peerName}</h2>
            <p>{status}</p>
            {showAvatar && <Avatar userId={call.peerId} name={call.peerName} className="cavatar" />}
          </div>
          {isVideo && call.phase !== "incoming" && (
            <div
              className={`selfwrap${dragXY ? " drag" : ""}`}
              style={{ left: self.x, top: self.y, width: self.w, height: self.h }}
              onPointerDown={onSelfDown} onPointerMove={onSelfMove} onPointerUp={onSelfUp} onPointerCancel={onSelfUp}
              role="group" aria-label="Your camera preview. Drag to move it."
            >
              <video ref={localRef} autoPlay playsInline muted style={{ transform: front ? "scaleX(-1)" : undefined }} />
            </div>
          )}

          {call.phase === "incoming" ? (
            <div className="inc">
              <div><button className="pbtn end big" onClick={reject} aria-label="Decline"><Phone rot={135} /></button><span>Decline</span></div>
              <div><button className="pbtn acc big" onClick={accept} aria-label="Accept"><Phone /></button><span>Accept</span></div>
            </div>
          ) : mini ? (
            <div className="minibar">
              <button onClick={() => setMini(false)} aria-label="Expand call"><Ico><path d="M6 15l6-6 6 6" /></Ico></button>
              <button onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"}><Ico><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3" />{muted && <path d="M4 4l16 16" />}</Ico></button>
              <button className="end" onClick={endCall} aria-label="End call"><Phone rot={135} /></button>
            </div>
          ) : (
            <div className="pill">
              <button className="pbtn" onClick={() => setSheet("more")} aria-label="More options"><Ico><circle cx="5" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><circle cx="19" cy="12" r="1.6" fill="currentColor" /></Ico></button>
              <button className={`pbtn${isVideo && camOff ? " on" : ""}`} onClick={toggleCam} disabled={!isVideo} aria-label={camOff ? "Turn camera on" : "Turn camera off"}><Ico><path d="M3 7h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H3zM16 11l5-3v8l-5-3z" fill="currentColor" />{camOff && <path d="M4 4l16 16" />}</Ico></button>
              <button className={`pbtn${sheet === "audio" || btActive ? " on" : ""}`} onClick={() => { void loadDevs(); setSheet("audio"); }} aria-label="Audio output">
                {btActive ? <Ico><path d="M7 7l10 10-5 5V2l5 5L7 17" /></Ico> : <Ico><path d="M4 9v6h4l5 4V5L8 9zM16 8a5 5 0 0 1 0 8" /></Ico>}
              </button>
              <button className={`pbtn${muted ? " on" : ""}`} onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"}><Ico><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3" />{muted && <path d="M4 4l16 16" />}</Ico></button>
              <button className="pbtn end" onClick={endCall} aria-label="End call"><Phone rot={135} /></button>
            </div>
          )}

          {sheet && call.phase !== "incoming" && (
            <div className="sheet" role="menu">
              {sheet === "more" ? (
                <>
                  <button onClick={() => { setMini(true); setSheet(null); }}>Minimize call</button>
                  {isVideo && <button onClick={() => { void ovRef.current?.requestFullscreen(); setSheet(null); }}>Fullscreen</button>}
                  {isVideo && <button onClick={() => { flip(); setSheet(null); }}>Flip camera</button>}
                  {isVideo && <button onClick={() => { setCorner("tr"); setSheet(null); }}>Reset self-view position</button>}
                </>
              ) : (
                <>
                  <h3>Speaker</h3>
                  <button role="menuitemradio" aria-checked={outId === ""} onClick={() => void chooseOut("default").then(() => setOutId(""))}>System default</button>
                  {devs.outs.map((d, i) => (
                    <button key={d.deviceId || i} role="menuitemradio" aria-checked={outId === d.deviceId} onClick={() => void chooseOut(d.deviceId)}>{d.label || `Speaker ${i + 1}`}</button>
                  ))}
                  <h3>Microphone</h3>
                  {devs.ins.map((d, i) => (
                    <button key={d.deviceId || i} role="menuitemradio" aria-checked={inId === d.deviceId} onClick={() => void chooseIn(d.deviceId)}>{d.label || `Microphone ${i + 1}`}</button>
                  ))}
                  <div className="hint">Pair Bluetooth headsets in your device settings first. Then pick them here.</div>
                </>
              )}
              <button onClick={() => setSheet(null)}>Close</button>
            </div>
          )}
        </div>
      )}
      {note && <div className="toast" role="status">{note}</div>}
    </>
  );
}
