// @ts-check
// 追问队列的离线单测：不联网、不碰宿主。
// 背景：浮层想发起追问，但只能借 composer 提交命令；直接写 `--thread t_xxx`
// 会把内部参数暴露在用户输入框里。队列让命令退化成裸 `/btw`。
import assert from "node:assert/strict";
import test from "node:test";

import { createFollowUpQueue } from "../lib/followup-queue.js";

test("push + take：一次性取出，取过就没了", () => {
  const q = createFollowUpQueue();
  q.push("s1", { threadId: "t_a", question: "追问内容" });
  assert.equal(q.size(), 1);
  const taken = q.take("s1");
  assert.deepEqual(
    { threadId: taken?.threadId, question: taken?.question, scope: taken?.scope },
    { threadId: "t_a", question: "追问内容", scope: "" },
  );
  assert.equal(q.take("s1"), undefined, "取过即清空");
  assert.equal(q.size(), 0);
});

test("按 sessionId 分槽，互不串台", () => {
  const q = createFollowUpQueue();
  q.push("s1", { threadId: "t_1", question: "q1" });
  q.push("s2", { threadId: "t_2", question: "q2" });
  assert.equal(q.take("s1")?.threadId, "t_1");
  assert.equal(q.take("s2")?.threadId, "t_2");
});

test("同一 session 再 push 覆盖旧值（连点两次时后一次生效）", () => {
  const q = createFollowUpQueue();
  q.push("s1", { threadId: "t_1", question: "第一次" });
  q.push("s1", { threadId: "t_1", question: "第二次" });
  assert.equal(q.size(), 1);
  assert.equal(q.take("s1")?.question, "第二次");
});

test("过期条目视为不存在", () => {
  let clock = 1_000;
  const q = createFollowUpQueue({ ttlMs: 5_000, now: () => clock });
  q.push("s1", { threadId: "t_1", question: "q" });
  clock += 5_001;
  assert.equal(q.take("s1"), undefined, "超过 TTL 丢弃");
});

test("非法输入不入队（空 session / 空 threadId / 空问题）", () => {
  const q = createFollowUpQueue();
  q.push("", { threadId: "t_1", question: "q" });
  q.push("s1", { threadId: "", question: "q" });
  q.push("s1", { threadId: "t_1", question: "" });
  assert.equal(q.size(), 0);
});

test("scope 一并带过去", () => {
  const q = createFollowUpQueue();
  q.push("s1", { threadId: "t_1", question: "q", scope: "recent" });
  assert.equal(q.take("s1")?.scope, "recent");
});
