// @ts-check
// prompt.js 纯函数单测：
//  - buildMessages({transcript}) 的消息结构与纯对象性；
//  - renderTranscript / buildSystemPrompt 的裁剪与约束（提示词里写死的上限必须真的被实现）；
//  - parseSuggestion(raw)：合法 JSON、```json 围栏、前后多余文字、1 条/3 条 option、
//    两条同 stance、needed / reason 缺失、超长 label / nextPrompt、空字符串、缺字段——
//    **非法一律 null，绝不截断**。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMessages,
  buildSystemPrompt,
  concreteTokens,
  ghostAgreesWithLabel,
  isGenericLabel,
  LABEL_MAX,
  LABEL_MIN,
  NEXT_PROMPT_MAX,
  parseSuggestion,
  QUESTION_MAX,
  REASON_MAX,
  renderTranscript,
  SUMMARY_MAX,
} from "../lib/prompt.js";

/** 一个合法的模型输出对象。 */
function validPayload() {
  return {
    needed: true,
    reason: "卡片已经接进 turnTail，但还没有回归测试。",
    summary: "已在 docs/runtime 里记录了 turnTail 槽位，还没写冒烟。",
    question: "下一步先补测试还是先把卡片接进去？",
    options: [
      { stance: "verify", label: "补 next-step 冒烟" },
      { stance: "proceed", label: "接 turnTail 卡片" },
    ],
    // 幽灵提示与推荐项（options[0]）共享具体对象 next-step，符合一致性校验。
    nextPrompt: "先给 next-step 补 web 冒烟和桌面回归",
  };
}

/**
 * 断言解析结果非 null 并收窄类型。
 * @param {unknown} result
 * @param {string} label
 * @returns {{ needed: boolean, reason: string, summary: string, question: string, options: { stance: string, label: string }[], nextPrompt?: string }}
 */
function expectSuggestion(result, label) {
  assert.notEqual(result, null, `${label} 期望解析成功（非 null），实际=null`);
  return /** @type {any} */ (result);
}

// ---------------------------------------------------------------------------
// 1. buildMessages
// ---------------------------------------------------------------------------

test("buildMessages：返回单条 user 消息，content 是纯对象文本块", () => {
  const messages = buildMessages({ transcript: "用户：你好\n\n助手：你好，有什么可以帮你？" });
  assert.equal(Array.isArray(messages), true, `期望返回数组，实际=${typeof messages}`);
  assert.equal(messages.length, 1, `期望恰好 1 条消息，实际=${messages.length}`);
  const message = messages[0];
  assert.equal(message.role, "user", `期望 role="user"，实际=${JSON.stringify(message.role)}`);
  assert.equal(
    Array.isArray(message.content),
    true,
    `期望 content 是数组，实际=${JSON.stringify(message.content)}`,
  );
  assert.equal(message.content.length, 1, `期望 1 个内容块，实际=${message.content.length}`);
  const block = message.content[0];
  assert.equal(block.type, "text", `期望块类型="text"，实际=${JSON.stringify(block.type)}`);
  assert.equal(typeof block.text, "string", `期望块 text 是字符串，实际=${typeof block.text}`);
});

test("buildMessages：纯对象（不引入宿主 Message 实例 / 不依赖原型链）", () => {
  const messages = buildMessages({ transcript: "用户：hi" });
  const message = messages[0];
  assert.equal(
    Object.getPrototypeOf(message),
    Object.prototype,
    `期望消息是普通对象，实际原型=${Object.getPrototypeOf(message)?.constructor?.name}`,
  );
  assert.equal(
    Object.getPrototypeOf(message.content[0]),
    Object.prototype,
    `期望内容块是普通对象，实际原型=${Object.getPrototypeOf(message.content[0])?.constructor?.name}`,
  );
  // 只允许 role/content 两个键：塞进别的字段会被宿主 Message 校验拒绝
  assert.deepEqual(
    Object.keys(message).sort(),
    ["content", "role"],
    `期望键集合=["content","role"]，实际=${JSON.stringify(Object.keys(message).sort())}`,
  );
  assert.deepEqual(
    Object.keys(message.content[0]).sort(),
    ["text", "type"],
    `期望内容块键集合=["text","type"]，实际=${JSON.stringify(Object.keys(message.content[0]).sort())}`,
  );
});

