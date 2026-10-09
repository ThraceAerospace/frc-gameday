import type { RemoteSessionAction, RemoteSessionMessage } from "./actions";

export type RemoteRole = "controller" | "display";
export type RemotePeerStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type RemoteSignalingStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

type SignalMessage =
  | { type: "connected"; role: RemoteRole }
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
  onSignalingStatus?: (status: RemoteSignalingStatus) => void;
  onAction?: (action: RemoteSessionAction) => void;
  onMessage?: (message: RemoteSessionMessage) => void;
};

function getSignalingUrl(code: string, role: RemoteRole, token: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/remote/ws?code=${encodeURIComponent(code)}&role=${role}&token=${encodeURIComponent(token)}`;
}

export class RemotePeer {
  private readonly options: PeerOptions;
  private socket: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private queuedActions: RemoteSessionAction[] = [];
  private remoteDescriptionSet = false;
  private signalingReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly token = crypto.randomUUID();
  private reconnectingPeer = false;

  constructor(options: PeerOptions) {
    this.options = options;
  }

  start() {
    this.closed = false;
    this.connectSignaling();
  }

  sendAction(action: RemoteSessionAction) {
    this.sendMessage({ type: "action", action });
  }

  sendMessage(message: RemoteSessionMessage) {
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify(message));
      return;
    }

    if (message.type === "action") {
      this.queuedActions.push(message.action);
    }
  }

  close() {
    this.closed = true;

    if (this.signalingReconnectTimer) {
      clearTimeout(this.signalingReconnectTimer);
      this.signalingReconnectTimer = null;
    }

    this.channel?.close();
    this.peer?.close();
    this.socket?.close();

    this.channel = null;
    this.peer = null;
    this.socket = null;
    this.queuedActions = [];
    this.pendingCandidates = [];
  }

  private connectSignaling() {
    if (this.closed) return;

    if (this.socket) return;

    this.options.onSignalingStatus?.("connecting");

    const socket = new WebSocket(
      getSignalingUrl(this.options.code, this.options.role, this.token),
    );

    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket || this.closed) return;
      this.options.onSignalingStatus?.("connected");
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket || this.closed) return;

      let message: SignalMessage;

      try {
        message = JSON.parse(String(event.data)) as SignalMessage;
      } catch {
        return;
      }

      void this.handleSignalMessage(message);
    };

    socket.onerror = () => {
      if (this.socket !== socket || this.closed) return;
      this.options.onSignalingStatus?.("error");
    };

    socket.onclose = () => {
      if (this.socket !== socket || this.closed) return;

      this.socket = null;
      this.options.onSignalingStatus?.("disconnected");

      if (this.shouldReconnectSignaling()) {
        this.scheduleSignalingReconnect();
      }
    };
  }

  private shouldReconnectSignaling() {
    if (this.closed) return false;

    const state = this.peer?.connectionState;

    return !this.peer || state === "new" || state === "connecting" || state === "failed" || state === "closed";
  }

  private scheduleSignalingReconnect() {
    if (this.signalingReconnectTimer || this.closed) return;

    this.signalingReconnectTimer = setTimeout(() => {
      this.signalingReconnectTimer = null;
      this.connectSignaling();
    }, 1000);
  }

  private async handleSignalMessage(message: SignalMessage) {
    if (message.type === "error") {
      this.options.onSignalingStatus?.("error");
      console.error("[Remote] Signaling error:", message.message);
      return;
    }

    if (message.type === "connected") {
      return;
    }

    if (message.type === "peer-ready") {
      if (this.options.role === "controller") {
        await this.createControllerOffer();
      }

      return;
    }

    if (message.type === "signal") {
      await this.handlePeerSignal(message.payload);
    }
  }

  private createPeerConnection() {
    if (this.peer) return this.peer;

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal({
          type: "signal",
          payload: {
            kind: "candidate",
            candidate: event.candidate.toJSON(),
          },
        });
      }
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") {
        this.options.onStatus?.("connected");
      }

      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        this.options.onStatus?.("disconnected");
        this.restartPeer();
      }
    };

    if (this.options.role === "controller") {
      this.attachChannel(
        peer.createDataChannel("multiview-actions", { ordered: true }),
      );
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

      // The controller publishes the authoritative shared session state
      // when this peer connects. Never replay stale queued UI actions.
      this.queuedActions = [];
    };

    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as RemoteSessionMessage;

        if (message.type === "action") {
          if (this.options.role === "display") {
            this.options.onAction?.(message.action);
          }
          return;
        }

        this.options.onMessage?.(message);
      } catch (error) {
        console.error("[Remote] Invalid message:", error);
      }
    };

    channel.onclose = () => {
      if (this.closed) return;

      this.options.onStatus?.("disconnected");
      this.restartPeer();
    };
  }

  private sendSignal(message: {
    type: "signal";
    payload: WebRTCSignalPayload;
  }) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;

    const target: RemoteRole =
      this.options.role === "controller" ? "display" : "controller";

    this.socket.send(
      JSON.stringify({
        ...message,
        target,
      }),
    );
  }

  private restartPeer() {
    if (this.closed || this.reconnectingPeer) return;

    this.reconnectingPeer = true;
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
    this.queuedActions = [];

    if (this.socket) {
      this.socket.close();
    } else {
      this.scheduleSignalingReconnect();
    }

    this.reconnectingPeer = false;
  }

  private async createControllerOffer() {
    const peer = this.createPeerConnection();

    if (peer.connectionState === "connected" || peer.signalingState !== "stable") return;

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    this.sendSignal({
      type: "signal",
      payload: {
        kind: "description",
        description: offer,
      },
    });
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

      for (const candidate of this.pendingCandidates) {
        await peer.addIceCandidate(candidate);
      }

      this.pendingCandidates = [];

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      this.sendSignal({
        type: "signal",
        payload: {
          kind: "description",
          description: answer,
        },
      });

      return;
    }

    if (this.options.role === "controller" && description.type === "answer") {
      await peer.setRemoteDescription(description);
      this.remoteDescriptionSet = true;

      for (const candidate of this.pendingCandidates) {
        await peer.addIceCandidate(candidate);
      }

      this.pendingCandidates = [];
    }
  }
}
