const state = {
  config: null,
  meta: null,
  db: {},
  activeTab: ''
};

const DOMAIN_ENDPOINTS = {
  seals: { path: '/api/seals', ok: '封存单已开具' },
  checks: { path: '/api/reopen-checks', ok: '复测已登记' },
  reopens: { path: '/api/reopen-orders', ok: '复开评审已提交' }
};

const DOMAIN_COLLECTIONS = { seals: 'sealOrders', checks: 'reopenChecks', reopens: 'reopenOrders' };

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
  setTimeout(() => el.classList.remove('show'), 2200);
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

function seasonOptions(preferred) {
  return (state.meta?.seasons || []).map((s) =>
    `<option value="${s.value}"${s.value === preferred ? ' selected' : ''}>${escapeHtml(s.label)}</option>`
  ).join('');
}

function formField(field, view) {
  const required = field.required ? 'required' : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'season-select') {
    // 封存针对当季，复测/复开针对开季（下一季）
    const preferred = view?.domain === 'seals' ? state.meta?.current : state.meta?.next;
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${seasonOptions(preferred)}</select></label>`;
  }
  if (field.type === 'route-select') {
    const routes = state.meta?.routes || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${routes.map((route) => `<option value="${escapeHtml(route)}">${escapeHtml(route)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  const inputType = field.type === 'datetime' ? 'datetime-local' : (field.type || 'text');
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${inputType}" step="1" name="${field.name}" ${required}></label>`;
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
  return `<div class="history">${history.slice(0, 6).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function formValues(form, view) {
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

function actionButtons(collection, item) {
  return state.config.actions
    .filter((action) => action.collection === collection)
    .filter((action) => !(action.id === 'check-withdraw' && item.status === '已撤回'))
    .filter((action) => !(action.id === 'survey-withdraw' && item.status === '已撤回'))
    .map((action) => {
      if (action.custom === 'baseline') {
        return `<button type="button" class="ghost" data-baseline="${item.id}">${escapeHtml(action.label)}</button>`;
      }
      return `<button type="button" class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`;
    })
    .join('');
}

function baselineEditor(item) {
  return `<form class="baseline-editor" data-baseline-form="${item.id}" hidden>
    <div class="form-grid">
      <label>基准温度℃<input type="number" step="0.1" name="baselineTemp" value="${escapeHtml(item.baselineTemp)}"></label>
      <label>基准湿度%<input type="number" step="0.1" name="baselineHumidity" value="${escapeHtml(item.baselineHumidity)}"></label>
      <label class="wide">基准CO2 ppm<input type="number" name="baselineCo2" value="${escapeHtml(item.baselineCo2)}"></label>
    </div>
    <div class="actions">
      <button type="submit">保存修订（原封存/复开结论将失效）</button>
      <button type="button" class="ghost" data-baseline-cancel>取消</button>
    </div>
  </form>`;
}

function calibrationLine(item) {
  if (item.calibrationStatus !== '待校准') return '';
  return `<p class="calib">${pill('待校准', 'warn')} ${escapeHtml(item.calibrationSeason || '')} ${escapeHtml(item.calibrationReason || '')}</p>`;
}

function verdictLine(item) {
  if (!item.verdict) return '';
  return `<p class="calib">${pill(item.verdict, toneFor(item.verdict))} ${escapeHtml(item.verdictReason || '')}</p>`;
}

function reopenEvaluationBlock(item) {
  const evaluation = item.evaluation;
  if (!evaluation?.sites) return '';
  const rows = evaluation.sites.map((row) => `
    <div class="eval-row ${row.blockers.length ? 'bad' : 'ok'}">
      <strong>${escapeHtml(row.pointCode)}</strong>
      <span>${row.blockers.length ? escapeHtml(row.blockers.join('；')) : `复测合规（温差${row.tempGap ?? '-'}℃ / 湿差${row.humidGap ?? '-'} / CO2增量${row.co2Delta ?? '-'}ppm）`}</span>
    </div>`).join('');
  return `<div class="eval">${rows}</div>`;
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    let value;
    if (field.type === 'relation') value = relationLabel(field, raw);
    else if (field.type === 'datetime') value = fmtDate(raw);
    else value = raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value ?? '-')}</strong></div>`;
  }).join('');
  const summaryFields = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  return `<article class="card" data-card="${item.id}">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${calibrationLine(item)}
    ${verdictLine(item)}
    ${summaryFields ? `<p>${escapeHtml(summaryFields)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${collection === 'reopenOrders' ? reopenEvaluationBlock(item) : ''}
    ${collection === 'sites' ? baselineEditor(item) : ''}
    <div class="actions">${actionButtons(collection, item)}</div>
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection || DOMAIN_COLLECTIONS[view.domain];
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

function pendingPanel() {
  const list = state.meta?.pendingCalibration || [];
  if (!list.length) {
    return `<div class="panel pending"><h2>待校准清单</h2><div class="empty">暂无待校准样点</div></div>`;
  }
  const rows = list.map((row) => `
    <div class="eval-row bad">
      <strong>${escapeHtml(row.pointCode)}（${escapeHtml(row.route)}）</strong>
      <span>${escapeHtml(row.season)}：${escapeHtml(row.reason || '复测超阈值')}</span>
    </div>`).join('');
  return `<div class="panel pending"><h2>待校准清单（${list.length} 个样点）</h2><div class="eval">${rows}</div></div>`;
}

function renderDashboardView(view) {
  const groups = view.focus.map((source) => {
    let items = [...(state.db[source.collection] || [])];
    if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
    items = items.slice(0, source.limit || 8);
    const cardView = state.config.views.find((entry) => entry.id === source.view)
      || state.config.views.find((entry) => entry.collection === source.collection)
      || source;
    return `<div class="panel"><h2>${escapeHtml(source.title || cardView.listTitle || cardView.label)}</h2>
      <div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无事项</div>'}</div>
    </div>`;
  }).join('');
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    ${pendingPanel()}
    <div class="dashboard-grid">${groups}</div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map((field) => formField(field, view)).join('')}</div>
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

function renderDomainView(view) {
  const statusOptions = view.statusOptions || [];
  const preflight = view.domain === 'reopens' ? `
    <div class="actions">
      <button type="button" class="secondary" data-preflight>预检：本路线能否复开</button>
    </div>
    <div class="preflight" id="preflight-${view.id}" hidden></div>` : '';
  const pending = view.domain === 'reopens' ? pendingPanel() : '';
  return `<section class="view" id="${view.id}">
    ${view.domain === 'reopens' ? renderThresholdBanner() : ''}
    <div class="grid">
      <form class="panel" data-domain="${view.domain}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map((field) => formField(field, view)).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
        ${preflight}
      </form>
      <div class="domain-side">
        ${pending}
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
    </div>
  </section>`;
}

function renderThresholdBanner() {
  const t = state.meta?.thresholds || {};
  return `<div class="panel banner">
    <strong>复开判定</strong>：路线内每个样点须由两人间隔 ≥ ${t.gapHours ?? 24} 小时各测一次；
    温差 &gt; ${t.temp ?? 0.8}℃、湿度差 &gt; ${t.humidity ?? 5} 个百分点或 CO2 增量 &gt; ${t.co2 ?? 100}ppm，
    该样点只转待校准，整条路线本季不得复开。
  </div>`;
}

function renderPreflight(view, result) {
  const box = $(`#preflight-${view.id}`);
  box.hidden = false;
  const head = result.allowed
    ? `<div class="eval-head ok">全部 ${result.sites.length} 个样点满足复开条件，可提交复开评审。</div>`
    : `<div class="eval-head bad">存在 ${result.sites.filter((s) => s.blockers.length).length} 个阻断样点，整条路线不得复开：</div>`;
  box.innerHTML = head + result.sites.map((row) => `
    <div class="eval-row ${row.blockers.length ? 'bad' : 'ok'}">
      <strong>${escapeHtml(row.pointCode)}（${escapeHtml(row.zone)}）</strong>
      <span>${row.blockers.length ? escapeHtml(row.blockers.join('；')) : '上季已封存 · 两人复测合规'}</span>
    </div>`).join('');
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views
    .map((view) => {
      if (view.type === 'dashboard') return renderDashboardView(view);
      if (view.type === 'domain') return renderDomainView(view);
      return renderCrudView(view);
    })
    .join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  const [db, meta] = await Promise.all([api('/api/db'), api('/api/meta')]);
  state.db = db;
  state.meta = meta;
  render();
}

async function runCustomAction(action, element) {
  const id = element.dataset.id;
  if (action.custom === 'withdrawSurvey') {
    if (!window.confirm('撤回该巡测将让当季封存结论失效，确认撤回？')) return;
    await api(`/api/surveys/${id}/withdraw`, { method: 'POST', body: JSON.stringify({}) });
    toast('巡测已撤回，相关封存结论已失效');
  } else if (action.custom === 'withdrawCheck') {
    if (!window.confirm('撤回该复测将让路线复开结论失效并重算待校准状态，确认撤回？')) return;
    await api(`/api/reopen-checks/${id}/withdraw`, { method: 'POST', body: JSON.stringify({}) });
    toast('复测已撤回，复开结论已失效');
  }
  await load();
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  if (tab) {
    setTab(tab.dataset.tab);
    return;
  }

  const baselineBtn = event.target.closest('[data-baseline]');
  if (baselineBtn) {
    const card = baselineBtn.closest('.card');
    const panel = $('[data-baseline-form]', card);
    panel.hidden = !panel.hidden;
    return;
  }
  const cancelBtn = event.target.closest('[data-baseline-cancel]');
  if (cancelBtn) {
    cancelBtn.closest('[data-baseline-form]').hidden = true;
    return;
  }

  const preflightBtn = event.target.closest('[data-preflight]');
  if (preflightBtn) {
    const form = preflightBtn.closest('form');
    const view = state.config.views.find((entry) => entry.id === form.dataset.view);
    const route = form.elements.route.value;
    const season = form.elements.season.value;
    try {
      const result = await api(`/api/routes/${encodeURIComponent(route)}/reopen-evaluation?season=${encodeURIComponent(season)}`);
      renderPreflight(view, result);
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  const actionEl = event.target.closest('[data-action]');
  if (actionEl) {
    const action = state.config.actions.find((entry) => entry.id === actionEl.dataset.action);
    try {
      if (action?.custom) {
        await runCustomAction(action, actionEl);
      } else {
        await api(`/api/action/${actionEl.dataset.action}/${actionEl.dataset.id}`, { method: 'POST' });
        await load();
        toast('已更新');
      }
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`);
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const baselineForm = event.target.closest('[data-baseline-form]');
  if (baselineForm) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(baselineForm).entries());
    try {
      await api(`/api/sites/${baselineForm.dataset.baselineForm}`, {
        method: 'PATCH',
        body: JSON.stringify({
          baselineTemp: Number(payload.baselineTemp),
          baselineHumidity: Number(payload.baselineHumidity),
          baselineCo2: Number(payload.baselineCo2),
          historyAction: '修订基准'
        })
      });
      toast('基准已修订，相关封存/复开结论已失效');
      await load();
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  const domainForm = event.target.closest('[data-domain]');
  if (domainForm) {
    event.preventDefault();
    const view = state.config.views.find((entry) => entry.id === domainForm.dataset.view);
    const endpoint = DOMAIN_ENDPOINTS[domainForm.dataset.domain];
    try {
      await api(endpoint.path, { method: 'POST', body: JSON.stringify(formValues(domainForm, view)) });
      domainForm.reset();
      const box = $(`#preflight-${view.id}`);
      if (box) box.hidden = true;
      await load();
      toast(endpoint.ok);
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  try {
    await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(formValues(form, view)) });
    form.reset();
    await load();
    toast('已保存');
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
