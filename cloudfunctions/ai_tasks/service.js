class AiError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// office_state is already server-only; keep AI request content behind its verified rules.
const AI_COLLECTION = 'office_state';

async function read(db, collection, id) {
  try { return (await db.collection(collection).doc(id).get()).data; }
  catch (error) {
    if (error.code === 'DOCUMENT_NOT_FOUND' || error.errCode === -502005) return null;
    throw error;
  }
}

function dateValid(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function suggestions(value, memberIds) {
  if (!Array.isArray(value) || value.length > 8) throw new AiError('INVALID_SUGGESTIONS');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AiError('INVALID_SUGGESTIONS');
    const text = (field, limit) => {
      if (item[field] === undefined || item[field] === null) return '';
      if (typeof item[field] !== 'string' || item[field].trim().length > limit) throw new AiError('INVALID_SUGGESTIONS');
      return item[field].trim();
    };
    const title = text('title', 100);
    const assigneeId = text('assigneeId', 100);
    const dueDate = text('dueDate', 10);
    if (!title || !memberIds.includes(assigneeId) || !dateValid(dueDate)) throw new AiError('INVALID_SUGGESTIONS');
    return { title, description: text('description', 2000), assigneeId, dueDate, orderNote: text('orderNote', 300), risk: text('risk', 300), order: index + 1 };
  });
}

function createService(db, generate, now, model) {
  async function context(openid, taskId) {
    const state = await read(db, 'office_state', 'main');
    const person = await read(db, 'members', openid);
    if (!state || !state.memberIds || !state.memberIds.includes(openid) || !person || person.status !== 'approved') throw new AiError('FORBIDDEN');
    const task = await read(db, 'tasks', taskId);
    if (!task) throw new AiError('NOT_FOUND');
    if (task.depth >= 3) throw new AiError('DEPTH_LIMIT');
    const members = [];
    for (const id of state.memberIds) {
      const member = await read(db, 'members', id);
      if (member && member.status === 'approved') members.push({ id, name: member.name });
    }
    return { task, members, memberIds: members.map(member => member.id) };
  }

  async function record(openid, id) {
    const state = await read(db, 'office_state', 'main');
    const person = await read(db, 'members', openid);
    if (!state || !state.memberIds || !state.memberIds.includes(openid) || !person || person.status !== 'approved') throw new AiError('FORBIDDEN');
    const draft = await read(db, AI_COLLECTION, id);
    if (!draft || draft.userId !== openid) throw new AiError('NOT_FOUND');
    return draft;
  }

  async function propose(openid, input) {
    if (!input || typeof input.taskId !== 'string' || !input.taskId) throw new AiError('INVALID_REQUEST');
    const { task, members, memberIds } = await context(openid, input.taskId);
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    const attachmentText = typeof input.attachmentText === 'string' ? input.attachmentText.trim() : '';
    if (description.length > 2000 || attachmentText.length > 10000) throw new AiError('INVALID_REQUEST');
    const request = { title: task.title, description: description || task.description || '', deadline: task.dueDate || '', participants: members.filter(member => [task.assigneeId, ...(task.collaboratorIds || [])].includes(member.id)), availableMembers: members, attachmentText };
    const log = { userId: openid, taskId: task._id, model, request, response: '', status: 'generating', adopted: false, createdAt: now(), updatedAt: now() };
    const { _id: id } = await db.collection(AI_COLLECTION).add({ data: { ...log, kind: 'ai_task_decomposition' } });
    try {
      const response = await generate(request);
      await db.collection(AI_COLLECTION).doc(id).update({ data: { response: JSON.stringify(response), updatedAt: now() } });
      const items = suggestions(response.subtasks, memberIds);
      if (!items.length) throw new AiError('EMPTY_SUGGESTIONS');
      await db.collection(AI_COLLECTION).doc(id).update({ data: { normalizedSuggestions: items, status: 'preview', updatedAt: now() } });
      return { id, suggestions: items };
    } catch (error) {
      await db.collection(AI_COLLECTION).doc(id).update({ data: { status: 'failed', errorCode: error.code || error.message || 'AI_SERVICE_ERROR', updatedAt: now() } });
      if (error instanceof AiError) throw error;
      throw new AiError(error.message === 'AI_NOT_CONFIGURED' ? 'AI_NOT_CONFIGURED' : 'AI_SERVICE_ERROR');
    }
  }

  async function cancel(openid, id) {
    const draft = await record(openid, id);
    if (draft.status !== 'preview') throw new AiError('INVALID_STATE');
    return db.runTransaction(async transaction => {
      const current = (await transaction.collection(AI_COLLECTION).doc(id).get()).data;
      if (current.status !== 'preview') throw new AiError('INVALID_STATE');
      await transaction.collection(AI_COLLECTION).doc(id).update({ data: { status: 'cancelled', updatedAt: now() } });
      return { id };
    });
  }

  async function confirm(openid, id, edited) {
    const draft = await record(openid, id);
    if (draft.status !== 'preview') throw new AiError('INVALID_STATE');
    const { task, memberIds } = await context(openid, draft.taskId);
    const items = suggestions(edited, memberIds);
    if (!items.length) throw new AiError('INVALID_SUGGESTIONS');
    const timestamp = now();
    return db.runTransaction(async transaction => {
      const current = (await transaction.collection(AI_COLLECTION).doc(id).get()).data;
      if (current.status !== 'preview') throw new AiError('INVALID_STATE');
      const ids = [];
      for (const item of items) {
        const result = await transaction.collection('tasks').add({ data: {
          title: item.title, description: item.description, assigneeId: item.assigneeId, dueDate: item.dueDate,
          collaboratorIds: [], type: task.type, priority: task.priority, status: 'in_progress', parentId: task._id,
          confirmationRule: task.confirmationRule, confirmerId: task.confirmationRule === 'important' ? task.confirmerId : '',
          creatorId: openid, depth: task.depth + 1, aiRequestId: id, executionOrder: item.order, orderNote: item.orderNote, risk: item.risk,
          createdAt: timestamp, updatedAt: timestamp
        } });
        ids.push(result._id);
      }
      await transaction.collection(AI_COLLECTION).doc(id).update({ data: { status: 'adopted', adopted: true, adoptedSuggestions: items, createdTaskIds: ids, updatedAt: timestamp } });
      return { ids };
    });
  }

  return { propose, cancel, confirm };
}

module.exports = { createService, AiError };
