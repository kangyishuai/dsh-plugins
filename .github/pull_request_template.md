## 改了什么

<!-- 一两句话。关联 issue：Closes #... -->

## 自查清单

- [ ] PR 标题符合 Conventional Commits（squash 后就是 main 上的提交信息）
- [ ] 分支名是 `<type>/<plugin>-<主题>`
- [ ] 只改了一个插件的目录（共享文件 `docs/`、根配置等单独提交）
- [ ] `pnpm verify` 本地通过
- [ ] 需要发版的改动已经加了 changeset（`pnpm changeset`）
- [ ] 已经打包安装进 DSH（`pnpm pack` + `dsh plugin add <tgz>`，见 AGENTS.md），在 GUI 里实际点过一遍（host 改动重启了 DSH，client 改动刷新了页面）
- [ ] 破坏性操作有确认框，写明了影响面（数量、大小、是否 live、能否恢复）
- [ ] README 的「副作用与风险」「兼容性」两节已更新
- [ ] 借用了第三方代码的话，已经确认许可证并在 NOTICE 里注明出处

## 在哪个 DSH 版本上验证

<!-- 例如：桌面版 0.2.1-rc.5，macOS -->
