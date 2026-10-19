// The meeting bot's voice (see meet-bot.html). The meeting's own audio goes to a
// GPT-Live session over WebRTC and its answers come back as the bot's voice.
// The SDP exchange runs through the meeting's Durable Object, which holds the
// key and its own sideband to the session; the data channel carries nothing.

const params = new URLSearchParams(location.search);
const call = params.get("call") || "";
const token = params.get("t") || "";
const base = `/meet/${encodeURIComponent(call)}`;
const queue = [];
let ws;

document.getElementById("name").textContent = params.get("name") || "AI assistant";

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  else queue.push(msg);
}

// The control socket reconnects by itself; the voice connection is separate.
function connect() {
  ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}${base}/ws?t=${encodeURIComponent(token)}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", voice: !!voicePc }));
    while (queue.length) ws.send(JSON.stringify(queue.shift()));
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connect, 1000);
}

function log(...args) {
  send({ type: "log", text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
}
window.addEventListener("error", (e) => log("page error:", e.message));
window.addEventListener("unhandledrejection", (e) => log("page rejection:", String(e.reason)));

let audioCtx;
function ctx() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// Plays the voice out loud and shows its level on the card. The bot renders
// at 15 fps on a small machine, so the glow updates at most 8 times a second.
function speak(node) {
  node.connect(ctx().destination);
  const analyser = ctx().createAnalyser();
  analyser.fftSize = 512;
  node.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  const mark = document.getElementById("mark");
  setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    const level = Math.min(1, peak / 64);
    mark.style.transform = `scale(${1 + level * 0.12})`;
    mark.style.boxShadow = `0 0 ${level * 80}px rgba(232,134,90,${level})`;
  }, 125);
}

let voicePc;
let voiceGate;
let voiceGateOpen = false;

const handlers = {
  async "voice.start"() {
    if (voicePc) return;
    const pc = (voicePc = new RTCPeerConnection());
    pc.addEventListener("track", (e) => {
      // Chrome only feeds a remote WebRTC track into Web Audio while a media element plays it.
      const el = new Audio();
      el.muted = true;
      el.srcObject = new MediaStream([e.track]);
      el.play().catch(() => {});
      // The voice passes a short delay and a gate. The meeting's object opens
      // the gate only when the bot was addressed by name, or delivers a result
      // or a notice; the delay lets a late open or close still apply.
      const delay = ctx().createDelay(1);
      delay.delayTime.value = 0.25;
      voiceGate = ctx().createGain();
      voiceGate.gain.value = voiceGateOpen ? 1 : 0;
      ctx().createMediaStreamSource(new MediaStream([e.track])).connect(delay).connect(voiceGate);
      speak(voiceGate);
      log("voice track up");
    });
    pc.addEventListener("connectionstatechange", () => {
      log("voice connection:", pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        voicePc = undefined;
        send({ type: "voice.down", state: pc.connectionState });
      }
    });
    const meeting = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of meeting.getAudioTracks()) pc.addTrack(t, meeting);
    pc.createDataChannel("oai-events");
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => {
      if (pc.iceGatheringState === "complete") return r();
      pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && r());
      setTimeout(r, 3000);
    });
    const res = await fetch(`${base}/session?t=${encodeURIComponent(token)}`, { method: "POST", body: pc.localDescription.sdp });
    if (!res.ok) {
      voicePc = undefined;
      pc.close();
      throw new Error(`session ${res.status}: ${await res.text()}`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    log("voice session started");
  },
  "voice.gate"(msg) {
    voiceGateOpen = !!msg.open;
    if (voiceGate) voiceGate.gain.setTargetAtTime(voiceGateOpen ? 1 : 0, ctx().currentTime, 0.03);
  },
  "voice.stop"() {
    voicePc?.close();
    voicePc = undefined;
  },
  ping() {},
};

async function handle(msg) {
  const h = handlers[msg.type];
  if (!h) return log("unknown message", msg.type);
  try {
    await h(msg);
  } catch (err) {
    log(`handler ${msg.type} failed:`, String(err));
  }
}

connect();
