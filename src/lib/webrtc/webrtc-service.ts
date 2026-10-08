import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

export type CallState = "idle" | "calling" | "ringing" | "connecting" | "connected" | "ended" | "failed";
export type CallKind = "VOICE" | "VIDEO";

export type SignalMessage =
  | { type: "call-start"; from: string; callId: string; kind: CallKind }
  | { type: "call-accept" | "call-reject" | "call-end"; from: string; callId: string }
  | { type: "offer" | "answer"; from: string; callId: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; from: string; callId: string; candidate: RTCIceCandidateInit };

export function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  const url = process.env.NEXT_PUBLIC_TURN_URL;
  if (url) {
    servers.push({
      urls: url,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }
  return servers;
}

/** Signaling over Supabase Broadcast: each user listens on `calls:<userId>`. */
export class SignalingChannel {
  private inbox: RealtimeChannel;
  constructor(private supabase: SupabaseClient, private me: string, onSignal: (m: SignalMessage) => void) {
    this.inbox = supabase
      .channel(`calls:${me}`)
      .on("broadcast", { event: "signal" }, ({ payload }) => onSignal(payload as SignalMessage))
      .subscribe();
  }
  async send(to: string, msg: SignalMessage): Promise<void> {
    const ch = this.supabase.channel(`calls:${to}`);
    await new Promise<void>((resolve, reject) =>
      ch.subscribe((s) => (s === "SUBSCRIBED" ? resolve() : s === "CHANNEL_ERROR" ? reject(new Error("Signaling failed")) : undefined)),
    );
    await ch.send({ type: "broadcast", event: "signal", payload: msg });
    void this.supabase.removeChannel(ch);
  }
  close(): void { void this.supabase.removeChannel(this.inbox); }
}

/** Owns one RTCPeerConnection. No React, no Supabase: fully unit-testable. */
export class WebRTCService {
  private pc: RTCPeerConnection;
  private pending: RTCIceCandidateInit[] = [];
  localStream: MediaStream | null = null;
  readonly remoteStream = new MediaStream();

  constructor(
    private onCandidate: (c: RTCIceCandidateInit) => void,
    private onState: (s: CallState) => void,
    iceServers: RTCIceServer[] = getIceServers(),
  ) {
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.onicecandidate = (e) => e.candidate && this.onCandidate(e.candidate.toJSON());
    this.pc.ontrack = (e) => e.streams[0]?.getTracks().forEach((t) => this.remoteStream.addTrack(t));
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "connected") this.onState("connected");
      else if (s === "connecting") this.onState("connecting");
      else if (s === "failed") this.onState("failed");
    };
  }

  async startMedia(kind: CallKind): Promise<MediaStream> {
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === "VIDEO" });
    this.localStream.getTracks().forEach((t) => this.pc.addTrack(t, this.localStream!));
    return this.localStream;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(offer);
    await this.flushPending();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(answer);
    await this.flushPending();
  }

  async addCandidate(c: RTCIceCandidateInit): Promise<void> {
    if (this.pc.remoteDescription) await this.pc.addIceCandidate(c);
    else this.pending.push(c); // candidates can arrive before the offer is applied
  }

  setMuted(muted: boolean): void { this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted)); }
  setCameraOn(on: boolean): void { this.localStream?.getVideoTracks().forEach((t) => (t.enabled = on)); }

  close(): void {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.pc.close();
  }

  private async flushPending(): Promise<void> {
    for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c);
  }
}
