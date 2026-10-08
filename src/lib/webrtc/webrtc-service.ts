export type CallState = "idle" | "calling" | "ringing" | "connecting" | "connected" | "ended" | "failed";
export type CallKind = "VOICE" | "VIDEO";

export function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];
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

/** Owns one RTCPeerConnection. No React, no Supabase: fully unit-testable. */
export class WebRTCService {
  private pc: RTCPeerConnection;
  private pending: RTCIceCandidateInit[] = [];
  private facing: "user" | "environment" = "user";
  localStream: MediaStream | null = null;
  readonly remoteStream = new MediaStream();

  constructor(
    private onCandidate: (c: RTCIceCandidateInit) => void,
    private onState: (s: CallState) => void,
    iceServers: RTCIceServer[] = getIceServers(),
    private onTrack?: () => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.onicecandidate = (e) => e.candidate && this.onCandidate(e.candidate.toJSON());
    this.pc.ontrack = (e) => {
      if (!this.remoteStream.getTracks().includes(e.track)) this.remoteStream.addTrack(e.track);
      this.onTrack?.();
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "connected") this.onState("connected");
      else if (s === "connecting") this.onState("connecting");
      else if (s === "failed") this.onState("failed");
    };
  }

  async startMedia(kind: CallKind): Promise<MediaStream> {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: kind === "VIDEO" ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
    this.localStream.getTracks().forEach((t) => this.pc.addTrack(t, this.localStream!));
    return this.localStream;
  }

  /** Switch between front and back camera without renegotiating the call. */
  async switchCamera(): Promise<void> {
    const old = this.localStream?.getVideoTracks()[0];
    if (!this.localStream || !old) return;
    const next = this.facing === "user" ? "environment" : "user";
    old.stop(); // phones often allow only one camera at a time
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: next }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      const track = s.getVideoTracks()[0];
      const sender = this.pc.getSenders().find((x) => x.track?.kind === "video");
      await sender?.replaceTrack(track);
      this.localStream.removeTrack(old);
      this.localStream.addTrack(track);
      this.facing = next;
    } catch (e) {
      // try to get the previous camera back
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: this.facing } } });
      const track = s.getVideoTracks()[0];
      await this.pc.getSenders().find((x) => x.track?.kind === "video")?.replaceTrack(track);
      this.localStream.removeTrack(old);
      this.localStream.addTrack(track);
      throw e;
    }
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return { type: offer.type, sdp: offer.sdp };
  }

  async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(offer);
    await this.flushPending();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return { type: answer.type, sdp: answer.sdp };
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
