const fs = require('fs');
const express = require('express');
const path = require('path');

// Carrega .env manualmente (sem dependência extra) — usado como key padrão do servidor.
// O arquivo nunca é servido ao navegador (express.static não expõe dotfiles por padrão) nem versionado (.gitignore).
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  });
}

const app = express();
const PORT = process.env.PORT || 3000;
const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';
const DEFAULT_API_KEY = process.env.FOOTBALL_DATA_KEY || null;

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'rbforex_bet_analyzer.html'));
});

// Diz ao front-end se o servidor já tem uma key configurada (não expõe a key em si).
app.get('/api/config', (req, res) => {
  res.json({ hasServerKey: !!DEFAULT_API_KEY });
});

// Proxy para football-data.org: evita CORS pois o navegador chama só o próprio servidor
// (mesma origem), e é este servidor Node quem faz a chamada externa.
// Se o navegador não enviar uma key própria, usa a key padrão configurada em .env.
async function proxyFootballData(req, res, upstreamPath) {
  const apiKey = req.header('X-Auth-Token') || DEFAULT_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'Nenhuma API key disponível (nem enviada pelo navegador, nem configurada em .env).' });
  }
  try {
    const upstream = await fetch(`${FOOTBALL_DATA_BASE}${upstreamPath}`, {
      headers: { 'X-Auth-Token': apiKey }
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao contatar football-data.org', details: err.message });
  }
}

app.get('/api/matches/:league', (req, res) => {
  const league = encodeURIComponent(req.params.league);
  proxyFootballData(req, res, `/competitions/${league}/matches?status=SCHEDULED`);
});

// Classificação da liga: dá gols pró/contra e jogos disputados reais de cada time
// (o plano free não tem endpoint de médias prontas, então calculamos gf/ga = goalsFor/playedGames no cliente).
app.get('/api/standings/:league', (req, res) => {
  const league = encodeURIComponent(req.params.league);
  proxyFootballData(req, res, `/competitions/${league}/standings`);
});

// Copa Sul-Americana não está no catálogo free da football-data.org — usa TheSportsDB
// (API gratuita, key de teste pública "3", sem cadastro necessário) como fonte alternativa.
const THESPORTSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/3';
const SUDAMERICANA_LEAGUE_ID = '4724';

app.get('/api/sudamericana/matches', async (req, res) => {
  try {
    const upstream = await fetch(`${THESPORTSDB_BASE}/eventsnextleague.php?id=${SUDAMERICANA_LEAGUE_ID}`);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao contatar TheSportsDB', details: err.message });
  }
});

// ---------- ODDS REAIS (Bet365 / Betano BR via odds-api.io) ----------
// Fonte de odds de mercado de verdade — usada pra probabilidade de resultado/over-under/BTTS/escanteios/cartões
// e pros mercados por jogador (chutes ao gol, cartão). Plano free: 5.000 req/hora, 2 bookmakers selecionados na conta.
const ODDS_API_BASE = 'https://api.odds-api.io/v3';
const ODDS_API_KEY = process.env.ODDS_API_KEY || null;
const ODDS_BOOKMAKERS = 'Bet365,Betano BR';

// Ligas com cobertura de odds reais confirmada nesta conta odds-api.io (slugs verificados manualmente em /leagues).
const ODDS_LEAGUES = [
  { code: 'england-premier-league', name: 'Premier League (Inglaterra)' },
  { code: 'england-championship', name: 'Championship (Inglaterra 2ª div.)' },
  { code: 'spain-laliga', name: 'La Liga (Espanha)' },
  { code: 'germany-bundesliga', name: 'Bundesliga (Alemanha)' },
  { code: 'italy-serie-a', name: 'Serie A (Itália)' },
  { code: 'france-ligue-1', name: 'Ligue 1 (França)' },
  { code: 'netherlands-eredivisie', name: 'Eredivisie (Holanda)' },
  { code: 'portugal-liga-portugal', name: 'Primeira Liga (Portugal)' },
  { code: 'brazil-brasileiro-serie-a', name: 'Brasileirão Série A' },
  { code: 'international-clubs-uefa-champions-league-qualification', name: 'UEFA Champions League' },
  { code: 'international-clubs-uefa-europa-league-qualification', name: 'UEFA Europa League' },
  { code: 'international-clubs-conmebol-libertadores-knockout-stage', name: 'Copa Libertadores' },
  { code: 'international-clubs-conmebol-sudamericana-knockout-stage', name: 'Copa Sul-Americana' }
];

app.get('/api/odds/leagues', (req, res) => {
  res.json({ leagues: ODDS_LEAGUES, hasKey: !!ODDS_API_KEY });
});

app.get('/api/odds/events', async (req, res) => {
  if (!ODDS_API_KEY) return res.status(400).json({ error: 'ODDS_API_KEY não configurada no servidor.' });
  const league = req.query.league;
  if (!league) return res.status(400).json({ error: 'Parâmetro league obrigatório.' });
  try {
    const url = `${ODDS_API_BASE}/events?apiKey=${ODDS_API_KEY}&sport=football&league=${encodeURIComponent(league)}&status=pending,live`;
    const upstream = await fetch(url);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao contatar odds-api.io', details: err.message });
  }
});

app.get('/api/odds/match', async (req, res) => {
  if (!ODDS_API_KEY) return res.status(400).json({ error: 'ODDS_API_KEY não configurada no servidor.' });
  const eventId = req.query.eventId;
  if (!eventId) return res.status(400).json({ error: 'Parâmetro eventId obrigatório.' });
  try {
    const url = `${ODDS_API_BASE}/odds?apiKey=${ODDS_API_KEY}&eventId=${encodeURIComponent(eventId)}&bookmakers=${encodeURIComponent(ODDS_BOOKMAKERS)}`;
    const upstream = await fetch(url);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao contatar odds-api.io', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`RBFOREX Analyzer rodando em http://localhost:${PORT}`);
});
