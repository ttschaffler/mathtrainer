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

const screens = ["home", "trainer", "settings"];
function go(name) {
  for (const s of screens) {
    document.getElementById(`screen-${s}`).classList.toggle("active", s === name);
  }
  if (name === "trainer") startSession();
  if (name === "home") refreshHome();
  if (name === "settings") renderSettings();
  window.scrollTo(0, 0);
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-go]");
  if (t) { e.preventDefault(); go(t.dataset.go); }
});

/* ---------- Trainer ---------- */

const T = {
  current: null,
  correct: 0,
  total: 0,
  streak: 0,
  locked: false,
};

const elQuestion = () => document.getElementById("t-question");
const elAnswer   = () => document.getElementById("t-answer");
const elFeedback = () => document.getElementById("t-feedback");
const elCorrect  = () => document.getElementById("t-correct");
const elTotal    = () => document.getElementById("t-total");
const elStreak   = () => document.getElementById("t-streak");

function startSession() {
  T.correct = 0; T.total = 0; T.streak = 0; T.locked = false;
  updateBar();
  showQuestion();
}

function updateBar() {
  elCorrect().textContent = T.correct;
  elTotal().textContent = T.total;
  elStreak().textContent = T.streak;
}

function showQuestion() {
  T.current = nextQuestion();
  T.locked = false;
  const a = elAnswer();
  a.value = "";
  a.classList.remove("good", "bad", "shake");
  elFeedback().textContent = "";
  elFeedback().className = "feedback";
  elQuestion().textContent = `${T.current.operandText} ${T.current.opSymbol} ${T.current.factor}`;
  // Focus only if user is interacting (avoid keyboard popping unexpectedly on first load)
  if (document.getElementById("screen-trainer").classList.contains("active")) {
    setTimeout(() => a.focus({ preventScroll: true }), 30);
  }
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
  T.total++;
  if (eq(parsed, T.current.answer)) {
    T.correct++; T.streak++;
    elAnswer().classList.add("good");
    elFeedback().textContent = "Richtig!";
    elFeedback().className = "feedback good";
    bumpStats(true);
    updateBar();
    setTimeout(showQuestion, 550);
  } else {
    T.streak = 0;
    elAnswer().classList.add("bad", "shake");
    elFeedback().textContent = `Falsch — richtig wäre ${T.current.answerText}`;
    elFeedback().className = "feedback bad";
    bumpStats(false);
    updateBar();
    setTimeout(showQuestion, 1700);
  }
}

function skipQuestion() {
  if (T.locked) return;
  T.locked = true;
  T.total++;
  T.streak = 0;
  elFeedback().textContent = `Antwort: ${T.current.answerText}`;
  elFeedback().className = "feedback";
  bumpStats(false);
  updateBar();
  setTimeout(showQuestion, 1100);
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
