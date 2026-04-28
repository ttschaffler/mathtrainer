"use strict";

/* ---------- Persistence ---------- */

const LS = {
  load(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? { ...fallback, ...JSON.parse(v) } : fallback; }
    catch { return fallback; }
  },
  save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

const DEFAULT_SETTINGS = {
  intDigits: 3,
  decDigits: 3,
  ops: {
    "*10": true,  "*100": true,  "*1000": true,  "*10000": false,
    "/10": true,  "/100": true,  "/1000": true,  "/10000": false,
  },
  lastLength: 20, // 0 = endless
};

const DEFAULT_STATS = {
  commashift: { correct: 0, total: 0, bestStreak: 0 },
};

let settings = LS.load("mt.settings", DEFAULT_SETTINGS);
let stats = LS.load("mt.stats", DEFAULT_STATS);

function saveSettings() { LS.save("mt.settings", settings); }
function saveStats() { LS.save("mt.stats", stats); }

/* ---------- Decimal helpers (string-based, no float math) ---------- */

// Canonical representation: { intPart, fracPart } both digit strings.
// intPart has no leading zeros (except "0"); fracPart has no trailing zeros.
function canonicalize(digits, intLen) {
  while (intLen <= 0) { digits = "0" + digits; intLen++; }
  while (intLen > digits.length) digits += "0";
  while (intLen > 1 && digits[0] === "0") { digits = digits.slice(1); intLen--; }
  const intPart = digits.slice(0, intLen) || "0";
  const fracPart = digits.slice(intLen).replace(/0+$/, "");
  return { intPart, fracPart };
}

function shift(digits, intLen, k) {
  return canonicalize(digits, intLen + k);
}

function format(num) {
  return num.fracPart ? num.intPart + "," + num.fracPart : num.intPart;
}

function parseDecimal(s) {
  if (typeof s !== "string") return null;
  s = s.trim().replace(/\s+/g, "").replace(",", ".");
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return canonicalize(i + f, i.length);
}

function eq(a, b) {
  return !!a && !!b && a.intPart === b.intPart && a.fracPart === b.fracPart;
}

/* ---------- Question generator ---------- */

function randInt(n) { return Math.floor(Math.random() * n); }

function randomNumber(intMax, decMax) {
  // Decide structure
  let intLen = 1 + randInt(intMax);
  let decLen = randInt(decMax + 1);
  // Slight bias towards having decimals so the comma matters
  if (decLen === 0 && Math.random() < 0.5) decLen = 1 + randInt(decMax);

  const total = intLen + decLen;
  let digits = "";
  for (let i = 0; i < total; i++) digits += String(randInt(10));

  // No leading zero on integers wider than 1 digit
  if (intLen > 1 && digits[0] === "0") {
    digits = String(1 + randInt(9)) + digits.slice(1);
  }
  // No trailing zero on fractional
  if (decLen > 0 && digits[digits.length - 1] === "0") {
    digits = digits.slice(0, -1) + String(1 + randInt(9));
  }
  // Avoid the all-zero number
  if (/^0+$/.test(digits)) digits = digits.slice(0, -1) + "1";

  return { digits, intLen };
}

function enabledOps() {
  const list = Object.entries(settings.ops).filter(([, v]) => v).map(([k]) => k);
  return list.length ? list : ["*10"]; // safety fallback
}

function nextQuestion() {
  const ops = enabledOps();
  const op = ops[randInt(ops.length)];
  const sign = op[0]; // '*' or '/'
  const factor = parseInt(op.slice(1), 10);
  const exp = Math.log10(factor); // 1, 2, 3, 4
  const k = sign === "*" ? exp : -exp;

  const n = randomNumber(settings.intDigits, settings.decDigits);
  const operand = canonicalize(n.digits, n.intLen);
  const answer = shift(n.digits, n.intLen, k);

  return {
    operandText: format(operand),
    opSymbol: sign === "*" ? "×" : "÷",
    factor,
    answer,
    answerText: format(answer),
  };
}

/* ---------- Routing ---------- */

const screens = ["home", "length", "trainer", "settings", "summary"];
function go(name) {
  for (const s of screens) {
    document.getElementById(`screen-${s}`).classList.toggle("active", s === name);
  }
  if (name === "home") refreshHome();
  if (name === "length") renderLength();
  if (name === "settings") renderSettings();
  window.scrollTo(0, 0);
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-go]");
  if (t) { e.preventDefault(); go(t.dataset.go); }
});

