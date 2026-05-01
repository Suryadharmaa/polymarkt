/* ═══════════════════════════════════════════════════════════════
BTC Signal · app.js  v2 — FIXED
Fixes:

- Multi-source BTC data fallback (Binance → Binance US → CoinGecko)
- Groq fires immediately after data loads (no more WAITING freeze)
- Guards against calling Groq before candles exist
- Robust JSON parsing (handles extra text, code fences)
- Better error display so user knows what went wrong
  ═══════════════════════════════════════════════════════════════ */

‘use strict’;

/* ──────────────────────────────────────────────────────
CONSTANTS
────────────────────────────────────────────────────── */
const GROQ_ENDPOINT = ‘https://api.groq.com/openai/v1/chat/completions’;
const GROQ_MODEL    = ‘llama3-8b-8192’;
const KLINE_LIMIT   = 20;

// Polymarket static sentiment values (from embed)
const PM_UP_DEFAULT   = 51;
const PM_DOWN_DEFAULT = 50;

/* ──────────────────────────────────────────────────────
STATE
────────────────────────────────────────────────────── */
const state = {
candles:           [],
lastPrice:         null,
prevPrice:         null,
ticker24h:         {},
signalHistory:     [],
currentSignal:     null,
groqBusy:          false,
dataSource:        ‘none’,
priceTimerId:      null,
groqTimerId:       null,
countdownTimerId:  null,
nextGroqIn:        0,
groqIntervalMs:    60000,
refreshIntervalMs: 10000,
dataReady:         false,
};

/* ──────────────────────────────────────────────────────
DOM REFS
────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const dom = {
clock:               $(‘clock’),
apiBanner:           $(‘apiBanner’),
apiKeyInput:         $(‘apiKeyInput’),
saveKeyBtn:          $(‘saveKeyBtn’),
clearKeyBtn:         $(‘clearKeyBtn’),
btcPrice:            $(‘btcPrice’),
priceChange:         $(‘priceChange’),
high24:              $(‘high24’),
low24:               $(‘low24’),
vol24:               $(‘vol24’),
chartStatus:         $(‘chartStatus’),
metMomentum:         $(‘metMomentum’),
metVolatility:       $(‘metVolatility’),
metDelta:            $(‘metDelta’),
metSlope:            $(‘metSlope’),
signalCard:          $(‘signalCard’),
signalIcon:          $(‘signalIcon’),
signalDirection:     $(‘signalDirection’),
signalAge:           $(‘signalAge’),
confBar:             $(‘confBar’),
confPct:             $(‘confPct’),
signalReasoning:     $(‘signalReasoning’),
signalLoader:        $(‘signalLoader’),
historyList:         $(‘historyList’),
pmUp:                $(‘pmUp’),
pmDown:              $(‘pmDown’),
refreshInterval:     $(‘refreshInterval’),
groqInterval:        $(‘groqInterval’),
refreshNow:          $(‘refreshNow’),
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
dom.apiKeyInput.value          = ‘••••••••••••••••••••••••••’;
dom.saveKeyBtn.style.display   = ‘none’;
dom.clearKeyBtn.style.display  = ‘inline-block’;
dom.apiBanner.style.borderBottomColor = ‘rgba(0,255,136,0.35)’;
} else {
dom.apiKeyInput.value          = ‘’;
dom.saveKeyBtn.style.display   = ‘inline-block’;
dom.clearKeyBtn.style.display  = ‘none’;
dom.apiBanner.style.borderBottomColor = ‘’;
}
}

dom.saveKeyBtn.addEventListener(‘click’, () => {
const val = dom.apiKeyInput.value.trim();
if (!val || val.startsWith(’•’)) return;
saveApiKey(val);
updateApiBannerUI();

if (state.dataReady) {
triggerGroqNow();
} else {
dom.signalReasoning.textContent = ‘Key saved — waiting for market data…’;
const waiter = setInterval(() => {
if (state.dataReady) {
clearInterval(waiter);
triggerGroqNow();
}
}, 1000);
}
});

dom.clearKeyBtn.addEventListener(‘click’, () => {
clearApiKey();
updateApiBannerUI();
});

/* ──────────────────────────────────────────────────────
CLOCK
────────────────────────────────────────────────────── */
function updateClock() {
dom.clock.textContent = new Date().toLocaleTimeString(‘en-US’, {
hour: ‘2-digit’, minute: ‘2-digit’, second: ‘2-digit’, hour12: false,
});
}
setInterval(updateClock, 1000);
updateClock();

