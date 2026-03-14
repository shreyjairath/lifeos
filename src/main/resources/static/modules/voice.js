/**
 * voice.js — STT (SpeechRecognition) + TTS (SpeechSynthesis) state machine.
 *
 * Two modes:
 *  - Mic button (#mic-btn): push-to-talk / tap-to-listen.
 *  - Voice mode (#voice-mode-btn): full loop — auto-submit after STT finishes,
 *    auto-speak agent reply, auto-reopen mic after speaking done.
 */

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

let micBtn = null;
let voiceModeBtn = null;
let _sendFn = null;
let _voiceMode = false;
let _recognition = null;
let _listening = false;
let _speaking = false;
let _iosPrewarmed = false;

// ── Public API ────────────────────────────────────────────────────────────────

export function isVoiceMode() { return _voiceMode; }

export function cancelSpeech() {
  if (_speaking || window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    _speaking = false;
    if (micBtn && micBtn.dataset.state === "speaking") {
      setMicState("idle");
    }
  }
}

/** Called by chat.js when agent finishes a turn. */
export function onAgentDone(text) {
  if (!_voiceMode) return;
  cancelSpeech();
  const cleaned = stripMarkdown(text);
  if (!cleaned) {
    if (!isIOS) startListening();
    return;
  }
  if (isIOS) prewarmIOS();
  _speaking = true;
  setMicState("speaking");
  speakChunks(splitIntoChunks(cleaned), 0);
}

export function init(sendFn) {
  _sendFn = sendFn;
  micBtn = document.getElementById("mic-btn");
  voiceModeBtn = document.getElementById("voice-mode-btn");

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    if (micBtn) { micBtn.style.display = "none"; }
    if (voiceModeBtn) { voiceModeBtn.style.display = "none"; }
    return;
  }

  _recognition = buildRecognition();

  if (micBtn) {
    micBtn.dataset.state = "idle";
    micBtn.addEventListener("click", () => {
      if (isIOS && !_iosPrewarmed) prewarmIOS();
      if (_listening) {
        stopListening();
      } else {
        cancelSpeech();
        startListening();
      }
    });
  }

  if (voiceModeBtn) {
    voiceModeBtn.addEventListener("click", () => {
      if (isIOS && !_iosPrewarmed) prewarmIOS();
      _voiceMode = !_voiceMode;
      voiceModeBtn.classList.toggle("active", _voiceMode);
      voiceModeBtn.title = _voiceMode
        ? "Voice mode on — click to disable"
        : "Voice mode — auto-listen after agent responds";
      if (_voiceMode) {
        startListening();
      } else {
        cancelSpeech();
        stopListening();
        setMicState("idle");
      }
    });
  }
}


// ── Private ───────────────────────────────────────────────────────────────────

function buildRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const r = new SpeechRecognition();
  r.continuous = !isIOS;   // iOS doesn't support continuous
  r.interimResults = false;
  r.lang = "en-US";

  r.onstart = () => {
    _listening = true;
    setMicState("listening");
  };

  r.onend = () => {
    _listening = false;
    // On desktop in voice mode: restart unless agent is speaking or voice mode disabled
    if (_voiceMode && !isIOS && !_speaking) {
      setTimeout(startListening, 250);
    } else {
      setMicState("idle");
    }
  };

  r.onresult = (evt) => {
    const transcript = Array.from(evt.results)
      .map(r => r[0].transcript)
      .join(" ")
      .trim();
    if (transcript && _sendFn) {
      _recognition.stop();
      _sendFn(transcript);
    }
  };

  r.onerror = (evt) => {
    _listening = false;
    if (evt.error !== "no-speech" && evt.error !== "aborted") {
      console.warn("SpeechRecognition error:", evt.error);
    }
    // Restart on no-speech in voice mode (desktop only)
    if (_voiceMode && !isIOS && evt.error === "no-speech") {
      setTimeout(startListening, 250);
    } else {
      setMicState("idle");
    }
  };

  return r;
}

function startListening() {
  if (_listening || !_recognition || _speaking) return;
  try { _recognition.start(); } catch (_) { /* already started */ }
}

function stopListening() {
  if (!_listening || !_recognition) return;
  try { _recognition.stop(); } catch (_) {}
}

function setMicState(state) {
  if (!micBtn) return;
  micBtn.dataset.state = state;
  micBtn.classList.toggle("listening", state === "listening");
  micBtn.classList.toggle("speaking",  state === "speaking");
  if (state === "idle")      micBtn.title = "Tap to speak";
  if (state === "listening") micBtn.title = "Listening… tap to stop";
  if (state === "speaking")  micBtn.title = "Agent speaking…";
}

function speakChunks(chunks, index) {
  if (index >= chunks.length) {
    _speaking = false;
    setMicState("idle");
    if (_voiceMode && !isIOS) startListening();
    return;
  }
  const utter = new SpeechSynthesisUtterance(chunks[index]);
  utter.onend = () => speakChunks(chunks, index + 1);
  utter.onerror = () => {
    _speaking = false;
    setMicState("idle");
  };
  window.speechSynthesis.speak(utter);
}

function prewarmIOS() {
  if (_iosPrewarmed) return;
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  _iosPrewarmed = true;
}

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, "code block")
    .replace(/`[^`]+`/g, "code")
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[*\-]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\n+/g, " ")
    .trim();
}

function splitIntoChunks(text, maxLen = 300) {
  const sentences = text.match(/[^.!?]+[.!?]+|\S[^.!?]*/g) || [text];
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if (current.length + s.length > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}