/* ---------- Length picker ---------- */

function renderLength() {
  const last = settings.lastLength;
  for (const chip of document.querySelectorAll("#l-chips .chip")) {
    chip.classList.toggle("last", parseInt(chip.dataset.len, 10) === last);
  }
  // Pre-fill custom input only if last choice is non-standard
  const standard = new Set([10, 20, 50, 0]);
  const customEl = document.getElementById("l-custom");
  customEl.value = standard.has(last) ? "" : String(last);
}

document.getElementById("l-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const len = parseInt(chip.dataset.len, 10);
  startSession(len);
});

document.getElementById("l-custom-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = parseInt(document.getElementById("l-custom").value, 10);
  if (!Number.isFinite(v) || v < 1 || v > 999) {
    document.getElementById("l-custom").focus();
    return;
  }
  startSession(v);
});

/* ---------- Trainer ---------- */

const T = {
  current: null,
  target: 0,         // 0 = endless
  correct: 0,
  total: 0,
  streak: 0,
  bestStreak: 0,     // longest streak this session
  totalTimeMs: 0,    // sum of response times
  questionStart: 0,  // performance.now() of current question
  sessionStart: 0,
  locked: false,
};

const elQuestion = () => document.getElementById("t-question");
const elAnswer   = () => document.getElementById("t-answer");
const elFeedback = () => document.getElementById("t-feedback");
const elCorrect  = () => document.getElementById("t-correct");
const elTotal    = () => document.getElementById("t-total");
const elTarget   = () => document.getElementById("t-target");
const elStreak   = () => document.getElementById("t-streak");
const elEnd      = () => document.getElementById("t-end");

function startSession(target) {
  T.target = Number.isFinite(target) && target > 0 ? target : 0;
  T.correct = 0; T.total = 0; T.streak = 0; T.bestStreak = 0;
  T.totalTimeMs = 0; T.sessionStart = performance.now();
  T.locked = false;

  settings.lastLength = T.target;
  saveSettings();

  go("trainer");
  updateBar();
  showQuestion();
}

function updateBar() {
  elCorrect().textContent = T.correct;
  elTotal().textContent = T.total;
  elTarget().textContent = T.target ? `/${T.target}` : "";
  elStreak().textContent = T.streak;
  // End-session link visible only after first answer (and only really useful in endless mode,
  // but allowed everywhere so users can quit early if they want)
  elEnd().hidden = T.total === 0;
}

function showQuestion() {
  T.current = nextQuestion();
  T.locked = false;
  T.questionStart = performance.now();
  const a = elAnswer();
  a.value = "";
  a.classList.remove("good", "bad", "shake");
  elFeedback().textContent = "";
  elFeedback().className = "feedback";
  elQuestion().textContent = `${T.current.operandText} ${T.current.opSymbol} ${T.current.factor}`;
  if (document.getElementById("screen-trainer").classList.contains("active")) {
    setTimeout(() => a.focus({ preventScroll: true }), 30);
  }
}

function recordTime() {
  T.totalTimeMs += performance.now() - T.questionStart;
}

function advanceOrFinish() {
  if (T.target && T.total >= T.target) finishSession();
  else showQuestion();
}

function submitAnswer() {
  if (T.locked) return;
  const raw = elAnswer().value;
  const parsed = parseDecimal(raw);
  if (!parsed) {
    elFeedback().textContent = "Bitte eine Zahl eingeben (z. B. 0,389)";
    elFeedback().className = "feedback bad";
    elAnswer().classList.add("shake");
    setTimeout(() => elAnswer().classList.remove("shake"), 320);
    return;
  }
  T.locked = true;
  recordTime();
  T.total++;
  if (eq(parsed, T.current.answer)) {
    T.correct++; T.streak++;
    if (T.streak > T.bestStreak) T.bestStreak = T.streak;
    elAnswer().classList.add("good");
    elFeedback().textContent = "Richtig!";
    elFeedback().className = "feedback good";
    bumpStats(true);
    updateBar();
    setTimeout(advanceOrFinish, 550);
  } else {
    T.streak = 0;
    elAnswer().classList.add("bad", "shake");
    elFeedback().textContent = `Falsch — richtig wäre ${T.current.answerText}`;
    elFeedback().className = "feedback bad";
    bumpStats(false);
    updateBar();
    setTimeout(advanceOrFinish, 1700);
  }
}

