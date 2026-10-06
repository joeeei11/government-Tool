# 政务协作小程序

面向五人办公室的微信小程序。当前版本提供成员工作区、任务创建、AI 拆解预览和任务执行记录。

## 当前能力

- 用户通过微信登录后提交加入申请；管理员可批准或拒绝。
- 已批准成员可查看办公室成员；管理员可查看待审核申请。
- 云函数根据微信身份校验权限，并将成员、申请和办公室成员名单存入云数据库。
- 办公室最多五名成员；成员可创建三级任务、筛选任务并查看工作箱。
- 成员可对前两级任务生成 AI 拆解建议，编辑或取消预览；确认后才创建子任务。
- 任务参与人可添加执行记录、上传图片或文档；负责人可更新执行状态，子任务完成数汇总为上级进度。
- 负责人可发起任务交接并填写进度、已完成和未完成工作、下一步及风险；接任人确认后任务才恢复执行。

管理员登录和工作区、云数据库客户端访问限制已在开发环境验证。使用第二个微信账号完成申请、拒绝、重申与批准的完整流程尚待验证。

## 运行与部署

1. 使用微信开发者工具导入项目根目录。在 `project.config.json` 配置自己的小程序 AppID，并在 `miniprogram/app.js` 配置对应的云环境 ID。
2. 在该云环境创建 `members`、`join_requests`、`office_state` 和 `tasks` 集合。将四个集合的客户端权限均设为“所有用户不可读写”；自定义安全规则可使用 `{"read": false, "write": false}`。AI 调用记录使用受保护的 `office_state` 集合中的独立文档，不能开放此集合的客户端访问。
3. 部署 `cloudfunctions/office`、`cloudfunctions/tasks`、`cloudfunctions/ai_tasks` 和 `cloudfunctions/execution` 云函数，并安装各自的 npm 依赖。
4. 以预定管理员微信账号调用 `office` 云函数的 `identity` 操作，取得当前小程序的 OpenID。在 `office_state` 集合创建 ID 为 `main` 的文档，字段为 `adminOpenId`（该 OpenID）和 `memberIds`（空数组）。管理员首次调用 `session` 时会加入成员名单。
5. 在 `ai_tasks` 云函数环境设置 `AI_API_KEY`。代码使用 DeepSeek 的 `https://api.deepseek.com/chat/completions` 和 `deepseek-flash`。将云函数超时设置为至少 30 秒，然后重新部署该函数。密钥不得放入小程序源码或仓库。
6. 将 `execution` 云函数超时设置为至少 60 秒。在云开发控制台将云存储安全规则设为 [cloudstorage.rules.json](cloudstorage.rules.json) 中的拒绝客户端读写规则。任务文件由 `execution` 云函数写入；客户端只能在云函数核验任务参与关系后取得 60 秒有效的临时下载链接。启用附件功能前务必完成这一步。
7. 在小程序中登录并使用成员加入流程。

部署配置中的 OpenID 必须来自该小程序的 `identity` 操作。请勿把管理员身份记录或本机配置提交到仓库。

## 测试

安装 Node.js 后，在项目根目录运行：

```bash
node --test cloudfunctions/office/service.test.js cloudfunctions/tasks/service.test.js cloudfunctions/ai_tasks/service.test.js cloudfunctions/execution/service.test.js
```

测试覆盖成员和任务权限、三级限制、AI 建议取消与确认、执行记录权限、子任务进度、附件上限及交接状态保护。