/* ──────────────────────────────────────────────────────
CHART SETUP (Chart.js)
────────────────────────────────────────────────────── */
let btcChart = null;

function initChart() {
const canvas = document.getElementById(‘btcChart’);
if (!canvas) return;
const ctx = canvas.getContext(‘2d’);
const gradient = ctx.createLinearGradient(0, 0, 0, 160);
gradient.addColorStop(0, ‘rgba(0,255,136,0.18)’);
gradient.addColorStop(1, ‘rgba(0,255,136,0)’);

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
}],
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
label: c => ‘$’ + c.parsed.y.toLocaleString(‘en-US’, { minimumFractionDigits: 2 }),
},
},
},
scales: {
x: {
grid: { color: ‘rgba(30,45,58,0.6)’, drawTicks: false },
ticks: { color: ‘#354550’, font: { family: ‘Share Tech Mono’, size: 10 }, maxTicksLimit: 5 },
border: { display: false },
},
y: {
position: ‘right’,
grid: { color: ‘rgba(30,45,58,0.6)’, drawTicks: false },
ticks: {
color: ‘#607585’,
font: { family: ‘Share Tech Mono’, size: 10 },
callback: v => ‘$’ + v.toLocaleString(‘en-US’, { maximumFractionDigits: 0 }),
},
border: { display: false },
},
},
},
});
}

function updateChart(candles) {
if (!btcChart || !candles.length) return;
const labels = candles.map(c => {
const d = new Date(c.t);
return d.toLocaleTimeString(‘en-US’, { hour: ‘2-digit’, minute: ‘2-digit’, hour12: false });
});
const closes  = candles.map(c => c.c);
const upTrend = closes[closes.length - 1] >= closes[0];

btcChart.data.labels = labels;
btcChart.data.datasets[0].data = closes;

const g = btcChart.ctx.createLinearGradient(0, 0, 0, 160);
if (upTrend) {
g.addColorStop(0, ‘rgba(0,255,136,0.18)’);
g.addColorStop(1, ‘rgba(0,255,136,0)’);
btcChart.data.datasets[0].borderColor = ‘#00ff88’;
} else {
g.addColorStop(0, ‘rgba(255,61,90,0.18)’);
g.addColorStop(1, ‘rgba(255,61,90,0)’);
btcChart.data.datasets[0].borderColor = ‘#ff3d5a’;
}
btcChart.data.datasets[0].backgroundColor = g;
btcChart.update(‘none’);
}

/* ──────────────────────────────────────────────────────
DATA SOURCE: BINANCE GLOBAL
────────────────────────────────────────────────────── */
async function tryBinanceGlobal() {
const base = ‘https://api.binance.com/api/v3’;
const kRes = await fetch(
`${base}/klines?symbol=BTCUSDT&interval=5m&limit=${KLINE_LIMIT}`,
{ signal: AbortSignal.timeout(6000) }
);
if (!kRes.ok) throw new Error(’Binance global ’ + kRes.status);
const kRaw = await kRes.json();

const tRes = await fetch(`${base}/ticker/24hr?symbol=BTCUSDT`,
{ signal: AbortSignal.timeout(6000) }
);
if (!tRes.ok) throw new Error(’Binance global ticker ’ + tRes.status);
const tRaw = await tRes.json();

return { kRaw, tRaw };
}

