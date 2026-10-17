#!/usr/bin/env node

import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";
import * as history from "../lib/prompt-history.js";
import * as pm from "../lib/prompt-manager.js";

const rawArgs = process.argv.slice(2);

function printHelp() {
  console.log(`dsh-purge 核心用法:
  dsh-purge --status              显示全局补丁与环境状态
  dsh-purge --apply               应用全部源码清洗（提示词+代码+shim+override）
  dsh-purge --revert              回滚还原官方源码
  dsh-purge --uninstall           卸载插件（已应用则先还原）
  dsh-purge --edit                直接用系统默认编辑器编辑 prompt-inject.md

多提示词方案与版本控制 (类似 Git 的多场景提示词管理):
  dsh-purge prompt list           列出所有提示词方案与当前激活状态
  dsh-purge prompt use <名称>     切换当前激活的提示词方案 (即刻生效)
  dsh-purge prompt create <名称>  新建一份提示词场景方案 (默认基于当前提示词克隆)
  dsh-purge prompt commit -m <消息> 为当前提示词方案提交一次新版本 (保留历史与说明)
  dsh-purge prompt log            查看当前提示词方案的完整版本提交历史 (类似 git log)
  dsh-purge prompt checkout <版本> 回滚/检出当前方案到指定历史版本
  dsh-purge prompt status         查看当前活跃方案及统计信息

快捷单文件快照命令:
  dsh-purge --backup [备注]       快速保存单次快照
  dsh-purge --snapshots           查看历史快照
  dsh-purge --rollback [序号]     一键回滚到指定快照 (默认上一版)
`);
}

