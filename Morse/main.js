// ─── Morse tables ──────────────────────────────────────────────────────────
const MORSE = {
  A:'.-',   B:'-...', C:'-.-.', D:'-..', E:'.',    F:'..-.', G:'--.',   H:'....',
  I:'..',   J:'.---', K:'-.-',  L:'.-..', M:'--',   N:'-.',   O:'---',   P:'.--.',
  Q:'--.-', R:'.-.',  S:'...',  T:'-',    U:'..-',  V:'...-', W:'.--',   X:'-..-',
  Y:'-.--', Z:'--..',
  '0':'-----', '1':'.----', '2':'..---', '3':'...--', '4':'....-',
  '5':'.....', '6':'-....', '7':'--...', '8':'---..', '9':'----.',
  '.':'.-.-.-', ',':'--..--', '?':'..--..', "'":'.--.-..',
  '!':'-.-.--', '/':'-..-.', '(':'-.--.', ')':'-.--.-',
  '&':'.-...', ':':'---...', ';':'-.-.-.', '=':'-...-',
  '+':'.-.-.', '-':'-....-', '_':'..--.-', '"':'.-..-.',
  '$':'...-..-', '@':'.--.-.',
};

const DECODE = Object.fromEntries(Object.entries(MORSE).map(([c, m]) => [m, c]));
const symStr = str => str.replace(/\./g, '·').replace(/-/g, '—');

// ─── Config ────────────────────────────────────────────────────────────────
const DEFAULTS = {
  soundOn: true, volume: 80, pitch: 680, waveform: 'sine',
  hapticOn: true, letterDelayMs: 1000, autoWordSpace: true,
};
let cfg = { ...DEFAULTS };

function loadCfg() {
  try {
    const stored = localStorage.getItem('morse-cfg');
    if (stored) cfg = { ...DEFAULTS, ...JSON.parse(stored) };
  } catch (_) {}
}

function saveCfg() {
  localStorage.setItem('morse-cfg', JSON.stringify(cfg));
}

// ─── Audio ─────────────────────────────────────────────────────────────────
const audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.connect(audioCtx.destination);

function makeTone(startTime, durationSeconds) {
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(masterGain);
  osc.frequency.value = cfg.pitch;
  osc.type            = cfg.waveform;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.85, startTime + 0.005);
  gain.gain.setValueAtTime(0.85, startTime + durationSeconds - 0.005);
  gain.gain.linearRampToValueAtTime(0, startTime + durationSeconds);
  osc.start(startTime);
  osc.stop(startTime + durationSeconds);
}

function playKeyTone(isDash) {
  if (!cfg.soundOn) return;
  audioCtx.resume();
  masterGain.gain.value = cfg.volume / 100;
  makeTone(audioCtx.currentTime + 0.01, isDash ? 0.24 : 0.08);
}

function playRefTone(morseCode) {
  if (!cfg.soundOn) return;
  audioCtx.resume();
  masterGain.gain.value = cfg.volume / 100;
  let scheduledTime = audioCtx.currentTime + 0.05;
  morseCode.split('').forEach((sym, idx, arr) => {
    const dur = sym === '-' ? 0.24 : 0.08;
    makeTone(scheduledTime, dur);
    scheduledTime += dur + (idx < arr.length - 1 ? 0.08 : 0);
  });
}

function vibrate(ms) {
  if (cfg.hapticOn && navigator.vibrate) navigator.vibrate(ms);
}

// ─── WPM ───────────────────────────────────────────────────────────────────
const commitTimes = [];

function recordCommit() {
  const now = Date.now();
  commitTimes.push(now);
  while (commitTimes.length && now - commitTimes[0] > 60000) commitTimes.shift();
  const el = document.getElementById('wpm-display');
  if (!el) return;
  const recent = commitTimes.filter(t => now - t < 60000);
  if (recent.length < 2) { el.textContent = '– wpm'; return; }
  el.textContent = Math.round((recent.length / 5) / ((now - recent[0]) / 60000)) + ' wpm';
}

