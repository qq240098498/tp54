(function () {
  'use strict';

  // 页面状态：用例列表、内置示例接口、请求头草稿行、最近一次响应结果与结果视图
  // checkedIds 为列表勾选；batch 为正在进行或最近一次批量执行的完整快照
  const state = {
    cases: [],
    selectedId: '',
    checkedIds: new Set(),
    headers: [{ key: '', value: '' }],
    demos: [],
    busy: false,
    result: null,
    resultView: 'structured',
    batch: null,
  };

  const dom = {
    health: document.getElementById('health-badge'),
    notice: document.getElementById('notice'),
    name: document.getElementById('field-name'),
    method: document.getElementById('field-method'),
    url: document.getElementById('field-url'),
    body: document.getElementById('field-body'),
    headerRows: document.getElementById('header-rows'),
    addHeader: document.getElementById('add-header'),
    demos: document.getElementById('demo-list'),
    demoSummary: document.getElementById('demo-summary'),
    sendRequest: document.getElementById('send-request'),
    saveCase: document.getElementById('save-case'),
    resetDraft: document.getElementById('reset-draft'),
    resultBody: document.getElementById('result-body'),
    resultSummary: document.getElementById('result-summary'),
    clearResult: document.getElementById('clear-result'),
    caseList: document.getElementById('case-list'),
    caseSummary: document.getElementById('case-summary'),
    refreshCases: document.getElementById('refresh-cases'),
    selectAllCases: document.getElementById('select-all-cases'),
    clearSelectCases: document.getElementById('clear-select-cases'),
    selectSummary: document.getElementById('select-summary'),
    runBatch: document.getElementById('run-batch'),
    stopBatch: document.getElementById('stop-batch'),
    batchPanel: document.getElementById('batch-panel'),
    batchStatus: document.getElementById('batch-status'),
    batchBody: document.getElementById('batch-body'),
    caseDetail: document.getElementById('case-detail'),
    closeDetail: document.getElementById('close-detail'),
  };

  const emptyDetailHint = '在用例列表点「详情」，这里显示该用例保存下来的目标地址、请求头与请求内容。';
  // 结构化视图最多铺开的层级条目数量，避免内容过大时页面卡顿
  const TREE_LIMIT = 800;
  let noticeTimer = 0;

  // ---------------- 后端交互 ----------------

  // 统一请求入口：把服务端返回的错误码与出错位置打包进异常对象
  async function request(path, options) {
    const config = options || {};
    const init = { method: config.method || 'GET' };
    if (config.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(config.body);
    }
    if (config.signal) init.signal = config.signal;

    let response = null;
    try {
      response = await fetch(path, init);
    } catch (err) {
      // 批量执行停止时主动中断的请求，原样抛出由调用方按已取消处理
      if (err && err.name === 'AbortError') throw err;
      const error = new Error('无法连接服务，请确认服务已启动');
      error.code = 'NETWORK_ERROR';
      error.field = '';
      throw error;
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      payload = null;
    }

    if (!response.ok) {
      const info = (payload && payload.error) || {};
      const error = new Error(info.message || `操作失败（状态码 ${response.status}）`);
      error.code = info.code || 'request_failed';
      error.field = typeof info.field === 'string' ? info.field : '';
      throw error;
    }
    return payload;
  }

  function setBusy(busy, activeAction) {
    state.busy = busy;
    dom.sendRequest.disabled = busy;
    dom.saveCase.disabled = busy;
    dom.resetDraft.disabled = busy;
    dom.refreshCases.disabled = busy;
    dom.sendRequest.textContent = busy && activeAction === 'send' ? '发送中…' : '发送请求';
    dom.saveCase.textContent = busy && activeAction === 'save' ? '正在保存…' : '保存为用例';
  }

  // ---------------- 页面消息与出错标记 ----------------

  function showNotice(message, type) {
    dom.notice.textContent = message;
    dom.notice.className = `notice notice-${type || 'info'}`;
    dom.notice.hidden = false;
    window.clearTimeout(noticeTimer);
    const stay = type === 'error' ? 6000 : 3500;
    noticeTimer = window.setTimeout(() => {
      dom.notice.hidden = true;
    }, stay);
  }

  function clearFieldErrors() {
    document.querySelectorAll('.field-error').forEach((node) => {
      node.hidden = true;
      node.textContent = '';
    });
    [dom.name, dom.url, dom.body, dom.headerRows].forEach((node) => node.classList.remove('invalid'));
  }

  // 服务端给出的位置可能是 headers.2.key 这种形式，标记时按区块归位
  function normalizeField(field) {
    if (typeof field !== 'string' || !field) return '';
    const key = field.split('.')[0];
    return ['name', 'method', 'url', 'headers', 'body'].includes(key) ? key : '';
  }

  function showFieldError(field, message) {
    const key = normalizeField(field);
    if (!key) return;
    const slot = document.querySelector(`[data-error="${key}"]`);
    if (slot) {
      slot.textContent = message;
      slot.hidden = false;
    }
    const target = {
      name: dom.name,
      method: dom.method,
      url: dom.url,
      headers: dom.headerRows,
      body: dom.body,
    }[key];
    if (target) target.classList.add('invalid');
  }

  // ---------------- 请求区 ----------------

  function renderHeaderRows() {
    dom.headerRows.textContent = '';
    if (!state.headers.length) {
      const empty = document.createElement('p');
      empty.className = 'rows-empty';
      empty.textContent = '暂无请求头';
      dom.headerRows.appendChild(empty);
      return;
    }

    state.headers.forEach((row, index) => {
      const line = document.createElement('div');
      line.className = 'header-row';

      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'header-key';
      keyInput.value = row.key;
      keyInput.autocomplete = 'off';
      keyInput.dataset.index = String(index);
      keyInput.dataset.part = 'key';
      keyInput.setAttribute('aria-label', `第 ${index + 1} 行请求头名称`);

      const valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueInput.className = 'header-value';
      valueInput.value = row.value;
      valueInput.autocomplete = 'off';
      valueInput.dataset.index = String(index);
      valueInput.dataset.part = 'value';
      valueInput.setAttribute('aria-label', `第 ${index + 1} 行请求头取值`);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost btn-small';
      remove.textContent = '删除';
      remove.dataset.action = 'remove-header';
      remove.dataset.index = String(index);

      line.append(keyInput, valueInput, remove);
      dom.headerRows.appendChild(line);
    });
  }

  function collectDraft() {
    return {
      name: dom.name.value.trim(),
      method: dom.method.value,
      url: dom.url.value.trim(),
      headers: state.headers.map((row) => ({ key: row.key.trim(), value: row.value })),
      body: dom.body.value,
    };
  }

  // 把一份请求内容写回表单，既用于示例接口填入，也用于用例回填
  function fillDraft(draft) {
    dom.name.value = typeof draft.name === 'string' ? draft.name : '';
    dom.method.value = draft.method || 'GET';
    dom.url.value = draft.url || '';
    dom.body.value = typeof draft.body === 'string' ? draft.body : '';
    state.headers = Array.isArray(draft.headers) && draft.headers.length
      ? draft.headers.map((row) => ({
          key: typeof row.key === 'string' ? row.key : '',
          value: typeof row.value === 'string' ? row.value : '',
        }))
      : [{ key: '', value: '' }];
    renderHeaderRows();
    clearFieldErrors();
  }

  function resetDraft(silent) {
    fillDraft({ name: '', method: 'GET', url: '', headers: [], body: '' });
    if (!silent) showNotice('草稿已清空', 'info');
  }

  // ---------------- 内置示例接口 ----------------

  async function loadDemos() {
    try {
      const data = await request('/api/demos');
      state.demos = data && Array.isArray(data.endpoints) ? data.endpoints : [];
    } catch (err) {
      state.demos = [];
    }
    renderDemos();
  }

  function renderDemos() {
    dom.demos.textContent = '';
    if (!state.demos.length) {
      dom.demoSummary.textContent = '读取失败';
      const hint = document.createElement('p');
      hint.className = 'rows-empty';
      hint.textContent = '内置示例接口暂时读取不到，可以直接在目标地址里填写完整地址';
      dom.demos.appendChild(hint);
      return;
    }

    dom.demoSummary.textContent = `共 ${state.demos.length} 个`;
    state.demos.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'demo-item';

      const main = document.createElement('div');
      main.className = 'demo-main';

      const title = document.createElement('div');
      title.className = 'demo-title';
      const nameNode = document.createElement('span');
      nameNode.className = 'demo-name';
      nameNode.textContent = item.name;
      title.append(nameNode, buildTag(item.method, item.method === 'GET' ? 'get' : 'any'));

      const pathNode = document.createElement('p');
      pathNode.className = 'demo-path';
      pathNode.textContent = item.path;

      const summaryNode = document.createElement('p');
      summaryNode.className = 'demo-summary';
      summaryNode.textContent = item.summary;

      main.append(title, pathNode, summaryNode);

      const fill = document.createElement('button');
      fill.type = 'button';
      fill.className = 'btn btn-small';
      fill.textContent = '填入请求区';
      fill.addEventListener('click', () => {
        fillDraft(item.example);
        state.selectedId = '';
        renderCases();
        showNotice(`已把「${item.name}」填入请求区，点发送请求即可看到结果`, 'info');
      });

      row.append(main, fill);
      dom.demos.appendChild(row);
    });
  }

  // ---------------- 发送请求与结果展示 ----------------

  async function sendRequest() {
    if (state.busy || isBatchRunning()) return;
    clearFieldErrors();

    const draft = collectDraft();
    if (!draft.url) {
      showFieldError('url', '请填写目标地址');
      showNotice('请填写目标地址', 'error');
      dom.url.focus();
      return;
    }
    if (draft.body.trim() && (draft.method === 'GET' || draft.method === 'HEAD')) {
      showFieldError('body', `请求方式为 ${draft.method} 时不带请求内容，请清空请求内容或更换请求方式`);
      showNotice('请求方式与请求内容不匹配，请调整后再发送', 'error');
      return;
    }

    setBusy(true, 'send');
    renderResultPending(draft);
    try {
      const result = await request('/api/send', { method: 'POST', body: draft });
      state.result = result;
      renderResult(result);
      if (result.ok) {
        showNotice(`请求已完成：状态码 ${result.status}，耗时 ${formatDuration(result.timeMs)}`, 'success');
      } else {
        showNotice(`请求失败：${result.failure.reason}`, 'error');
      }
    } catch (err) {
      state.result = null;
      if (err.field) showFieldError(err.field, err.message);
      dom.resultSummary.textContent = '';
      dom.resultBody.textContent = '';
      dom.clearResult.hidden = false;
      dom.resultBody.appendChild(buildFailurePanel('这次请求没有发出去', err.message, ''));
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function renderResultPending(draft) {
    dom.resultSummary.textContent = '正在等待响应';
    dom.clearResult.hidden = true;
    dom.resultBody.textContent = '';

    const block = document.createElement('div');
    block.className = 'result-pending';
    const title = document.createElement('p');
    title.className = 'pending-title';
    title.textContent = '请求已发出，正在等待响应…';
    const sub = document.createElement('p');
    sub.className = 'empty-sub';
    sub.textContent = `${draft.method} ${draft.url} 已按照填写的内容发出去，收到回应后这里会显示状态、耗时、响应头与响应内容。`;
    block.append(title, sub);
    dom.resultBody.appendChild(block);
  }

  function renderEmptyResult() {
    dom.resultSummary.textContent = '';
    dom.clearResult.hidden = true;
    dom.resultBody.textContent = '';
    dom.resultBody.appendChild(
      buildEmptyBlock(
        '还没有发送过请求',
        '填好请求方式与目标地址后点「发送请求」，这里会显示响应状态、耗时、响应头与响应内容。'
      )
    );
  }

  function renderResult(result) {
    dom.resultBody.textContent = '';
    dom.clearResult.hidden = false;

    const head = document.createElement('div');
    head.className = 'result-head';

    if (result.ok) {
      head.appendChild(buildStatusBadge(result.status, result.statusText));
      head.appendChild(buildChip(`耗时 ${formatDuration(result.timeMs)}`));
      head.appendChild(buildChip(`内容 ${formatBytes(result.size)}`));
      // 状态码落在 400 及以上时，页面同样按失败口径提醒
      if (result.status >= 400) head.appendChild(buildChip('本次响应为失败状态', 'chip-bad'));
      dom.resultSummary.textContent = `最近一次：${result.status} ${result.statusText}`.trim();
    } else {
      head.appendChild(buildStatusBadge(0, '未完成'));
      head.appendChild(buildChip(`已等待 ${formatDuration(result.timeMs)}`));
      dom.resultSummary.textContent = '最近一次：请求未完成';
    }
    dom.resultBody.appendChild(head);

    const targetLine = document.createElement('p');
    targetLine.className = 'result-target';
    targetLine.textContent = result.internal
      ? `目标地址（本机内置示例接口）：${result.targetUrl}`
      : `目标地址：${result.targetUrl}`;
    dom.resultBody.appendChild(targetLine);

    if (!result.ok) {
      dom.resultBody.appendChild(
        buildFailurePanel('请求没有完成', result.failure.reason, result.failure.detail)
      );
      return;
    }

    const headerSection = buildSection('响应头');
    if (result.headers.length) {
      headerSection.appendChild(buildHeaderTable(result.headers));
    } else {
      headerSection.appendChild(buildTextNote('本次响应没有返回响应头'));
    }
    dom.resultBody.appendChild(headerSection);

    const bodySection = buildSection('响应内容');
    bodySection.appendChild(buildBodyView(result));
    dom.resultBody.appendChild(bodySection);
  }

  function buildFailurePanel(title, reason, detail) {
    const panel = document.createElement('div');
    panel.className = 'failure-panel';

    const titleNode = document.createElement('p');
    titleNode.className = 'failure-title';
    titleNode.textContent = title;

    const reasonNode = document.createElement('p');
    reasonNode.className = 'failure-reason';
    reasonNode.textContent = `失败原因：${reason}`;

    panel.append(titleNode, reasonNode);

    if (detail) {
      const detailNode = document.createElement('p');
      detailNode.className = 'failure-detail';
      detailNode.textContent = `详细信息：${detail}`;
      panel.appendChild(detailNode);
    }
    return panel;
  }

  function buildBodyView(result) {
    const wrap = document.createElement('div');
    wrap.className = 'body-view';

    const text = typeof result.body === 'string' ? result.body : '';
    if (!text.trim()) {
      wrap.appendChild(buildTextNote(result.status === 204 ? '本次响应为成功且没有返回内容' : '本次响应没有返回内容'));
      return wrap;
    }

    const tabs = document.createElement('div');
    tabs.className = 'view-tabs';
    tabs.append(
      buildTab('结构化', state.resultView === 'structured', () => switchResultView('structured')),
      buildTab('原始文本', state.resultView === 'raw', () => switchResultView('raw'))
    );
    wrap.appendChild(tabs);

    const parsed = tryParseJson(text);
    if (state.resultView === 'raw') {
      wrap.appendChild(buildPre(text));
    } else if (parsed.ok) {
      wrap.appendChild(buildJsonTree(parsed.value, '', { left: TREE_LIMIT }));
    } else {
      wrap.appendChild(buildTextNote('响应内容不是结构化数据，已按文本显示'));
      wrap.appendChild(buildPre(text));
    }

    if (result.truncated) {
      wrap.appendChild(buildTextNote('响应内容较大，这里只保留了开头的一部分用于展示'));
    }
    return wrap;
  }

  function switchResultView(view) {
    state.resultView = view;
    if (state.result) renderResult(state.result);
  }

  function tryParseJson(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (err) {
      return { ok: false, value: null };
    }
  }

  function buildPre(text) {
    const pre = document.createElement('pre');
    pre.className = 'result-pre';
    pre.textContent = text;
    return pre;
  }

  // 结构化视图：对象与数组逐层铺开，取值按类型区分显示
  function buildJsonTree(value, label, counter) {
    counter.left -= 1;
    const node = document.createElement('div');
    node.className = 'json-node';

    if (value !== null && typeof value === 'object') {
      const isArray = Array.isArray(value);
      const keys = isArray ? value.map((_, index) => index) : Object.keys(value);

      const head = document.createElement('div');
      head.className = 'json-line';
      head.appendChild(buildJsonKey(label));
      head.appendChild(buildJsonTag(`${isArray ? '数组' : '对象'} ${keys.length} 项`));
      node.appendChild(head);

      const children = document.createElement('div');
      children.className = 'json-children';

      if (!keys.length) {
        children.appendChild(buildJsonLine('', isArray ? '空数组' : '空对象', 'empty'));
      } else {
        let shown = 0;
        for (let index = 0; index < keys.length; index += 1) {
          if (counter.left <= 0) break;
          const key = keys[index];
          children.appendChild(
            buildJsonTree(value[key], isArray ? `[${key}]` : String(key), counter)
          );
          shown += 1;
        }
        if (shown < keys.length) {
          children.appendChild(buildTextNote(`还有 ${keys.length - shown} 项未展开，可切换到原始文本查看完整内容`));
        }
      }

      node.appendChild(children);
      return node;
    }

    node.appendChild(buildJsonLine(label, describePrimitive(value), primitiveKind(value)));
    return node;
  }

  function buildJsonLine(label, text, kind) {
    const line = document.createElement('div');
    line.className = 'json-line';
    if (label) line.appendChild(buildJsonKey(label));
    const valueNode = document.createElement('span');
    valueNode.className = `json-value json-${kind}`;
    valueNode.textContent = text;
    line.appendChild(valueNode);
    return line;
  }

  function buildJsonKey(label) {
    const key = document.createElement('span');
    key.className = 'json-key';
    key.textContent = label || '整体内容';
    return key;
  }

  function buildJsonTag(text) {
    const tag = document.createElement('span');
    tag.className = 'json-tag';
    tag.textContent = text;
    return tag;
  }

  function describePrimitive(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') return `"${value}"`;
    return String(value);
  }

  function primitiveKind(value) {
    if (value === null) return 'null';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    return 'string';
  }

  // ---------------- 用例区 ----------------

  async function loadCases() {
    const list = await request('/api/cases');
    state.cases = Array.isArray(list) ? list : [];
    if (state.selectedId && !state.cases.some((item) => item.id === state.selectedId)) {
      state.selectedId = '';
    }
    // 列表刷新后，勾选里指向已删除用例的条目清掉；已结束批次的历史记录保持原样
    const validIds = new Set(state.cases.map((item) => item.id));
    state.checkedIds.forEach((id) => {
      if (!validIds.has(id)) state.checkedIds.delete(id);
    });
    renderCases();
  }

  function renderCases() {
    // 整列表重建会收起已展开的失败原因，先记下哪些用例的详情正开着
    const openFailures = new Set();
    dom.caseList.querySelectorAll('details[data-case-id][open]').forEach((node) => {
      openFailures.add(node.dataset.caseId);
    });

    dom.caseSummary.textContent = `共 ${state.cases.length} 条`;
    dom.caseList.textContent = '';

    if (!state.cases.length) {
      dom.caseList.appendChild(
        buildEmptyBlock('还没有保存过用例', '在请求区填好内容后点「保存为用例」，用例会出现在这里。')
      );
    } else {
      state.cases.forEach((item) => {
        dom.caseList.appendChild(buildCaseRow(item));
      });
    }
    openFailures.forEach((id) => {
      const node = dom.caseList.querySelector(`details[data-case-id="${id}"]`);
      if (node) node.open = true;
    });
    renderBatchControls();
  }

  // 勾选计数、全选/清空/开始/停止几个入口的可用状态统一在这里刷新
  function renderBatchControls() {
    const running = !!state.batch && state.batch.running;
    const total = state.cases.length;
    const checkedCount = state.cases.reduce(
      (count, item) => (state.checkedIds.has(item.id) ? count + 1 : count),
      0
    );

    dom.selectSummary.textContent = running
      ? `本次批次已选 ${state.batch.entries.length} 条`
      : `已选 ${checkedCount} 条`;

    dom.selectAllCases.disabled = running || total === 0 || checkedCount === total;
    dom.clearSelectCases.disabled = running || checkedCount === 0;
    dom.runBatch.hidden = running;
    dom.stopBatch.hidden = !running;
    dom.runBatch.disabled = state.busy || checkedCount === 0;
    // 执行过程中不允许刷新列表或改动请求区，避免列表顺序与批次条目错位
    dom.refreshCases.disabled = state.busy || running;
    dom.sendRequest.disabled = state.busy || running;
    dom.saveCase.disabled = state.busy || running;
    dom.resetDraft.disabled = state.busy || running;
    dom.addHeader.disabled = running;
  }

  function buildEmptyBlock(title, subtitle) {
    const block = document.createElement('div');
    block.className = 'empty';
    const titleNode = document.createElement('p');
    titleNode.className = 'empty-title';
    titleNode.textContent = title;
    const subNode = document.createElement('p');
    subNode.className = 'empty-sub';
    subNode.textContent = subtitle;
    block.append(titleNode, subNode);
    return block;
  }

  function buildTextNote(text) {
    const note = document.createElement('p');
    note.className = 'text-note';
    note.textContent = text;
    return note;
  }

  function buildTag(text, kind) {
    const tag = document.createElement('span');
    tag.className = `method method-${kind || 'any'}`;
    tag.textContent = text;
    return tag;
  }

  function buildCaseRow(item) {
    const row = document.createElement('article');
    row.className = 'case-item';
    row.dataset.caseId = item.id;
    if (item.id === state.selectedId) row.classList.add('active');

    const checkCell = document.createElement('label');
    checkCell.className = 'case-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.checkedIds.has(item.id);
    checkbox.disabled = !!state.batch && state.batch.running;
    checkbox.setAttribute('aria-label', `选择用例「${item.name}」`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.checkedIds.add(item.id);
      else state.checkedIds.delete(item.id);
      renderBatchControls();
    });
    checkCell.appendChild(checkbox);

    const main = document.createElement('div');
    main.className = 'case-main';

    const title = document.createElement('div');
    title.className = 'case-title';
    const nameNode = document.createElement('span');
    nameNode.className = 'case-name';
    nameNode.textContent = item.name;
    title.append(buildTag(item.method, String(item.method).toLowerCase()), nameNode);
    if (item.url.startsWith('/')) title.appendChild(buildTag('内置', 'inner'));

    const urlNode = document.createElement('p');
    urlNode.className = 'case-url';
    urlNode.textContent = item.url;

    const metaNode = document.createElement('p');
    metaNode.className = 'case-meta';
    metaNode.textContent = `请求头 ${item.headers.length} 行 · 保存于 ${formatTime(item.createdAt)}`;

    main.append(title, urlNode, metaNode);

    const batchEntry = state.batch
      ? state.batch.entries.find((entry) => entry.id === item.id)
      : null;
    if (batchEntry) {
      const batchNode = buildBatchEntryLine(batchEntry);
      main.appendChild(batchNode);
      if (batchEntry.status === 'failed' || batchEntry.status === 'success') {
        row.classList.add(`case-batch-${batchEntry.status}`);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'case-actions';

    const fillButton = document.createElement('button');
    fillButton.type = 'button';
    fillButton.className = 'btn btn-small';
    fillButton.textContent = '回填';
    fillButton.disabled = !!state.batch && state.batch.running;
    fillButton.addEventListener('click', () => {
      applyCase(item);
    });

    const viewButton = document.createElement('button');
    viewButton.type = 'button';
    viewButton.className = 'btn btn-small';
    viewButton.textContent = '详情';
    viewButton.disabled = !!state.batch && state.batch.running;
    viewButton.addEventListener('click', () => {
      openDetail(item.id);
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-small btn-danger';
    deleteButton.textContent = '删除';
    deleteButton.disabled = !!state.batch && state.batch.running;
    deleteButton.addEventListener('click', () => {
      removeCase(item);
    });

    actions.append(fillButton, viewButton, deleteButton);
    row.append(checkCell, main, actions);
    return row;
  }

  // 列表行内的本次批次状态：执行中、成功（状态码+耗时）、失败（可展开原因）、已取消
  function buildBatchEntryLine(entry) {
    const wrap = document.createElement('div');
    wrap.className = 'case-batch-line';

    if (entry.status === 'pending') {
      wrap.classList.add('batch-pending');
      wrap.textContent = '待执行';
      return wrap;
    }
    if (entry.status === 'running') {
      wrap.classList.add('batch-running');
      wrap.textContent = '正在执行…';
      return wrap;
    }
    if (entry.status === 'cancelled') {
      wrap.classList.add('batch-cancelled');
      wrap.textContent = '已取消';
      return wrap;
    }

    const result = entry.result;
    if (entry.status === 'success' && result && result.ok) {
      wrap.classList.add('batch-ok');
      const label = document.createElement('span');
      label.className = 'batch-result-label';
      label.textContent = `成功 · 状态码 ${result.status} · 耗时 ${formatDuration(result.timeMs)}`;
      wrap.appendChild(label);
      return wrap;
    }

    // 没拿到响应或拿到 400 及以上状态，都按失败呈现，失败原因可点开查看
    wrap.classList.add('batch-failed');
    const details = document.createElement('details');
    details.className = 'batch-failure-details';
    details.dataset.caseId = item.id;
    const summary = document.createElement('summary');
    const statusText = result && result.ok
      ? `状态码 ${result.status}`
      : (result && result.failure ? result.failure.reason : '请求未完成');
    summary.textContent = `失败 · ${statusText} · 耗时 ${formatDuration(result ? result.timeMs : 0)}（点击查看原因）`;
    details.appendChild(summary);
    details.appendChild(buildFailureReasonBlock(result));
    wrap.appendChild(details);
    return wrap;
  }

  // 失败条目展开后的完整原因：网络层失败给出原因与详情，HTTP 失败状态码给出响应头与响应内容摘要
  function buildFailureReasonBlock(result) {
    const box = document.createElement('div');
    box.className = 'batch-failure-box';

    if (!result) {
      box.appendChild(buildTextNote('这条用例没有拿到执行结果。'));
      return box;
    }

    if (!result.ok) {
      const reasonNode = document.createElement('p');
      reasonNode.className = 'failure-reason';
      reasonNode.textContent = `失败原因：${result.failure.reason}`;
      box.appendChild(reasonNode);
      if (result.failure.detail) {
        const detailNode = document.createElement('p');
        detailNode.className = 'failure-detail';
        detailNode.textContent = `详细信息：${result.failure.detail}`;
        box.appendChild(detailNode);
      }
      return box;
    }

    const statusNode = document.createElement('p');
    statusNode.className = 'failure-reason';
    statusNode.textContent = `目标返回了失败状态码：${result.status} ${result.statusText}`.trim();
    box.appendChild(statusNode);

    if (Array.isArray(result.headers) && result.headers.length) {
      box.appendChild(buildTextNote('响应头：'));
      box.appendChild(buildHeaderTable(result.headers));
    }
    if (result.body) {
      box.appendChild(buildTextNote('响应内容：'));
      box.appendChild(buildPre(result.body));
    }
    return box;
  }

  // 回填：把用例保存下来的内容写回请求区，可以直接点发送请求重发一次
  function applyCase(item) {
    if (state.busy || isBatchRunning()) return;
    fillDraft(item);
    state.selectedId = item.id;
    renderCases();
    renderDetail(item);
    showNotice(`用例「${item.name}」已回填到请求区，可直接点发送请求`, 'success');
  }

  async function openDetail(id) {
    if (state.busy || isBatchRunning()) return;
    try {
      const item = await request(`/api/cases/${encodeURIComponent(id)}`);
      state.selectedId = item.id;
      renderCases();
      renderDetail(item);
    } catch (err) {
      showNotice(err.message, 'error');
      if (err.code === 'CASE_NOT_FOUND') {
        state.selectedId = '';
        renderEmptyDetail();
        try {
          await loadCases();
        } catch (reloadError) {
          showNotice(reloadError.message, 'error');
        }
      }
    }
  }

  function renderDetail(item) {
    dom.caseDetail.textContent = '';

    const head = document.createElement('div');
    head.className = 'detail-head';
    const nameNode = document.createElement('h3');
    nameNode.textContent = item.name;
    head.append(buildTag(item.method, String(item.method).toLowerCase()), nameNode);

    const fillButton = document.createElement('button');
    fillButton.type = 'button';
    fillButton.className = 'btn btn-small';
    fillButton.textContent = '回填到请求区';
    fillButton.addEventListener('click', () => {
      applyCase(item);
    });
    head.appendChild(fillButton);

    dom.caseDetail.append(head);
    dom.caseDetail.append(buildDetailRow('目标地址', item.url, false));
    dom.caseDetail.append(
      buildDetailRow(
        '请求头',
        item.headers.length ? item.headers.map((row) => `${row.key}: ${row.value}`).join('\n') : '暂无内容',
        true
      )
    );
    dom.caseDetail.append(buildDetailRow('请求内容', item.body || '暂无内容', true));
    dom.caseDetail.append(
      buildDetailRow('保存时间', `${formatTime(item.createdAt)}（最近更新 ${formatTime(item.updatedAt)}）`, false)
    );
    dom.closeDetail.hidden = false;
  }

  function buildDetailRow(label, text, block) {
    const wrap = document.createElement('div');
    wrap.className = 'detail-row';

    const labelNode = document.createElement('span');
    labelNode.className = 'detail-label';
    labelNode.textContent = label;

    const valueNode = document.createElement(block ? 'pre' : 'p');
    valueNode.className = 'detail-value';
    valueNode.textContent = text;

    wrap.append(labelNode, valueNode);
    return wrap;
  }

  function renderEmptyDetail() {
    dom.closeDetail.hidden = true;
    dom.caseDetail.textContent = '';
    const subNode = document.createElement('p');
    subNode.className = 'empty-sub';
    subNode.textContent = emptyDetailHint;
    dom.caseDetail.appendChild(subNode);
  }

  // ---------------- 批量执行 ----------------

  function isBatchRunning() {
    return !!state.batch && state.batch.running;
  }

  function selectAllCases() {
    if (isBatchRunning()) return;
    state.cases.forEach((item) => state.checkedIds.add(item.id));
    renderCases();
  }

  function clearCheckedCases() {
    if (isBatchRunning()) return;
    state.checkedIds.clear();
    renderCases();
  }

  // 按列表当前顺序取出勾中的用例，批量执行过程中顺序不再随列表变化
  function startBatch() {
    if (state.busy || isBatchRunning()) return;
    const selected = state.cases.filter((item) => state.checkedIds.has(item.id));
    if (!selected.length) {
      showNotice('请先勾选要执行的用例', 'error');
      return;
    }

    state.batch = {
      startedAt: Date.now(),
      finishedAt: null,
      running: true,
      stopped: false,
      abortController: null,
      timer: 0,
      entries: selected.map((item) => ({
        id: item.id,
        name: item.name,
        method: item.method,
        url: item.url,
        // 整份请求内容在发起时快照，执行过程中不再受请求区草稿影响
        headers: item.headers.map((row) => ({ key: row.key, value: row.value })),
        body: item.body,
        status: 'pending', // pending / running / success / failed / cancelled
        result: null,
      })),
    };

    dom.batchPanel.hidden = false;
    renderCases();
    runBatch();
  }

  async function runBatch() {
    const batch = state.batch;
    // 执行过程中定时刷新已用时长，结束时统一清掉
    batch.timer = window.setInterval(renderBatchTick, 200);
    showNotice(`批量执行已开始，共 ${batch.entries.length} 条用例，按列表顺序逐条执行`, 'info');

    for (const entry of batch.entries) {
      // 每条开始前先看是否已被停止：没开始的一律标为已取消，不再发请求。
      // 停止后剩余条目在同一个同步循环里处理完，渲染交给循环结束后的 finishBatch 统一做
      if (!batch.running) {
        entry.status = 'cancelled';
        continue;
      }

      entry.status = 'running';
      renderCaseRowById(entry.id);
      renderBatchSummary();

      const startedAt = Date.now();
      const controller = new AbortController();
      batch.abortController = controller;
      try {
        const result = await request('/api/send', {
          method: 'POST',
          body: {
            method: entry.method,
            url: entry.url,
            headers: entry.headers,
            body: entry.body,
          },
          signal: controller.signal,
        });
        // 等待响应期间点了停止：这条还没算完成，按已取消处理，后面的条目也不再开始
        entry.result = result;
        entry.status = batch.running && result.ok && result.status < 400 ? 'success' : 'failed';
        if (!batch.running) entry.status = 'cancelled';
      } catch (err) {
        if (err && err.name === 'AbortError') {
          entry.status = 'cancelled';
        } else {
          entry.status = 'failed';
          entry.result = {
            ok: false,
            targetUrl: entry.url,
            timeMs: Date.now() - startedAt,
            failure: { reason: err.message, detail: '' },
          };
        }
      }
      batch.abortController = null;
      renderCaseRowById(entry.id);
      renderBatchSummary();
    }

    finishBatch();
  }

  // 停止：立即中断正在执行的那一条，循环随后把未开始的条目全部标为已取消
  function stopBatch() {
    const batch = state.batch;
    if (!batch || !batch.running) return;
    batch.running = false;
    batch.stopped = true;
    if (batch.abortController) batch.abortController.abort();
    renderBatchSummary();
    showNotice('已停止批量执行，未开始的用例标记为已取消', 'info');
  }

  function finishBatch() {
    const batch = state.batch;
    batch.running = false;
    batch.finishedAt = Date.now();
    if (batch.timer) {
      window.clearInterval(batch.timer);
      batch.timer = 0;
    }
    batch.abortController = null;
    renderCases();
    renderBatchSummary();

    const stats = countBatchEntries(batch);
    if (batch.stopped) {
      showNotice(
        `批量执行已停止：成功 ${stats.success} 条，失败 ${stats.failed} 条，取消 ${stats.cancelled} 条`,
        'info'
      );
    } else if (stats.failed) {
      showNotice(`批量执行完成：${stats.success} 条成功，${stats.failed} 条失败`, 'error');
    } else {
      showNotice(`批量执行完成：全部 ${stats.success} 条用例成功`, 'success');
    }
  }

  function countBatchEntries(batch) {
    const stats = { total: batch.entries.length, success: 0, failed: 0, cancelled: 0, pending: 0 };
    batch.entries.forEach((entry) => {
      if (Object.prototype.hasOwnProperty.call(stats, entry.status)) stats[entry.status] += 1;
    });
    return stats;
  }

  // 只替换列表里的某一行，避免每完成一条就整列表重建
  function renderCaseRowById(id) {
    const item = state.cases.find((caseItem) => caseItem.id === id);
    const old = dom.caseList.querySelector(`[data-case-id="${id}"]`);
    if (!item || !old) return;
    old.replaceWith(buildCaseRow(item));
  }

  // 批次摘要面板：发起时间、执行状态、四种计数与总耗时
  function renderBatchSummary() {
    const batch = state.batch;
    if (!batch) return;
    // 重建面板会收起已展开的失败原因，先按条目序号记下来再恢复
    const openIndexes = new Set();
    dom.batchBody.querySelectorAll('details[data-batch-index][open]').forEach((node) => {
      openIndexes.add(Number(node.dataset.batchIndex));
    });

    dom.batchPanel.hidden = false;
    dom.batchBody.textContent = '';

    const stats = countBatchEntries(batch);
    const finishedCount = stats.success + stats.failed + stats.cancelled;
    const elapsed = (batch.running ? Date.now() : batch.finishedAt || Date.now()) - batch.startedAt;

    if (batch.running) {
      dom.batchStatus.textContent = batch.stopped
        ? `正在停止… ${finishedCount}/${stats.total} 已结束`
        : `正在执行 ${finishedCount + 1}/${stats.total} · 已用 ${formatDuration(elapsed)}`;
    } else {
      dom.batchStatus.textContent = batch.stopped ? '已停止' : '已完成';
    }

    const infoLine = document.createElement('p');
    infoLine.className = 'batch-meta-line';
    infoLine.textContent = `发起时间：${formatTime(batch.startedAt)}`;
    dom.batchBody.appendChild(infoLine);

    const statLine = document.createElement('div');
    statLine.className = 'batch-stats';
    statLine.append(
      buildBatchStat('总条数', stats.total, 'stat-total'),
      buildBatchStat('成功', stats.success, 'stat-ok'),
      buildBatchStat('失败', stats.failed, 'stat-bad'),
      buildBatchStat('取消', stats.cancelled, 'stat-muted'),
      buildBatchStat('总耗时', formatDuration(elapsed), 'stat-total', 'batch-elapsed')
    );
    dom.batchBody.appendChild(statLine);

    const entryList = document.createElement('div');
    entryList.className = 'batch-entry-list';
    batch.entries.forEach((entry, index) => {
      const rowNode = buildBatchSummaryRow(entry, index);
      if (openIndexes.has(index)) {
        const detailsNode = rowNode.querySelector('details[data-batch-index]');
        if (detailsNode) detailsNode.open = true;
      }
      entryList.appendChild(rowNode);
    });
    dom.batchBody.appendChild(entryList);
  }

  // 计时跳动时只改状态文字与总耗时，不重建面板，避免打断展开的详情
  function renderBatchTick() {
    const batch = state.batch;
    if (!batch || !batch.running) return;
    const stats = countBatchEntries(batch);
    const finishedCount = stats.success + stats.failed + stats.cancelled;
    const elapsed = Date.now() - batch.startedAt;
    dom.batchStatus.textContent = batch.stopped
      ? `正在停止… ${finishedCount}/${stats.total} 已结束`
      : `正在执行 ${finishedCount + 1}/${stats.total} · 已用 ${formatDuration(elapsed)}`;
    const elapsedNode = document.getElementById('batch-elapsed');
    if (elapsedNode) elapsedNode.textContent = formatDuration(elapsed);
  }

  function buildBatchStat(label, value, extraClass, valueId) {
    const chip = document.createElement('span');
    chip.className = `batch-stat ${extraClass || ''}`;
    const labelNode = document.createElement('span');
    labelNode.className = 'batch-stat-label';
    labelNode.textContent = label;
    const valueNode = document.createElement('span');
    valueNode.className = 'batch-stat-value';
    valueNode.textContent = String(value);
    if (valueId) valueNode.id = valueId;
    chip.append(labelNode, valueNode);
    return chip;
  }

  // 批次面板里的逐条结果行，失败行同样可以点开看完整原因
  function buildBatchSummaryRow(entry, index) {
    const line = document.createElement('div');
    line.className = `batch-entry batch-entry-${entry.status}`;

    const head = document.createElement('div');
    head.className = 'batch-entry-head';
    const indexNode = document.createElement('span');
    indexNode.className = 'batch-entry-index';
    indexNode.textContent = `${index + 1}.`;
    head.append(indexNode, buildTag(entry.method, String(entry.method).toLowerCase()));

    const nameNode = document.createElement('span');
    nameNode.className = 'batch-entry-name';
    nameNode.textContent = entry.name;
    head.appendChild(nameNode);

    const statusNode = document.createElement('span');
    statusNode.className = 'batch-entry-status';
    head.appendChild(statusNode);
    line.appendChild(head);

    if (entry.status === 'pending') {
      statusNode.textContent = '待执行';
      return line;
    }
    if (entry.status === 'running') {
      statusNode.textContent = '正在执行…';
      return line;
    }
    if (entry.status === 'cancelled') {
      statusNode.textContent = '已取消';
      return line;
    }

    const result = entry.result;
    if (entry.status === 'success') {
      statusNode.textContent = `成功 · 状态码 ${result.status} · 耗时 ${formatDuration(result.timeMs)}`;
      return line;
    }

    statusNode.textContent = '失败';
    const details = document.createElement('details');
    details.className = 'batch-failure-details';
    details.dataset.batchIndex = String(index);
    const summary = document.createElement('summary');
    const brief = result && result.ok
      ? `状态码 ${result.status} · 耗时 ${formatDuration(result.timeMs)}（点击查看原因）`
      : `${result && result.failure ? result.failure.reason : '请求未完成'} · 耗时 ${formatDuration(result ? result.timeMs : 0)}（点击查看原因）`;
    summary.textContent = brief;
    details.appendChild(summary);
    details.appendChild(buildFailureReasonBlock(result));
    line.appendChild(details);
    return line;
  }

  // ---------------- 保存与删除 ----------------

  async function saveCase() {
    if (state.busy || isBatchRunning()) return;
    clearFieldErrors();

    const draft = collectDraft();
    if (!draft.name) {
      showFieldError('name', '请填写用例名称');
      showNotice('请填写用例名称', 'error');
      dom.name.focus();
      return;
    }
    if (!draft.url) {
      showFieldError('url', '请填写目标地址');
      showNotice('请填写目标地址', 'error');
      dom.url.focus();
      return;
    }

    setBusy(true, 'save');
    try {
      const created = await request('/api/cases', { method: 'POST', body: draft });
      state.selectedId = created.id;
      await loadCases();
      renderDetail(created);
      showNotice(`用例「${created.name}」已保存，请求区内容保留可直接发送`, 'success');
    } catch (err) {
      if (err.field) showFieldError(err.field, err.message);
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeCase(item) {
    if (state.busy || isBatchRunning()) return;
    const confirmed = window.confirm(`确认删除用例「${item.name}」？删除后无法恢复。`);
    if (!confirmed) return;

    setBusy(true);
    try {
      await request(`/api/cases/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (state.selectedId === item.id) state.selectedId = '';
      await loadCases();
      if (!state.selectedId) renderEmptyDetail();
      showNotice(`用例「${item.name}」已删除`, 'success');
    } catch (err) {
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---------------- 结果区小零件 ----------------

  function buildSection(title) {
    const section = document.createElement('div');
    section.className = 'result-section';
    const head = document.createElement('p');
    head.className = 'result-section-title';
    head.textContent = title;
    section.appendChild(head);
    return section;
  }

  function buildStatusBadge(code, statusText) {
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    if (!code) {
      badge.classList.add('status-bad');
    } else if (code >= 500) {
      badge.classList.add('status-bad');
    } else if (code >= 400) {
      badge.classList.add('status-warn');
    } else if (code >= 300) {
      badge.classList.add('status-info');
    } else {
      badge.classList.add('status-ok');
    }
    badge.textContent = code ? `${code} ${statusText}`.trim() : statusText;
    return badge;
  }

  function buildChip(text, extraClass) {
    const chip = document.createElement('span');
    chip.className = extraClass ? `chip ${extraClass}` : 'chip';
    chip.textContent = text;
    return chip;
  }

  function buildTab(text, active, onClick) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = active ? 'view-tab active' : 'view-tab';
    tab.textContent = text;
    tab.addEventListener('click', onClick);
    return tab;
  }

  function buildHeaderTable(headers) {
    const list = document.createElement('div');
    list.className = 'header-table';
    headers.forEach((row) => {
      const line = document.createElement('div');
      line.className = 'header-line';
      const keyNode = document.createElement('span');
      keyNode.className = 'header-line-key';
      keyNode.textContent = row.key;
      const valueNode = document.createElement('span');
      valueNode.className = 'header-line-value';
      valueNode.textContent = row.value;
      line.append(keyNode, valueNode);
      list.appendChild(line);
    });
    return list;
  }

  // ---------------- 工具函数 ----------------

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '时间未知';
    const pad = (num) => String(num).padStart(2, '0');
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
  }

  function formatDuration(ms) {
    const value = Number(ms) || 0;
    if (value >= 1000) return `${(value / 1000).toFixed(2)} 秒`;
    return `${value} 毫秒`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} 字节`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }

  async function checkHealth() {
    try {
      await request('/api/health');
      dom.health.textContent = '服务已连接';
      dom.health.classList.add('ok');
    } catch (err) {
      dom.health.textContent = '服务未连接';
      dom.health.classList.add('bad');
    }
  }

  // ---------------- 事件绑定与入口 ----------------

  function bindEvents() {
    dom.headerRows.addEventListener('input', (event) => {
      const target = event.target;
      const index = Number(target.dataset ? target.dataset.index : NaN);
      const part = target.dataset ? target.dataset.part : '';
      if (!Number.isInteger(index) || !state.headers[index] || !part) return;
      state.headers[index][part] = target.value;
      const slot = document.querySelector('[data-error="headers"]');
      if (slot) slot.hidden = true;
      dom.headerRows.classList.remove('invalid');
    });

    dom.headerRows.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action="remove-header"]');
      if (!button) return;
      const index = Number(button.dataset.index);
      if (!Number.isInteger(index) || !state.headers[index]) return;
      state.headers.splice(index, 1);
      renderHeaderRows();
    });

    dom.addHeader.addEventListener('click', () => {
      state.headers.push({ key: '', value: '' });
      renderHeaderRows();
      const inputs = dom.headerRows.querySelectorAll('input');
      const last = inputs[inputs.length - 2];
      if (last) last.focus();
    });

    dom.sendRequest.addEventListener('click', sendRequest);
    dom.saveCase.addEventListener('click', saveCase);

    dom.resetDraft.addEventListener('click', () => {
      if (state.busy || isBatchRunning()) return;
      resetDraft(false);
    });

    dom.clearResult.addEventListener('click', () => {
      state.result = null;
      renderEmptyResult();
      showNotice('结果区已清空', 'info');
    });

    dom.refreshCases.addEventListener('click', async () => {
      if (state.busy) return;
      try {
        await loadCases();
        showNotice('用例列表已刷新', 'info');
      } catch (err) {
        showNotice(err.message, 'error');
      }
    });

    dom.closeDetail.addEventListener('click', () => {
      state.selectedId = '';
      renderCases();
      renderEmptyDetail();
    });

    dom.selectAllCases.addEventListener('click', selectAllCases);
    dom.clearSelectCases.addEventListener('click', clearCheckedCases);
    dom.runBatch.addEventListener('click', startBatch);
    dom.stopBatch.addEventListener('click', stopBatch);
  }

  async function init() {
    bindEvents();
    renderHeaderRows();
    renderEmptyDetail();
    renderEmptyResult();
    renderCases();
    await checkHealth();
    await loadDemos();
    try {
      await loadCases();
    } catch (err) {
      showNotice(err.message, 'error');
    }
  }

  init();
})();