function printStatus(state) {
  const out = [];
  out.push("dsh-purge 状态 / Status");
  out.push("  宿主 / surface " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  if (state.desktop_install) out.push("  桌面安装       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  插件根 / root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  插件根 / root  " + core.missingAiBaseMessage());
  }
  out.push(`  shim 目录      ${state.shim_dir || "未定位 / not found"}`);
  out.push(`  备份 / backup  ${state.has_backup ? "有 / yes" : "无 / no"}`);
  out.push(`  注入文件       ${state.override_path}`);
  out.push(`  注入状态       ${state.override_status}`);

  // 补充当前激活的提示词方案信息
  try {
    const active = pm.getActiveProfile(state.dsh_home);
    out.push(`  活跃提示词方案  ${active.name} (${active.version})`);
  } catch {}

  out.push("");
  out.push(`  补丁 ${state.patches_applied}/${core.ALL_PATCHES.length} 已清洗, ${state.patches_pending} 待清洗`);
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id];
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : "·";
    out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  out.push("");
  out.push(`  shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

async function handlePromptCommand(args) {
  const subcmd = args[0] || "list";
  const home = core.findDshHome();
  pm.ensureInitialized(home);

  if (subcmd === "list" || subcmd === "ls") {
    const profiles = pm.listProfiles(home);
    console.log(`提示词方案列表 (共 ${profiles.length} 个方案):`);
    for (const p of profiles) {
      const activeMark = p.isActive ? "* [ACTIVE]" : " ";
      const timeStr = p.updatedAt ? p.updatedAt.toLocaleString() : "";
      console.log(`  ${activeMark.padEnd(10)} ${p.name.padEnd(22)} ${String(p.size).padStart(6)} 字节  ${p.commitCount} 次提交  (最新: ${p.latestMessage})`);
    }
    console.log("\n切换方案: dsh-purge prompt use <方案名>");
    console.log("新建方案: dsh-purge prompt create <新方案名>");
    return;
  }

  if (subcmd === "status" || subcmd === "current") {
    const active = pm.getActiveProfile(home);
    const curPath = pm.profileDir(home, active.name);
    console.log(`当前激活方案: ${active.name}`);
    console.log(`当前指向版本: ${active.version}`);
    console.log(`方案存储目录: ${curPath}`);
    console.log(`全局生效文件: ${core.findOverrideFile(home)}`);
    return;
  }

  if (subcmd === "presets") {
    const presets = pm.getBuiltinPresets();
    console.log(`系统内置官方场景预设 (共 ${Object.keys(presets).length} 个):`);
    for (const [k, v] of Object.entries(presets)) {
      console.log(`  - ${k.padEnd(16)} (${v.length} 字节)`);
    }
    console.log("\n基于预设创建新方案: dsh-purge prompt create <新方案名> --from <预设名>");
    return;
  }

  if (subcmd === "create" || subcmd === "new") {
    const name = args[1];
    if (!name) {
      console.error("用法错误: 请提供新方案名称，如: dsh-purge prompt create my-profile");
      process.exit(1);
    }
    const fromEmpty = args.includes("--empty");
    const fromIdx = args.indexOf("--from");
    let content = "";
    let initMsg = "Initial commit";
    if (fromEmpty) {
      content = "# Custom System Prompt\n";
      initMsg = "Initial commit: 空白初始化";
    } else if (fromIdx >= 0 && args[fromIdx + 1]) {
      const presetKey = args[fromIdx + 1];
      const presets = pm.getBuiltinPresets();
      if (presets[presetKey]) {
        content = presets[presetKey];
        initMsg = `Initial commit from preset: ${presetKey}`;
      } else {
        console.error(`未找到预设: ${presetKey}。可用预设: ${Object.keys(presets).join(", ")}`);
        process.exit(1);
      }
    } else {
      content = core.readPromptInjectFileSync(home) || "";
      initMsg = "Initial commit from current template";
    }
    try {
      const created = pm.createProfile(home, name, content, initMsg);
      console.log(`✓ 提示词方案 "${created.name}" 创建成功！`);
      console.log(`  初始版本: ${created.commit.id} (${created.commit.size} 字节)`);
      console.log(`  立即切换使用: dsh-purge prompt use ${created.name}`);
    } catch (e) {
      console.error(`✗ 创建失败: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (subcmd === "use" || subcmd === "switch") {
    const name = args[1];
    if (!name) {
      console.error("用法错误: 请指定要切换的方案名称，如: dsh-purge prompt use all-in-one");
      process.exit(1);
    }
    const version = args[2] || "latest";
    try {
      const res = pm.switchProfile(home, name, version);
      console.log(`✓ 已成功切换提示词方案！`);
      console.log(`  当前激活: ${res.name} (版本: ${res.version})`);
      console.log(`  已同步写入: ${res.path} (${res.size} 字节)`);
      console.log(`  * DSH 会在下一次对话步自动热加载最新提示词。`);
    } catch (e) {
      console.error(`✗ 切换失败: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (subcmd === "commit" || subcmd === "save") {
    let msg = "";
    const mIdx = args.indexOf("-m");
    if (mIdx >= 0 && args[mIdx + 1]) {
      msg = args[mIdx + 1];
    } else {
      msg = args.slice(1).filter((a) => !a.startsWith("-")).join(" ");
    }
    if (!msg) msg = "Update prompt";

    try {
      const res = pm.commitProfile(home, "", msg);
      if (res.alreadyClean) {
        console.log(`- ${res.message}`);
      } else {
        console.log(`✓ 已为方案 [${res.targetName}] 提交新版本！`);
        console.log(`  Commit ID: ${res.commit.id}`);
        console.log(`  提交说明 : ${res.commit.message}`);
        console.log(`  文件大小 : ${res.commit.size} 字节`);
      }
    } catch (e) {
      console.error(`✗ 提交失败: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (subcmd === "log" || subcmd === "history") {
    const name = args[1] && !args[1].startsWith("-") ? args[1] : "";
    try {
      const res = pm.getProfileLog(home, name);
      console.log(`方案 [${res.name}] 版本历史记录 (共 ${res.commits.length} 次提交):`);
      res.commits.forEach((c, i) => {
        const timeStr = new Date(c.timestamp).toLocaleString();
        console.log(`  commit ${c.id}`);
        console.log(`  Date:    ${timeStr}`);
        console.log(`  Size:    ${c.size} 字节`);
        console.log(`  Message: ${c.message}\n`);
      });
      console.log("回滚检出指定版本: dsh-purge prompt checkout <commitId>");
    } catch (e) {
      console.error(`✗ 获取日志失败: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (subcmd === "checkout" || subcmd === "rollback") {
    const ver = args[1];
    if (!ver) {
      console.error("用法错误: 请提供要回滚/检出的 commitId 或版本号，如: dsh-purge prompt checkout c1_xxx");
      process.exit(1);
    }
    try {
      const res = pm.rollbackProfileVersion(home, ver);
      console.log(`✓ 已成功检出至指定版本！`);
      console.log(`  方案: ${res.name}`);
      console.log(`  版本: ${res.version} (${res.size} 字节)`);
      console.log(`  已生效于: ${res.path}`);
    } catch (e) {
      console.error(`✗ 检出失败: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  console.error(`未知子命令: prompt ${subcmd}。运行 dsh-purge --help 查看帮助。`);
}

async function main() {
  if (rawArgs.length === 0) {
    const state = await core.gatherState();
    console.log(printStatus(state));
    console.log("");
    console.log("提示: 运行 dsh-purge --help 查看全部选项与多提示词管理命令。");
    return;
  }

  if (rawArgs[0] === "prompt") {
    await handlePromptCommand(rawArgs.slice(1));
    return;
  }

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printHelp();
    return;
  }

  // 兼容单次快照命令
  const backupIdx = rawArgs.findIndex((a) => a === "--backup" || a === "-b");
  if (backupIdx >= 0) {
    const label = rawArgs[backupIdx + 1] && !rawArgs[backupIdx + 1].startsWith("-") ? rawArgs[backupIdx + 1] : "";
    try {
      const snap = history.createSnapshot(core.findDshHome(), label);
      console.log(`✓ 提示词快照已创建: ${snap.filename} (${snap.size} 字节)`);
      console.log(`  路径: ${snap.path}`);
    } catch (e) {
      console.error(`✗ 创建快照失败: ${e.message}`);
    }
    return;
  }

  if (rawArgs.includes("--snapshots") || rawArgs.includes("--list-backups") || rawArgs.includes("-l")) {
    const list = history.listSnapshots(core.findDshHome());
    if (list.length === 0) {
      console.log("暂无任何提示词快照。可使用 'dsh-purge --backup [备注]' 创建。");
      return;
    }
    console.log(`提示词历史快照列表 (共 ${list.length} 个):`);
    list.forEach((item, i) => {
      const timeStr = item.mtime.toLocaleString();
      console.log(`  [${i + 1}] ${item.name.padEnd(45)} ${String(item.size).padStart(6)} 字节  (${timeStr})`);
    });
    console.log("\n回滚命令: dsh-purge --rollback <序号或文件名>");
    return;
  }

  const rollbackIdx = rawArgs.findIndex((a) => a === "--rollback");
  if (rollbackIdx >= 0) {
    const target = rawArgs[rollbackIdx + 1] && !rawArgs[rollbackIdx + 1].startsWith("-") ? rawArgs[rollbackIdx + 1] : 1;
    try {
      const result = history.rollbackToSnapshot(core.findDshHome(), target);
      console.log(`✓ 提示词已成功无损回滚！`);
      console.log(`  来源版本: ${result.restoredFrom}`);
      console.log(`  写入文件: ${result.targetFile} (${result.size} 字节)`);
      console.log(`  * 回滚前已自动保存当前版本至快照库，防止误操作。`);
    } catch (e) {
      console.error(`✗ 回滚失败: ${e.message}`);
    }
    return;
  }

  const mode = rawArgs.find((a) => ["--apply", "--revert", "--uninstall", "--status", "--edit"].includes(a));

  const state = await core.gatherState();
  if (mode === "--status") {
    console.log(printStatus(state));
    return;
  }

  if (mode === "--apply") {
    if (!state.ai_base) {
      console.log("[ERROR] " + core.missingAiBaseMessage());
      console.log("  fix: 把 DSH_BASE 指到含 dsh-agent-instructions/lib 的 @deepseek-ai 目录");
      process.exit(1);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] 提示词和规则集都是空的，必须先添加提示词");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  宿主 / host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ 已清洗" : r.status === "already" ? "- 已是最新" : r.status === "missing_file" ? "⚠ 文件缺失" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`);
    }
    const flashHost = hosts[0]?.aiBase || state.ai_base;
    const flash = core.silenceCmdFlash(flashHost);
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  多宿主 / multi-host: ${hosts.length} 份 @deepseek-ai 已清洗`);
    }
    console.log(inject.source === "rule"
      ? "  - 使用当前规则集，不改写提示词文件"
      : "  - 使用已有提示词文件");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} 注入 / injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} 已注入 / already injected`);
        else if (st === "missing") console.log(`  - shim ${fname} 不存在 / missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  ⚠ 未定位 shim 目录，跳过注入");
    }
    console.log("");
    console.log("全部完成 / All done。重启 dsh 生效 / Restart dsh to take effect.");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ 已还原 / Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ 还原失败 ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - 没有补丁备份可还原 / no patch backup");
    }
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
    console.log("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
  } else if (mode === "--uninstall") {
    const { uninstallPurge } = await import("../lib/uninstall.js");
    const result = await uninstallPurge();
    if (result.applied) console.log("  已检测到补丁，已还原回原版。");
    else console.log("  未检测到已应用补丁，仍会清除插件文件。");
    if (result.override?.removed) console.log(`  已删除 ${result.override.path}`);
    if (result.stripped?.length) console.log(`  已从 profile 移除: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    if (!result.ok) {
      console.log("  卸载中止：还原失败，插件文件未删除。");
      process.exit(1);
    }
    console.log("");
    console.log("卸载完成。请重启 dsh。");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ 已创建默认注入文件：${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → 已打开 ${r.editor} 编辑注入文件：${r.path}`);
    }
    console.log("  编辑完成后重启 dsh 生效。");
  } else {
    console.log(printStatus(state));
    console.log("\n提示: 运行 dsh-purge --help 查看全部选项与多提示词管理命令。");
  }
}

main().catch((e) => {
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
