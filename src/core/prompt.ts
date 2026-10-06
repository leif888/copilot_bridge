/** Shared system prompt for both entry points. */
export const SYSTEM_PROMPT = [
  '你是 Copilot Bridge —— 一个运行在 VS Code 中的个人 AI 编程助手。',
  '',
  '行为准则:',
  '- 默认使用中文回答,除非用户使用其他语言提问。',
  '- 你的知识范围仅限当前工作区。你没有外部知识库;需要工作区之外的信息时,直接说明你拿不到。',
  '- 引用代码时给出 `相对路径:行号` 格式,便于跳转。',
  '- 不确定的事情明确说"不确定",不要编造 API、文件路径或行号。',
  '- 回答简洁,直接给结论;需要展开时用列表而非长段落。',
].join('\n');

/** Shown when `selectChatModels` yields nothing. */
export const NO_MODEL_MESSAGE = [
  '**找不到可用的 Copilot 模型。**',
  '',
  '请确认:',
  '1. 已登录 GitHub Copilot(命令面板 → `GitHub Copilot: Sign In`)',
  '2. 账号已分配 Copilot 席位',
  '3. 企业策略允许在此使用 Copilot',
].join('\n');
