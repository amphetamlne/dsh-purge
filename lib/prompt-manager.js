import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { findDshHome, readPromptInjectFileSync } from "./core.js";

/**
 * 提示词方案管理器主目录: $DSH_HOME/prompts
 */
export function promptsBaseDir(dshHome = findDshHome()) {
  const dir = path.join(dshHome, "prompts");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function activeStatePath(dshHome = findDshHome()) {
  return path.join(promptsBaseDir(dshHome), "active.json");
}

function computeHash(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
}

/**
 * 获取当前激活的提示词方案与状态
 */
export function getActiveProfile(dshHome = findDshHome()) {
  const p = activeStatePath(dshHome);
  if (fs.existsSync(p)) {
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      if (data && data.name) return data;
    } catch { /* 容错 */ }
  }
  return { name: "all-in-one", version: "latest", switchedAt: new Date().toISOString() };
}

/**
 * 记录激活的方案
 */
export function setActiveProfile(dshHome = findDshHome(), name, version = "latest") {
  const data = { name, version, switchedAt: new Date().toISOString() };
  fs.writeFileSync(activeStatePath(dshHome), JSON.stringify(data, null, 2), "utf8");
  return data;
}

export function profileDir(dshHome = findDshHome(), name) {
  return path.join(promptsBaseDir(dshHome), name);
}

export function commitsPath(dshHome = findDshHome(), name) {
  return path.join(profileDir(dshHome, name), "commits.json");
}

