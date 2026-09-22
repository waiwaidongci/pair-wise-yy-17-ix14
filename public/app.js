const state = {
  config: null,
  db: {},
  overview: null,
  activeTab: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function displayField(item, field) {
  const value = item[field.name] ?? '';
  if (field.type === 'select' && field.options) return value || field.options[0];
  return value;
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function siteOptions() {
  const sites = [...(state.db.sites || [])].sort((a, b) => String(a.pointCode).localeCompare(String(b.pointCode), 'zh'));
  return sites.map((site) => `<option value="${site.id}">${escapeHtml([site.cave, site.zone, site.pointCode].filter(Boolean).join(' / '))}</option>`).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.type === 'relation' ? relationLabel(field, raw) : raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

// ---------- 季节平台视图：路线、待校准清单、履历均由 /api/season/overview 派生 ----------

function renderRoutePanel(route) {
  const rows = route.sites.map((site) => {
    const sealHtml = site.sealState === '未封存'
      ? `<span class="meta">未封存</span>${site.sealBlockers.length ? `<div class="meta">${site.sealBlockers.map(escapeHtml).join('；')}</div>` : ''}`
      : pill(site.sealState, toneFor(site.sealState));
    const recheckHtml = `${pill(site.recheckStatus, toneFor(site.recheckStatus))}<div class="meta">${escapeHtml(site.recheckNote)}</div>`;
    const logs = site.rechecks.map((entry) => `${escapeHtml(entry.surveyor)}｜${fmtDate(entry.measuredAt)}｜${entry.temperature}℃ / ${entry.humidity}% / ${entry.co2}ppm`).join('<br>') || '—';
    return `<tr>
      <td><strong>${escapeHtml(site.pointCode)}</strong><br><span class="meta">${escapeHtml(site.cave)} ${escapeHtml(site.zone)}</span></td>
      <td>${pill(site.protectedStatus, toneFor(site.protectedStatus))}</td>
      <td>${sealHtml}</td>
      <td>${recheckHtml}</td>
      <td class="meta">${logs}</td>
    </tr>`;
  }).join('');
  const reopen = route.reopen;
  const canReopen = !reopen && route.reopenBlockers.length === 0;
  const reopenNote = reopen
    ? `${fmtDate(reopen.createdAt)} 复开，覆盖 ${reopen.siteCount} 个样点`
    : route.reopenBlockers.length
      ? `不得复开：${route.reopenBlockers.map(escapeHtml).join('；')}`
      : '全部样点复测合格，可复开';
  return `<div class="panel">
    <div class="card-head"><h2>${escapeHtml(route.route)}</h2>${reopen ? pill('已复开', 'ok') : pill('未复开', 'warn')}</div>
    <table class="table">
      <thead><tr><th>样点</th><th>保护状态</th><th>封存</th><th>开季复测</th><th>复测记录</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="actions">
      <button data-reopen-route="${escapeHtml(route.route)}" ${canReopen ? '' : 'disabled'}>${reopen ? '本季已复开' : '路线复开'}</button>
      <span class="meta">${reopenNote}</span>
    </div>
  </div>`;
}

function renderCalibrations(overview) {
  if (!overview.calibrations.length) return '<div class="empty">暂无校准事项</div>';
  return overview.calibrations.map((item) => `<article class="card">
    <div class="card-head"><h3>${escapeHtml(item.siteLabel)}</h3>${pill(item.status, toneFor(item.status))}</div>
    <div class="meta">${escapeHtml(item.route)} · ${escapeHtml(item.season)}</div>
    <p>${item.reasons.map(escapeHtml).join('；')}</p>
    ${historyHtml(item)}
  </article>`).join('');
}

function renderSeals(overview) {
  if (!overview.seals.length) return '<div class="empty">暂无封存单</div>';
  return overview.seals.map((item) => `<article class="card">
    <div class="card-head"><h3>${escapeHtml(item.siteLabel)}</h3>${pill(item.status, toneFor(item.status))}</div>
    <div class="meta">${escapeHtml(item.route)} · ${escapeHtml(item.season)}${item.note ? ' · ' + escapeHtml(item.note) : ''}</div>
    ${historyHtml(item)}
  </article>`).join('');
}

function renderFeed(overview) {
  if (!overview.history.length) return '<div class="empty">暂无履历</div>';
  return overview.history.map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>[${escapeHtml(entry.entity)}] ${escapeHtml(entry.label)}｜${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('');
}

function renderSeasonView(view) {
  const overview = state.overview;
  if (!overview) return `<section class="view" id="${view.id}"><div class="empty">季节数据加载中…</div></section>`;
  const t = overview.thresholds;
  const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return `<section class="view" id="${view.id}">
    <div class="stack">
      <div class="panel season-banner">
        <strong>当前季节：${escapeHtml(overview.season)}</strong>
        <span class="meta">封存：每样点每季仅一张封存单，并发只认首单；暂停开放或本季巡测缺项不得封存。复开：路线内每点须两名不同人员各测一次、间隔≥${t.gapHours}小时；温差>${t.tempDiff}℃、湿度差>${t.humidityDiff}个百分点或CO2增量>${t.co2Rise}ppm 只转待校准，整条路线不得复开。修订基准或撤回巡测，原结论失效。</span>
      </div>
      ${overview.routes.map(renderRoutePanel).join('') || '<div class="empty">暂无路线</div>'}
      <div class="season-forms">
        <form class="panel" data-season-form="seal">
          <h2>办理季末封存</h2>
          <div class="form-grid">
            <label class="wide">样点<select name="siteId" required>${siteOptions()}</select></label>
            <label class="wide">备注<textarea name="note" placeholder="本季巡测已补齐，办理封存"></textarea></label>
          </div>
          <div class="actions"><button>提交封存单</button></div>
        </form>
        <form class="panel" data-season-form="recheck">
          <h2>登记开季复测</h2>
          <div class="form-grid">
            <label class="wide">样点<select name="siteId" required>${siteOptions()}</select></label>
            <label>复测人员<input name="surveyor" required></label>
            <label>复测时间<input type="datetime-local" name="measuredAt" value="${nowLocal}" required></label>
            <label>温度 ℃<input type="number" step="0.1" name="temperature" required></label>
            <label>湿度 %<input type="number" step="0.1" name="humidity" required></label>
            <label>CO2 ppm<input type="number" step="1" name="co2" required></label>
            <label class="wide">备注<textarea name="note" placeholder="仪器编号、校准情况等"></textarea></label>
          </div>
          <div class="actions"><button>保存复测</button></div>
        </form>
        <form class="panel" data-season-form="baseline">
          <h2>修订基准</h2>
          <div class="form-grid">
            <label class="wide">样点<select name="siteId" required>${siteOptions()}</select></label>
            <label>基准温度 ℃<input type="number" step="0.1" name="baselineTemp" required></label>
            <label>基准湿度 %<input type="number" step="0.1" name="baselineHumidity" required></label>
            <label>基准CO2 ppm<input type="number" step="1" name="baselineCo2" required></label>
            <label class="wide">修订说明<textarea name="note" placeholder="修订后原封存结论失效"></textarea></label>
          </div>
          <div class="actions"><button class="danger">提交基准修订</button></div>
        </form>
      </div>
      <div class="grid-2">
        <div class="panel"><h2>待校准清单</h2><div class="list">${renderCalibrations(overview)}</div></div>
        <div class="panel"><h2>封存单</h2><div class="list">${renderSeals(overview)}</div></div>
      </div>
      <div class="panel"><h2>履历</h2><div class="history">${renderFeed(overview)}</div></div>
    </div>
  </section>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'season') return renderSeasonView(view);
    return renderCrudView(view);
  }).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  const [db, overview] = await Promise.all([api('/api/db'), api('/api/season/overview')]);
  state.db = db;
  state.overview = overview;
  render();
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const reopenBtn = event.target.closest('[data-reopen-route]');
  if (tab) setTab(tab.dataset.tab);
  if (action) {
    const def = state.config.actions.find((entry) => entry.id === action.dataset.action);
    const url = def && def.endpoint ? `${def.endpoint}/${action.dataset.id}` : `/api/action/${action.dataset.action}/${action.dataset.id}`;
    try {
      await api(url, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }
  if (reopenBtn) {
    try {
      await api('/api/season/reopen', { method: 'POST', body: JSON.stringify({ route: reopenBtn.dataset.reopenRoute }) });
      await load();
      toast('路线已复开');
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const seasonForm = event.target.closest('[data-season-form]');
  if (seasonForm) {
    event.preventDefault();
    const kind = seasonForm.dataset.seasonForm;
    const payload = Object.fromEntries(new FormData(seasonForm).entries());
    try {
      if (kind === 'seal') {
        await api('/api/season/seal', { method: 'POST', body: JSON.stringify(payload) });
      } else if (kind === 'recheck') {
        payload.temperature = Number(payload.temperature);
        payload.humidity = Number(payload.humidity);
        payload.co2 = Number(payload.co2);
        payload.measuredAt = new Date(payload.measuredAt).toISOString();
        await api('/api/season/recheck', { method: 'POST', body: JSON.stringify(payload) });
      } else if (kind === 'baseline') {
        payload.baselineTemp = Number(payload.baselineTemp);
        payload.baselineHumidity = Number(payload.baselineHumidity);
        payload.baselineCo2 = Number(payload.baselineCo2);
        await api('/api/season/revise-baseline', { method: 'POST', body: JSON.stringify(payload) });
      }
      seasonForm.reset();
      await load();
      toast('已提交');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(values(form, view)) });
  form.reset();
  await load();
  toast('已保存');
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