// ─── Notes state ───────────────────────────────────────────────────────────
const entries        = [];
let   pendingSyms    = [];
let   letterTimer    = null;
let   wordTimer      = null;
let   cursorPosition = 0;

// ─── Undo ──────────────────────────────────────────────────────────────────
const undoStack = [];

function pushUndoSnapshot() {
  undoStack.push({ entries: entries.map(e => ({ ...e })), cursorPosition });
  if (undoStack.length > 60) undoStack.shift();
}

function undo() {
  if (!undoStack.length) return;
  clearTimeout(letterTimer); clearTimeout(wordTimer);
  const snap = undoStack.pop();
  entries.length = 0;
  entries.push(...snap.entries);
  cursorPosition = snap.cursorPosition;
  pendingSyms = [];
  refreshPending(); refreshNotes();
}

const outputText = () => entries.map(e => e.space ? ' ' : e.char).join('');

// ─── DOM refs ──────────────────────────────────────────────────────────────
const elNotes     = document.getElementById('notes');
const elPendSyms  = document.getElementById('pend-syms');
const elPendArrow = document.getElementById('pend-arrow');
const elPendChar  = document.getElementById('pend-char');
const elCharCount = document.getElementById('char-count');

// ─── Input ─────────────────────────────────────────────────────────────────
function addSymbol(isDash) {
  audioCtx.resume();
  clearTimeout(letterTimer); clearTimeout(wordTimer);
  pendingSyms.push(isDash ? '-' : '.');
  playKeyTone(isDash);
  vibrate(isDash ? 28 : 10);
  refreshPending();
  letterTimer = setTimeout(commitLetter, cfg.letterDelayMs);
}

function commitLetter() {
  if (!pendingSyms.length) return;
  const morse   = pendingSyms.join('');
  const decoded = DECODE[morse] ?? '?';
  pendingSyms = [];
  refreshPending();

  if (isLearnMode) {
    checkLearnAnswer(decoded);
    return;
  }

  pushUndoSnapshot();
  entries.splice(cursorPosition, 0, { char: decoded, morse });
  cursorPosition++;
  refreshNotes();
  flashRefCard(decoded);
  recordCommit();
  if (cfg.autoWordSpace) {
    wordTimer = setTimeout(() => {
      entries.splice(cursorPosition, 0, { space: true });
      cursorPosition++;
      refreshNotes();
    }, cfg.letterDelayMs * 2.5);
  }
}

function addSpace() {
  clearTimeout(letterTimer); clearTimeout(wordTimer);
  if (isLearnMode) return;
  pushUndoSnapshot();
  if (pendingSyms.length) {
    const morse   = pendingSyms.join('');
    const decoded = DECODE[morse] ?? '?';
    entries.splice(cursorPosition, 0, { char: decoded, morse });
    cursorPosition++;
    pendingSyms = [];
    flashRefCard(decoded);
    recordCommit();
  }
  entries.splice(cursorPosition, 0, { space: true });
  cursorPosition++;
  refreshPending(); refreshNotes();
}

function backspace() {
  clearTimeout(letterTimer); clearTimeout(wordTimer);
  if (pendingSyms.length) {
    pendingSyms.pop();
    refreshPending();
    if (pendingSyms.length) letterTimer = setTimeout(commitLetter, cfg.letterDelayMs);
  } else if (!isLearnMode && cursorPosition > 0) {
    pushUndoSnapshot();
    entries.splice(cursorPosition - 1, 1);
    cursorPosition--;
    refreshNotes();
  }
}

function clearAll() {
  if (!entries.length && !pendingSyms.length) return;
  pushUndoSnapshot();
  clearTimeout(letterTimer); clearTimeout(wordTimer);
  entries.length = 0;
  cursorPosition = 0;
  pendingSyms    = [];
  refreshPending(); refreshNotes();
}

function moveCursorLeft()  { if (!isLearnMode && cursorPosition > 0)              { cursorPosition--; refreshNotes(); } }
function moveCursorRight() { if (!isLearnMode && cursorPosition < entries.length)  { cursorPosition++; refreshNotes(); } }

