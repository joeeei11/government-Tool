const cloud = require('wx-server-sdk');
const { createService, AiError } = require('./service');
const { generate } = require('./provider');
const { createService: createInsightService, InsightError } = require('./insight_service');
const { generate: generateInsight } = require('./insight_provider');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async event => {
  const openid = cloud.getWXContext().OPENID;
  try {
    const insights = createInsightService(cloud.database(), generateInsight, () => new Date().toISOString(), 'deepseek-flash');
    if (!openid && event && event.Type === 'Timer') return { ok: true, data: await insights.daily() };
    if (!openid) return { ok: false, code: 'FORBIDDEN' };
    const insightActions = {
      insightLatest: () => insights.latest(openid),
      insightRefresh: () => insights.refresh(openid),
      insightAsk: () => insights.ask(openid, event.question),
      insightAdopt: () => insights.adopt(openid, event.id)
    };
    if (Object.prototype.hasOwnProperty.call(insightActions, event.action)) return { ok: true, data: await insightActions[event.action]() };
    const service = createService(cloud.database(), generate, () => new Date().toISOString(), 'deepseek-flash');
    const actions = {
      propose: () => service.propose(openid, event.input),
      cancel: () => service.cancel(openid, event.id),
      confirm: () => service.confirm(openid, event.id, event.suggestions)
    };
    if (!Object.prototype.hasOwnProperty.call(actions, event.action)) throw new AiError('INVALID_ACTION');
    return { ok: true, data: await actions[event.action]() };
  } catch (error) {
    if (error instanceof AiError || error instanceof InsightError) return { ok: false, code: error.code };
    console.error('ai_tasks failed', error && error.message);
    return { ok: false, code: 'INTERNAL_ERROR' };
  }
};
