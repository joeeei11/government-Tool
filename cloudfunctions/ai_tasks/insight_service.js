class InsightError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function read(db, collection, id) {
  try { return (await db.collection(collection).doc(id).get()).data; }
  catch (error) { if (error.code === 'DOCUMENT_NOT_FOUND' || error.errCode === -502005) return null; throw error; }
}

async function all(db, collection, query) {
  const result = [];
  for (let offset = 0; ; offset += 100) {
    let ref = db.collection(collection);
    if (query) ref = ref.where(query);
    const batch = (await ref.skip(offset).limit(100).get()).data;
    result.push(...batch);
    if (batch.length < 100) return result;
  }
}

function visible(task, memberId, role, handoffs) {
  return role === 'admin' || [task.creatorId, task.assigneeId, task.confirmerId, ...(task.collaboratorIds || [])].includes(memberId) ||
    handoffs.some(item => item.taskId === task._id && (item.fromId === memberId || item.successorId === memberId || item.acceptedBy === memberId));
}

function scrub(value, identities) {
  let text = String(value || '');
  for (const identity of identities.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(identity).join('[成员]');
  return text.replace(/\b1[3-9]\d{9}\b/g, '[手机号]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[邮箱]')
    .replace(/\b(?:sk-|AKID|AKIA)[A-Za-z0-9_-]{12,}\b/g, '[密钥]')
    .replace(/(?:password|secret|token|api[_-]?key|密码|密钥)\s*[:=：]\s*[^\s,，;；]+/gi, '[敏感配置]')
    .slice(0, 2000);
}

function risk(task, children, records, handoffs, now) {
  if (!['in_progress', 'awaiting_handoff'].includes(task.status)) return null;
  const evidence = [];
  const due = /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate || '') ? Date.parse(`${task.dueDate}T23:59:59+08:00`) : NaN;
  const days = Number.isFinite(due) ? Math.ceil((due - Date.parse(now)) / 86400000) : Infinity;
  if (Number.isFinite(due) && due < Date.parse(now)) evidence.push(`已逾期 ${Math.max(1, Math.ceil((Date.parse(now) - due) / 86400000))} 天`);
  else if (days <= 3) evidence.push(`距离截止 ${days} 天`);
  const last = records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const staleDays = Math.floor((Date.parse(now) - Date.parse(last ? last.createdAt : task.createdAt || now)) / 86400000);
  if (staleDays >= 3) evidence.push(`${staleDays} 天无执行更新`);
  const blocked = children.filter(child => !['completed', 'archived', 'awaiting_confirmation'].includes(child.status));
  if (blocked.length && days <= 3) evidence.push(`${blocked.length} 个子任务尚未完成`);
  if (task.status === 'awaiting_handoff' || handoffs.some(item => item.status === 'submitted')) evidence.push('交接尚未完成');
  if (!evidence.length) return null;
  const overdue = Number.isFinite(due) && due < Date.parse(now);
  const level = overdue || (days <= 1 && (blocked.length || staleDays >= 3)) ? 'high' : days <= 3 || staleDays >= 7 ? 'medium' : 'low';
  return { taskId: task._id, title: task.title, level, reason: overdue ? '任务已逾期' : task.status === 'awaiting_handoff' ? '交接尚未完成' : '进度可能偏离计划', impact: overdue ? '已影响计划完成时间' : days <= 3 ? '可能影响按期完成' : '进展信息可能不完整', action: task.status === 'awaiting_handoff' ? '跟进交接确认' : '核实进度并补充执行记录', evidence, evidenceText: evidence.join('；') };
}