// ─── Display ───────────────────────────────────────────────────────────────
function refreshPending() {
  const morse = pendingSyms.join('');
  if (!morse) {
    elPendSyms.textContent = elPendArrow.textContent = elPendChar.textContent = '';
    return;
  }
  elPendSyms.textContent  = symStr(morse);
  elPendArrow.textContent = '→';
  elPendChar.textContent  = DECODE[morse] ?? '?';
}

function refreshNotes() {
  const raw       = outputText();
  const charCount = raw.replace(/ /g, '').length;
  const wordCount = raw.trim() ? raw.trim().split(/\s+/).length : 0;
  elCharCount.textContent = `${charCount} chars · ${wordCount} word${wordCount !== 1 ? 's' : ''}`;

  if (!raw) {
    elNotes.innerHTML = '<span class="notes-hint">tap the keys below…</span>';
    saveSession(); return;
  }

  const esc    = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  elNotes.innerHTML = esc(raw.slice(0, cursorPosition))
    + '<span class="cursor"></span>'
    + esc(raw.slice(cursorPosition));
  saveSession();
}

function flashRefCard(char) {
  const card = document.querySelector(`.ref-card[data-char="${char}"]`);
  if (!card) return;
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 500);
}

// ─── Learn mode: character selection ───────────────────────────────────────
const ALL_LEARN_CHARS    = 'ETIANMSURWDKGOHVFLPJBXCYZQ'.split('').concat('0123456789'.split(''));
const LETTER_CHARS       = 'ETIANMSURWDKGOHVFLPJBXCYZQ'.split('');
const NUMBER_CHARS       = '0123456789'.split('');

// Persisted selection — loaded from localStorage, defaults to all chars
let selectedLearnChars = new Set(ALL_LEARN_CHARS);

function loadLearnChars() {
  try {
    const stored = localStorage.getItem('morse-learn-chars');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length) {
        selectedLearnChars = new Set(parsed.filter(c => ALL_LEARN_CHARS.includes(c)));
      }
    }
  } catch (_) {}
}

function saveLearnChars() {
  try {
    localStorage.setItem('morse-learn-chars', JSON.stringify([...selectedLearnChars]));
  } catch (_) {}
}

function getActiveLearnSequence() {
  const active = ALL_LEARN_CHARS.filter(c => selectedLearnChars.has(c));
  return active.length ? active : ALL_LEARN_CHARS;
}

function getPracticingLabel() {
  const count  = selectedLearnChars.size;
  const total  = ALL_LEARN_CHARS.length;
  if (count === total) return `practicing: all ${total}`;
  const onlyLetters = LETTER_CHARS.every(c => selectedLearnChars.has(c)) && count === LETTER_CHARS.length;
  if (onlyLetters) return 'practicing: letters';
  const onlyNumbers = NUMBER_CHARS.every(c => selectedLearnChars.has(c)) && count === NUMBER_CHARS.length;
  if (onlyNumbers) return 'practicing: numbers';
  return `practicing: ${count} chars`;
}

function syncPickerGrid() {
  document.querySelectorAll('.picker-char-btn').forEach(btn => {
    btn.classList.toggle('selected', selectedLearnChars.has(btn.dataset.char));
  });
  syncPresetHighlights();
  document.getElementById('learn-practicing-label').textContent = getPracticingLabel();
}

function syncPresetHighlights() {
  const count = selectedLearnChars.size;
  document.querySelectorAll('.picker-preset').forEach(btn => {
    const preset = btn.dataset.preset;
    const isActive =
      preset === 'all'     ? count === ALL_LEARN_CHARS.length :
      preset === 'letters' ? LETTER_CHARS.every(c => selectedLearnChars.has(c)) && count === LETTER_CHARS.length :
      preset === 'numbers' ? NUMBER_CHARS.every(c => selectedLearnChars.has(c)) && count === NUMBER_CHARS.length :
      false;
    btn.classList.toggle('active', isActive);
  });
}

function applyPreset(preset) {
  if (preset === 'all')     selectedLearnChars = new Set(ALL_LEARN_CHARS);
  if (preset === 'letters') selectedLearnChars = new Set(LETTER_CHARS);
  if (preset === 'numbers') selectedLearnChars = new Set(NUMBER_CHARS);
  learnIndex = 0;
  saveLearnChars();
  syncPickerGrid();
  updateLearnDisplay();
}