/* ──────────────────────────────────────────────────────
DATA SOURCE: BINANCE US
────────────────────────────────────────────────────── */
async function tryBinanceUS() {
const base = ‘https://api.binance.us/api/v3’;
const kRes = await fetch(
`${base}/klines?symbol=BTCUSDT&interval=5m&limit=${KLINE_LIMIT}`,
{ signal: AbortSignal.timeout(6000) }
);
if (!kRes.ok) throw new Error(’Binance US ’ + kRes.status);
const kRaw = await kRes.json();

const tRes = await fetch(`${base}/ticker/24hr?symbol=BTCUSDT`,
{ signal: AbortSignal.timeout(6000) }
);
if (!tRes.ok) throw new Error(’Binance US ticker ’ + tRes.status);
const tRaw = await tRes.json();

return { kRaw, tRaw };
}

/* ──────────────────────────────────────────────────────
DATA SOURCE: COINGECKO (final fallback)
────────────────────────────────────────────────────── */
async function tryCoingecko() {
// OHLC endpoint: [timestamp, open, high, low, close]
const ohlcRes = await fetch(
‘https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=1’,
{ signal: AbortSignal.timeout(10000) }
);
if (!ohlcRes.ok) throw new Error(’CoinGecko ohlc ’ + ohlcRes.status);
const ohlcRaw = await ohlcRes.json();

const priceRes = await fetch(
‘https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd’ +
‘&include_24hr_change=true&include_24hr_vol=true’,
{ signal: AbortSignal.timeout(10000) }
);
if (!priceRes.ok) throw new Error(’CoinGecko price ’ + priceRes.status);
const priceRaw = await priceRes.json();

// Map ohlc to Binance kline format stub
const kRaw = ohlcRaw.slice(-KLINE_LIMIT).map(([ts, o, h, l, c]) => [
ts, String(o), String(h), String(l), String(c), ‘0’,
]);

const btc  = priceRaw.bitcoin || {};
const spot = btc.usd || 0;
const tRaw = {
lastPrice:          String(spot),
priceChangePercent: String((btc.usd_24h_change || 0).toFixed(2)),
highPrice:          String(spot * 1.005),   // CG free tier: no 24h high
lowPrice:           String(spot * 0.995),
volume:             String((btc.usd_24h_vol / (spot || 1)).toFixed(2)),
};

return { kRaw, tRaw };
}

/* ──────────────────────────────────────────────────────
PARSE RAW → STATE
────────────────────────────────────────────────────── */
function parseAndStore(kRaw, tRaw) {
state.candles = kRaw.map(k => ({
t: k[0],
o: parseFloat(k[1]),
h: parseFloat(k[2]),
l: parseFloat(k[3]),
c: parseFloat(k[4]),
v: parseFloat(k[5]),
})).filter(c => !isNaN(c.c) && c.c > 0);

state.prevPrice = state.lastPrice;
state.lastPrice = parseFloat(tRaw.lastPrice);
state.ticker24h = {
change: parseFloat(tRaw.priceChangePercent),
high:   parseFloat(tRaw.highPrice),
low:    parseFloat(tRaw.lowPrice),
vol:    parseFloat(tRaw.volume),
};
state.dataReady = state.candles.length >= 10;
}

/* ──────────────────────────────────────────────────────
MAIN FETCH — waterfall through sources
────────────────────────────────────────────────────── */
async function fetchMarketData() {
const sources = [
{ name: ‘Binance’,   fn: tryBinanceGlobal },
{ name: ‘BinanceUS’, fn: tryBinanceUS     },
{ name: ‘CoinGecko’, fn: tryCoingecko     },
];

for (const src of sources) {
try {
const { kRaw, tRaw } = await src.fn();
parseAndStore(kRaw, tRaw);
state.dataSource = src.name;
dom.chartStatus.textContent = `${state.candles.length} candles · ${src.name}`;
updateChart(state.candles);
computeAndRenderMetrics();
updatePriceUI();
return true;
} catch (err) {
console.warn(`[${src.name}] failed:`, err.message);
}
}

dom.chartStatus.textContent = ‘⚠ all data sources failed’;
return false;
}

