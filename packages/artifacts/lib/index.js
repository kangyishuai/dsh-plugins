// @ts-check
// host 半入口：导出 Cordis 插件类（Typert Remote Service 形态）。
// Remote 方法必须声明在这个被导出的类自身原型上（见 ./service.js 的 declareRemote），
// 不要再包一层子类，否则 /api/artifacts/* 会 404（docs/runtime/0.2.1-rc.5.md §6.10）。

export { CONTRACT, createArtifactLibrary, LIBRARY_METHODS, publicArtifact } from "./library.js";
export { contentTypeFor, createRouteHandler } from "./route.js";
export {
  ArtifactsService,
  ArtifactsService as default,
  ROUTE_PREFIX,
  SERVICE_NAME,
} from "./service.js";
export {
  ARTIFACT_CONTRACT,
  ARTIFACT_KINDS,
  ArtifactError,
  createArtifactStore,
  defaultMime,
  extFor,
  filterArtifacts,
  isTextKind,
  KIND_INFO,
  latestBytes,
  MAX_BYTES,
  normalizeKind,
  normalizeMeta,
  resolveDataRoot,
  slugify,
  sniffImageMime,
  summarizeArtifacts,
  totalBytes,
} from "./store.js";
export {
  createToolDefinition,
  decodeImageContent,
  renderToolOutput,
  TOOL_NAME,
  TOOL_OUTPUT_SCHEMA,
  TOOL_PARAMETERS,
} from "./tool.js";