export function versionsDir(dshHome = findDshHome(), name) {
  const dir = path.join(profileDir(dshHome, name), "versions");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadCommits(dshHome = findDshHome(), name) {
  const cp = commitsPath(dshHome, name);
  if (fs.existsSync(cp)) {
    try {
      const data = JSON.parse(fs.readFileSync(cp, "utf8"));
      if (Array.isArray(data)) return data;
    } catch { /* 容错 */ }
  }
  return [];
}

export function saveCommits(dshHome = findDshHome(), name, commits) {
  fs.writeFileSync(commitsPath(dshHome, name), JSON.stringify(commits, null, 2), "utf8");
}

/**
 * 初始化系统，如果尚未有任何方案，将当前 prompt-inject.md 作为 all-in-one 方案的基线
 */
export function ensureInitialized(dshHome = findDshHome()) {
  const baseDir = promptsBaseDir(dshHome);
  const profiles = listProfiles(dshHome);
  if (profiles.length === 0) {
    const current = readPromptInjectFileSync(dshHome);
    const content = current && current.trim() ? current : "# System Prompt\n";
    createProfile(dshHome, "all-in-one", content, "Initial commit: 当前全能基线版本");
    setActiveProfile(dshHome, "all-in-one", "latest");
  }
}

/**
 * 列出所有已注册的提示词方案
 */
export function listProfiles(dshHome = findDshHome()) {
  const baseDir = promptsBaseDir(dshHome);
  if (!fs.existsSync(baseDir)) return [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  const active = getActiveProfile(dshHome);

  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const curPath = path.join(baseDir, name, "current.md");
    if (!fs.existsSync(curPath)) continue;
    const stat = fs.statSync(curPath);
    const commits = loadCommits(dshHome, name);
    const latestCommit = commits.length > 0 ? commits[commits.length - 1] : null;

    profiles.push({
      name,
      isActive: name === active.name,
      size: stat.size,
      commitCount: commits.length,
      latestMessage: latestCommit ? latestCommit.message : "无提交信息",
      updatedAt: stat.mtime,
    });
  }
  return profiles;
}

/**
 * 创建一个新的提示词方案
 */
export function createProfile(dshHome = findDshHome(), name, initialContent = "", initialMsg = "Initial commit") {
  const safeName = name.trim().replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_");
  if (!safeName) throw new Error("方案名称不能为空");

  const dir = profileDir(dshHome, safeName);
  if (fs.existsSync(dir)) {
    throw new Error(`方案 "${safeName}" 已存在，不可重复创建`);
  }
  fs.mkdirSync(dir, { recursive: true });
  versionsDir(dshHome, safeName);

  const curFile = path.join(dir, "current.md");
  fs.writeFileSync(curFile, initialContent, "utf8");

  // 创建初始 commit
  const commitId = "c1_" + computeHash(initialContent);
  const commitObj = {
    id: commitId,
    message: initialMsg,
    timestamp: new Date().toISOString(),
    size: initialContent.length,
    filename: `${commitId}.md`,
  };
  fs.writeFileSync(path.join(versionsDir(dshHome, safeName), commitObj.filename), initialContent, "utf8");
  saveCommits(dshHome, safeName, [commitObj]);

  return { name: safeName, commit: commitObj };
}

/**
 * 为指定或当前方案提交一次新版本（类似 git commit）
 */
export function commitProfile(dshHome = findDshHome(), name = "", message = "Update prompt") {
  const active = getActiveProfile(dshHome);
  const targetName = name || active.name;
  const dir = profileDir(dshHome, targetName);
  if (!fs.existsSync(dir)) {
    throw new Error(`方案 "${targetName}" 不存在`);
  }

  // 如果提交的是当前活跃方案，优先以当前 $DSH_HOME/prompt-inject.md 的最新修改为准
  let content = "";
  if (targetName === active.name) {
    content = readPromptInjectFileSync(dshHome) || "";
    // 同步写回 current.md
    fs.writeFileSync(path.join(dir, "current.md"), content, "utf8");
  } else {
    content = fs.readFileSync(path.join(dir, "current.md"), "utf8");
  }

  const commits = loadCommits(dshHome, targetName);
  const nextNum = commits.length + 1;
  const hash = computeHash(content);
  
  // 检查是否与上一版内容完全相同
  if (commits.length > 0) {
    const last = commits[commits.length - 1];
    if (last.id.endsWith(hash)) {
      return { alreadyClean: true, message: "内容未发生任何更改，无需重复提交" };
    }
  }

  const commitId = `c${nextNum}_${hash}`;
  const commitObj = {
    id: commitId,
    message: message || `Update ${targetName}`,
    timestamp: new Date().toISOString(),
    size: content.length,
    filename: `${commitId}.md`,
  };

  fs.writeFileSync(path.join(versionsDir(dshHome, targetName), commitObj.filename), content, "utf8");
  commits.push(commitObj);
  saveCommits(dshHome, targetName, commits);

  setActiveProfile(dshHome, targetName, commitId);

  return { targetName, commit: commitObj };
}

/**
 * 切换激活的提示词方案，并一键推送到全局 prompt-inject.md
 */
export function switchProfile(dshHome = findDshHome(), name, versionId = "latest") {
  const dir = profileDir(dshHome, name);
  if (!fs.existsSync(dir)) {
    throw new Error(`方案 "${name}" 不存在`);
  }

  let content = "";
  let appliedVersion = "latest";

  if (versionId === "latest") {
    const curPath = path.join(dir, "current.md");
    content = fs.readFileSync(curPath, "utf8");
  } else {
    const commits = loadCommits(dshHome, name);
    let targetCommit = commits.find((c) => c.id === versionId);
    if (!targetCommit && /^\d+$/.test(versionId)) {
      const idx = Number(versionId) - 1;
      if (idx >= 0 && idx < commits.length) targetCommit = commits[idx];
    }
    if (!targetCommit) {
      throw new Error(`方案 "${name}" 中找不到版本 "${versionId}"`);
    }
    const verPath = path.join(versionsDir(dshHome, name), targetCommit.filename);
    content = fs.readFileSync(verPath, "utf8");
    appliedVersion = targetCommit.id;
  }

  // 写入主生效文件
  const mainInject = path.join(dshHome, "prompt-inject.md");
  fs.writeFileSync(mainInject, content, "utf8");

  // 记录激活方案
  setActiveProfile(dshHome, name, appliedVersion);

  return { name, version: appliedVersion, size: content.length, path: mainInject };
}

/**
 * 查看指定方案的提交历史日志（类似 git log）
 */
export function getProfileLog(dshHome = findDshHome(), name = "") {
  const active = getActiveProfile(dshHome);
  const targetName = name || active.name;
  const dir = profileDir(dshHome, targetName);
  if (!fs.existsSync(dir)) {
    throw new Error(`方案 "${targetName}" 不存在`);
  }
  const commits = loadCommits(dshHome, targetName);
  return { name: targetName, commits: commits.slice().reverse() };
}

/**
 * 回滚到当前方案的某一次历史 commit
 */
export function rollbackProfileVersion(dshHome = findDshHome(), versionRef) {
  const active = getActiveProfile(dshHome);
  return switchProfile(dshHome, active.name, versionRef);
}
