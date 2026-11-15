'use strict';
// 配置加载：config.json（首次运行自动生成）+ 环境变量覆盖。
// config.json 是唯一被原子写（tmp + rename）的配置文件。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  port: 5284,
  accessKey: '',              // 首次运行生成 12 位 base32
  storageRoot: path.join(PROJECT_ROOT, 'data', 'storage'),
  maxChunkBytes: 12 * 1024 * 1024, // 单块请求体上限（服务端实际下发 4MB/8MB）
  maxInFlight: 200,                // 在途上传上限
  incomingTtlHours: 72,            // .incoming 超时清理
  hashMaxBytes: 64 * 1024 * 1024,  // 客户端做全文件 sha256 的尺寸阈值（建议值，仅提示用）
  rateLimitQps: 200,               // 每 IP 每秒请求数上限
  logKeepDays: 14,
};

// Windows 保留名 + 非法字符在这里只做配置级提示，实际清洗在 storage.js
function generateKey() {
  // 12 字符 base32（Crockford 字母表去易混淆字符），约 60 bit
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

function atomicWriteJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function load() {
  const cfgFile = path.join(PROJECT_ROOT, 'config.json');
  let fileCfg = {};
  if (fs.existsSync(cfgFile)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    } catch (e) {
      throw new Error(`config.json 解析失败: ${e.message}`);
    }
  }

  const cfg = { ...DEFAULTS, ...fileCfg };

  // 环境变量覆盖（SIPP_ 前缀）
  if (process.env.SIPP_PORT) cfg.port = Number(process.env.SIPP_PORT);
  if (process.env.SIPP_ACCESS_KEY) cfg.accessKey = process.env.SIPP_ACCESS_KEY;
  if (process.env.SIPP_STORAGE_ROOT) cfg.storageRoot = path.resolve(process.env.SIPP_STORAGE_ROOT);
  if (process.env.SIPP_INCOMING_TTL_HOURS) cfg.incomingTtlHours = Number(process.env.SIPP_INCOMING_TTL_HOURS);

  if (!cfg.accessKey) {
    cfg.accessKey = generateKey();
    // 写回文件以便下次一致（环境变量指定时以环境变量为准，不写文件）
    if (!process.env.SIPP_ACCESS_KEY) {
      atomicWriteJson(cfgFile, cfg);
      console.log(`[config] 已生成访问密钥并写入 config.json`);
    }
  }

  // 校验
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new Error(`非法端口: ${cfg.port}`);
  }
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(cfg.accessKey)) {
    throw new Error('accessKey 须为 4~64 位字母数字');
  }
  cfg.storageRoot = path.resolve(cfg.storageRoot);
  fs.mkdirSync(cfg.storageRoot, { recursive: true });
  fs.mkdirSync(path.join(cfg.storageRoot, '.incoming'), { recursive: true });
  const dataDir = path.join(PROJECT_ROOT, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

  cfg.projectRoot = PROJECT_ROOT;
  cfg.dataDir = dataDir;
  cfg.dbFile = path.join(dataDir, 'app.db');
  cfg.logDir = path.join(dataDir, 'logs');
  cfg.incomingDir = path.join(cfg.storageRoot, '.incoming');
  return cfg;
}

module.exports = { load, PROJECT_ROOT, DEFAULTS };