test("buildMessages：把 transcript 原文放进提示词（可被模型读到）", () => {
  const transcript = "用户：帮我看看这个报错\n\n助手：是端口占用。";
  const text = buildMessages({ transcript })[0].content[0].text;
  assert.equal(
    text.includes("用户：帮我看看这个报错"),
    true,
    `期望提示词包含 transcript 原文，实际=${JSON.stringify(text.slice(0, 200))}`,
  );
  assert.equal(
    text.includes("助手：是端口占用。"),
    true,
    `期望提示词包含助手原文，实际=${JSON.stringify(text.slice(0, 200))}`,
  );
});

test("buildMessages：transcript 两端空白被裁掉", () => {
  const text = buildMessages({ transcript: "\n\n  用户：hi  \n\n" })[0].content[0].text;
  assert.equal(
    text.endsWith("用户：hi"),
    true,
    `期望 transcript 两端空白被裁掉（结尾是「用户：hi」），实际结尾=${JSON.stringify(text.slice(-30))}`,
  );
});

test("buildMessages：没有 transcript 时用占位文案，结构仍然合法", () => {
  for (const input of [
    undefined,
    {},
    { transcript: "" },
    { transcript: "   " },
    { transcript: 42 },
  ]) {
    const messages = buildMessages(/** @type {any} */ (input));
    assert.equal(
      messages.length,
      1,
      `input=${JSON.stringify(input)} 期望 1 条消息，实际=${messages.length}`,
    );
    assert.equal(messages[0].role, "user", `input=${JSON.stringify(input)} 期望 role=user`);
    const text = messages[0].content[0].text;
    assert.equal(
      typeof text === "string" && text.length > 0,
      true,
      `input=${JSON.stringify(input)} 期望非空提示词，实际=${JSON.stringify(text)}`,
    );
    assert.equal(
      text.includes("没有可用的对话内容"),
      true,
      `input=${JSON.stringify(input)} 期望含占位文案「没有可用的对话内容」，实际=${JSON.stringify(text.slice(0, 80))}`,
    );
  }
});

test("buildMessages：不修改传入对象，且同样输入得到同样输出（纯函数）", () => {
  const input = { transcript: "用户：hi" };
  const before = JSON.stringify(input);
  const first = buildMessages(input);
  const second = buildMessages(input);
  assert.equal(JSON.stringify(input), before, `期望入参不被修改，实际=${JSON.stringify(input)}`);
  assert.deepEqual(first, second, "期望纯函数：同样输入输出一致");
});

// ---------------------------------------------------------------------------
// 2. renderTranscript
// ---------------------------------------------------------------------------

/** @param {string} role @param {string} text */
function msg(role, text) {
  return { role, content: [{ type: "text", text }] };
}

test("renderTranscript：只保留 user / assistant 文本，忽略工具块与其他角色", () => {
  const rendered = renderTranscript([
    msg("user", "问题一"),
    { role: "tool", content: [{ type: "text", text: "工具输出" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "思考" },
        { type: "text", text: "回答一" },
      ],
    },
    { role: "system", content: [{ type: "text", text: "系统提示" }] },
  ]);
  assert.equal(
    rendered.includes("问题一"),
    true,
    `期望含用户文本，实际=${JSON.stringify(rendered)}`,
  );
  assert.equal(
    rendered.includes("回答一"),
    true,
    `期望含助手文本，实际=${JSON.stringify(rendered)}`,
  );
  assert.equal(
    rendered.includes("工具输出"),
    false,
    `期望不含工具输出，实际=${JSON.stringify(rendered)}`,
  );
  assert.equal(
    rendered.includes("系统提示"),
    false,
    `期望不含系统提示，实际=${JSON.stringify(rendered)}`,
  );
  assert.equal(
    rendered.includes("思考"),
    false,
    `期望不含 reasoning，实际=${JSON.stringify(rendered)}`,
  );
});

