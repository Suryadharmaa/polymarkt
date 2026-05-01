/* ═══════════════════════════════════════════════════════════════
BTC Signal · app.js
Static GitHub Pages app — no backend required
Data: Binance public REST API
AI:   Groq API (user-supplied key, stored in localStorage)
═══════════════════════════════════════════════════════════════ */

‘use strict’;

/* ──────────────────────────────────────────────────────
CONSTANTS
────────────────────────────────────────────────────── */
const BINANCE_BASE  = ‘https://api.binance.com/api/v3’;
const GROQ_ENDPOINT = ‘https://api.groq.com/openai/v1/chat/completions’;
const GROQ_MODEL    = ‘llama3-8b-8192’;       // fast, free-tier friendly
const BTC_SYMBOL    = ‘BTCUSDT’;
const KLINE_LIMIT   = 20;                      // last 20 M5 candles

/* Polymarket sentiment (static embed — these values are from the embed) */
const PM_UP_DEFAULT   = 51;
const PM_DOWN_DEFAULT = 50;

/* ──────────────────────────────────────────────────────
STATE
────────────────────────────────────────────────────── */
const state = {
candles:          [],     // [{o,h,l,c,v,t}]
lastPrice:        null,
prevPrice:        null,
ticker24h:        {},
signalHistory:    [],     // last 10 signals
currentSignal:    null,
groqBusy:         false,
priceTimerId:     null,
groqTimerId:      null,
countdownTimerId: null,
nextGroqIn:       0,      // seconds until next Groq call
groqIntervalMs:   60000,
refreshIntervalMs: 10000,
};

/* ──────────────────────────────────────────────────────
DOM REFS
────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const dom = {
clock:            $(‘clock’),
liveDot:          $(‘liveDot’),
apiBanner:        $(‘apiBanner’),
apiKeyInput:      $(‘apiKeyInput’),
saveKeyBtn:       $(‘saveKeyBtn’),
clearKeyBtn:      $(‘clearKeyBtn’),

btcPrice:         $(‘btcPrice’),
priceChange:      $(‘priceChange’),
high24:           $(‘high24’),
low24:            $(‘low24’),
vol24:            $(‘vol24’),

chartStatus:      $(‘chartStatus’),

metMomentum:      $(‘metMomentum’),
metVolatility:    $(‘metVolatility’),
metDelta:         $(‘metDelta’),
metSlope:         $(‘metSlope’),

signalCard:       $(‘signalCard’),
signalIcon:       $(‘signalIcon’),
signalDirection:  $(‘signalDirection’),
signalAge:        $(‘signalAge’),
confBar:          $(‘confBar’),
confPct:          $(‘confPct’),
signalReasoning:  $(‘signalReasoning’),
signalLoader:     $(‘signalLoader’),

historyList:      $(‘historyList’),

pmUp:             $(‘pmUp’),
pmDown:           $(‘pmDown’),

refreshInterval:  $(‘refreshInterval’),
groqInterval:     $(‘groqInterval’),
refreshNow:       $(‘refreshNow’),
nextSignalCountdown: $(‘nextSignalCountdown’),
};

/* ──────────────────────────────────────────────────────
API KEY MANAGEMENT
────────────────────────────────────────────────────── */
function getApiKey() {
return localStorage.getItem(‘groq_api_key’) || ‘’;
}

function saveApiKey(key) {
localStorage.setItem(‘groq_api_key’, key.trim());
}

function clearApiKey() {
localStorage.removeItem(‘groq_api_key’);
}

function updateApiBannerUI() {
const key = getApiKey();
if (key) {
dom.apiKeyInput.value = ‘••••••••••••••••••••’;
dom.saveKeyBtn.style.display  = ‘none’;
dom.clearKeyBtn.style.display = ‘inline-block’;
dom.apiBanner.style.borderBottomColor = ‘rgba(0,255,136,0.3)’;
} else {
dom.apiKeyInput.value = ‘’;
dom.saveKeyBtn.style.display  = ‘inline-block’;
dom.clearKeyBtn.style.display = ‘none’;
dom.apiBanner.style.borderBottomColor = ‘’;
}
}

