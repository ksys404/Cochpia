import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// 工作模式只读工具：ls / read / grep / find。全部只读，不写文件、不执行命令，安全。
const ROOT = process.cwd();
const MAX_READ = 80 * 1024;
const MAX_RESULTS = 200;
const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.vite', 'Knowledge_Base']);

function* walk(dir, depth = 0) {
  if (depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, depth + 1);
    else if (entry.isFile()) yield full;
  }
}

const rel = p => path.relative(ROOT, p);

// 安全策略：拒绝读取可能含密钥的文件
const SENSITIVE_NAME = /(^|\.)env(\..*)?$|\.pem$|\.key$|\.p12$|credential|secret/i;

// 脱敏：隐藏密钥、token、密码等
const redact = text => String(text || '')
  .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
  .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*['"]?)[^'"\s]+/gi, '$1[REDACTED]');

export const WORK_TOOLS = [
  {
    name: 'ls',
    description: '列出目录内容（默认项目根目录），返回条目名和大小。',
    parameters: { type: 'object', properties: { dir: { type: 'string', description: '目录路径，可选，默认项目根目录' } } },
    async execute(args = {}) {
      const dir = path.resolve(String(args.dir || '.'));
      const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 100);
      if (!entries.length) return '(空目录)';
      return entries.map(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return `📁 ${rel(full)}/`;
        const size = fs.statSync(full).size;
        return `📄 ${rel(full)} (${size}B)`;
      }).join('\n');
    }
  },
  {
    name: 'read',
    description: '读取文件内容，返回文本。用于查看代码、配置、文档。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '要读取的文件路径（相对或绝对）' } }, required: ['path'] },
    async execute(args = {}) {
      const file = path.resolve(String(args.path || ''));
      if (SENSITIVE_NAME.test(path.basename(file))) return '（安全策略：拒绝读取该文件，可能包含敏感信息）';
      const stat = fs.statSync(file);
      if (!stat.isFile()) return `${rel(file)} 不是文件`;
      if (stat.size > MAX_READ) {
        return `文件过大（${stat.size}B），仅显示前 ${MAX_READ}B：\n` + fs.readFileSync(file, 'utf8').slice(0, MAX_READ) + '\n…(内容已截断)';
      }
      return fs.readFileSync(file, 'utf8');
    }
  },
  {
    name: 'grep',
    description: '在项目源码中搜索文本或正则，返回「文件:行号: 内容」。自动跳过 node_modules/.git/dist 等目录。',
    parameters: { type: 'object', properties: { pattern: { type: 'string', description: '要搜索的文本或正则表达式' } }, required: ['pattern'] },
    async execute(args = {}) {
      const raw = String(args.pattern || '');
      if (!raw) return '需要 pattern 参数';
      let regex;
      try { regex = new RegExp(raw, 'i'); } catch { regex = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
      const out = [];
      for (const file of walk(ROOT)) {
        if (out.length >= MAX_RESULTS) break;
        try {
          const content = fs.readFileSync(file, 'utf8');
          content.split('\n').forEach((line, i) => {
            if (out.length < MAX_RESULTS && regex.test(line)) out.push(redact(`${rel(file)}:${i + 1}: ${line.trim().slice(0, 180)}`));
          });
        } catch { /* 二进制或无法读取，跳过 */ }
      }
      return out.join('\n') || '(未找到匹配)';
    }
  },
  {
    name: 'find',
    description: '按文件名关键词查找文件，返回匹配的文件路径列表。',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '文件名关键词（不区分大小写）' } }, required: ['name'] },
    async execute(args = {}) {
      const keyword = String(args.name || '').toLowerCase();
      if (!keyword) return '需要 name 参数';
      const results = [];
      for (const file of walk(ROOT)) {
        if (rel(file).toLowerCase().includes(keyword)) results.push(rel(file));
        if (results.length >= MAX_RESULTS) break;
      }
      return results.join('\n') || '(未找到)';
    }
  },
  {
    name: 'write',
    description: '创建或覆盖一个文件。执行前会先征求用户确认。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '要写入的文件路径' }, content: { type: 'string', description: '文件完整内容' } }, required: ['path', 'content'] },
    requiresApproval: true,
    async execute(args = {}) {
      const file = path.resolve(String(args.path || ''));
      if (SENSITIVE_NAME.test(path.basename(file))) return '（安全策略：拒绝写入敏感文件）';
      const content = String(args.content || '');
      fs.writeFileSync(file, content, 'utf8');
      return `已写入 ${rel(file)}（${content.length} 字符）`;
    }
  },
  {
    name: 'edit',
    description: '替换文件中的一段文本（用 oldText 精确匹配，替换为 newText）。执行前会先征求用户确认。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '要修改的文件路径' }, oldText: { type: 'string', description: '要替换的原文（必须精确匹配）' }, newText: { type: 'string', description: '替换后的新文本' } }, required: ['path', 'oldText', 'newText'] },
    requiresApproval: true,
    async execute(args = {}) {
      const file = path.resolve(String(args.path || ''));
      if (SENSITIVE_NAME.test(path.basename(file))) return '（安全策略：拒绝修改敏感文件）';
      const oldText = String(args.oldText || '');
      const newText = String(args.newText || '');
      const content = fs.readFileSync(file, 'utf8');
      if (!content.includes(oldText)) return `未找到要替换的文本（请确认 oldText 与文件内容完全一致）`;
      fs.writeFileSync(file, content.replace(oldText, newText), 'utf8');
      return `已修改 ${rel(file)}`;
    }
  },
  {
    name: 'bash',
    description: '执行一个 shell 命令（如 git status、npm test、node 脚本）。执行前会先征求用户确认。',
    parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的 shell 命令' } }, required: ['command'] },
    requiresApproval: true,
    async execute(args = {}) {
      const command = String(args.command || '').trim();
      if (!command) return '需要 command 参数';
      if (command.length > 500) return '命令过长（超过 500 字符）';
      try {
        const output = execSync(command, { cwd: ROOT, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
        return output || '(命令执行成功，无输出)';
      } catch (error) {
        return `命令执行失败（exit ${error.status ?? '未知'}）：\n${(error.stdout || '') + (error.stderr || error.message)}`.slice(0, 4000);
      }
    }
  }
];

export const findTool = name => WORK_TOOLS.find(tool => tool.name === name) || null;

export const toOpenAITools = () => WORK_TOOLS.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));

export async function executeTool(name, args = {}) {
  const tool = findTool(name);
  if (!tool) return `未知工具：${name}`;
  try { return await tool.execute(args); }
  catch (error) { return `工具执行出错：${error.message}`; }
}
