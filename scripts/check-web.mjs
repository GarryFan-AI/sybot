// 语法/加载检查 web 模块（Node 上下文缺浏览器 API 属预期）
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const files = ['web/app.js', 'web/engine.js', 'web/store.js', 'web/ui.js', 'web/vendor/sha256.js'];
let fail = 0;
for (const f of files) {
  try {
    await import(pathToFileURL(path.resolve(f)).href);
    console.log('LOADED', f);
  } catch (e) {
    if (e instanceof SyntaxError) { console.log('SYNTAX FAIL', f, e.message); fail++; }
    else console.log('SYNTAX OK（运行时缺浏览器 API，属预期）', f, '->', e.message);
  }
}
process.exit(fail ? 1 : 0);