test("renderTranscript：limit 只保留最后 N 条", () => {
  const messages = [msg("user", "第1条"), msg("assistant", "第2条"), msg("user", "第3条")];
  const rendered = renderTranscript(messages, { limit: 2 });
  assert.equal(
    rendered.includes("第3条"),
    true,
    `期望保留最后一条，实际=${JSON.stringify(rendered)}`,
  );
  assert.equal(
    rendered.includes("第2条"),
    true,
    `期望保留倒数第二条，实际=${JSON.stringify(rendered)}`,
  );
  assert.equal(
    rendered.includes("第1条"),
    false,
    `期望丢掉更早的第1条，实际=${JSON.stringify(rendered)}`,
  );
});

test("renderTranscript：clip 超长单条被裁剪并带省略号", () => {
  const rendered = renderTranscript([msg("user", "x".repeat(50))], { clip: 10 });
  assert.equal(
    rendered.includes("xxxxxxxxxx…"),
    true,
    `期望裁剪到 10 字符并加省略号，实际=${JSON.stringify(rendered)}`,
  );
  assert.equal(
    rendered.includes("x".repeat(11)),
    false,
    `期望不保留第 11 个字符，实际=${JSON.stringify(rendered)}`,
  );
});

test("renderTranscript：空文本与非法输入不抛错", () => {
  assert.equal(
    renderTranscript([]),
    "",
    `空数组期望空字符串，实际=${JSON.stringify(renderTranscript([]))}`,
  );
  assert.equal(
    renderTranscript(/** @type {any} */ (null)),
    "",
    `null 期望空字符串，实际=${JSON.stringify(renderTranscript(/** @type {any} */ (null)))}`,
  );
  assert.equal(
    renderTranscript([msg("user", "   "), null, { role: "user" }]),
    "",
    "全是空文本时期望空字符串",
  );
});

// ---------------------------------------------------------------------------
// 3. buildSystemPrompt
// ---------------------------------------------------------------------------

test("buildSystemPrompt：要求严格 JSON、1–2 条、并写明各字段上限", () => {
  const prompt = buildSystemPrompt({ locale: "zh-CN" });
  assert.equal(typeof prompt, "string", `期望字符串，实际=${typeof prompt}`);
  assert.equal(
    prompt.includes("JSON"),
    true,
    `期望提到 JSON，实际=${JSON.stringify(prompt.slice(0, 120))}`,
  );
  assert.equal(
    prompt.includes("1–2 条"),
    true,
    `期望写明 options 是 1–2 条，实际=${JSON.stringify(prompt.slice(0, 300))}`,
  );
  assert.equal(prompt.includes(String(LABEL_MAX)), true, `期望写明 label 上限 ${LABEL_MAX}`);
  assert.equal(
    prompt.includes("needed"),
    true,
    `期望提示词提到 needed（模型自评是否值得继续），实际=${JSON.stringify(prompt.slice(0, 400))}`,
  );
  assert.equal(
    prompt.includes("reason"),
    true,
    `期望提示词提到 reason（判断依据），实际=${JSON.stringify(prompt.slice(0, 400))}`,
  );
  assert.equal(prompt.includes(String(REASON_MAX)), true, `期望写明 reason 上限 ${REASON_MAX}`);
  assert.equal(
    prompt.includes(String(NEXT_PROMPT_MAX)),
    true,
    `期望写明 nextPrompt 上限 ${NEXT_PROMPT_MAX}`,
  );
  assert.equal(
    prompt.includes("zh-CN"),
    true,
    `期望带上界面语言 zh-CN，实际=${JSON.stringify(prompt.slice(-200))}`,
  );
});

test("buildSystemPrompt：locale 缺失时回落 auto，不抛错", () => {
  const prompt = buildSystemPrompt();
  assert.equal(typeof prompt, "string", `期望字符串，实际=${typeof prompt}`);
  assert.equal(
    prompt.includes("auto"),
    true,
    `期望 locale 回落 auto，实际=${JSON.stringify(prompt.slice(-120))}`,
  );
});