function skipQuestion() {
  if (T.locked) return;
  T.locked = true;
  recordTime();
  T.total++;
  T.streak = 0;
  elFeedback().textContent = `Antwort: ${T.current.answerText}`;
  elFeedback().className = "feedback";
  bumpStats(false);
  updateBar();
  setTimeout(advanceOrFinish, 1100);
}

function bumpStats(correct) {
  const s = stats.commashift;
  s.total++;
  if (correct) s.correct++;
  if (T.streak > s.bestStreak) s.bestStreak = T.streak;
  saveStats();
}

document.getElementById("t-form").addEventListener("submit", (e) => {
  e.preventDefault();
  submitAnswer();
});
document.getElementById("t-skip").addEventListener("click", skipQuestion);
document.getElementById("t-end").addEventListener("click", () => {
  if (T.total > 0) finishSession();
});

/* ---------- Summary ---------- */

function rate(acc, total) {
  if (total === 0)      return { emoji: "🤔", label: "Keine Antworten", tone: "weak" };
  if (acc === 1)        return { emoji: "🏆", label: "Perfekt!",        tone: "great" };
  if (acc >= 0.9)       return { emoji: "🥇", label: "Hervorragend",   tone: "great" };
  if (acc >= 0.75)      return { emoji: "🥈", label: "Sehr gut",       tone: "good" };
  if (acc >= 0.5)       return { emoji: "🥉", label: "Solide",         tone: "ok" };
  return                       { emoji: "💪", label: "Weiter üben",    tone: "weak" };
}

function fmtSeconds(ms) {
  const s = ms / 1000;
  return s.toFixed(1).replace(".", ",") + " s";
}

function fmtDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

function finishSession() {
  const total = T.total;
  const acc = total > 0 ? T.correct / total : 0;
  const r = rate(acc, total);

  const ratingEl = document.getElementById("su-rating");
  ratingEl.classList.remove("great", "good", "ok", "weak");
  ratingEl.classList.add(r.tone);
  document.getElementById("su-emoji").textContent = r.emoji;
  document.getElementById("su-label").textContent = r.label;

  document.getElementById("su-correct").textContent = T.correct;
  document.getElementById("su-total").textContent = total;
  document.getElementById("su-acc").textContent = total ? `${Math.round(acc * 100)}%` : "—";
  document.getElementById("su-streak").textContent = T.bestStreak;
  document.getElementById("su-avgtime").textContent =
    total ? fmtSeconds(T.totalTimeMs / total) : "—";
  document.getElementById("su-duration").textContent =
    fmtDuration(performance.now() - T.sessionStart);

  go("summary");
}

document.getElementById("su-again").addEventListener("click", () => {
  startSession(T.target);
});
document.getElementById("su-change").addEventListener("click", () => {
  go("length");
});

/* ---------- Home ---------- */

function refreshHome() {
  const s = stats.commashift;
  const acc = s.total ? Math.round((s.correct / s.total) * 100) : 0;
  document.getElementById("home-stats-commashift").textContent =
    s.total ? `${s.correct}/${s.total} richtig (${acc}%) · Beste Serie ${s.bestStreak}` : "Noch nicht trainiert";
}

/* ---------- Settings ---------- */

function renderSettings() {
  document.getElementById("s-intDigits").value = String(settings.intDigits);
  document.getElementById("s-decDigits").value = String(settings.decDigits);
  for (const cb of document.querySelectorAll("[data-op]")) {
    cb.checked = !!settings.ops[cb.dataset.op];
  }
}

document.getElementById("s-intDigits").addEventListener("change", (e) => {
  settings.intDigits = parseInt(e.target.value, 10); saveSettings();
});
document.getElementById("s-decDigits").addEventListener("change", (e) => {
  settings.decDigits = parseInt(e.target.value, 10); saveSettings();
});
for (const cb of document.querySelectorAll("[data-op]")) {
  cb.addEventListener("change", () => {
    settings.ops[cb.dataset.op] = cb.checked; saveSettings();
  });
}
document.getElementById("s-reset").addEventListener("click", () => {
  if (!confirm("Statistik wirklich zurücksetzen?")) return;
  stats = JSON.parse(JSON.stringify(DEFAULT_STATS));
  saveStats();
  refreshHome();
});

/* ---------- Boot ---------- */

refreshHome();
renderSettings();

// Service worker (best-effort, ignored in non-https/local file contexts)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/* Expose for console testing */
window.__mt = { canonicalize, shift, parseDecimal, format, eq, nextQuestion };