/* ──────────────────────────────────────────────────────
PRICE UI
────────────────────────────────────────────────────── */
function updatePriceUI() {
const { lastPrice, prevPrice, ticker24h } = state;
if (!lastPrice || isNaN(lastPrice)) return;

dom.btcPrice.textContent = ‘$’ + lastPrice.toLocaleString(‘en-US’, {
minimumFractionDigits: 2, maximumFractionDigits: 2,
});

if (prevPrice !== null && prevPrice !== lastPrice) {
const cls = lastPrice > prevPrice ? ‘flash-green’ : ‘flash-red’;
dom.btcPrice.classList.remove(‘flash-green’, ‘flash-red’);
void dom.btcPrice.offsetWidth;
dom.btcPrice.classList.add(cls);
}

const pct  = ticker24h.change || 0;
dom.priceChange.textContent = (pct >= 0 ? ‘+’ : ‘’) + pct.toFixed(2) + ‘%’;
dom.priceChange.className   = ’price-change ’ + (pct >= 0 ? ‘up’ : ‘down’);

dom.high24.textContent = ticker24h.high
? ‘$’ + ticker24h.high.toLocaleString(‘en-US’, { maximumFractionDigits: 0 }) : ‘—’;
dom.low24.textContent  = ticker24h.low
? ‘$’ + ticker24h.low.toLocaleString(‘en-US’,  { maximumFractionDigits: 0 }) : ‘—’;
dom.vol24.textContent  = ticker24h.vol
? (ticker24h.vol / 1000).toFixed(1) + ‘K BTC’ : ‘—’;
}

/* ──────────────────────────────────────────────────────
METRICS
────────────────────────────────────────────────────── */
function computeMetrics() {
const candles = state.candles;
if (!candles || candles.length < 6) return null;

const closes = candles.map(c => c.c);
const n      = closes.length;

const atrSlice = candles.slice(-10);
const atr = atrSlice.reduce((s, c) => s + (c.h - c.l), 0) / atrSlice.length;

const momentum = closes[n - 1] - closes[Math.max(0, n - 6)];

const last  = candles[n - 1];
const delta = last.c - last.o;

const sl = closes.slice(-10);
const xM = 4.5;
const yM = sl.reduce((a, b) => a + b, 0) / sl.length;
let num = 0, den = 0;
sl.forEach((y, x) => { num += (x - xM) * (y - yM); den += (x - xM) ** 2; });
const slope = den ? num / den : 0;

return { atr, momentum, delta, slope };
}

function computeAndRenderMetrics() {
const m = computeMetrics();
if (!m) return;
const { atr, momentum, delta, slope } = m;

const fmt = v => ‘$’ + Math.abs(v).toLocaleString(‘en-US’, {
minimumFractionDigits: 2, maximumFractionDigits: 2,
});

dom.metMomentum.textContent  = (momentum >= 0 ? ‘+’ : ‘-’) + fmt(momentum);
dom.metMomentum.style.color  = momentum >= 0 ? ‘var(–green)’ : ‘var(–red)’;
dom.metVolatility.textContent = fmt(atr);
dom.metVolatility.style.color = ‘var(–cyan)’;
dom.metDelta.textContent = (delta >= 0 ? ‘+’ : ‘-’) + fmt(delta);
dom.metDelta.style.color = delta >= 0 ? ‘var(–green)’ : ‘var(–red)’;
dom.metSlope.textContent = (slope >= 0 ? ‘+’ : ‘’) + slope.toFixed(2) + ‘/bar’;
dom.metSlope.style.color = slope >= 0 ? ‘var(–green)’ : ‘var(–red)’;
}

