class TaskError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const TYPES = ['routine', 'special', 'urgent'];
const PRIORITIES = ['low', 'normal', 'high'];
const STATUSES = ['draft', 'in_progress', 'awaiting_confirmation', 'awaiting_handoff', 'completed', 'archived'];
const RULES = ['ordinary', 'important', 'major'];
const ACTIVE_DEADLINES = ['in_progress', 'awaiting_handoff'];

function deadline(task, instant) {
  if (!ACTIVE_DEADLINES.includes(task.status) || !task.dueDate) return null;
  const due = Date.parse(`${task.dueDate}T23:59:59+08:00`);
  if (!Number.isFinite(due)) return null;
  const remaining = due - instant;
  if (remaining < 0) return { state: 'overdue', reason: `已于 ${task.dueDate} 截止` };
  const localToday = new Date(instant + 8 * 3600000).toISOString().slice(0, 10);
  if (task.dueDate === localToday) return { state: 'soon', reason: `今天截止：${task.dueDate}` };
  const ordinaryLimit = new Date(`${localToday}T00:00:00Z`).valueOf() + 3 * 86400000;
  if (task.type === 'urgent' ? remaining <= 24 * 3600000 : Date.parse(`${task.dueDate}T00:00:00Z`) <= ordinaryLimit) return { state: 'soon', reason: `${task.type === 'urgent' ? '紧急任务，截止前 24 小时' : '截止前 3 天'}：${task.dueDate}` };
  return null;
}

