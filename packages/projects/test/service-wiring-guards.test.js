// @ts-check
// 源码守卫：这几处是"静默做错事"的高风险接线，纯函数单测覆盖不到，但用文本断言能防回归。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serviceSource = readFileSync(join(here, "..", "lib", "service.js"), "utf8");
const clientSource = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

/**
 * 截出某个方法体（从 `async name(` 起，到下一个顶层方法注释/方法定义前）。
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function methodRegion(source, name) {
  const start = source.indexOf(`async ${name}(`);
  assert.ok(start >= 0, `找不到方法 ${name}`);
  const rest = source.slice(start + 1);
  // 下一个同级方法：以两个空格缩进的 `async xxx(` 或 `/**` 后的方法名为界
  const nextCandidates = [
    rest.indexOf("\n  async ", 1),
    rest.indexOf("\n  /**", 1),
    rest.indexOf("\n  constructor("),
  ].filter((index) => index > 0);
  const end = nextCandidates.length > 0 ? Math.min(...nextCandidates) : rest.length;
  return rest.slice(0, end);
}

describe("PR 命令的工作目录：必须走 pickRepoRoot（不能再用 dirs[0]）", () => {
  for (const method of ["prOverview", "mergePr"]) {
    it(`${method} 使用 pickRepoRoot 而不是 project.dirs[0]`, () => {
      const region = methodRegion(serviceSource, method);
      assert.match(region, /pickRepoRoot\(/u);
      assert.doesNotMatch(region, /project\.dirs\[0\]/u);
    });
  }
  it("pollPrs 使用 pickPollRoot", () => {
    const start = serviceSource.indexOf("async pollPrs(");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 6000);
    assert.match(region, /pickPollRoot\(/u);
  });
});

describe("事件回写：高频路径必须合并写盘（saveSoon）", () => {
  it("applyThreadEvent 之后用 saveSoon(250)", () => {
    const anchor = serviceSource.indexOf("applyThreadEvent(sessionId, event, next)");
    assert.ok(anchor >= 0);
    const around = serviceSource.slice(anchor, anchor + 200);
    assert.match(around, /saveSoon\(250\)/u);
  });
});

describe("客户端轮询：后台标签页不轮询", () => {
  it("详情页 5s 轮询里有 document.hidden 门控", () => {
    const anchor = clientSource.indexOf("const timer = setInterval(() => load(true), 5000);");
    // 新写法不是单行，改为找 load(true) 附近的 setInterval 片段
    const fallback = clientSource.indexOf("load(true);");
    const index = anchor >= 0 ? anchor : fallback;
    assert.ok(index >= 0);
    const region = clientSource.slice(Math.max(0, index - 600), index + 200);
    assert.match(region, /hidden === true/u);
  });
});

describe("生命周期保护：在跑/等你的线程不许被回收/归档清理/删项目", () => {
  it("reclaimThread 先查 threadBusy；cleanupBranches 跳过 thread-busy", () => {
    const reclaim = methodRegion(serviceSource, "reclaimThread");
    assert.match(reclaim, /threadBusy\(/u);
    assert.match(reclaim, /thread-busy/u);
    const cleanupStart = serviceSource.indexOf("async cleanupBranches(");
    assert.ok(cleanupStart >= 0);
    const cleanup = serviceSource.slice(cleanupStart, cleanupStart + 6000);
    assert.match(cleanup, /thread-busy/u);
  });

  it("deleteProject 是 async、会拒绝在跑的线程，并把 worktree 写进影响面", () => {
    const del = methodRegion(serviceSource, "deleteProject");
    assert.match(del, /threadBusy\(/u);
    assert.match(del, /running\/waiting thread/u);
    assert.match(del, /worktrees: preview\.worktrees/u);
  });

  it("purgeTrash 枚举整个 trash 根（不是按现存项目过滤）", () => {
    const start = serviceSource.indexOf("  purgeTrash(");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 5000);
    assert.match(region, /trashProjectIdOf\(/u);
    assert.doesNotMatch(region, /names\.startsWith/u);
  });

  it("getProject 同时接受 id 与 projectId 两个实参名", () => {
    const start = serviceSource.indexOf("  getProject(");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 400);
    assert.match(region, /projectId/u);
    assert.match(region, /\?\? id/u);
  });
});

describe("审查 P1 回归防线", () => {
  it("libraryView 有总调用预算与 partial 标记（空目录不再打爆宿主）", () => {
    const start = serviceSource.indexOf("async libraryView(");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 9000);
    assert.match(region, /budget\.left <= 0/u);
    assert.match(region, /partial: false/u);
    assert.match(region, /const pathCandidates = \["\.", dir\]/u);
  });

  it("threadStates 与 progress 共用 liveSessionFacts / pendingInput", () => {
    const region = methodRegion(serviceSource, "threadStates");
    assert.match(region, /liveSessionFacts\(/u);
    assert.match(region, /pendingInput/u);
    assert.doesNotMatch(region, /state !== "active"/u);
  });

  it("无目录项目的线程 cwd 走 workspaces 专用目录", () => {
    const threadSource = readFileSync(join(here, "..", "lib", "thread.js"), "utf8");
    assert.match(threadSource, /workspaces\/\$\{/u);
    assert.doesNotMatch(threadSource, /: \[dataRoot\];/u);
  });
});

describe("审查 P1（第二批）回归防线", () => {
  it("模板 instructions.md 写到数据根（读路径），不是 dirs[0]/相对路径", () => {
    const start = serviceSource.indexOf("applyProjectTemplate(");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 3000);
    assert.match(region, /join\(this\.dataRoot, project\.id, "instructions\.md"\)/u);
    assert.doesNotMatch(region, /const instructions = join\(base/u);
  });

  it("协调器会话的 token 也归到项目桶（预算闸不再漏账）", () => {
    const start = serviceSource.indexOf("const threadProject = this.store?.projectOfSession");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 1600);
    assert.match(region, /coordinatorSessionId/u);
    assert.match(region, /addTokenUsage\(usageProject\.id/u);
  });

  it("attachThread 拒绝空 sessionId", () => {
    const start = serviceSource.indexOf("  attachThread(sessionId, projectId) {");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 400);
    assert.match(region, /sessionId is required/u);
  });
});

describe("审查 P2 回归防线（第三批）", () => {
  it("PR 轮询只在有变化时写审计/写盘，失败原因去重", () => {
    const start = serviceSource.indexOf("async pollPrs(");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 7000);
    assert.match(region, /lastFailure/u);
    assert.match(region, /if \(patches\.length > 0\)/u);
    assert.doesNotMatch(region, /this\.prPoll\.lastResult = result;\s*\n\s*store\.save\(\);/u);
  });

  it("detachThread 返回 worktree/分支（不让它们变孤儿），createThread 记录 prompt 失败", () => {
    const detachStart = serviceSource.indexOf("  detachThread(");
    assert.ok(detachStart >= 0);
    const detach = serviceSource.slice(detachStart, detachStart + 1600);
    assert.match(detach, /detached:/u);
    assert.match(detach, /worktree/u);
    const create = methodRegion(serviceSource, "createThread");
    assert.match(create, /thread\/prompt-failed/u);
    assert.match(create, /promptFailed/u);
  });

  it("searchLibraryFiles 遍历多个 dirs（不再只看 dirs[0]）", () => {
    const start = serviceSource.indexOf("async searchLibraryFiles(");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 4000);
    assert.match(region, /for \(const dir of dirs/u);
    assert.match(region, /dirsSearched/u);
  });

  it("写盘失败会通知（lastSaveError/onSaveError）", () => {
    const storeSource = readFileSync(join(here, "..", "lib", "store.js"), "utf8");
    assert.match(storeSource, /lastSaveError/u);
    assert.match(storeSource, /onSaveError\?\.\(/u);
  });
});

describe("审查 P2（第四批）回归防线", () => {
  it("PR 失败次数真的落盘（give-up 上限才会触发）", () => {
    const start = serviceSource.indexOf("const tryCount = Number(thread.prAttempts ?? 0) + 1;");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 400);
    assert.match(region, /prAttempts: tryCount/u);
  });

  it("不再保留没有调用者的 canAutoMerge（死代码已清）", () => {
    const autoprSource = readFileSync(join(here, "..", "lib", "autopr.js"), "utf8");
    assert.doesNotMatch(autoprSource, /export function canAutoMerge/u);
  });
});

describe("审查 P2（第五批）：删除项目的事务顺序", () => {
  it("manifest 先写、内容搬完再删记录；失败路径有回滚", () => {
    const start = serviceSource.indexOf("  async deleteProject(");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 7000);
    const manifestAt = region.indexOf("manifest(false)");
    const moveAt = region.indexOf("moveInto(preview.contentDir");
    const removeAt = region.indexOf("store.removeProject(id)");
    assert.ok(manifestAt > 0 && moveAt > manifestAt, "manifest 必须在搬内容之前");
    assert.ok(removeAt > moveAt, "删记录必须在内容搬完之后");
    assert.match(region, /rmSync\(trashDir/u); // 失败路径清理回收站残留
    assert.match(region, /renameSync\(`\$\{trashDir\}\/content`, preview\.contentDir\)/u);
    // 无目录项目的 workspaces 目录同样是插件资产：进回收站、失败时一起回滚
    assert.match(region, /moveInto\(preview\.workspaceDir/u);
    assert.match(region, /renameSync\(`\$\{trashDir\}\/workspace`, preview\.workspaceDir\)/u);
    // 事务里 detachSession 只跑一次（以前复制粘贴成两遍）
    assert.equal(region.split("this.detachSession(thread.sessionId)").length - 1, 1);
  });
});

describe("最终自查补漏", () => {
  it("openPr 数提交也用线程 worktree（多目录不再误报 no-commits）", () => {
    const start = serviceSource.indexOf("async openPr(");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 1500);
    assert.match(region, /pickRepoRoot\(/u);
    assert.doesNotMatch(region, /project\.dirs\[0\]/u);
  });

  it("归档只做元数据操作：不删 worktree/分支（删除不可逆，可恢复语义要成立）", () => {
    const region = methodRegion(serviceSource, "archiveProject");
    assert.doesNotMatch(region, /cleanupBranches\(/u);
    assert.match(region, /project\/archived/u);
    assert.match(region, /skipped-non-destructive/u);
    assert.match(region, /cleanup: null/u);
  });

  it("详情页只在从未加载时显示整页 loading（静默刷新不换掉内容）", () => {
    const raw = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
    assert.match(raw, /if \(data\.loading && !data\.progress\)/u);
  });
});

describe("剩余审查项", () => {
  it("routine 更新：宿主 {ok:false} 也按失败处理（不写本地）", () => {
    const region = methodRegion(serviceSource, "updateRoutine");
    assert.match(region, /edited\.ok === false/u);
    assert.match(region, /created\.ok === false/u);
    assert.match(region, /schedule-rejected/u);
  });

  it("progress 的产物列表只取一次（不再每行克隆）", () => {
    const start = serviceSource.indexOf("const autoRetryEnabled = store.getProject(projectId)");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 4000);
    assert.match(region, /const artifactRefs = store\.listArtifactRefs\(projectId\)/u);
    assert.doesNotMatch(region, /row\.artifacts = store\s*\n?\s*\.listArtifactRefs/u);
  });
});

describe("第二轮独立复审修复（P0/P1）", () => {
  const executeSource = readFileSync(join(here, "..", "lib", "execute.js"), "utf8");

  it("审批合并与 UI 用同一个仓库解析（线程 worktree 优先）与同一套 assessMergePr", () => {
    assert.match(executeSource, /pickRepoRoot\(/u);
    const mergeStart = executeSource.indexOf('if (approval.action === "merge") {');
    const mergeRegion = executeSource.slice(mergeStart, mergeStart + 2500);
    assert.match(mergeRegion, /pickRepoRoot\(/u, "合并仓库必须从线程 worktree 解析");
    assert.doesNotMatch(mergeRegion, /project\.dirs\[0\]/u);
    // 合并执行分支（不是上面解析仓库那一小段）必须共用 assessMergePr
    const execStart = executeSource.indexOf("// merge：走 gh pr merge");
    assert.ok(execStart >= 0);
    const execRegion = executeSource.slice(execStart, execStart + 4200);
    assert.match(execRegion, /assessMergePr\(/u, "审批路径必须共用改动量/CI/批准判据");
    assert.match(execRegion, /additions,deletions,changedFiles/u);
    // 不再读不存在的 policy.danger.merge（注释里提到是可以的，读法不行）
    assert.doesNotMatch(executeSource, /policy\?\.danger\?\.merge|policy\.danger\?\.merge/u);
  });

  it("delete-project 审批 await 真实结果，失败不能报 executed", () => {
    const start = executeSource.indexOf('approval.action === "delete-project"');
    assert.ok(start >= 0);
    const region = executeSource.slice(start, start + 1600);
    assert.match(region, /= await deleteProject\(/u);
    assert.match(region, /executed: false/u);
  });

  it("直推保护分支在执行前也做 refname 校验（不只 planCommand）", () => {
    const start = executeSource.indexOf('approval.action === "push-protected-branch"');
    assert.ok(start >= 0);
    const region = executeSource.slice(start, start + 1200);
    assert.match(region, /checkSafePushRef\(/u);
    assert.doesNotMatch(region, /dirs\?\.\[0\]/u);
  });

  it("归档钩子（宿主 session-archived）也查 threadBusy，不删在跑会话的 worktree", () => {
    const region = methodRegion(serviceSource, "onSessionArchived");
    assert.match(region, /liveSessionFacts\(/u);
    assert.match(region, /this\.threadBusy\(/u);
    assert.match(region, /worktree\/reclaim-skipped/u);
  });

  it("threadStates 与 buildThreadRow 同口径（宿主 archived/running/pending）", () => {
    const region = methodRegion(serviceSource, "threadStates");
    assert.match(region, /archivedIds/u);
    assert.match(region, /resolveLiveRunning\(/u);
    assert.match(region, /settleState\(/u);
  });

  it("回收站条目拒绝 '.'（join 后就是回收站根）", () => {
    const start = serviceSource.indexOf("  deleteTrashEntry(");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 900);
    assert.match(region, /entryId === "\."/u);
  });

  it("mergePr 先判全部门禁再 pr ready（草稿转正不再是失败前的副作用）", () => {
    const region = methodRegion(serviceSource, "mergePr");
    const preAt = region.indexOf("preDraft = assessMergePr(");
    const readyAt = region.indexOf('"pr", "ready"');
    assert.ok(preAt > 0 && readyAt > preAt, "必须先用非草稿副本预判其余门禁");
  });
});
