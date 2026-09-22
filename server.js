const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const rules = require('./rules');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 写请求串行化：同一时刻只处理一笔写入，并发封存只认首单。
let writeQueue = Promise.resolve();
app.use((req, res, next) => {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const run = writeQueue.then(() => new Promise((resolve) => {
    res.on('finish', resolve);
    res.on('close', resolve);
    next();
  }));
  writeQueue = run.catch(() => {});
});

const wrap = (handler) => (req, res) => handler(req, res).catch((err) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: '服务器内部错误' });
});

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  const db = JSON.parse(raw);
  for (const key of Object.keys(config.collections)) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  return db;
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function newId(collection) {
  return `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', wrap(async (req, res) => {
  const db = await readDb();
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
}));

// ---------- 季节平台接口（判定规则全部在 rules.js） ----------

app.get('/api/season/overview', wrap(async (req, res) => {
  const db = await readDb();
  res.json(rules.buildOverview(db));
}));

app.post('/api/season/seal', wrap(async (req, res) => {
  const db = await readDb();
  const site = db.sites.find((entry) => entry.id === req.body.siteId);
  if (!site) return res.status(404).json({ error: '样点不存在' });
  const season = rules.currentSeason();
  const blockers = rules.sealBlockers(db, site, season);
  if (blockers.length) return res.status(409).json({ error: blockers.join('；') });
  const now = new Date().toISOString();
  const order = {
    id: newId('sealOrders'),
    siteId: site.id,
    route: site.route,
    season,
    status: '已封存',
    note: req.body.note || '',
    createdAt: now,
    updatedAt: now,
    history: [rules.stamp('季末封存', req.body.note || `${season} 季末封存`)]
  };
  db.sealOrders.push(order);
  site.history = site.history || [];
  site.history.unshift(rules.stamp('季末封存', `${season} 封存单已登记`));
  site.updatedAt = now;
  await writeDb(db);
  res.status(201).json(order);
}));

app.post('/api/season/recheck', wrap(async (req, res) => {
  const db = await readDb();
  const site = db.sites.find((entry) => entry.id === req.body.siteId);
  if (!site) return res.status(404).json({ error: '样点不存在' });
  const surveyor = String(req.body.surveyor || '').trim();
  if (!surveyor) return res.status(409).json({ error: '复测人员必填' });
  const measuredAt = new Date(req.body.measuredAt);
  if (!req.body.measuredAt || Number.isNaN(measuredAt.getTime())) return res.status(409).json({ error: '复测时间无效' });
  const temperature = Number(req.body.temperature);
  const humidity = Number(req.body.humidity);
  const co2 = Number(req.body.co2);
  if (![temperature, humidity, co2].every(Number.isFinite)) return res.status(409).json({ error: '温度、湿度、CO2 须为数字' });
  const season = rules.currentSeason();
  const now = new Date().toISOString();
  const recheck = {
    id: newId('rechecks'),
    siteId: site.id,
    route: site.route,
    season,
    surveyor,
    measuredAt: measuredAt.toISOString(),
    temperature,
    humidity,
    co2,
    note: req.body.note || '',
    createdAt: now,
    updatedAt: now,
    history: [rules.stamp('复测登记', req.body.note || `${season} 开季复测`)]
  };
  db.rechecks.push(recheck);
  rules.syncCalibrations(db, site, season);
  await writeDb(db);
  res.status(201).json(recheck);
}));

app.post('/api/season/reopen', wrap(async (req, res) => {
  const db = await readDb();
  const route = String(req.body.route || '').trim();
  const sites = db.sites.filter((entry) => entry.route === route);
  if (!route || !sites.length) return res.status(404).json({ error: '路线不存在或无样点' });
  const season = rules.currentSeason();
  const existing = db.routeReopens.find((entry) => entry.route === route && entry.season === season && entry.status === '已复开');
  if (existing) return res.status(409).json({ error: '本季已复开，仅首次复开有效' });
  const blockers = sites
    .map((site) => ({ site, evaluation: rules.recheckEvaluation(db, site.id, season) }))
    .filter(({ evaluation }) => evaluation.status !== '复测合格')
    .map(({ site, evaluation }) => `${site.pointCode} ${evaluation.status}`);
  if (blockers.length) return res.status(409).json({ error: `路线不得复开：${blockers.join('；')}` });
  const now = new Date().toISOString();
  const reopen = {
    id: newId('routeReopens'),
    route,
    season,
    status: '已复开',
    siteCount: sites.length,
    createdAt: now,
    updatedAt: now,
    history: [rules.stamp('路线复开', `${route} ${season} 复开，覆盖 ${sites.length} 个样点`)]
  };
  db.routeReopens.push(reopen);
  for (const site of sites) {
    site.history = site.history || [];
    site.history.unshift(rules.stamp('路线复开', `${route} ${season} 复开`));
    site.updatedAt = now;
  }
  await writeDb(db);
  res.status(201).json(reopen);
}));

app.post('/api/season/withdraw-survey/:id', wrap(async (req, res) => {
  const db = await readDb();
  const survey = db.surveys.find((entry) => entry.id === req.params.id);
  if (!survey) return res.status(404).json({ error: '巡测记录不存在' });
  if (survey.status === '已撤回') return res.status(409).json({ error: '该巡测已撤回' });
  const result = rules.withdrawSurvey(db, survey, req.body && req.body.note);
  await writeDb(db);
  res.json({ survey, invalidatedSeals: result.invalidated });
}));

app.post('/api/season/revise-baseline', wrap(async (req, res) => {
  const db = await readDb();
  const site = db.sites.find((entry) => entry.id === req.body.siteId);
  if (!site) return res.status(404).json({ error: '样点不存在' });
  const values = {
    baselineTemp: Number(req.body.baselineTemp),
    baselineHumidity: Number(req.body.baselineHumidity),
    baselineCo2: Number(req.body.baselineCo2)
  };
  if (!Object.values(values).every(Number.isFinite)) return res.status(409).json({ error: '基准温度、湿度、CO2 须为数字' });
  if (!rules.baselineChanged(site, values)) return res.status(409).json({ error: '基准未变化，无需修订' });
  const result = rules.applyBaselineRevision(db, site, values, req.body.note);
  await writeDb(db);
  res.json({ site, invalidatedSeals: result.invalidated });
}));

// ---------- 通用存储接口 ----------

app.post('/api/:collection', wrap(async (req, res) => {
  const { collection } = req.params;
  const db = await readDb();
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  if (rules.SEASON_COLLECTIONS.includes(collection)) return res.status(409).json({ error: '季节平台数据请通过封存/复开接口登记' });
  const now = new Date().toISOString();
  const item = {
    id: newId(collection),
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [rules.stamp('创建', req.body.note || req.body.memo || '')]
  };
  db[collection].push(item);
  await writeDb(db);
  res.status(201).json(item);
}));

app.patch('/api/:collection/:id', wrap(async (req, res) => {
  const { collection, id } = req.params;
  const db = await readDb();
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  if (rules.SEASON_COLLECTIONS.includes(collection)) return res.status(409).json({ error: '季节平台数据请通过封存/复开接口变更' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const baselineTouched = collection === 'sites' && rules.baselineChanged(item, req.body);
  const withdrawing = collection === 'surveys' && req.body.status === '已撤回' && item.status !== '已撤回';
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(rules.stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
  }
  if (baselineTouched) {
    item.history.unshift(rules.stamp('基准修订', '基准值修订'));
    rules.invalidateSeals(db, item.id, rules.currentSeason(), '基准修订，原封存结论失效');
  }
  if (withdrawing) {
    rules.invalidateSeals(db, item.siteId, rules.seasonOf(item.date), '巡测撤回，原封存结论失效');
  }
  await writeDb(db);
  res.json(item);
}));

app.delete('/api/:collection/:id', wrap(async (req, res) => {
  const { collection, id } = req.params;
  const db = await readDb();
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  if (rules.SEASON_COLLECTIONS.includes(collection)) return res.status(409).json({ error: '季节平台数据请通过封存/复开接口变更' });
  const target = db[collection].find((entry) => entry.id === id);
  if (!target) return res.status(404).json({ error: 'not found' });
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (collection === 'surveys') {
    rules.invalidateSeals(db, target.siteId, rules.seasonOf(target.date), '巡测删除，原封存结论失效');
  }
  await writeDb(db);
  res.status(204).end();
}));

app.post('/api/action/:actionId/:id', wrap(async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const result = runAction(db, action, item);
  if (result.error) return res.status(409).json({ error: result.error });
  await writeDb(db);
  res.json(result.item);
}));

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(rules.stamp(action.label, action.note || '状态流转'));
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(rules.stamp(action.label, action.note || '数量调整'));
  }
  return { item };
}

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
