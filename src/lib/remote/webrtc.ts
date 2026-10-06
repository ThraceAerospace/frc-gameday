import type { RemoteMultiviewAction } from "./actions";

export type RemoteRole = "controller" | "display";
export type RemotePeerStatus = "connecting" | "waiting" | "connecting-peer" | "connected" | "disconnected" | "error";

type SignalMessage =
  | { type: "peer-ready" }
  | { type: "signal"; payload: WebRTCSignalPayload }
  | { type: "error"; message: string };

type WebRTCSignalPayload =
  | { kind: "description"; description: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit };

type PeerOptions = {
  code: string;
  role: RemoteRole;
  onStatus?: (status: RemotePeerStatus) => void;
  onAction?: (action: RemoteMultiviewAction) => void;
};

function getSignalingUrl(code: string, role: RemoteRole) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = crypto.randomUUID();

  return `${protocol}//${window.location.host}/api/remote/ws?code=${encodeURIComponent(code)}&role=${role}&token=${encodeURIComponent(token)}`;
}

export class RemotePeer {
  private readonly options: PeerOptions;
  private socket: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private queuedActions: RemoteMultiviewAction[] = [];
  private remoteDescriptionSet = false;
  private closed = false;

  constructor(options: PeerOptions) {
    this.options = options;
  }

  start() {
    this.options.onStatus?.("connecting");

    const socket = new WebSocket(getSignalingUrl(this.options.code, this.options.role));
    this.socket = socket;

    socket.onopen = () => this.options.onStatus?.("waiting");
    socket.onmessage = (event) => {
      let message: SignalMessage;
      try { message = JSON.parse(String(event.data)) as SignalMessage; } catch { return; }
      void this.handleSignalMessage(message);
    };
    socket.onerror = () => this.options.onStatus?.("error");
    socket.onclose = () => {
      if (!this.closed) this.options.onStatus?.("disconnected");
    };
  }

  sendAction(action: RemoteMultiviewAction) {
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify(action));
      return;
    }
    this.queuedActions.push(action);
  }

  close() {
    this.closed = true;
    this.channel?.close();
    this.peer?.close();
    this.socket?.close();
    this.channel = null;
    this.peer = null;
    this.socket = null;
    this.queuedActions = [];
    this.pendingCandidates = [];
  }

  private async handleSignalMessage(message: SignalMessage) {
    if (message.type === "error") {
      this.options.onStatus?.("error");
      console.error("[Remote] Signaling error:", message.message);
      return;
    }

    if (message.type === "peer-ready") {
      this.options.onStatus?.("connecting-peer");
      if (this.options.role === "controller") await this.createControllerOffer();
      return;
    }

    if (message.type === "signal") await this.handlePeerSignal(message.payload);
  }

  private createPeerConnection() {
    if (this.peer) return this.peer;

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal({ type: "signal", payload: { kind: "candidate", candidate: event.candidate.toJSON() } });
      }
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") this.options.onStatus?.("connected");
      if (peer.connectionState === "failed" || peer.connectionState === "closed" || peer.connectionState === "disconnected") {
        this.options.onStatus?.("disconnected");
      }
    };

    if (this.options.role === "controller") {
      this.attachChannel(peer.createDataChannel("multiview-actions", { ordered: true }));
    } else {
      peer.ondatachannel = (event) => this.attachChannel(event.channel);
    }

    this.peer = peer;
    return peer;
  }

  private attachChannel(channel: RTCDataChannel) {
    this.channel = channel;

    channel.onopen = () => {
      this.options.onStatus?.("connected");
      for (const action of this.queuedActions) channel.send(JSON.stringify(action));
      this.queuedActions = [];
    };

    channel.onmessage = (event) => {
      if (this.options.role !== "display") return;

      try {
        this.options.onAction?.(JSON.parse(String(event.data)) as RemoteMultiviewAction);
      } catch (error) {
        console.error("[Remote] Invalid action:", error);
      }
    };

    channel.onclose = () => {
      if (!this.closed) this.options.onStatus?.("disconnected");
    };
  }

  private sendSignal(message: { type: "signal"; payload: RTCSessionDescriptionInit | RTCIceCandidateInit }) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private async createControllerOffer() {
    const peer = this.createPeerConnection();
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    this.sendSignal({ type: "signal", payload: { kind: "description", description: offer } });
  }

  private async handlePeerSignal(signal: WebRTCSignalPayload) {
    const peer = this.createPeerConnection();

    if (signal.kind === "candidate") {
      if (!this.remoteDescriptionSet) {
        this.pendingCandidates.push(signal.candidate);
        return;
      }
      await peer.addIceCandidate(signal.candidate);
      return;
    }

    const description = signal.description;

    if (this.options.role === "display" && description.type === "offer") {
      await peer.setRemoteDescription(description);
      this.remoteDescriptionSet = true;
      for (const candidate of this.pendingCandidates) await peer.addIceCandidate(candidate);
      this.pendingCandidates = [];

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      this.sendSignal({ type: "signal", payload: { kind: "description", description: answer } });
      return;
    }

    if (this.options.role === "controller" && description.type === "answer") {
      await peer.setRemoteDescription(description);
      this.remoteDescriptionSet = true;
      for (const candidate of this.pendingCandidates) await peer.addIceCandidate(candidate);
      this.pendingCandidates = [];
    }
  }
}