function createService(db, generate, now, model) {
  async function members() {
    const state = await read(db, 'office_state', 'main');
    const people = [];
    for (const id of state && Array.isArray(state.memberIds) ? state.memberIds : []) {
      const person = await read(db, 'members', id);
      if (person && person.status === 'approved') people.push({ id, name: person.name, role: person.role });
    }
    return people;
  }

  async function context(openid) {
    const people = await members();
    const member = people.find(item => item.id === openid);
    if (!member) throw new InsightError('FORBIDDEN');
    const [tasks, state] = await Promise.all([all(db, 'tasks'), all(db, 'office_state')]);
    const handoffs = state.filter(item => item.kind === 'task_handoff');
    const permitted = tasks.filter(task => visible(task, openid, member.role, handoffs));
    const ids = new Set(permitted.map(task => task._id));
    return { tasks: permitted, state: state.filter(item => ids.has(item.taskId)), people, requesterId: openid };
  }

  function facts({ tasks, state, people, requesterId }) {
    const identities = people.flatMap(item => [item.name, item.id]);
    const today = new Date(Date.parse(now()) + 8 * 3600000).toISOString().slice(0, 10);
    const references = tasks.map((task, index) => ({ ref: `T${index + 1}`, id: task._id }));
    const payload = tasks.map((task, index) => {
      const entries = state.filter(item => item.taskId === task._id);
      const children = tasks.filter(item => item.parentId === task._id);
      const records = entries.filter(item => item.kind === 'execution_record');
      const handoffs = entries.filter(item => item.kind === 'task_handoff');
      const history = entries.filter(item => item.kind === 'execution_event' || item.kind === 'task_event');
      const done = children.filter(item => ['awaiting_confirmation', 'completed', 'archived'].includes(item.status)).length;
      const progress = children.length ? Math.round(done * 100 / children.length) : ['awaiting_confirmation', 'completed', 'archived'].includes(task.status) ? 100 : 0;
      return { ref: `T${index + 1}`, title: scrub(task.title, identities), description: scrub(task.description, identities), status: task.status, dueDate: task.dueDate || '', progress, assignedToRequester: task.assigneeId === requesterId, createdByRequester: task.creatorId === requesterId,
        records: records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3).map(item => ({ date: item.createdAt.slice(0, 10), text: scrub(item.text, identities) })),
        handoffs: handoffs.slice(-2).map(item => ({ status: item.status, progress: scrub(item.currentProgress, identities), unfinished: scrub(item.unfinishedWork, identities), nextAction: scrub(item.nextAction, identities), risks: scrub(item.risks, identities) })),
        changes: history.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3).map(item => ({ date: item.createdAt.slice(0, 10), action: item.action })),
        risk: risk(task, children, records, handoffs, now()) };
    });
    return { today, references, payload, risks: payload.filter(item => item.risk).map(item => ({ ...item.risk, title: tasks.find(task => task._id === item.risk.taskId).title })) };
  }

  async function call(openid, kind, question, source) {
    const { today, references, payload, risks } = facts(source);
    const identities = source.people.flatMap(item => [item.name, item.id]);
    const request = { kind, today, question: scrub(question, identities), tasks: payload.map(({ risk: taskRisk, ...item }) => ({ ...item, risk: taskRisk && { level: taskRisk.level, evidence: taskRisk.evidence } })) };
    const result = await db.collection('office_state').add({ data: { kind: 'ai_insight_call', userId: openid, model, request, response: '', taskIds: references.map(item => item.id), adopted: false, status: 'generating', createdAt: now() } });
    try {
      const response = scrub(await generate(request), identities);
      await db.collection('office_state').doc(result._id).update({ data: { response, status: 'ready', updatedAt: now() } });
      return { id: result._id, summary: response, risks, tasks: payload.map(item => ({ ref: item.ref, taskId: references.find(ref => ref.ref === item.ref).id, title: source.tasks.find(task => task._id === references.find(ref => ref.ref === item.ref).id).title, status: item.status, dueDate: item.dueDate, progress: item.progress })), createdAt: now() };
    } catch (error) {
      await db.collection('office_state').doc(result._id).update({ data: { status: 'failed', errorCode: error.message || 'AI_SERVICE_ERROR', updatedAt: now() } });
      throw new InsightError(error.message === 'AI_NOT_CONFIGURED' ? 'AI_NOT_CONFIGURED' : 'AI_SERVICE_ERROR');
    }
  }

  async function refresh(openid) { return call(openid, 'progress', '', await context(openid)); }
  async function ask(openid, question) {
    if (typeof question !== 'string' || !question.trim() || question.length > 300) throw new InsightError('INVALID_QUESTION');
    return call(openid, 'query', question.trim(), await context(openid));
  }
  async function latest(openid) {
    const source = await context(openid);
    const log = (await all(db, 'office_state', { kind: 'ai_insight_call', userId: openid })).filter(item => item.status === 'ready' && item.request.kind === 'progress').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!log) return null;
    const allowed = new Set(source.tasks.map(task => task._id));
    if (!(log.taskIds || []).every(id => allowed.has(id))) return null;
    const current = facts(source);
    return { id: log._id, summary: log.response, risks: current.risks, createdAt: log.createdAt, adopted: log.adopted };
  }
  async function adopt(openid, id) {
    const source = await context(openid);
    const log = await read(db, 'office_state', id);
    if (!log || log.kind !== 'ai_insight_call' || log.userId !== openid || log.status !== 'ready') throw new InsightError('NOT_FOUND');
    const allowed = new Set(source.tasks.map(task => task._id));
    if (!(log.taskIds || []).every(taskId => allowed.has(taskId))) throw new InsightError('NOT_FOUND');
    await db.collection('office_state').doc(id).update({ data: { adopted: true, adoptedAt: now() } });
    return { id };
  }
  async function daily() {
    const day = new Date(Date.parse(now()) + 8 * 3600000).toISOString().slice(0, 10);
    const outcomes = await Promise.all((await members()).map(async person => {
      const existing = (await all(db, 'office_state', { kind: 'ai_insight_call', userId: person.id })).some(item => item.request && item.request.kind === 'progress' && item.day === day && item.status === 'ready');
      if (existing) return 'skipped';
      try {
        const result = await refresh(person.id);
        await db.collection('office_state').doc(result.id).update({ data: { day } });
        return 'generated';
      } catch (_) { return 'failed'; }
    }));
    return { generated: outcomes.filter(item => item === 'generated').length, failed: outcomes.filter(item => item === 'failed').length };
  }
  return { latest, refresh, ask, adopt, daily };
}

module.exports = { createService, InsightError, visible, scrub, risk };