function toggleLearnChar(char) {
  // Always keep at least one character selected
  if (selectedLearnChars.has(char) && selectedLearnChars.size === 1) return;
  if (selectedLearnChars.has(char)) {
    selectedLearnChars.delete(char);
  } else {
    selectedLearnChars.add(char);
  }
  // Reset index so it stays within the new set bounds
  learnIndex = 0;
  saveLearnChars();
  syncPickerGrid();
  updateLearnDisplay();
}

function buildPickerGrid() {
  const grid = document.getElementById('picker-grid');
  grid.innerHTML = '';
  ALL_LEARN_CHARS.forEach(char => {
    const btn = document.createElement('button');
    btn.className       = 'picker-char-btn';
    btn.dataset.char    = char;
    btn.textContent     = char;
    btn.classList.toggle('selected', selectedLearnChars.has(char));
    btn.addEventListener('pointerdown', e => { e.preventDefault(); toggleLearnChar(char); });
    grid.appendChild(btn);
  });
}

function initLearnPicker() {
  const editBtn  = document.getElementById('learn-edit-btn');
  const picker   = document.getElementById('learn-picker');
  let pickerOpen = false;

  editBtn.addEventListener('click', () => {
    pickerOpen = !pickerOpen;
    picker.style.display  = pickerOpen ? '' : 'none';
    editBtn.textContent   = pickerOpen ? 'done ▴' : 'edit ▾';
    editBtn.classList.toggle('open', pickerOpen);
  });

  document.querySelectorAll('.picker-preset').forEach(btn => {
    btn.addEventListener('pointerdown', e => { e.preventDefault(); applyPreset(btn.dataset.preset); });
  });

  buildPickerGrid();
  syncPresetHighlights();
}

// ─── Learn mode: quiz logic ────────────────────────────────────────────────
let isLearnMode   = false;
let learnIndex    = 0;
let learnStreak   = 0;
let learnScore    = 0;
let learnAnswered = false;

function getCurrentLearnChar() {
  const seq = getActiveLearnSequence();
  return seq[learnIndex % seq.length];
}

function updateLearnDisplay() {
  const target      = getCurrentLearnChar();
  const targetMorse = symStr(MORSE[target] || '');
  document.getElementById('learn-char').textContent   = target;
  document.getElementById('learn-morse').textContent  = targetMorse;
  document.getElementById('learn-streak').textContent = `streak: ${learnStreak}`;
  document.getElementById('learn-score').textContent  = `score: ${learnScore}`;
  const feedbackEl = document.getElementById('learn-feedback');
  feedbackEl.textContent = '';
  feedbackEl.className   = 'learn-feedback';
  learnAnswered = false;
  playRefTone(MORSE[target] || '');
}

function advanceLearnChar() {
  learnIndex = (learnIndex + 1) % getActiveLearnSequence().length;
  updateLearnDisplay();
}

function checkLearnAnswer(decodedChar) {
  if (learnAnswered) return;
  learnAnswered = true;

  const target     = getCurrentLearnChar();
  const feedbackEl = document.getElementById('learn-feedback');

  if (decodedChar === target) {
    learnStreak++;
    learnScore++;
    feedbackEl.textContent = '✓ correct!';
    feedbackEl.className   = 'learn-feedback correct';
    flashRefCard(target);
    document.getElementById('learn-streak').textContent = `streak: ${learnStreak}`;
    document.getElementById('learn-score').textContent  = `score: ${learnScore}`;
    setTimeout(advanceLearnChar, 800);
  } else {
    learnStreak = 0;
    feedbackEl.textContent = `✗  answer: ${symStr(MORSE[target] || '')}`;
    feedbackEl.className   = 'learn-feedback wrong';
    document.getElementById('learn-streak').textContent = `streak: ${learnStreak}`;
    playRefTone(MORSE[target] || '');
    setTimeout(advanceLearnChar, 1800);
  }
}