dom.saveKeyBtn.addEventListener(‘click’, () => {
const val = dom.apiKeyInput.value.trim();
if (!val || val.startsWith(’•’)) return;
saveApiKey(val);
updateApiBannerUI();
// trigger immediate Groq call
triggerGroqNow();
});

dom.clearKeyBtn.addEventListener(‘click’, () => {
clearApiKey();
updateApiBannerUI();
});

/* ──────────────────────────────────────────────────────
CLOCK
────────────────────────────────────────────────────── */
function updateClock() {
const now = new Date();
dom.clock.textContent = now.toLocaleTimeString(‘en-US’, {
hour: ‘2-digit’, minute: ‘2-digit’, second: ‘2-digit’, hour12: false
});
}
setInterval(updateClock, 1000);
updateClock();

/* ──────────────────────────────────────────────────────
CHART SETUP (Chart.js)
────────────────────────────────────────────────────── */
let btcChart = null;

function initChart() {
const ctx = document.getElementById(‘btcChart’).getContext(‘2d’);
const gradient = ctx.createLinearGradient(0, 0, 0, 160);
gradient.addColorStop(0,   ‘rgba(0,255,136,0.18)’);
gradient.addColorStop(1,   ‘rgba(0,255,136,0)’);

btcChart = new Chart(ctx, {
type: ‘line’,
data: {
labels: [],
datasets: [{
label: ‘BTC M5’,
data: [],
borderColor: ‘#00ff88’,
borderWidth: 1.5,
backgroundColor: gradient,
fill: true,
tension: 0.35,
pointRadius: 0,
pointHoverRadius: 4,
pointHoverBackgroundColor: ‘#00ff88’,
}]
},
options: {
responsive: true,
maintainAspectRatio: false,
animation: { duration: 400 },
plugins: {
legend: { display: false },
tooltip: {
backgroundColor: ‘#0d1318’,
borderColor: ‘#1e2d3a’,
borderWidth: 1,
titleColor: ‘#607585’,
bodyColor: ‘#c8dae8’,
callbacks: {
label: ctx => `$${ctx.parsed.y.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
}
}
},
scales: {
x: {
grid: { color: ‘rgba(30,45,58,0.6)’, drawTicks: false },
ticks: { color: ‘#354550’, font: { family: ‘Share Tech Mono’, size: 10 }, maxTicksLimit: 5 },
border: { display: false }
},
y: {
position: ‘right’,
grid: { color: ‘rgba(30,45,58,0.6)’, drawTicks: false },
ticks: {
color: ‘#607585’,
font: { family: ‘Share Tech Mono’, size: 10 },
callback: v => ‘$’ + v.toLocaleString(‘en-US’, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
},
border: { display: false }
}
}
}
});
}

function updateChart(candles) {
if (!btcChart || !candles.length) return;
const labels = candles.map(c => {
const d = new Date(c.t);
return d.toLocaleTimeString(‘en-US’, { hour: ‘2-digit’, minute: ‘2-digit’, hour12: false });
});
const closes = candles.map(c => c.c);

btcChart.data.labels = labels;
btcChart.data.datasets[0].data = closes;

// Re-colour gradient based on trend
const first = closes[0];
const last  = closes[closes.length - 1];
const upTrend = last >= first;
const ctx = btcChart.ctx;
const grad = ctx.createLinearGradient(0, 0, 0, 160);
if (upTrend) {
grad.addColorStop(0, ‘rgba(0,255,136,0.18)’);
grad.addColorStop(1, ‘rgba(0,255,136,0)’);
btcChart.data.datasets[0].borderColor = ‘#00ff88’;
} else {
grad.addColorStop(0, ‘rgba(255,61,90,0.18)’);
grad.addColorStop(1, ‘rgba(255,61,90,0)’);
btcChart.data.datasets[0].borderColor = ‘#ff3d5a’;
}
btcChart.data.datasets[0].backgroundColor = grad;
btcChart.update(‘none’);
}

/* ──────────────────────────────────────────────────────
BINANCE DATA FETCHING
────────────────────────────────────────────────────── */
/**

- Fetch last N M5 klines from Binance public REST API
  */
  async function fetchKlines() {
  try {
  const url = `${BINANCE_BASE}/klines?symbol=${BTC_SYMBOL}&interval=5m&limit=${KLINE_LIMIT}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Klines HTTP ${res.status}`);
  const raw = await res.json();
  
  // Binance kline format:
  // [openTime, open, high, low, close, volume, closeTime, …]
  state.candles = raw.map(k => ({
  t: k[0],   // open timestamp
  o: parseFloat(k[1]),
  h: parseFloat(k[2]),
  l: parseFloat(k[3]),
  c: parseFloat(k[4]),
  v: parseFloat(k[5]),
  }));
  
  dom.chartStatus.textContent = `${state.candles.length} candles`;
  updateChart(state.candles);
  computeMetrics();
  return true;
  } catch (err) {
  console.warn(‘fetchKlines error:’, err);
  dom.chartStatus.textContent = ‘error’;
  return false;
  }
  }

/**

- Fetch 24h ticker for price, change, high, low, vol
  */
  async function fetchTicker() {
  try {
  const url = `${BINANCE_BASE}/ticker/24hr?symbol=${BTC_SYMBOL}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Ticker HTTP ${res.status}`);
  const data = await res.json();
  
  state.prevPrice = state.lastPrice;
  state.lastPrice = parseFloat(data.lastPrice);
  state.ticker24h = {
  change:  parseFloat(data.priceChangePercent),
  high:    parseFloat(data.highPrice),
  low:     parseFloat(data.lowPrice),
  vol:     parseFloat(data.volume),
  };
  
  updatePriceUI();
  return true;
  } catch (err) {
  console.warn(‘fetchTicker error:’, err);
  return false;
  }
  }

/* ──────────────────────────────────────────────────────
PRICE UI UPDATE
────────────────────────────────────────────────────── */
function updatePriceUI() {
const { lastPrice, prevPrice, ticker24h } = state;
if (!lastPrice) return;

const priceStr = ‘$’ + lastPrice.toLocaleString(‘en-US’, {
minimumFractionDigits: 2, maximumFractionDigits: 2
});
dom.btcPrice.textContent = priceStr;

// Flash on change
if (prevPrice !== null && prevPrice !== lastPrice) {
const cls = lastPrice > prevPrice ? ‘flash-green’ : ‘flash-red’;
dom.btcPrice.classList.remove(‘flash-green’, ‘flash-red’);
void dom.btcPrice.offsetWidth; // reflow
dom.btcPrice.classList.add(cls);
}

// 24h change
const pct = ticker24h.change;
const sign = pct >= 0 ? ‘+’ : ‘’;
dom.priceChange.textContent = `${sign}${pct.toFixed(2)}%`;
dom.priceChange.className   = ’price-change ’ + (pct >= 0 ? ‘up’ : ‘down’);

dom.high24.textContent = ‘$’ + ticker24h.high?.toLocaleString(‘en-US’, { minimumFractionDigits: 0 });
dom.low24.textContent  = ‘$’ + ticker24h.low?.toLocaleString(‘en-US’,  { minimumFractionDigits: 0 });
dom.vol24.textContent  = ticker24h.vol ? (ticker24h.vol / 1000).toFixed(1) + ‘K BTC’ : ‘—’;
}

/* ──────────────────────────────────────────────────────
MARKET METRICS (computed from candles)
────────────────────────────────────────────────────── */
function computeMetrics() {
const candles = state.candles;
if (candles.length < 5) return null;

// ATR-like volatility (avg of last 10 true ranges)
const atrCandles = candles.slice(-10);
const trs = atrCandles.map(c => c.h - c.l);
const atr = trs.reduce((a, b) => a + b, 0) / trs.length;

// Momentum: close[last] - close[last-5]
const closes = candles.map(c => c.c);
const n       = closes.length;
const momentum = closes[n - 1] - closes[n - 6];

// Delta: last candle body
const last   = candles[n - 1];
const delta  = last.c - last.o;

// Linear regression slope over last 10 closes (simple rise/run)
const slopeCandles = closes.slice(-10);
const xMean  = 4.5;
const yMean  = slopeCandles.reduce((a, b) => a + b, 0) / 10;
let num = 0, den = 0;
slopeCandles.forEach((y, x) => {
num += (x - xMean) * (y - yMean);
den += (x - xMean) ** 2;
});
const slope = den !== 0 ? num / den : 0;

const metrics = { atr, momentum, delta, slope };

// Update UI
const fmt = (v, prefix = ‘$’) =>
prefix + Math.abs(v).toLocaleString(‘en-US’, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

dom.metMomentum.textContent  = (momentum >= 0 ? ‘+’ : ‘-’) + fmt(momentum);
dom.metMomentum.style.color  = momentum >= 0 ? ‘var(–green)’ : ‘var(–red)’;

dom.metVolatility.textContent = fmt(atr);
dom.metVolatility.style.color = ‘var(–cyan)’;

dom.metDelta.textContent = (delta >= 0 ? ‘+’ : ‘-’) + fmt(delta);
dom.metDelta.style.color = delta >= 0 ? ‘var(–green)’ : ‘var(–red)’;

dom.metSlope.textContent = (slope >= 0 ? ‘+’ : ‘’) + slope.toFixed(2) + ‘/bar’;
dom.metSlope.style.color = slope >= 0 ? ‘var(–green)’ : ‘var(–red)’;

return metrics;
}

/* ──────────────────────────────────────────────────────
GROQ API — PROMPT ENGINEERING
────────────────────────────────────────────────────── */
/**

- Build a compact, token-efficient prompt from market data.
- Returns a system + user message pair.
  */
  function buildGroqMessages(candles, metrics, pmUp, pmDown) {
  const closes = candles.map(c => c.c);
  const n = closes.length;

// Only send last 10 close prices to keep tokens low
const recentCloses = closes.slice(-10).map(p =>
p.toLocaleString(‘en-US’, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
).join(’, ’);

const lastPrice  = closes[n - 1].toFixed(2);
const { atr, momentum, delta, slope } = metrics;

const system = `You are a quantitative crypto trading signal generator. Analyze the provided Bitcoin M5 market data and Polymarket sentiment, then respond ONLY with valid JSON in this exact schema: {"signal":"UP"|"DOWN","confidence":0-100,"reasoning":"max 30 words"} No markdown, no extra text. Be decisive.`;

const user =
`BTC/USDT M5 snapshot:

- Last price: $${lastPrice}
- Last 10 closes (oldest→newest): ${recentCloses}
- Momentum (5-bar): ${momentum.toFixed(2)}
- ATR proxy: ${atr.toFixed(2)}
- Last candle Δ: ${delta.toFixed(2)}
- Regression slope: ${slope.toFixed(3)}/bar
- Polymarket UP: ${pmUp}% | DOWN: ${pmDown}%

Generate signal for the NEXT 5 minutes.`;

return [
{ role: ‘system’, content: system },
{ role: ‘user’,   content: user   },
];
}

/**

- Call Groq API and parse signal
  */
  async function callGroq() {
  const apiKey = getApiKey();
  if (!apiKey) {
  dom.signalReasoning.textContent = ‘⚠️ Enter your Groq API key above to enable AI signals.’;
  return;
  }

const metrics = computeMetrics();
if (!metrics || state.candles.length < 10) {
dom.signalReasoning.textContent = ‘Waiting for enough candle data…’;
return;
}

if (state.groqBusy) return;
state.groqBusy = true;

// Show loader
dom.signalLoader.classList.add(‘active’);
dom.signalLoader.querySelector(‘span:last-child’).textContent = ‘Querying Groq…’;

const pmUp   = PM_UP_DEFAULT;
const pmDown = PM_DOWN_DEFAULT;
const messages = buildGroqMessages(state.candles, metrics, pmUp, pmDown);

try {
const res = await fetch(GROQ_ENDPOINT, {
method: ‘POST’,
headers: {
‘Content-Type’:  ‘application/json’,
‘Authorization’: `Bearer ${apiKey}`,
},
body: JSON.stringify({
model:       GROQ_MODEL,
max_tokens:  120,
temperature: 0.3,
messages,
}),
});

```
if (!res.ok) {
  const errBody = await res.text();
  throw new Error(`Groq HTTP ${res.status}: ${errBody.slice(0, 120)}`);
}

const data = await res.json();
const raw  = data.choices?.[0]?.message?.content?.trim() || '{}';

// Strip any stray markdown fences
const clean = raw.replace(/```json|```/gi, '').trim();
const parsed = JSON.parse(clean);

if (!parsed.signal || !['UP','DOWN'].includes(parsed.signal.toUpperCase())) {
  throw new Error('Invalid signal value: ' + JSON.stringify(parsed));
}

const signal = {
  direction:  parsed.signal.toUpperCase(),
  confidence: Math.min(100, Math.max(0, parseInt(parsed.confidence) || 50)),
  reasoning:  parsed.reasoning || 'No reasoning provided.',
  price:      state.lastPrice,
  timestamp:  Date.now(),
};

state.currentSignal = signal;
state.signalHistory.unshift(signal);
if (state.signalHistory.length > 10) state.signalHistory.pop();

updateSignalUI(signal);
updateHistoryUI();
```

} catch (err) {
console.error(‘Groq error:’, err);
dom.signalReasoning.textContent = ’⚠️ Groq error: ’ + err.message.slice(0, 120);
} finally {
state.groqBusy = false;
dom.signalLoader.classList.remove(‘active’);
}
}

/* ──────────────────────────────────────────────────────
SIGNAL UI
────────────────────────────────────────────────────── */
function updateSignalUI(signal) {
const { direction, confidence, reasoning } = signal;
const isUp = direction === ‘UP’;

// Card class
dom.signalCard.classList.remove(‘signal-up’, ‘signal-down’);
dom.signalCard.classList.add(isUp ? ‘signal-up’ : ‘signal-down’);

// Icon + direction
dom.signalIcon.textContent      = isUp ? ‘▲’ : ‘▼’;
dom.signalIcon.style.color      = isUp ? ‘var(–green)’ : ‘var(–red)’;
dom.signalDirection.textContent = direction;

// Confidence bar
dom.confBar.style.width  = confidence + ‘%’;
dom.confPct.textContent  = confidence + ‘%’;

// Reasoning
dom.signalReasoning.textContent = reasoning;

// Age label
dom.signalAge.textContent = ‘just now’;

// Entrance animation
dom.signalCard.classList.remove(‘signal-in’);
void dom.signalCard.offsetWidth;
dom.signalCard.classList.add(‘signal-in’);

// Start relative-time updater
updateSignalAge();
}

function updateSignalAge() {
if (!state.currentSignal) return;
const diffSec = Math.round((Date.now() - state.currentSignal.timestamp) / 1000);
if (diffSec < 60)       dom.signalAge.textContent = diffSec + ‘s ago’;
else if (diffSec < 3600) dom.signalAge.textContent = Math.floor(diffSec / 60) + ‘m ago’;
else                     dom.signalAge.textContent = Math.floor(diffSec / 3600) + ‘h ago’;
}
// Update age label every 5s
setInterval(updateSignalAge, 5000);

/* ──────────────────────────────────────────────────────
HISTORY UI
────────────────────────────────────────────────────── */
function updateHistoryUI() {
const history = state.signalHistory;
if (!history.length) {
dom.historyList.innerHTML = ‘<div class="history-empty">No signals yet</div>’;
return;
}

dom.historyList.innerHTML = history.map(s => {
const isUp    = s.direction === ‘UP’;
const time    = new Date(s.timestamp).toLocaleTimeString(‘en-US’, {
hour: ‘2-digit’, minute: ‘2-digit’, second: ‘2-digit’, hour12: false
});
const price   = s.price
? ‘$’ + s.price.toLocaleString(‘en-US’, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
: ‘—’;
return ` <div class="history-item"> <span class="history-dir ${isUp ? 'up' : 'down'}">${isUp ? '▲ UP' : '▼ DN'}</span> <span class="history-price">${price}</span> <span class="history-conf">${s.confidence}%</span> <span class="history-time">${time}</span> </div>`;
}).join(’’);
}

/* ──────────────────────────────────────────────────────
COUNTDOWN TICKER
────────────────────────────────────────────────────── */
function startCountdown() {
clearInterval(state.countdownTimerId);
state.nextGroqIn = Math.round(state.groqIntervalMs / 1000);

state.countdownTimerId = setInterval(() => {
state.nextGroqIn = Math.max(0, state.nextGroqIn - 1);
dom.nextSignalCountdown.textContent = state.nextGroqIn + ‘s’;
if (state.nextGroqIn === 0) {
state.nextGroqIn = Math.round(state.groqIntervalMs / 1000);
}
}, 1000);

dom.nextSignalCountdown.textContent = state.nextGroqIn + ‘s’;
}

/* ──────────────────────────────────────────────────────
POLLING LOOPS
────────────────────────────────────────────────────── */
async function refreshMarketData() {
await Promise.all([fetchKlines(), fetchTicker()]);
}

function startPriceLoop() {
clearInterval(state.priceTimerId);
state.priceTimerId = setInterval(refreshMarketData, state.refreshIntervalMs);
}

function startGroqLoop() {
clearInterval(state.groqTimerId);
state.groqTimerId = setInterval(() => {
callGroq();
startCountdown(); // reset countdown each time loop fires
}, state.groqIntervalMs);
startCountdown();
}

function triggerGroqNow() {
callGroq();
// reset the groq interval so it fires again after a full period
clearInterval(state.groqTimerId);
state.groqTimerId = setInterval(() => {
callGroq();
startCountdown();
}, state.groqIntervalMs);
startCountdown();
}

/* ──────────────────────────────────────────────────────
CONTROLS
────────────────────────────────────────────────────── */
dom.refreshInterval.addEventListener(‘change’, () => {
state.refreshIntervalMs = parseInt(dom.refreshInterval.value);
startPriceLoop();
});

dom.groqInterval.addEventListener(‘change’, () => {
state.groqIntervalMs = parseInt(dom.groqInterval.value);
startGroqLoop();
});

dom.refreshNow.addEventListener(‘click’, async () => {
dom.refreshNow.textContent = ‘↻ …’;
dom.refreshNow.disabled    = true;
await refreshMarketData();
dom.refreshNow.textContent = ‘↻ Now’;
dom.refreshNow.disabled    = false;
});

/* ──────────────────────────────────────────────────────
INIT
────────────────────────────────────────────────────── */
async function init() {
// 1. Restore UI state for API key
updateApiBannerUI();

// 2. Init chart
initChart();

// 3. First data fetch
await refreshMarketData();

// 4. Start polling loops
startPriceLoop();
startGroqLoop();

// 5. First Groq call if key is already saved
if (getApiKey()) {
callGroq();
}
}

init();
