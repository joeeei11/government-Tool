const cloud = require('wx-server-sdk');
const { createService, ReminderError, messageData } = require('./service');

const TEMPLATE_ID = 'TEPXD-2VtXr3RH0aZ__jbXsMj4b6rGiXsK2aQj4tLeE';
const TEMPLATE_FIELDS = { thing3: 'title', date6: 'due', thing24: 'state' };

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function fields() {
  if (!process.env.REMINDER_TEMPLATE_FIELDS) return TEMPLATE_FIELDS;
  try {
    const value = JSON.parse(process.env.REMINDER_TEMPLATE_FIELDS || 'null');
    if (value && Object.keys(value).length && Object.values(value).every(item => ['title', 'due', 'state'].includes(item))) return value;
  } catch (_) { /* Invalid configuration disables notifications. */ }
  return null;
}

exports.main = async event => {
  const openid = cloud.getWXContext().OPENID;
  const service = createService(cloud.database(), async ({ openid: recipient, task, kind, templateId, fields: mapping }) => {
    const data = messageData(task, kind, mapping);
    try {
      await cloud.openapi.subscribeMessage.send({ touser: recipient, templateId, page: 'pages/index/index', data });
    } catch (error) {
      console.error('reminder subscription send failed', error);
      throw error;
    }
  }, () => new Date().toISOString(), { templateId: process.env.REMINDER_TEMPLATE_ID || TEMPLATE_ID, fields: fields() });
  try {
    if (!openid && event && event.Type === 'Timer') return { ok: true, data: await service.run() };
    if (!openid) throw new ReminderError('FORBIDDEN');
    if (event.action === 'config') return { ok: true, data: service.configuration() };
    if (event.action === 'subscribe') return { ok: true, data: await service.subscribe(openid, event.taskId, event.kind) };
    if (event.action === 'status') return { ok: true, data: await service.subscriptionStatus(openid, event.taskId) };
    throw new ReminderError('INVALID_ACTION');
  } catch (error) {
    if (error instanceof ReminderError) return { ok: false, code: error.code };
    console.error('reminders function failed', error);
    return { ok: false, code: 'INTERNAL_ERROR' };
  }
};