// ---------------------------------------------------------------------------
// 4. parseSuggestion —— 合法输入
// ---------------------------------------------------------------------------

test("parseSuggestion：合法 JSON 对象被完整解析", () => {
  const payload = validPayload();
  const parsed = expectSuggestion(parseSuggestion(JSON.stringify(payload)), "合法 JSON");
  assert.equal(parsed.needed, true, `needed 期望=true，实际=${JSON.stringify(parsed.needed)}`);
  assert.equal(
    parsed.reason,
    payload.reason,
    `reason 期望=${JSON.stringify(payload.reason)} 实际=${JSON.stringify(parsed.reason)}`,
  );
  assert.equal(
    parsed.summary,
    payload.summary,
    `summary 期望=${JSON.stringify(payload.summary)} 实际=${JSON.stringify(parsed.summary)}`,
  );
  assert.equal(
    parsed.question,
    payload.question,
    `question 期望=${JSON.stringify(payload.question)} 实际=${JSON.stringify(parsed.question)}`,
  );
  assert.deepEqual(
    parsed.options,
    payload.options,
    `options 期望=${JSON.stringify(payload.options)} 实际=${JSON.stringify(parsed.options)}`,
  );
  assert.equal(
    parsed.nextPrompt,
    payload.nextPrompt,
    `nextPrompt 期望=${JSON.stringify(payload.nextPrompt)} 实际=${JSON.stringify(parsed.nextPrompt)}`,
  );
});

test("parseSuggestion：前后带 ```json 围栏可解析", () => {
  const raw = `\`\`\`json\n${JSON.stringify(validPayload())}\n\`\`\``;
  const parsed = expectSuggestion(parseSuggestion(raw), "```json 围栏");
  assert.equal(parsed.options.length, 2, `期望 2 条 option，实际=${parsed.options.length}`);
  assert.equal(parsed.summary, validPayload().summary, "围栏内的 summary 应一致");
});

test("parseSuggestion：无语言标记的 ``` 围栏也可解析", () => {
  const raw = `\`\`\`\n${JSON.stringify(validPayload())}\n\`\`\``;
  const parsed = expectSuggestion(parseSuggestion(raw), "无语言标记围栏");
  assert.equal(parsed.question, validPayload().question, "围栏内 question 应一致");
});

test("parseSuggestion：JSON 前后有多余文字时，抠出 JSON 对象", () => {
  const raw = `好的，下面是决策卡：\n${JSON.stringify(validPayload())}\n希望有帮助。`;
  const parsed = expectSuggestion(parseSuggestion(raw), "前后多余文字");
  assert.equal(parsed.summary, validPayload().summary, "多余文字里的 JSON 应被正确解析");
  assert.equal(parsed.options.length, 2, `期望 2 条 option，实际=${parsed.options.length}`);
});

test("parseSuggestion：围栏 + 多余文字同时存在也能解析", () => {
  const raw = `思考结束\n\`\`\`json\n${JSON.stringify(validPayload())}\n\`\`\`\n以上。`;
  const parsed = expectSuggestion(parseSuggestion(raw), "围栏+多余文字");
  assert.equal(
    parsed.options[0].stance,
    "verify",
    `期望第一条 stance="verify"，实际=${JSON.stringify(parsed.options[0].stance)}`,
  );
});

test("parseSuggestion：缺 nextPrompt 时返回不含该键的对象（不是 null）", () => {
  const payload = validPayload();
  delete (/** @type {any} */ (payload).nextPrompt);
  const parsed = expectSuggestion(parseSuggestion(JSON.stringify(payload)), "缺 nextPrompt");
  assert.equal(
    "nextPrompt" in parsed,
    false,
    `期望不含 nextPrompt 键，实际=${JSON.stringify(parsed.nextPrompt)}`,
  );
  assert.equal(parsed.options.length, 2, "options 仍应完整");
});