function enterLearnMode() {
  isLearnMode = true;
  clearTimeout(letterTimer); clearTimeout(wordTimer);
  pendingSyms = [];
  refreshPending();
  document.getElementById('type-panel').style.display  = 'none';
  document.getElementById('learn-panel').style.display = '';
  document.getElementById('btn-space').style.visibility = 'hidden';
  document.getElementById('btn-left').style.visibility  = 'hidden';
  document.getElementById('btn-right').style.visibility = 'hidden';
  updateLearnDisplay();
}

function exitLearnMode() {
  isLearnMode = false;
  clearTimeout(letterTimer); clearTimeout(wordTimer);
  pendingSyms = [];
  refreshPending();
  document.getElementById('type-panel').style.display  = '';
  document.getElementById('learn-panel').style.display = 'none';
  document.getElementById('btn-space').style.visibility = '';
  document.getElementById('btn-left').style.visibility  = '';
  document.getElementById('btn-right').style.visibility = '';
}

function initModeTabs() {
  document.getElementById('mode-type').addEventListener('click', () => {
    document.getElementById('mode-type').classList.add('active');
    document.getElementById('mode-learn').classList.remove('active');
    exitLearnMode();
  });
  document.getElementById('mode-learn').addEventListener('click', () => {
    document.getElementById('mode-learn').classList.add('active');
    document.getElementById('mode-type').classList.remove('active');
    enterLearnMode();
  });
  document.getElementById('learn-skip').addEventListener('click', () => {
    clearTimeout(letterTimer);
    pendingSyms = [];
    refreshPending();
    learnAnswered = false;
    advanceLearnChar();
  });
}

// ─── Sound toggle ──────────────────────────────────────────────────────────
function initSoundToggle() {
  const btn = document.getElementById('sound-toggle');
  btn.classList.toggle('muted', !cfg.soundOn);
  btn.addEventListener('click', () => {
    cfg.soundOn = !cfg.soundOn;
    btn.classList.toggle('muted', !cfg.soundOn);
    saveCfg();
  });
}

// ─── Reference panel ───────────────────────────────────────────────────────
function buildReference() {
  const container = document.getElementById('ref-content');
  container.innerHTML = '';
  const SECTIONS = [
    { label: 'Letters',     chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') },
    { label: 'Numbers',     chars: '0123456789'.split('') },
    { label: 'Punctuation', chars: ['.', ',', '?', '!', "'", '/', '(', ')', '&', ':', ';', '=', '+', '-', '_', '"', '$', '@'] },
  ];
  SECTIONS.forEach(section => {
    const sectionEl  = document.createElement('div');
    sectionEl.className = 'ref-section';
    const labelEl    = document.createElement('div');
    labelEl.className   = 'ref-section-label';
    labelEl.textContent = section.label;
    sectionEl.appendChild(labelEl);
    const grid = document.createElement('div');
    grid.className = 'ref-grid';
    section.chars.forEach(char => {
      const morseCode = MORSE[char];
      if (!morseCode) return;
      const card = document.createElement('div');
      card.className    = 'ref-card';
      card.dataset.char = char;
      card.innerHTML = `<span class="ref-letter">${char}</span><span class="ref-morse">${symStr(morseCode)}</span>`;
      card.addEventListener('pointerdown', e => { e.preventDefault(); playRefTone(morseCode); flashRefCard(char); });
      grid.appendChild(card);
    });
    sectionEl.appendChild(grid);
    container.appendChild(sectionEl);
  });
}

// ─── Keyboard ──────────────────────────────────────────────────────────────
function initKeyboard() {
  document.getElementById('btn-dot').addEventListener('pointerdown',  e => { e.preventDefault(); addSymbol(false); });
  document.getElementById('btn-dash').addEventListener('pointerdown', e => { e.preventDefault(); addSymbol(true);  });
  document.getElementById('btn-space').addEventListener('pointerdown',e => { e.preventDefault(); addSpace();       });

  const backBtn = document.getElementById('btn-back');
  let backHoldTimer = null, backRepeat = null;
  function startBack()  { backspace(); backHoldTimer = setTimeout(() => { backRepeat = setInterval(backspace, 80); }, 450); }
  function stopBack()   { clearTimeout(backHoldTimer); clearInterval(backRepeat); }
  backBtn.addEventListener('pointerdown',  e => { e.preventDefault(); startBack(); });
  backBtn.addEventListener('pointerup',    stopBack);
  backBtn.addEventListener('pointerleave', stopBack);

  const clearBtn = document.getElementById('btn-clear');
  let clearHoldTimer = null;
  function startClear(e) {
    e.preventDefault();
    clearBtn.classList.add('holding');
    clearHoldTimer = setTimeout(() => {
      clearBtn.classList.remove('holding');
      if (!isLearnMode) clearAll(); else { pendingSyms = []; refreshPending(); }
      vibrate(30);
    }, 600);
  }
  function cancelClear() { clearTimeout(clearHoldTimer); clearBtn.classList.remove('holding'); }
  clearBtn.addEventListener('pointerdown',  startClear);
  clearBtn.addEventListener('pointerup',    cancelClear);
  clearBtn.addEventListener('pointerleave', cancelClear);

  document.getElementById('btn-left').addEventListener('pointerdown',  e => { e.preventDefault(); moveCursorLeft();  });
  document.getElementById('btn-right').addEventListener('pointerdown', e => { e.preventDefault(); moveCursorRight(); });
}

// ─── Swipe ─────────────────────────────────────────────────────────────────
function initSwipeBackspace() {
  const kb = document.getElementById('keyboard');
  let sx = 0, sy = 0;
  kb.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  kb.addEventListener('touchend',   e => {
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dy) > 35) return;
    if (dx < -55) backspace();
    if (dx >  55 && !isLearnMode) undo();
  }, { passive: true });
}

