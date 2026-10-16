// 桌面端发版用到的纯函数：版本号校验、SemVer 比较（含预发布）、更新清单内容。

export const REPO = "fukcrz/jarvis";
/** 测试版清单固定放在 `updater-beta` 这个（预发布）Release 的附件里，每次覆盖。 */
export const BETA_MANIFEST_TAG = "updater-beta";
export const STABLE_MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/latest.json`;
export const BETA_MANIFEST_URL = `https://github.com/${REPO}/releases/download/${BETA_MANIFEST_TAG}/beta.json`;

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/** 只接受 SemVer 的 `X.Y.Z` 或 `X.Y.Z-预发布`；不允许 `+构建元数据`（NSIS/更新器处理不一致）。 */
export function parseVersion(value) {
  const text = String(value).trim().replace(/^v/, "");
  const match = VERSION_PATTERN.exec(text);
  if (match === null) throw new Error(`版本号不合法：${String(value)}（应为 X.Y.Z 或 X.Y.Z-beta.N）`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split("."),
  };
}

export function isPrerelease(value) {
  return parseVersion(value).pre.length > 0;
}

/** SemVer 2.0 优先级：0.1.28-beta.1 < 0.1.28-beta.2 < 0.1.28 < 0.1.29-beta.1。 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    if (left.pre.length === right.pre.length) return 0;
    return left.pre.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 决定这次发版要写哪些清单：正式版写 latest.json，并在不低于当前测试版时一并写 beta.json；
 * 测试版只写 beta.json（同样不能把更高的版本覆盖掉）。
 */
export function planManifests(version, currentBetaVersion) {
  const prerelease = isPrerelease(version);
  const beta = currentBetaVersion === undefined || compareVersions(version, currentBetaVersion) >= 0;
  return { prerelease, latest: !prerelease, beta };
}

export function buildManifest({ version, exe, signature, pubDate = new Date().toISOString() }) {
  parseVersion(version);
  return {
    version,
    notes: `Jarvis ${version}`,
    pub_date: pubDate,
    platforms: {
      "windows-x86_64": {
        signature,
        url: `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(exe).replace(/%2F/gi, "/")}`,
      },
    },
  };
}
