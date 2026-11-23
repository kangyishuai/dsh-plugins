// @ts-check
// 危险动作的「执行分支」：从 service 抽出，好处是**不依赖宿主包**，可以在单测里直接驱动。
// service 只做一件事：把 store / 命令执行器 / 几个内部方法包成 deps 传进来。
//
// 为什么值得抽：执行分支最容易出的是「某条分支忘了 return，悄悄掉到最后那个 deferred」——
// 纯函数单测抓不到，只有真机或这一层能抓（0.3.x 就踩过一次）。

import {
  allowedMergeMethodsFromRepo,
  checkExecutable,
  checkMergeReadiness,
  parseRepoFromRemote,
  planCommand,
  recoveryEvidence,
  shouldRetryPreflight,
} from "./executor.js";
import {
  consumeOnceFolderGrant,
  folderAuthSummary,
  rollbackOnceFolderGrant,
} from "./folder-auth.js";
import {
  checkForcePushPrereqs,
  checkProtectedPushPrereqs,
  countCollaborators,
} from "./git-push.js";
import { applySettingsPatch, sanitizeSettingsPatch } from "./settings.js";
import { WORKTREE_DIR } from "./worktree.js";

/**
 * @typedef {object} ExecuteDeps
 * @property {any} store 仓储（真实 ProjectStore 或等价替身）
 * @property {string} dataRoot 数据根（purgeTrash 用）
 * @property {(args: string[], cwd?: string) => Promise<{code: number, stdout: string, stderr: string}>} runGit
 * @property {(args: string[], cwd?: string) => Promise<{code: number, stdout: string, stderr: string}>} runGh
 * @property {(projectId: string) => any} purgeTrash
 * @property {(sessionId: string) => Promise<any>} reclaimThread
 * @property {(projectId: string) => Promise<any>} deleteProject
 */

/** F55：会**在项目目录里跑命令**的危险动作（gh/git 的 cwd 就是项目目录）。 */
export const FOLDER_GATED_ACTIONS = Object.freeze([
  "merge",
  "push-branch",
  "push-protected-branch",
]);

/**
 * F55：动作**实际在哪个目录里跑**——闸门按它求 mode，而不是一律按 `dirs[0]`。
 *
 * `merge` 的 gh 命令在 `dirs[0]` 里跑；`push-branch` 却在**线程 worktree** 里跑，
 * worktree 位于 `<repoParent>/.dsh-worktrees/<repoName>/<projectId>-<n>`（仓库的兄弟目录）。
 * 语义：worktree **继承**它所属项目目录的授权——按本插件自己的 worktree 命名规则反查
 * 是哪个 `dirs[i]` 生出来的；反查不到才退回 `dirs[0]`（并在审计里标 inherited=false）。
 * @param {any} project @param {string} action @param {{ worktree?: string }} [context]
 * @returns {{ dir: string, cwd: string, inherited: boolean }}
 */
export function actionDirectory(project, action, context = {}) {
  const dirs = Array.isArray(project?.dirs)
    ? project.dirs.map((/** @type {any} */ dir) => String(dir ?? "")).filter(Boolean)
    : [];
  const primary = dirs[0] ?? "";
  const worktree =
    typeof context?.worktree === "string" && context.worktree !== "" ? context.worktree : "";
  if (String(action) !== "push-branch" || worktree === "") {
    return { dir: primary, cwd: primary, inherited: false };
  }
  for (const dir of dirs) {
    const clean = dir.replace(/\/+$/u, "");
    const parts = clean.split("/");
    const repoName = parts[parts.length - 1] || "repo";
    const parent = parts.slice(0, -1).join("/") || "/";
    const stem = `${parent}/${WORKTREE_DIR}/${repoName}/`;
    if (worktree.startsWith(stem)) return { dir, cwd: worktree, inherited: true };
  }
  // 反查不到（旧数据 / 用户手动改过 worktree）：按主目录授权判，但如实标 inherited=false。
  return { dir: primary, cwd: worktree, inherited: false };
}

