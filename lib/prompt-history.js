import fs from "node:fs";
import path from "node:path";
import { findDshHome, readPromptInjectFileSync, atomicWriteFile } from "./core.js";

export function backupsDir(dshHome = findDshHome()) {
  const dir = path.join(dshHome, "prompt-backups");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 为当前 prompt-inject.md 创建无损快照
 * @param {string} dshHome 
 * @param {string} label 可选备注标签
 */
export function createSnapshot(dshHome = findDshHome(), label = "") {
  const home = path.normalize(String(dshHome || findDshHome() || ""));
  const current = readPromptInjectFileSync(home);
  if (!current) {
    throw new Error("当前 prompt-inject.md 不存在或为空，无法创建备份");
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safeLabel = label ? `-${label.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_")}` : "";
  const filename = `prompt-inject-${timestamp}${safeLabel}.md`;
  
  const destDir = backupsDir(home);
  const target = path.join(destDir, filename);
  fs.writeFileSync(target, current, "utf8");

  return { filename, path: target, size: current.length, timestamp: now.toISOString() };
}

/**
 * 列出所有已保存的历史快照
 */
export function listSnapshots(dshHome = findDshHome()) {
  const dir = backupsDir(dshHome);
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith("prompt-inject-") && f.endsWith(".md"))
    .map((name) => {
      const fp = path.join(dir, name);
      const stat = fs.statSync(fp);
      return {
        name,
        path: fp,
        size: stat.size,
        mtime: stat.mtime,
      };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return files;
}

/**
 * 无损回滚到指定的快照版本（回滚前自动对当前版本生成 safety-before-rollback 快照）
 * @param {string} dshHome 
 * @param {string|number} target 快照文件名或序号（1 为最近的上一版）
 */
export function rollbackToSnapshot(dshHome = findDshHome(), target = 1) {
  const home = path.normalize(String(dshHome || findDshHome() || ""));
  const snapshots = listSnapshots(home);
  if (snapshots.length === 0) {
    throw new Error("未找到任何可回滚的历史快照");
  }

  let selected = null;
  if (typeof target === "number" || /^\d+$/.test(String(target))) {
    const idx = Number(target) - 1;
    if (idx < 0 || idx >= snapshots.length) {
      throw new Error(`无效的快照序号: ${target} (当前共有 ${snapshots.length} 个快照)`);
    }
    selected = snapshots[idx];
  } else {
    selected = snapshots.find((s) => s.name === target || s.path === target);
    if (!selected) {
      throw new Error(`未找到名为 "${target}" 的快照文件`);
    }
  }

  // 1. 回滚前：对当前现存的版本创建防误触安全快照
  try {
    createSnapshot(home, "safety-before-rollback");
  } catch { /* 忽略空文件情况 */ }

  // 2. 读入目标快照内容并写入主文件
  const content = fs.readFileSync(selected.path, "utf8");
  const promptFile = path.join(home, "prompt-inject.md");
  fs.writeFileSync(promptFile, content, "utf8");

  return {
    restoredFrom: selected.name,
    targetFile: promptFile,
    size: content.length,
  };
}