/* ──────────────────────────────────────────────────────
GROQ PROMPT
────────────────────────────────────────────────────── */
function buildGroqMessages(candles, metrics) {
const closes = candles.map(c => c.c);
const n      = closes.length;
const recent = closes.slice(-10).map(p => p.toFixed(2)).join(’, ’);
const { atr, momentum, delta, slope } = metrics;

const system =
`You are a quantitative BTC trading signal engine. Output ONLY valid JSON, no markdown, no extra text: {"signal":"UP","confidence":72,"reasoning":"brief reason max 20 words"} signal MUST be exactly UP or DOWN.`;

const user =
`BTC/USDT M5: lastPrice=${closes[n-1].toFixed(2)} last10closes=[${recent}] momentum5bar=${momentum.toFixed(2)} atr=${atr.toFixed(2)} lastCandleDelta=${delta.toFixed(2)} regressionSlope=${slope.toFixed(3)} polymarket_up=${PM_UP_DEFAULT}% polymarket_down=${PM_DOWN_DEFAULT}% Signal for next 5 minutes?`;

return [
{ role: ‘system’, content: system },
{ role: ‘user’,   content: user   },
];
}

/* ──────────────────────────────────────────────────────
GROQ CALL
────────────────────────────────────────────────────── */
async function callGroq() {
const apiKey = getApiKey();
if (!apiKey) {
dom.signalReasoning.textContent = ‘⚠️ Enter your Groq API key in the bar above.’;
return;
}

if (!state.dataReady) {
dom.signalReasoning.textContent = ‘⏳ Fetching market data… will generate signal shortly.’;
return;
}

const metrics = computeMetrics();
if (!metrics) {
dom.signalReasoning.textContent = ‘⏳ Not enough candle data yet, retrying…’;
return;
}

if (state.groqBusy) return;
state.groqBusy = true;

dom.signalLoader.classList.add(‘active’);
dom.signalLoader.querySelector(‘span:last-child’).textContent = ‘Querying Groq…’;
dom.signalDirection.textContent = ‘…’;

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
temperature: 0.2,
messages:    buildGroqMessages(state.candles, metrics),
}),
});

```
if (!res.ok) {
  let msg = `HTTP ${res.status}`;
  try {
    const e = await res.json();
    msg += ': ' + (e.error?.message || JSON.stringify(e)).slice(0, 100);
  } catch {}
  throw new Error(msg);
}

const data = await res.json();
let raw = (data.choices?.[0]?.message?.content || '').trim();

// Strip code fences
raw = raw.replace(/```json|```/gi, '').trim();

// Extract first JSON object (handles any leading/trailing text)
const jsonMatch = raw.match(/\{[\s\S]*?\}/);
if (!jsonMatch) throw new Error('No JSON found in response: ' + raw.slice(0, 100));

const parsed = JSON.parse(jsonMatch[0]);
const dir    = (String(parsed.signal || '')).toUpperCase().trim();
if (dir !== 'UP' && dir !== 'DOWN') throw new Error('Bad signal value: ' + dir);

const signal = {
  direction:  dir,
  confidence: Math.min(100, Math.max(0, parseInt(parsed.confidence) || 50)),
  reasoning:  String(parsed.reasoning || 'No reasoning provided.').slice(0, 200),
  price:      state.lastPrice,
  timestamp:  Date.now(),
};

state.currentSignal = signal;
state.signalHistory.unshift(signal);
if (state.signalHistory.length > 10) state.signalHistory.pop();

renderSignal(signal);
renderHistory();
```

} catch (err) {
console.error(‘Groq error:’, err);
dom.signalDirection.textContent = ‘ERROR’;
dom.signalReasoning.textContent = ’⚠️ Groq: ’ + err.message.slice(0, 160);
} finally {
state.groqBusy = false;
dom.signalLoader.classList.remove(‘active’);
}
}