test("parseSuggestion：stance 归一化为小写并去空白（两条仍互斥）", () => {
  const payload = validPayload();
  payload.options[0].stance = "  VERIFY ";
  payload.options[1].stance = "Proceed";
  const parsed = expectSuggestion(parseSuggestion(JSON.stringify(payload)), "stance 归一化");
  assert.equal(
    parsed.options[0].stance,
    "verify",
    `期望第一条="verify"，实际=${JSON.stringify(parsed.options[0].stance)}`,
  );
  assert.equal(
    parsed.options[1].stance,
    "proceed",
    `期望第二条="proceed"，实际=${JSON.stringify(parsed.options[1].stance)}`,
  );
});

// ---------------------------------------------------------------------------
// 5. parseSuggestion —— 非法输入一律 null（绝不截断/部分接受）
// ---------------------------------------------------------------------------

test("parseSuggestion：空字符串 / 纯空白 → null", () => {
  for (const raw of ["", "   ", "\n\t "]) {
    assert.equal(
      parseSuggestion(raw),
      null,
      `raw=${JSON.stringify(raw)} 期望=null，实际=${JSON.stringify(parseSuggestion(raw))}`,
    );
  }
});

test("parseSuggestion：非字符串输入 → null", () => {
  for (const raw of [null, undefined, 42, {}, []]) {
    assert.equal(
      parseSuggestion(/** @type {any} */ (raw)),
      null,
      `raw=${JSON.stringify(raw)} 期望=null，实际=${JSON.stringify(parseSuggestion(/** @type {any} */ (raw)))}`,
    );
  }
});

test("parseSuggestion：没有任何 JSON 的散文 → null", () => {
  const raw = "抱歉，我无法生成决策卡。";
  assert.equal(
    parseSuggestion(raw),
    null,
    `期望=null，实际=${JSON.stringify(parseSuggestion(raw))}`,
  );
});

test("parseSuggestion：JSON 语法损坏 → null（不做修复）", () => {
  const raw = '{"summary": "缺右括号", "question": "要吗？", "options": [}';
  assert.equal(
    parseSuggestion(raw),
    null,
    `期望=null，实际=${JSON.stringify(parseSuggestion(raw))}`,
  );
});

test("parseSuggestion：只有 1 条 option 也合法（下一步很明确时不凑数）", () => {
  const payload = /** @type {any} */ (validPayload());
  payload.options = [payload.options[0]];
  const parsed = expectSuggestion(parseSuggestion(JSON.stringify(payload)), "options 只有 1 条");
  assert.equal(parsed.options.length, 1);
});

test("parseSuggestion：3 条 option → null", () => {
  const payload = /** @type {any} */ (validPayload());
  payload.options.push({ stance: "third", label: "补第三种做法" });
  assert.equal(
    parseSuggestion(JSON.stringify(payload)),
    null,
    `options 有 3 条时期望=null，实际=${JSON.stringify(parseSuggestion(JSON.stringify(payload)))}`,
  );
});

test("parseSuggestion：两条同 stance → null（大小写/空白归一化后仍相同）", () => {
  const payload = /** @type {any} */ (validPayload());
  payload.options[1].stance = "  VERIFY  ";
  assert.equal(
    parseSuggestion(JSON.stringify(payload)),
    null,
    `两条 stance 归一化后相同时期望=null，实际=${JSON.stringify(parseSuggestion(JSON.stringify(payload)))}`,
  );
});

test("parseSuggestion：label 超上限 → null（整条丢弃，不截断）", () => {
  const payload = /** @type {any} */ (validPayload());
  payload.options[0].label = "这".repeat(LABEL_MAX + 1);
  const result = parseSuggestion(JSON.stringify(payload));
  assert.equal(
    result,
    null,
    `label=${LABEL_MAX + 1} 字时期望=null（不要截断成 ${LABEL_MAX} 字），实际=${JSON.stringify(result)}`,
  );
});

