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

app.listen(PORT, () => {
  console.log(`RBFOREX Analyzer rodando em http://localhost:${PORT}`);
});