/**
 * F55：文件夹授权闸（三键不再是死记录）。
 * 语义对齐授权卡：
 *  - `unset`   → 放行（旧行为；没授权过不等于拒绝，避免升级后所有动作被拦）
 *  - `default` → 长期放行，不消费
 *  - `deny`    → 拒绝执行（命令不会发出去）
 *  - `once`    → 本次放行，但**这里不消费**：凭据要等所有闸通过、占位成功后才落 `used=true`。
 *                B3 复审 P2 修复：以前在 checkExecutable 之前就消费，动作被拒时授权被烧掉。
 * @param {any} project @param {string} action @param {{ worktree?: string }} [context]
 * @returns {{ ok: true, mode: string, dir: string, cwd: string, inherited: boolean, consume: boolean } | { ok: false, mode: string, dir: string, cwd: string, inherited: boolean, reason: string }}
 */
export function folderGate(project, action, context = {}) {
  if (!FOLDER_GATED_ACTIONS.includes(String(action))) {
    return {
      ok: true,
      mode: "n/a",
      dir: "",
      cwd: "",
      inherited: false,
      consume: false,
    };
  }
  const target = actionDirectory(project, action, context);
  if (target.dir === "") {
    return { ok: true, mode: "unset", dir: "", cwd: "", inherited: false, consume: false };
  }
  const summary = folderAuthSummary(project?.policy, target.dir);
  if (summary.mode === "unset") {
    return { ok: true, mode: "unset", ...target, consume: false };
  }
  if (summary.mode === "deny") {
    return {
      ok: false,
      mode: "deny",
      dir: target.dir,
      cwd: target.cwd,
      inherited: target.inherited,
      reason: "folder/denied",
    };
  }
  if (summary.mode === "default") {
    return { ok: true, mode: "default", ...target, consume: false };
  }
  if (summary.allowed !== true) {
    return {
      ok: false,
      mode: "once",
      dir: target.dir,
      cwd: target.cwd,
      inherited: target.inherited,
      reason: "folder/once-already-used",
    };
  }
  return { ok: true, mode: "once", ...target, consume: true };
}

/**
 * 执行一条已批准的申请（幂等占位、闸门、恢复证据、审计都在这里面）。
 * @param {ExecuteDeps} deps
 * @param {string} requestId
 */
