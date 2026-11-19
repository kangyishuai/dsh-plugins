// @ts-check
// core/app-bundle.js：macOS .app 的一屏摘要（勘察第一跳）。
//
// 为什么需要：真实用过一轮，`inspect_desktop_application` 对纯原生 Swift 应用
// 返回 candidates=0，等于什么也没说，我只好手工 file / plutil / ls。
// 这里把"这是什么的 app、装了什么约束"一次说清，输出全部来自真实文件，
// 字段读不到就标 null，不猜。

/**
 * 从 Info.plist 的 JSON 形式里取一屏摘要。
 * @param {Record<string, any>} plist
 * @returns {Record<string, any>}
 */
export function summarizeInfoPlist(plist) {
  const value = plist && typeof plist === "object" ? plist : {};
  const exported = Array.isArray(value.UTExportedTypeDeclarations)
    ? value.UTExportedTypeDeclarations
    : [];
  const utis = exported
    .map((item) => (typeof item?.UTTypeIdentifier === "string" ? item.UTTypeIdentifier : null))
    .filter((item) => item != null);
  const schemeHosts = Array.isArray(value.CFBundleURLTypes) ? value.CFBundleURLTypes : [];
  const urlSchemes = schemeHosts.flatMap((item) =>
    Array.isArray(item?.CFBundleURLSchemes) ? item.CFBundleURLSchemes.map(String) : [],
  );
  const docExtensions = (
    Array.isArray(value.CFBundleDocumentTypes) ? value.CFBundleDocumentTypes : []
  ).flatMap((item) =>
    Array.isArray(item?.CFBundleTypeExtensions) ? item.CFBundleTypeExtensions.map(String) : [],
  );
  const bundleId = typeof value.CFBundleIdentifier === "string" ? value.CFBundleIdentifier : null;
  const ats = value.NSAppTransportSecurity;
  return {
    bundleId,
    bundleName: typeof value.CFBundleName === "string" ? value.CFBundleName : null,
    executable: typeof value.CFBundleExecutable === "string" ? value.CFBundleExecutable : null,
    shortVersion:
      typeof value.CFBundleShortVersionString === "string"
        ? value.CFBundleShortVersionString
        : null,
    buildVersion: typeof value.CFBundleVersion === "string" ? value.CFBundleVersion : null,
    minSystemVersion:
      typeof value.LSMinimumSystemVersion === "string" ? value.LSMinimumSystemVersion : null,
    category:
      typeof value.LSApplicationCategoryType === "string" ? value.LSApplicationCategoryType : null,
    uiElement: value.LSUIElement === true,
    sandboxed: value["MMKit_sandboxed"] === true || value.NSSandboxed === true || null,
    allowsArbitraryLoads:
      ats && typeof ats === "object" ? ats.NSAllowsArbitraryLoads === true : null,
    urlSchemes: [...new Set(urlSchemes)],
    documentExtensions: [...new Set(docExtensions)],
    exportedUtis: utis,
    utiPrefixes: [...new Set(utis.map((uti) => uti.split(".").slice(0, 2).join(".")))],
    principalClass: typeof value.NSPrincipalClass === "string" ? value.NSPrincipalClass : null,
    appleScriptEnabled: value.NSAppleScriptEnabled === true,
    sdefFile:
      typeof value.OSAScriptingDefinition === "string" ? value.OSAScriptingDefinition : null,
    xcodeBuild: typeof value.DTXcode === "string" ? value.DTXcode : null,
  };
}

/**
 * 从 `lipo -archs` 输出取架构列表。
 * @param {string} output 形如 "x86_64 arm64" 或 "Non-fat file: ... is architecture: arm64"
 * @returns {string[]}
 */
export function parseArchitectures(output) {
  const text = String(output ?? "").trim();
  if (text === "") return [];
  const nonFat = text.match(/is architecture:\s*(\S+)/u);
  if (nonFat) return [nonFat[1]];
  return [...new Set(text.split(/\s+/u).filter((item) => /^[\w-]+$/u.test(item)))];
}

/**
 * 归属域一致性：bundle id 与导出 UTI 的域前缀是否同一套。
 * 这不是"对错"判断，而是把真实存在的不一致摆出来给验收人看。
 * @param {Record<string, any>} summary
 * @returns {{ consistent: boolean | null, bundleDomain: string | null, utiDomains: string[] }}
 */
export function checkDomainConsistency(summary) {
  const bundleId = typeof summary?.bundleId === "string" ? summary.bundleId : null;
  /** @type {string[]} */
  const utiDomains = Array.isArray(summary?.utiPrefixes) ? summary.utiPrefixes.map(String) : [];
  if (bundleId == null || utiDomains.length === 0) {
    return {
      consistent: null,
      bundleDomain: bundleId == null ? null : bundleId.split(".").slice(0, 2).join("."),
      utiDomains,
    };
  }
  const bundleDomain = bundleId.split(".").slice(0, 2).join(".");
  return {
    consistent: utiDomains.every((domain) => domain === bundleDomain),
    bundleDomain,
    utiDomains,
  };
}

/**
 * 组合成一屏摘要。
 * @param {Record<string, any>} plist
 * @param {{ architectures?: string[], executablePath?: string, infoPlistPath?: string }} facts
 * @returns {Record<string, any>}
 */
export function summarizeAppBundle(plist, facts) {
  const summary = summarizeInfoPlist(plist);
  return {
    ...summary,
    architectures: Array.isArray(facts?.architectures) ? facts.architectures : [],
    executablePath: facts?.executablePath ?? null,
    infoPlistPath: facts?.infoPlistPath ?? null,
    domainConsistency: checkDomainConsistency(summary),
  };
}