test("parseSuggestion：label 恰好上限可接受（边界）", () => {
  const payload = /** @type {any} */ (validPayload());
  payload.options[0].label = "标".repeat(LABEL_MAX);
  const parsed = expectSuggestion(
    parseSuggestion(JSON.stringify(payload)),
    `label=${LABEL_MAX} 字`,
  );
  assert.equal(
    parsed.options[0].label.length,
    LABEL_MAX,
    `期望保留 ${LABEL_MAX} 字，实际=${parsed.options[0].label.length}`,
  );
});

test("parseSuggestion：nextPrompt 超长时截断（不丢整张卡）", () => {
  const payload = /** @type {any} */ (validPayload());
  // 前缀带上推荐项的具体对象，保证它先通过一致性校验，再验证截断。
  payload.nextPrompt = `补 next-step 冒烟 ${"再补一句".repeat(40)}`;
  assert.ok(payload.nextPrompt.length > NEXT_PROMPT_MAX);
  const parsed = expectSuggestion(
    parseSuggestion(JSON.stringify(payload)),
    `nextPrompt 超过 ${NEXT_PROMPT_MAX} 字`,
  );
  assert.equal(parsed.nextPrompt?.length, NEXT_PROMPT_MAX);
});

test("parseSuggestion：nextPrompt 与推荐项不一致时退化成按钮文案", () => {
  const payload = /** @type {any} */ (validPayload());
  payload.nextPrompt = "先别管这个，去看看 CI 的失败原因";
  const parsed = expectSuggestion(
    parseSuggestion(JSON.stringify(payload)),
    "nextPrompt 与 options[0] 无关",
  );
  // 同一个建议的两种入口：宁可短，也不让两处打脸。
  assert.equal(parsed.nextPrompt, payload.options[0].label);
});

test("parseSuggestion：nextPrompt 恰好上限可接受（边界）", () => {
  const payload = /** @type {any} */ (validPayload());
  const head = "补 next-step 冒烟 ";
  payload.nextPrompt = `${head}${"x".repeat(NEXT_PROMPT_MAX - head.length)}`;
  assert.equal(payload.nextPrompt.length, NEXT_PROMPT_MAX);
  const parsed = expectSuggestion(
    parseSuggestion(JSON.stringify(payload)),
    `nextPrompt=${NEXT_PROMPT_MAX} 字`,
  );
  assert.equal(parsed.nextPrompt?.length, NEXT_PROMPT_MAX);
});

test("parseSuggestion：label 少于下限 → null（「继续」这类悬空指令不可执行）", () => {
  const payload = /** @type {any} */ (validPayload());
  payload.options[0].label = "继续".slice(0, LABEL_MIN - 1);
  assert.equal(
    parseSuggestion(JSON.stringify(payload)),
    null,
    `label=${LABEL_MIN - 1} 字期望=null，实际=${JSON.stringify(parseSuggestion(JSON.stringify(payload)))}`,
  );
});

test("parseSuggestion：只有 text 没有 label → null（v0.2 起按钮文本就是消息）", () => {
  const payload = /** @type {any} */ (validPayload());
  payload.options[0] = { stance: "verify", text: "先给 next-step 写冒烟" };
  assert.equal(
    parseSuggestion(JSON.stringify(payload)),
    null,
    `缺 label 期望=null，实际=${JSON.stringify(parseSuggestion(JSON.stringify(payload)))}`,
  );
});

test("parseSuggestion：残留的 text 字段被忽略（不进入解析结果）", () => {
  const payload = /** @type {any} */ (validPayload());
  payload.options[0].text = "旧版本的隐藏指令";
  const parsed = expectSuggestion(parseSuggestion(JSON.stringify(payload)), "残留 text");
  assert.deepEqual(
    Object.keys(parsed.options[0]).sort(),
    ["label", "stance"],
    `期望 option 只含 stance/label，实际=${JSON.stringify(parsed.options[0])}`,
  );
});

