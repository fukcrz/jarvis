import { AppError } from "./errors.js";

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/** npm 包名，去掉版本。scoped 包的版本在第二个 @。 */
export function packageNameFromSource(source: string): string | undefined {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice(4).trim();
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash < 1) return undefined;
    const versionAt = spec.indexOf("@", slash + 1);
    const name = versionAt === -1 ? spec : spec.slice(0, versionAt);
    return PACKAGE_NAME.test(name) ? name : undefined;
  }
  const versionAt = spec.indexOf("@");
  const name = versionAt === -1 ? spec : spec.slice(0, versionAt);
  return PACKAGE_NAME.test(name) ? name : undefined;
}

/** npm 的 repository 常带 `git+` 和 `.git`，浏览页要能直接打开。 */
export function catalogUrl(repository: string | undefined, homepage: string | undefined, npmUrl: string): string {
  const github = [repository, homepage].find((value) => value?.includes("github.com"));
  if (github === undefined) return npmUrl;
  return github.replace(/^git\+/, "").replace(/\.git$/, "");
}

/** 只接受 npm 包和 GitHub 地址。本地路径不在这里装。 */
export function normalizeInstallSource(input: string): string {
  let value = input.trim();
  if (value.startsWith("git+")) value = value.slice(4);
  if (value === "" || /\s/.test(value) || value.includes("..")) {
    throw new AppError("PLUGIN_SOURCE_INVALID", "无法识别的安装地址", 400);
  }
  if (value.startsWith("npm:")) {
    const source = value.replace(/\/+$/, "");
    if (packageNameFromSource(source) === undefined) throw new AppError("PLUGIN_SOURCE_INVALID", "无法识别的安装地址", 400);
    return source;
  }
  if (/^git:github\.com\/[^/]+\/[^/@#]+(?:@[^\s]+)?$/i.test(value)) return value;
  const github = normalizeGithubHttps(value);
  if (github !== undefined) return github;
  if (/^git@github\.com:[^/]+\/[^/#]+(?:\.git)?(?:#[^\s]+)?$/i.test(value)) return value;
  if (PACKAGE_NAME.test(value)) return `npm:${value}`;
  throw new AppError("PLUGIN_SOURCE_INVALID", "无法识别的安装地址", 400);
}

/** 浏览页复制出来的地址常带 `.git`、查询串、末尾斜杠或 `/tree/main`。 */
function normalizeGithubHttps(value: string): string | undefined {
  const cleaned = value.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\/(?:tree|blob)\/[^/]+$/i, "").replace(/\.git$/i, "");
  return /^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(cleaned) ? cleaned : undefined;
}