// ─── Physical keyboard ─────────────────────────────────────────────────────
function initKeyShortcuts() {
  document.addEventListener('keydown', e => {
    if (document.activeElement.tagName === 'INPUT') return;
    if (e.code === 'Minus')        { e.preventDefault(); addSymbol(false);   }
    if (e.code === 'Equal')        { e.preventDefault(); addSymbol(true);    }
    if (e.code === 'Space')        { e.preventDefault(); addSpace();          }
    if (e.code === 'Backspace')    { e.preventDefault(); backspace();         }
    if (e.code === 'BracketLeft')  { e.preventDefault(); moveCursorLeft();   }
    if (e.code === 'BracketRight') { e.preventDefault(); moveCursorRight();  }
    if (e.code === 'KeyU' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); undo(); }
    if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
  });
}

// ─── Ref toggle ────────────────────────────────────────────────────────────
function initRefToggle() {
  document.getElementById('ref-toggle').addEventListener('click', () => {
    document.getElementById('ref-panel').classList.toggle('open');
  });
}

// ─── Copy ──────────────────────────────────────────────────────────────────
function initCopy() {
  const btn = document.getElementById('copy-btn');
  btn.addEventListener('click', async () => {
    const text = outputText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'copied!'; btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1800);
    } catch (_) {
      btn.textContent = 'failed';
      setTimeout(() => { btn.textContent = 'copy'; }, 1500);
    }
  });
}

// ─── Session persistence ───────────────────────────────────────────────────
function saveSession() {
  try { localStorage.setItem('morse-session', JSON.stringify({ entries, cursorPosition })); } catch (_) {}
}

function loadSession() {
  try {
    const stored = localStorage.getItem('morse-session');
    if (!stored) return;
    const { entries: saved, cursorPosition: savedCursor } = JSON.parse(stored);
    if (Array.isArray(saved) && saved.length) {
      entries.push(...saved);
      cursorPosition = typeof savedCursor === 'number' ? Math.min(savedCursor, saved.length) : saved.length;
    }
  } catch (_) {}
}

// ─── Boot ──────────────────────────────────────────────────────────────────
loadCfg();
loadLearnChars();
buildReference();
initModeTabs();
initSoundToggle();
initLearnPicker();
initKeyboard();
initSwipeBackspace();
initKeyShortcuts();
initRefToggle();
initCopy();
loadSession();
refreshNotes();