test("parseSuggestion：needed 缺失或不是布尔 → null", () => {
  const missing = /** @type {any} */ (validPayload());
  delete missing.needed;
  assert.equal(parseSuggestion(JSON.stringify(missing)), null, "缺 needed 期望=null");
  for (const value of ["true", 1, null]) {
    const payload = /** @type {any} */ (validPayload());
    payload.needed = value;
    assert.equal(
      parseSuggestion(JSON.stringify(payload)),
      null,
      `needed=${JSON.stringify(value)} 期望=null，实际=${JSON.stringify(parseSuggestion(JSON.stringify(payload)))}`,
    );
  }
});

test("parseSuggestion：needed=false 的卡仍然被解析（用户可手动补生成）", () => {
  const payload = /** @type {any} */ (validPayload());
  payload.needed = false;
  payload.reason = "回答已经向用户提出了明确问题，这一轮不需要再出卡。";
  const parsed = expectSuggestion(parseSuggestion(JSON.stringify(payload)), "needed=false");
  assert.equal(parsed.needed, false, `needed 期望=false，实际=${JSON.stringify(parsed.needed)}`);
  assert.equal(parsed.options.length, 2, "needed=false 时 options 仍应完整");
});

test("parseSuggestion：reason 为空或超长 → null", () => {
  const empty = /** @type {any} */ (validPayload());
  empty.reason = "   ";
  assert.equal(parseSuggestion(JSON.stringify(empty)), null, "reason 为空期望=null");
  const long = /** @type {any} */ (validPayload());
  long.reason = "r".repeat(REASON_MAX + 1);
  assert.equal(
    parseSuggestion(JSON.stringify(long)),
    null,
    `reason=${REASON_MAX + 1} 字期望=null，实际=${JSON.stringify(parseSuggestion(JSON.stringify(long)))}`,
  );
});

test("parseSuggestion：summary / question 为空 → null", () => {
  const noSummary = /** @type {any} */ (validPayload());
  noSummary.summary = "  ";
  assert.equal(parseSuggestion(JSON.stringify(noSummary)), null, "summary 为空期望=null");
  const noQuestion = /** @type {any} */ (validPayload());
  noQuestion.question = "";
  assert.equal(parseSuggestion(JSON.stringify(noQuestion)), null, "question 为空期望=null");
});

test("parseSuggestion：summary / question 超长 → null（不截断）", () => {
  const longSummary = /** @type {any} */ (validPayload());
  longSummary.summary = "s".repeat(SUMMARY_MAX + 1);
  assert.equal(
    parseSuggestion(JSON.stringify(longSummary)),
    null,
    `summary=${SUMMARY_MAX + 1} 字期望=null，实际=${JSON.stringify(parseSuggestion(JSON.stringify(longSummary)))}`,
  );
  const longQuestion = /** @type {any} */ (validPayload());
  longQuestion.question = "q".repeat(QUESTION_MAX + 1);
  assert.equal(
    parseSuggestion(JSON.stringify(longQuestion)),
    null,
    `question=${QUESTION_MAX + 1} 字期望=null，实际=${JSON.stringify(parseSuggestion(JSON.stringify(longQuestion)))}`,
  );
});

test("parseSuggestion：options 缺失或不是数组 → null", () => {
  const missing = /** @type {any} */ (validPayload());
  delete missing.options;
  assert.equal(parseSuggestion(JSON.stringify(missing)), null, "缺 options 期望=null");
  const notArray = /** @type {any} */ (validPayload());
  notArray.options = "nope";
  assert.equal(parseSuggestion(JSON.stringify(notArray)), null, "options 非数组期望=null");
  const nullItem = /** @type {any} */ (validPayload());
  nullItem.options = [null, nullItem.options[1]];
  assert.equal(parseSuggestion(JSON.stringify(nullItem)), null, "options 含 null 项期望=null");
});

test("parseSuggestion：stance 为空、label 为空 → null", () => {
  for (const mutate of [
    (/** @type {any} */ payload) => {
      payload.options[0].stance = "";
    },
    (/** @type {any} */ payload) => {
      payload.options[0].label = "";
    },
  ]) {
    const payload = /** @type {any} */ (validPayload());
    mutate(payload);
    assert.equal(
      parseSuggestion(JSON.stringify(payload)),
      null,
      `非法字段期望=null，实际=${JSON.stringify(parseSuggestion(JSON.stringify(payload)))}`,
    );
  }
});