export async function executeApprovalCore(deps, requestId) {
  const { store, runGit, runGh, purgeTrash, reclaimThread, deleteProject } = deps;

  const approval = store
    .listApprovals(undefined)
    .find((/** @type {any} */ item) => item.requestId === requestId);
  if (!approval) throw new Error(`projects: unknown approval ${requestId}`);

  // 幂等判定必须**最先**：删除类动作执行后项目已不存在，
  // 若先查项目就会抛 "unknown project"，把「重复执行」误报成「项目丢了」。
  if (typeof approval.executedAt === "string" && approval.executedAt !== "") {
    store.appendAudit({
      action: "approval/execution-refused",
      projectId: approval.projectId,
      requestId,
      dangerAction: approval.action,
      reason: "already-executed",
    });
    store.save();
    return { executed: false, reason: "already-executed" }; // 已执行：与占位无关
  }

  const project = store.getProject(approval.projectId);
  if (!project) {
    store.appendAudit({
      action: "approval/execution-refused",
      projectId: approval.projectId,
      requestId,
      dangerAction: approval.action,
      reason: "project-missing",
    });
    store.save();
    return { executed: false, reason: "project-missing" }; // 同样在占位之前
  }

  // push-branch 的 cwd 在线程 worktree 里（不是 dirs[0]）：先取出线程，闸门按**实际 cwd**
  // 所属目录求 mode（worktree 继承其项目目录的授权，见 actionDirectory）。
  const gateSessionId = String(approval.args?.sessionId ?? approval.args?.threadSessionId ?? "");
  const gateThread =
    approval.action === "push-branch"
      ? store
          .listThreads(approval.projectId)
          .find((/** @type {any} */ item) => item.sessionId === gateSessionId)
      : null;
  const gateWorktree =
    typeof gateThread?.worktree === "string" && gateThread.worktree !== ""
      ? gateThread.worktree
      : "";

  // F55：文件夹授权闸（deny / once / default 三键真的影响执行）。
  // once **不在这里消费**：要等 checkExecutable + 占位都通过后再落 used（复审 P2）。
  const folder = folderGate(project, approval.action, { worktree: gateWorktree });
  if (!folder.ok) {
    store.appendAudit({
      action: "approval/execution-refused",
      projectId: approval.projectId,
      requestId,
      dangerAction: approval.action,
      reason: folder.reason,
      folderMode: folder.mode,
      folderPath: folder.dir,
      folderCwd: folder.cwd,
    });
    store.save();
    return { executed: false, reason: folder.reason }; // 闸门在占位之前，无需释放
  }

  const verdict = checkExecutable({
    approval,
    danger: project.policy?.danger ?? {},
    limits: project.policy?.danger?.merge
      ? {
          maxDiffFiles: Number(project.policy.danger.merge?.maxDiffFiles ?? 20),
          maxDiffLines: Number(project.policy.danger.merge?.maxDiffLines ?? 600),
        }
      : undefined,
    impact: approval.args?.impact ?? {},
  });
  if (!verdict.ok) {
    store.appendAudit({
      action: "approval/execution-refused",
      projectId: approval.projectId,
      requestId,
      dangerAction: approval.action,
      reason: verdict.reason,
    });
    store.save();
    return { executed: false, reason: verdict.reason }; // 闸门在占位之前，无需释放
  }

  // 幂等：先**占位**（claim）再执行，防并发两次推送/重复删除；
  // 但占用 ≠ 执行——被拒绝或被闸门挡住时要释放，让同一张申请还能重试。
  try {
    store.claimApproval(requestId);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    const reason = message.includes("already claimed") ? "already-claimed" : "already-executed";
    store.appendAudit({
      action: "approval/execution-refused",
      projectId: approval.projectId,
      requestId,
      dangerAction: approval.action,
      reason,
    });
    store.save();
    return { executed: false, reason }; // 占位失败：不释放（本来就没占上）
  }
  /** 本次调用是否消费了一张 once 凭据（用于失败回滚）。 */
  let onceConsumed = false;
  /**
   * 执行没落地时把 once 还原：授权是「同意这一次动作」，动作没发生就不该算用掉。
   * 覆盖 no-worktree / repo-unknown / 命令失败等**占位之后**才发现的拒绝路径。
   */
  const rollbackOnce = () => {
    if (onceConsumed !== true) return;
    const live = store.getProject(approval.projectId);
    const rolled = rollbackOnceFolderGrant(live?.policy, folder.dir);
    if (rolled.ok === true) {
      store.updateProject(approval.projectId, { policy: rolled.policy });
      store.appendAudit({
        action: "folder/once-rolled-back",
        projectId: approval.projectId,
        path: folder.dir,
        reason: "execution-not-completed",
      });
    }
  };
  // 统一收口：本次调用结束后，成功的落 executedAt，其余一律释放占位并回滚 once。
  const settle = (/** @type {any} */ result) => {
    try {
      if (result?.executed === true) store.markApprovalExecuted(requestId, result.evidence ?? null);
      else {
        store.releaseApproval(requestId);
        rollbackOnce();
      }
      store.save();
    } catch {
      /* 收口失败不该盖掉真实结果 */
    }
    return result;
  };

  // merge 的目标仓库必须**先**解析出来：早期 planCommand 就要用它，
  // 否则它会因为缺 repo 直接拒绝（也防止落到「宿主当前目录所在仓库」）。
  let mergeRepo = "";
  /** gh 的 pr 子命令要在仓库里跑（宿主 cwd 不是仓库）——真实仓库验证时踩到 */
  let mergeRepoDir = "";
  if (approval.action === "merge") {
    const project = store.getProject(approval.projectId);
    const repoDir = Array.isArray(project?.dirs) ? String(project.dirs[0] ?? "") : "";
    mergeRepoDir = repoDir;
    const remote =
      repoDir === ""
        ? { code: 1, stdout: "", stderr: "" }
        : await runGit(["remote", "get-url", "origin"], repoDir);
    mergeRepo = remote.code === 0 ? parseRepoFromRemote(remote.stdout) : "";
    if (mergeRepo === "") {
      store.appendAudit({
        action: "approval/execution-refused",
        projectId: approval.projectId,
        requestId,
        dangerAction: approval.action,
        reason: "merge/repo-unknown",
      });
      store.save();
      return settle({ executed: false, reason: "merge/repo-unknown" });
    }
  }
  const planArgs =
    mergeRepo === "" ? (approval.args ?? {}) : { ...(approval.args ?? {}), repo: mergeRepo };
  const planned = planCommand(approval.action, planArgs);
  if ("error" in planned) {
    store.appendAudit({
      action: "approval/execution-refused",
      projectId: approval.projectId,
      requestId,
      dangerAction: approval.action,
      reason: planned.error,
    });
    store.save();
    return settle({ executed: false, reason: planned.error });
  }

  // once 凭据：**所有闸通过且占位成功之后**才消费。此前任何拒绝路径都不会烧掉授权。
  // 并发两张申请抢同一张一次性凭据：后到的这里 consume 失败 → settle 释放占位。
  if (folder.consume === true) {
    const consumedOnce = consumeOnceFolderGrant(project.policy, folder.dir);
    if (consumedOnce.ok !== true) {
      store.appendAudit({
        action: "approval/execution-refused",
        projectId: approval.projectId,
        requestId,
        dangerAction: approval.action,
        reason: "folder/once-already-used",
        folderMode: folder.mode,
        folderPath: folder.dir,
      });
      store.save();
      return settle({ executed: false, reason: "folder/once-already-used" });
    }
    store.updateProject(project.id, { policy: consumedOnce.policy });
    onceConsumed = true;
    store.appendAudit({
      action: "folder/once-consumed",
      projectId: project.id,
      path: folder.dir,
      cwd: folder.cwd,
      inherited: folder.inherited === true,
      afterClaim: true,
    });
    store.save();
  }

  // push-branch：在工作树里跑真实 git（argv 数组，不经 shell），只推我们自己的分支
  if (approval.action === "push-branch") {
    const thread = gateThread;
    const worktree = gateWorktree;
    if (worktree === "") {
      store.appendAudit({
        action: "approval/execution-refused",
        projectId: approval.projectId,
        requestId,
        dangerAction: approval.action,
        reason: "no-worktree",
      });
      store.save();
      return settle({ executed: false, reason: "no-worktree" });
    }
    const branch = String(approval.args?.branch ?? thread?.branch ?? "");
    const force = approval.args?.force === true;

    if (force) {
      // 强推硬前提（规格 §7.5 行 1）：自建且被记录、远端没被别人动过、非保护分支、旧 SHA 已知
      const pushProject = store.getProject(approval.projectId);
      const pushRepoDir = String(pushProject?.dirs?.[0] ?? "");
      const pushRemote =
        pushRepoDir === ""
          ? { code: 1, stdout: "", stderr: "" }
          : await runGit(["remote", "get-url", "origin"], pushRepoDir);
      const pushRepo = pushRemote.code === 0 ? parseRepoFromRemote(pushRemote.stdout) : "";
      if (pushRepo === "") {
        store.appendAudit({
          action: "approval/execution-refused",
          projectId: approval.projectId,
          requestId,
          dangerAction: approval.action,
          reason: "force-push/repo-unknown",
        });
        store.save();
        return settle({ executed: false, reason: "force-push/repo-unknown" });
      }
      const expectedSha = String(approval.args?.expectedSha ?? "");
      const remoteHead = await runGit(["rev-parse", `origin/${branch}`], worktree);
      const protectedCheck = await runGh([
        "api",
        `repos/${pushRepo}/branches/${branch}/protection`,
      ]);
      const prereqs = checkForcePushPrereqs({
        branch,
        threadBranch: thread?.branch ?? null,
        expectedSha,
        remoteHeadSha: remoteHead.code === 0 ? String(remoteHead.stdout).trim() : "",
        lastPushedSha: thread?.lastPushedSha ?? null,
        protectedBranch: protectedCheck.code === 0,
      });
      if (!prereqs.ok) {
        store.appendAudit({
          action: "approval/execution-refused",
          projectId: approval.projectId,
          requestId,
          dangerAction: approval.action,
          reason: prereqs.reason,
        });
        store.save();
        return settle({ executed: false, reason: prereqs.reason });
      }
      const forced = await runGit(
        ["push", `--force-with-lease=${branch}:${expectedSha}`, "origin", branch],
        worktree,
      );
      const forcedOk = forced.code === 0;
      const forcedEvidence = recoveryEvidence(
        approval.action,
        { branch, oldSha: expectedSha },
        { stdout: forced.stdout },
      );
      store.appendAudit({
        action: forcedOk ? "approval/executed" : "approval/execution-failed",
        projectId: approval.projectId,
        requestId,
        dangerAction: approval.action,
        evidence: forcedEvidence,
        ...(forcedOk ? {} : { reason: String(forced.stderr).split("\n")[0].slice(0, 200) }),
      });
      if (forcedOk) {
        const head = await runGit(["rev-parse", "HEAD"], worktree);
        if (head.code === 0) {
          store.setThreadWorktree(gateSessionId, { lastPushedSha: String(head.stdout).trim() });
        }
      }
      store.save();
      return settle(
        forcedOk
          ? { executed: true, evidence: forcedEvidence }
          : { executed: false, reason: "force-push-failed" },
      );
    }

    const pushed = await runGit(["push", "-u", "origin", branch], worktree);
    const ok = pushed.code === 0;
    if (ok) {
      const head = await runGit(["rev-parse", "HEAD"], worktree);
      if (head.code === 0) {
        store.setThreadWorktree(gateSessionId, { lastPushedSha: String(head.stdout).trim() });
      }
    }
    const evidence = recoveryEvidence(approval.action, { branch }, { stdout: pushed.stdout });
    store.appendAudit({
      action: ok ? "approval/executed" : "approval/execution-failed",
      projectId: approval.projectId,
      requestId,
      dangerAction: approval.action,
      evidence,
      ...(ok ? {} : { reason: String(pushed.stderr).split("\n")[0].slice(0, 200) }),
    });
    store.save();
    return settle(ok ? { executed: true, evidence } : { executed: false, reason: "push-failed" });
  }

  // merge 走 gh：需要真实远端与 PR 号，留给后续步骤（这里只回报计划）
  if (approval.action === "delete-project") {
    const result = deleteProject(approval.projectId);
    const evidence = recoveryEvidence(approval.action, approval.args ?? {}, result);
    store.appendAudit({
      action: "approval/executed",
      projectId: approval.projectId,
      requestId,
      dangerAction: approval.action,
      evidence,
    });
    store.save();
    return settle({ executed: true, evidence });
  }

  // 直推保护/默认分支（规格 §7.5 行 2）：per-repo 首次授予 + 服务端允许 + 审计/事后通知
  if (approval.action === "push-protected-branch") {
    const branch = String(approval.args?.branch ?? "");
    const grProject = store.getProject(approval.projectId);
    const grDir = String(grProject?.dirs?.[0] ?? "");
    const grRemote =
      grDir === ""
        ? { code: 1, stdout: "", stderr: "" }
        : await runGit(["remote", "get-url", "origin"], grDir);
    const grRepo = grRemote.code === 0 ? parseRepoFromRemote(grRemote.stdout) : "";
    if (grRepo === "") {
      store.appendAudit({
        action: "approval/execution-refused",
        projectId: approval.projectId,
        requestId,
        dangerAction: approval.action,
        reason: "protected-push/repo-unknown",
      });
      store.save();
      return settle({ executed: false, reason: "protected-push/repo-unknown" });
    }
    // ① per-repo 首次授予：只有项目策略里显式列出的仓库才允许
    if (grProject?.policy?.repoGrants?.[grRepo] !== true) {
      store.appendAudit({
        action: "approval/execution-refused",
        projectId: approval.projectId,
        requestId,
        dangerAction: approval.action,
        reason: "protected-push/repo-not-granted",
        repo: grRepo,
      });
      store.save();
      return settle({ executed: false, reason: "protected-push/repo-not-granted" });
    }
    // ② 服务端必须允许直接推：查 protection 与 rulesets
    const protection = await runGh(["api", `repos/${grRepo}/branches/${branch}/protection`]);
    const rulesets = await runGh(["api", `repos/${grRepo}/rulesets`]);
    let parsedRulesets = [];
    if (rulesets.code === 0) {
      try {
        parsedRulesets = JSON.parse(rulesets.stdout);
      } catch {
        parsedRulesets = [];
      }
    }
    const allowed = checkProtectedPushPrereqs({
      protection:
        protection.code === 0
          ? (() => {
              try {
                return JSON.parse(protection.stdout);
              } catch {
                return null;
              }
            })()
          : null,
      rulesets: parsedRulesets,
    });
    if (!allowed.ok) {
      store.appendAudit({
        action: "approval/execution-refused",
        projectId: approval.projectId,
        requestId,
        dangerAction: approval.action,
        reason: allowed.reason,
      });
      store.save();
      return settle({ executed: false, reason: allowed.reason });
    }
    // ③ 多人协作检测：不禁止，但要在审计与返回里显式警告
    const commits = await runGh(["api", `repos/${grRepo}/commits?per_page=30`]);
    /** @type {{ collaborators: number, multi: boolean, sample: string[] }} */
    let collab = { collaborators: 0, multi: false, sample: [] };
    if (commits.code === 0) {
      try {
        collab = countCollaborators(JSON.parse(commits.stdout));
      } catch {
        /* 拿不到就按单人处理，但下面仍会记一条审计 */
      }
    }
    const pushedProtected = await runGit(["push", "origin", branch], grDir);
    const okProtected = pushedProtected.code === 0;
    const evidence = recoveryEvidence(
      approval.action,
      { branch, repo: grRepo },
      { stdout: pushedProtected.stdout },
    );
    store.appendAudit({
      action: okProtected ? "approval/executed" : "approval/execution-failed",
      projectId: approval.projectId,
      requestId,
      dangerAction: approval.action,
      repo: grRepo,
      branch,
      evidence,
      collaborators: collab.collaborators,
      ...(collab.multi ? { warning: "multi-collaborator" } : {}),
      ...(okProtected
        ? {}
        : { reason: String(pushedProtected.stderr).split("\n")[0].slice(0, 200) }),
    });
    store.save();
    return settle(
      okProtected
        ? {
            executed: true,
            evidence,
            ...(collab.multi
              ? { warning: "multi-collaborator", collaborators: collab.collaborators }
              : {}),
          }
        : { executed: false, reason: "protected-push-failed" },
    );
  }

  // merge：走 gh pr merge（argv 里已含 --squash，不带 --admin/--force）。
  // 只合并我们自己的 PR：planCommand 已保证 PR 号是正整数，且危险开关与阈值都过了。
  if (approval.action === "merge") {
    const prNumber = Number(approval.args?.prNumber);
    const repo = mergeRepo;

    // 前置校验：非 draft、可合并、仍 open（规格 §7.5 行 3 的硬前提）
    const view = await runGh(
      [
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "isDraft,mergeable,state,statusCheckRollup,reviews",
      ],
      mergeRepoDir || undefined,
    );
    if (view.code !== 0) {
      store.appendAudit({
        action: "approval/execution-failed",
        projectId: approval.projectId,
        requestId,
        dangerAction: approval.action,
        reason: String(view.stderr).split("\n")[0].slice(0, 200) || "merge/pr-view-failed",
      });
      store.save();
      return settle({ executed: false, reason: "merge/pr-view-failed" });
    }
    const parsed = (() => {
      try {
        return JSON.parse(view.stdout);
      } catch {
        return null;
      }
    })();
    // 规格 §7.5 行 3 的 ⑥：仓库允许的合并方式（不允许 squash 就拒绝，不改方式）
    const repoInfo = await runGh(["api", `repos/${repo}`], mergeRepoDir || undefined);
    // REST 给的是三个布尔（allow_squash_merge…），没有 allowed_merge_methods 字段——真实仓库验证时踩到
    const allowedMethods = allowedMergeMethodsFromRepo(
      repoInfo.code === 0 ? JSON.parse(repoInfo.stdout) : null,
    );
    const readiness = (/** @type {any} */ pr) =>
      checkMergeReadiness({
        pr,
        reviews: pr?.reviews ?? [],
        allowedMethods,
        minApprovals: Number(project?.policy?.merge?.minApprovals ?? 1),
      });

    // GitHub 刚建 PR 时 mergeable 可能是 UNKNOWN（服务端还在算）：有界重试几次。
    let preflight = readiness(parsed);
    let attempt = 0;
    while (!preflight.ok && shouldRetryPreflight(preflight.reason ?? "") && attempt < 5) {
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const again = await runGh(
        [
          "pr",
          "view",
          String(prNumber),
          "--repo",
          repo,
          "--json",
          "isDraft,mergeable,state,statusCheckRollup,reviews",
        ],
        mergeRepoDir || undefined,
      );
      if (again.code !== 0) break;
      try {
        preflight = readiness(JSON.parse(again.stdout));
      } catch {
        break;
      }
    }
    if (!preflight.ok) {
      store.appendAudit({
        action: "approval/execution-refused",
        projectId: approval.projectId,
        requestId,
        dangerAction: approval.action,
        reason: preflight.reason,
      });
      store.save();
      return settle({ executed: false, reason: preflight.reason });
    }

    const ghArgs = planned.argv.slice(1); // 去掉 argv[0] 的 "gh"（planArgs 已带 --repo）
    const merged = await runGh(ghArgs, mergeRepoDir || undefined);
    const ok = merged.code === 0;
    if (ok) {
      // squash 合并后分支 commit 不再是主干的祖先，回收判据证不出"已合并"。
      // 合并成功这一刻是我们唯一确定知道的时点，记在线程上。
      const prNumber = Number(approval.args?.prNumber);
      for (const thread of store.listThreads(approval.projectId)) {
        if (Number.isFinite(prNumber) && Number(thread.prNumber) === prNumber) {
          store.setThreadWorktree(thread.sessionId, { mergedAt: new Date().toISOString() });
        }
      }
    }
    const evidence = recoveryEvidence(approval.action, approval.args ?? {}, {
      stdout: merged.stdout,
    });
    store.appendAudit({
      action: ok ? "approval/executed" : "approval/execution-failed",
      projectId: approval.projectId,
      requestId,
      dangerAction: approval.action,
      evidence,
      ...(ok
        ? {}
        : { reason: String(merged.stderr).split("\n")[0].slice(0, 200) || "gh-merge-failed" }),
    });
    store.save();
    return settle(
      ok ? { executed: true, evidence } : { executed: false, reason: "gh-merge-failed" },
    );
  }

  // 删除线程 / 回收 worktree（规格 §7.5 行 4b）：走 reclaimThread，三重判据仍生效
  if (approval.action === "delete-thread") {
    const sessionId = String(approval.args?.sessionId ?? approval.args?.threadSessionId ?? "");
    if (sessionId === "") {
      store.appendAudit({
        action: "approval/execution-refused",
        projectId: approval.projectId,
        requestId,
        dangerAction: approval.action,
        reason: "session-required",
      });
      store.save();
      return settle({ executed: false, reason: "session-required" });
    }
    const reclaimed = await reclaimThread(sessionId);
    const ok = reclaimed?.reclaimed === true;
    const evidence = recoveryEvidence(approval.action, { sessionId }, reclaimed ?? {});
    store.appendAudit({
      action: ok ? "approval/executed" : "approval/execution-failed",
      projectId: approval.projectId,
      requestId,
      dangerAction: approval.action,
      evidence,
      ...(ok ? {} : { reason: String(reclaimed?.reason ?? "worktree-kept") }),
    });
    store.save();
    return settle(
      ok
        ? { executed: true, evidence }
        : { executed: false, reason: String(reclaimed?.reason ?? "worktree-kept") },
    );
  }

  // 改本插件自己的配置（规格 §7.5 行 5a）：只允许白名单键，安全面一律拒绝
  if (approval.action === "change-settings") {
    const checked = sanitizeSettingsPatch(approval.args?.patch);
    if (!checked.ok) {
      store.appendAudit({
        action: "approval/execution-refused",
        projectId: approval.projectId,
        requestId,
        dangerAction: approval.action,
        reason: checked.reason,
      });
      store.save();
      return settle({ executed: false, reason: checked.reason });
    }
    const before = store.getProject(approval.projectId);
    const nextPolicy = applySettingsPatch(before?.policy ?? {}, checked.patch);
    store.updateProject(approval.projectId, { policy: nextPolicy });
    const evidence = recoveryEvidence(approval.action, { keys: checked.keys }, {});
    store.appendAudit({
      action: "approval/executed",
      projectId: approval.projectId,
      requestId,
      dangerAction: approval.action,
      keys: checked.keys,
      evidence,
    });
    store.save();
    return settle({ executed: true, evidence, keys: checked.keys });
  }

  // 回收站清理（规格 §7.5 行 4c）：审批路径复用 purgeTrash，开关与项目都按本次申请的项目判定
  if (approval.action === "purge-trash") {
    // deps 里的 purgeTrash 已经固定成「真删 + confirm + 指定项目」
    const purged = await purgeTrash(approval.projectId);
    const ok = purged.ok === true;
    const evidence = recoveryEvidence(approval.action, approval.args ?? {}, {
      purged: purged.purged.length,
      kept: purged.kept,
      manifestPath: purged.manifestPath ?? "",
    });
    store.appendAudit({
      action: ok ? "approval/executed" : "approval/execution-failed",
      projectId: approval.projectId,
      requestId,
      dangerAction: approval.action,
      evidence,
      ...(ok ? {} : { reason: purged.reason ?? "purge-failed" }),
    });
    store.save();
    return settle(
      ok
        ? { executed: true, evidence, purged: purged.purged.length, kept: purged.kept }
        : { executed: false, reason: purged.reason ?? "purge-failed" },
    );
  }

  store.appendAudit({
    action: "approval/execution-deferred",
    projectId: approval.projectId,
    requestId,
    dangerAction: approval.action,
    reason: "remote-action-not-implemented",
    planned: planned.argv,
  });
  store.save();
  return settle({
    executed: false,
    reason: "remote-action-not-implemented",
    planned: planned.argv,
  });
}