function workbox(tasks, openid, instant, confirmed = new Set()) {
  const today = new Date(instant + 8 * 3600000).toISOString().slice(0, 10);
  const mine = tasks.filter(task => task.assigneeId === openid || (task.collaboratorIds || []).includes(openid));
  const withDeadline = mine.map(task => ({ ...task, deadline: deadline(task, instant) }));
  const byDue = (a, b) => a.dueDate.localeCompare(b.dueDate) || a._id.localeCompare(b._id);
  const canConfirm = task => task.confirmationRule === 'major' ? !confirmed.has(task._id) : task.confirmationRule === 'important' ? task.confirmerId === openid : task.assigneeId === openid;
  return {
    today: withDeadline.filter(task => task.deadline && (task.deadline.state === 'overdue' || task.dueDate === today)).sort(byDue),
    soon: withDeadline.filter(task => task.deadline && task.deadline.state === 'soon' && task.dueDate !== today).sort(byDue),
    confirmation: tasks.filter(task => task.status === 'awaiting_confirmation' && canConfirm(task)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
    handoff: tasks.filter(task => task.status === 'awaiting_handoff' && (task.assigneeId === openid || (task.handoffReady && (!task.handoffSuccessorId || task.handoffSuccessorId === openid)))).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
    recent: tasks.filter(task => task.status !== 'draft' && [task.creatorId, task.assigneeId, ...(task.collaboratorIds || [])].includes(openid)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)
  };
}

function missing(error) {
  return error && (error.code === 'DOCUMENT_NOT_FOUND' || error.errCode === -502005);
}

async function read(db, collection, id) {
  try { return (await db.collection(collection).doc(id).get()).data; }
  catch (error) { if (missing(error)) return null; throw error; }
}

function uniqueIds(value) {
  if (!Array.isArray(value) || value.length > 5 || value.some(id => typeof id !== 'string')) throw new TaskError('INVALID_TASK');
  return [...new Set(value)];
}

function validDate(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function normalize(input, existing) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TaskError('INVALID_TASK');
  const task = { ...existing, ...input };
  const title = typeof task.title === 'string' ? task.title.trim() : '';
  const description = typeof task.description === 'string' ? task.description.trim() : '';
  if (!title || title.length > 100 || description.length > 2000) throw new TaskError('INVALID_TASK');
  if (!TYPES.includes(task.type) || !PRIORITIES.includes(task.priority) || !STATUSES.includes(task.status) || !RULES.includes(task.confirmationRule)) throw new TaskError('INVALID_TASK');
  if (!validDate(task.dueDate || '') || typeof task.assigneeId !== 'string' || !task.assigneeId) throw new TaskError('INVALID_TASK');
  const collaboratorIds = uniqueIds(task.collaboratorIds || []);
  const parentId = task.parentId || '';
  if (typeof parentId !== 'string') throw new TaskError('INVALID_TASK');
  const confirmerId = task.confirmationRule === 'important' ? task.confirmerId : '';
  if (task.confirmationRule === 'important' && (typeof confirmerId !== 'string' || !confirmerId)) throw new TaskError('INVALID_TASK');
  return { title, description, type: task.type, priority: task.priority, dueDate: task.dueDate || '', status: task.status, assigneeId: task.assigneeId, collaboratorIds, parentId, confirmationRule: task.confirmationRule, confirmerId };
}

function createService(db, now) {
  async function member(openid) {
    const state = await read(db, 'office_state', 'main');
    if (!state || !Array.isArray(state.memberIds) || !state.memberIds.includes(openid)) throw new TaskError('FORBIDDEN');
    const person = await read(db, 'members', openid);
    if (!person || person.status !== 'approved') throw new TaskError('FORBIDDEN');
    return { person, memberIds: state.memberIds };
  }

  function checkPeople(task, memberIds) {
    const ids = [task.assigneeId, ...task.collaboratorIds];
    if (task.confirmerId) ids.push(task.confirmerId);
    if (ids.some(id => !memberIds.includes(id))) throw new TaskError('INVALID_MEMBER');
  }

  async function allTasks() {
    const result = [];
    for (let offset = 0; ; offset += 100) {
      const batch = (await db.collection('tasks').skip(offset).limit(100).get()).data;
      result.push(...batch);
      if (batch.length < 100) break;
    }
    return result;
  }

  async function list(openid) {
    await member(openid);
    const tasks = await allTasks();
    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function listWorkbox(openid) {
    await member(openid);
    const tasks = await allTasks();
    const confirmations = [];
    for (let offset = 0; ; offset += 100) {
      const batch = (await db.collection('office_state').where({ kind: 'task_confirmation', memberId: openid }).skip(offset).limit(100).get()).data;
      confirmations.push(...batch);
      if (batch.length < 100) break;
    }
    return workbox(tasks, openid, Date.parse(now()), new Set(confirmations.map(item => item.taskId)));
  }

  async function get(openid, id) {
    await member(openid);
    if (typeof id !== 'string' || !id) throw new TaskError('NOT_FOUND');
    const task = await read(db, 'tasks', id);
    if (!task) throw new TaskError('NOT_FOUND');
    return task;
  }

  async function parentDepth(parentId, selfId) {
    if (!parentId) return 1;
    const visited = new Set(selfId ? [selfId] : []);
    let depth = 1;
    let current = parentId;
    while (current) {
      if (visited.has(current)) throw new TaskError('INVALID_PARENT');
      visited.add(current);
      const parent = await read(db, 'tasks', current);
      if (!parent) throw new TaskError('INVALID_PARENT');
      depth += 1;
      if (depth > 3) throw new TaskError('DEPTH_LIMIT');
      current = parent.parentId;
    }
    return depth;
  }

  async function create(openid, input) {
    const { memberIds } = await member(openid);
    const task = normalize({ type: 'routine', priority: 'normal', dueDate: '', description: '', collaboratorIds: [], parentId: '', confirmationRule: 'ordinary', ...input, status: input && input.status === 'draft' ? 'draft' : 'in_progress' });
    checkPeople(task, memberIds);
    const depth = await parentDepth(task.parentId);
    const timestamp = now();
    const result = await db.collection('tasks').add({ data: { ...task, creatorId: openid, depth, createdAt: timestamp, updatedAt: timestamp } });
    return { id: result._id };
  }

  async function update(openid, id, input) {
    const { person, memberIds } = await member(openid);
    const old = await read(db, 'tasks', id);
    if (!old) throw new TaskError('NOT_FOUND');
    if (old.status === 'awaiting_handoff') throw new TaskError('INVALID_STATE');
    if (old.depth === 1 && old.creatorId !== openid && person.role !== 'admin') throw new TaskError('FORBIDDEN');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TaskError('INVALID_TASK');
    const allowed = ['title', 'description', 'assigneeId', 'collaboratorIds', 'type', 'priority', 'dueDate', 'confirmationRule', 'confirmerId'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new TaskError('INVALID_TASK');
    if ((Object.prototype.hasOwnProperty.call(input, 'confirmationRule') || Object.prototype.hasOwnProperty.call(input, 'confirmerId')) && old.creatorId !== openid && person.role !== 'admin') throw new TaskError('FORBIDDEN');
    const task = normalize(input, old);
    checkPeople(task, memberIds);
    await db.runTransaction(async transaction => {
      const current = await read(transaction, 'tasks', id);
      if (!current || current.status === 'awaiting_handoff' || current.updatedAt !== old.updatedAt) throw new TaskError('INVALID_STATE');
      await transaction.collection('tasks').doc(id).update({ data: { ...task, updatedAt: now() } });
    });
    return { id };
  }

  async function deleteDraft(openid, id) {
    const { person } = await member(openid);
    const task = await read(db, 'tasks', id);
    if (!task) throw new TaskError('NOT_FOUND');
    if (task.status !== 'draft' || (task.creatorId !== openid && person.role !== 'admin')) throw new TaskError('INVALID_STATE');
    const timestamp = now();
    await db.runTransaction(async transaction => {
      const current = await read(transaction, 'tasks', id);
      if (!current || current.status !== 'draft') throw new TaskError('INVALID_STATE');
      await transaction.collection('tasks').doc(id).remove();
      await transaction.collection('office_state').add({ data: { kind: 'task_event', taskId: id, action: 'draft_deleted', actorId: openid, createdAt: timestamp } });
    });
    return { id };
  }

  return { list, listWorkbox, get, create, update, deleteDraft };
}

module.exports = { createService, TaskError, deadline, workbox };