test("parseSuggestion：JSON 是数组或标量 → null", () => {
  assert.equal(parseSuggestion("[1,2,3]"), null, "数组期望=null");
  assert.equal(parseSuggestion('"just a string"'), null, "字符串标量期望=null");
  assert.equal(parseSuggestion("123"), null, "数字标量期望=null");
});

test("parseSuggestion：每次调用返回新对象（不共享引用，避免投影里被就地改）", () => {
  const raw = JSON.stringify(validPayload());
  const first = expectSuggestion(parseSuggestion(raw), "第一次");
  const second = expectSuggestion(parseSuggestion(raw), "第二次");
  assert.notEqual(first, second, "期望两次调用返回不同对象引用");
  assert.notEqual(first.options, second.options, "期望 options 数组不共享引用");
  first.options[0].label = "被改了";
  assert.equal(
    second.options[0].label,
    validPayload().options[0].label,
    `期望互不影响，实际第二次=${JSON.stringify(second.options[0].label)}`,
  );
});

// ---------------------------------------------------------------------------
// 10. 按钮具体性 / 幽灵提示一致性（v0.5：内容质量）
// ---------------------------------------------------------------------------

test("isGenericLabel：空话动词 + 无具体对象 → 判为泛化", () => {
  for (const label of ["检查定义是否准确", "扩展到实现细节", "继续优化", "梳理一下流程"]) {
    assert.equal(isGenericLabel(label), true, `期望判为泛化：${label}`);
  }
});

test("isGenericLabel：带具体对象的按钮不算泛化", () => {
  for (const label of [
    "改成 %5",
    "写 M4-07 任务书",
    "排序取前 k",
    "出 v1.5 和 E2E-01c",
    "补 next-step 冒烟",
  ]) {
    assert.equal(isGenericLabel(label), false, `期望不算泛化：${label}`);
  }
});

test("parseSuggestion：泛化按钮被丢掉，剩下的仍然可用", () => {
  const payload = /** @type {any} */ (validPayload());
  payload.options[0].label = "检查定义是否准确";
  const parsed = expectSuggestion(parseSuggestion(JSON.stringify(payload)), "一条泛化 + 一条具体");
  assert.equal(parsed.options.length, 1, "泛化那条应当被丢掉");
  assert.equal(parsed.options[0].label, payload.options[1].label);
});

test("parseSuggestion：所有按钮都泛化 → 整卡不出（不凑数）", () => {
  const payload = /** @type {any} */ (validPayload());
  payload.options[0].label = "检查定义是否准确";
  payload.options[1].label = "扩展到实现细节";
  assert.equal(parseSuggestion(JSON.stringify(payload)), null);
});

test("ghostAgreesWithLabel：共享具体对象即视为一致（中文用包含关系）", () => {
  assert.equal(
    ghostAgreesWithLabel("先给 next-step 补 web 冒烟和桌面回归", "补 next-step 冒烟"),
    true,
  );
  assert.equal(
    ghostAgreesWithLabel("改 src/importer/csv.ts 的 BOM 处理", "改 src/importer/csv.ts"),
    true,
  );
});

test("ghostAgreesWithLabel：说的不是一件事 → false", () => {
  assert.equal(
    ghostAgreesWithLabel("先别管这个，去看看 CI 的失败原因", "补 next-step 冒烟"),
    false,
  );
});

test("concreteTokens：能抽出文件、命令、版本号与中文名词片段", () => {
  const tokens = concreteTokens("改 src/importer/csv.ts，跑 pnpm test，升到 v1.5.0，补冒烟");
  assert.ok(tokens.has("src/importer/csv.ts"), `实际=${[...tokens].join(",")}`);
  assert.ok([...tokens].some((token) => token === "v1.5.0" || token === "1.5.0"));
  assert.ok([...tokens].some((token) => token.includes("冒烟")));
});