/* ──────────────────────────────────────────────────────
RENDER SIGNAL
────────────────────────────────────────────────────── */
function renderSignal(signal) {
const { direction, confidence, reasoning } = signal;
const isUp = direction === ‘UP’;

dom.signalCard.classList.remove(‘signal-up’, ‘signal-down’);
dom.signalCard.classList.add(isUp ? ‘signal-up’ : ‘signal-down’);

dom.signalIcon.textContent  = isUp ? ‘▲’ : ‘▼’;
dom.signalIcon.style.color  = isUp ? ‘var(–green)’ : ‘var(–red)’;
dom.signalDirection.textContent = direction;

dom.confBar.style.width  = confidence + ‘%’;
dom.confPct.textContent  = confidence + ‘%’;
dom.signalReasoning.textContent = reasoning;
dom.signalAge.textContent       = ‘just now’;

dom.signalCard.classList.remove(‘signal-in’);
void dom.signalCard.offsetWidth;
dom.signalCard.classList.add(‘signal-in’);
}

function updateSignalAge() {
if (!state.currentSignal) return;
const s = Math.round((Date.now() - state.currentSignal.timestamp) / 1000);
dom.signalAge.textContent = s < 60
? s + ‘s ago’
: Math.floor(s / 60) + ‘m ago’;
}
setInterval(updateSignalAge, 5000);

/* ──────────────────────────────────────────────────────
RENDER HISTORY
────────────────────────────────────────────────────── */
function renderHistory() {
const h = state.signalHistory;
if (!h.length) {
dom.historyList.innerHTML = ‘<div class="history-empty">No signals yet</div>’;
return;
}
dom.historyList.innerHTML = h.map(s => {
const isUp  = s.direction === ‘UP’;
const time  = new Date(s.timestamp).toLocaleTimeString(‘en-US’, {
hour: ‘2-digit’, minute: ‘2-digit’, second: ‘2-digit’, hour12: false,
});
const price = s.price
? ‘$’ + Math.round(s.price).toLocaleString(‘en-US’) : ‘—’;
return `<div class="history-item"> <span class="history-dir ${isUp ? 'up' : 'down'}">${isUp ? '▲ UP' : '▼ DN'}</span> <span class="history-price">${price}</span> <span class="history-conf">${s.confidence}%</span> <span class="history-time">${time}</span> </div>`;
}).join(’’);
}

/* ──────────────────────────────────────────────────────
COUNTDOWN
────────────────────────────────────────────────────── */
function startCountdown() {
clearInterval(state.countdownTimerId);
state.nextGroqIn = Math.round(state.groqIntervalMs / 1000);
dom.nextSignalCountdown.textContent = state.nextGroqIn + ‘s’;
state.countdownTimerId = setInterval(() => {
state.nextGroqIn = Math.max(0, state.nextGroqIn - 1);
dom.nextSignalCountdown.textContent = state.nextGroqIn + ‘s’;
}, 1000);
}

/* ──────────────────────────────────────────────────────
LOOPS
────────────────────────────────────────────────────── */
function startPriceLoop() {
clearInterval(state.priceTimerId);
state.priceTimerId = setInterval(fetchMarketData, state.refreshIntervalMs);
}

function startGroqLoop() {
clearInterval(state.groqTimerId);
state.groqTimerId = setInterval(() => {
callGroq();
startCountdown();
}, state.groqIntervalMs);
startCountdown();
}

function triggerGroqNow() {
callGroq();
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
await fetchMarketData();
dom.refreshNow.textContent = ‘↻ Now’;
dom.refreshNow.disabled    = false;
});

/* ──────────────────────────────────────────────────────
INIT
────────────────────────────────────────────────────── */
async function init() {
updateApiBannerUI();
initChart();

dom.signalReasoning.textContent = ‘⏳ Loading market data…’;

const ok = await fetchMarketData();
startPriceLoop();
startGroqLoop();

if (ok && getApiKey()) {
// Data loaded AND key present → fire signal now
callGroq();
} else if (!getApiKey()) {
dom.signalReasoning.textContent = ‘⚠️ Enter your Groq API key above to activate AI signals.’;
}
}

init();
