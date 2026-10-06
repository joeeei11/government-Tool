class ReminderError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function read(db, collection, id) {
  try { return (await db.collection(collection).doc(id).get()).data; }
  catch (error) {
    if (error.code === 'DOCUMENT_NOT_FOUND' || error.errCode === -502005 || /not found|does not exist/i.test(error.message || '')) return null;
    throw error;
  }
}

async function all(db, collection) {
  const items = [];
  for (let offset = 0; ; offset += 100) {
    const batch = (await db.collection(collection).skip(offset).limit(100).get()).data;
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

function eventState(task, instant) {
  if (!['in_progress', 'awaiting_handoff'].includes(task.status) || !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate || '')) return '';
  const remaining = Date.parse(`${task.dueDate}T23:59:59+08:00`) - instant;
  if (remaining < 0) return 'overdue';
  const localToday = new Date(instant + 8 * 3600000).toISOString().slice(0, 10);
  const ordinaryLimit = Date.parse(`${localToday}T00:00:00Z`) + 3 * 86400000;
  return (task.type === 'urgent' ? remaining <= 24 * 3600000 : Date.parse(`${task.dueDate}T00:00:00Z`) <= ordinaryLimit) ? 'soon' : '';
}

function reminderId(task, openid, kind) {
  return `reminder_${task._id}_${task.dueDate}_${openid}_${kind}`;
}

function messageData(task, kind, fields) {
  const values = { title: task.title.slice(0, 20), due: task.dueDate, state: kind === 'soon' ? '即将截止，请及时处理' : '已经逾期，请尽快处理' };
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value: values[value] }]));
}

function createService(db, send, now, config) {
  async function member(openid) {
    const office = await read(db, 'office_state', 'main');
    if (!office || !Array.isArray(office.memberIds) || !office.memberIds.includes(openid)) throw new ReminderError('FORBIDDEN');
    const person = await read(db, 'members', openid);
    if (!person || person.status !== 'approved') throw new ReminderError('FORBIDDEN');
  }

  function configuration() {
    return { available: !!(config.templateId && config.fields), templateId: config.templateId || '' };
  }

  async function subscribe(openid, taskId, kind) {
    await member(openid);
    if (!configuration().available) throw new ReminderError('NOT_CONFIGURED');
    if (!['soon', 'overdue'].includes(kind)) throw new ReminderError('INVALID_EVENT');
    const task = await read(db, 'tasks', taskId);
    if (!task || !task.dueDate || !['in_progress', 'awaiting_handoff'].includes(task.status)) throw new ReminderError('NOT_FOUND');
    if (task.assigneeId !== openid && !(task.collaboratorIds || []).includes(openid)) throw new ReminderError('FORBIDDEN');
    const current = eventState(task, Date.parse(now()));
    if (kind === 'soon' && current === 'overdue') throw new ReminderError('INVALID_EVENT');
    if (kind === 'overdue' && current === 'overdue') throw new ReminderError('INVALID_EVENT');
    const id = reminderId(task, openid, kind);
    if (await read(db, 'office_state', id)) throw new ReminderError('ALREADY_SUBSCRIBED');
    await db.collection('office_state').doc(id).set({ data: { kind: 'reminder_subscription', taskId, memberId: openid, dueDate: task.dueDate, event: kind, status: 'pending', createdAt: now() } });
    return { taskId, kind };
  }

  async function subscriptionStatus(openid, taskId) {
    await member(openid);
    const task = await read(db, 'tasks', taskId);
    if (!task) throw new ReminderError('NOT_FOUND');
    if (task.assigneeId !== openid && !(task.collaboratorIds || []).includes(openid)) throw new ReminderError('FORBIDDEN');
    const result = {};
    for (const kind of ['soon', 'overdue']) result[kind] = !!(task.dueDate && await read(db, 'office_state', reminderId(task, openid, kind)));
    return result;
  }

  async function run() {
    const tasks = await all(db, 'tasks');
    const office = await read(db, 'office_state', 'main');
    const memberIds = new Set(office && office.memberIds || []);
    let sent = 0;
    let failed = 0;
    let approaching = 0;
    let overdue = 0;
    for (const task of tasks) {
      const state = eventState(task, Date.parse(now()));
      if (!state) continue;
      if (state === 'soon') approaching += 1;
      else overdue += 1;
      if (!configuration().available) continue;
      const recipients = [...new Set([task.assigneeId, ...(task.collaboratorIds || [])])];
      for (const openid of recipients) {
        if (!memberIds.has(openid)) continue;
        const person = await read(db, 'members', openid);
        if (!person || person.status !== 'approved') continue;
        const kind = state;
        const id = reminderId(task, openid, kind);
        const subscription = await read(db, 'office_state', id);
        if (!subscription || subscription.status !== 'pending' || subscription.event !== kind || subscription.memberId !== openid || subscription.taskId !== task._id || subscription.dueDate !== task.dueDate) continue;
        const claimed = await db.runTransaction(async transaction => {
          const current = await read(transaction, 'office_state', id);
          const latest = await read(transaction, 'tasks', task._id);
          if (!current || current.status !== 'pending' || !latest || latest.dueDate !== task.dueDate || eventState(latest, Date.parse(now())) !== kind) return false;
          await transaction.collection('office_state').doc(id).update({ data: { status: 'sending', attemptedAt: now() } });
          return true;
        });
        if (!claimed) continue;
        try {
          await send({ openid, task, kind, templateId: config.templateId, fields: config.fields });
          await db.collection('office_state').doc(id).update({ data: { status: 'sent', sentAt: now() } });
          sent += 1;
        } catch (error) {
          await db.collection('office_state').doc(id).update({ data: { status: 'failed', failedAt: now(), errorCode: String(error.errCode || error.code || 'SEND_FAILED') } });
          failed += 1;
        }
      }
    }
    return { checked: tasks.length, approaching, overdue, sent, failed, notificationsAvailable: configuration().available };
  }

  return { configuration, subscribe, subscriptionStatus, run };
}

module.exports = { createService, ReminderError, eventState, reminderId, messageData };
